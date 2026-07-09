use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer as TokenTransfer};

use crate::constants::*;
use crate::error::AnsemError;
use crate::math;
use crate::state::{BeefConfig, BeefMiner, BeefRound, Config, MinerPosition, Round, STATE_CLAIMABLE};

// BEEF vault emission layer (plan 2026-07-09-beef-vault-emission).
//
// INVARIANT — BEEF never blocks the game: an empty/missing vault stamps
// emission 0; roll_beef no-ops (never errors) on already-rolled / round-
// mismatch so it can't abort a stake or claim bundle; every ANSEM
// instruction is untouched and takes no BEEF accounts.
//
// ORDERING (SDK-enforced): roll_beef must precede any block_stake-zeroing ix
// in a bundle — claim_direct zeroes stakes, stake_direct re-stamps the miner.

fn validate_params(divisor: u64, secs_per_tick: i64) -> Result<()> {
    require!(divisor > 0 && secs_per_tick > 0, AnsemError::BadBeefParams);
    Ok(())
}

#[derive(Accounts)]
pub struct InitBeef<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.config_bump,
        constraint = config.admin == admin.key() @ AnsemError::Unauthorized)]
    pub config: Box<Account<'info, Config>>,

    pub beef_mint: Box<Account<'info, Mint>>,

    /// CHECK: existing payout vault authority PDA — reused as the BEEF vault owner.
    #[account(seeds = [VAULT_AUTH_SEED], bump = config.vault_auth_bump)]
    pub vault_authority: UncheckedAccount<'info>,

    // The (vanity-address) token account that IS the vault. Created off-chain by
    // ops (scripts/beef-init.mjs); the program only pins mint + owner here, then
    // trusts the stored pubkey everywhere else.
    #[account(
        constraint = beef_vault.mint == beef_mint.key() @ AnsemError::BadBeefVault,
        constraint = beef_vault.owner == vault_authority.key() @ AnsemError::BadBeefVault,
    )]
    pub beef_vault: Box<Account<'info, TokenAccount>>,

    #[account(init, payer = admin, space = 8 + BeefConfig::INIT_SPACE,
        seeds = [BEEF_CONFIG_SEED], bump)]
    pub beef_config: Box<Account<'info, BeefConfig>>,

    pub system_program: Program<'info, System>,
}

pub fn init_beef_handler(
    ctx: Context<InitBeef>,
    divisor: u64,
    tick_bps: u16,
    bonus_cap_bps: u16,
    activity_window_secs: i64,
    secs_per_tick: i64,
) -> Result<()> {
    validate_params(divisor, secs_per_tick)?;
    let bc = &mut ctx.accounts.beef_config;
    bc.beef_mint = ctx.accounts.beef_mint.key();
    bc.beef_vault = ctx.accounts.beef_vault.key();
    bc.divisor = divisor;
    bc.tick_bps = tick_bps;
    bc.bonus_cap_bps = bonus_cap_bps;
    bc.activity_window_secs = activity_window_secs;
    bc.secs_per_tick = secs_per_tick;
    bc.total_owed = 0;
    bc.bump = ctx.bumps.beef_config;
    Ok(())
}

#[derive(Accounts)]
pub struct SetBeefParams<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.config_bump,
        constraint = config.admin == admin.key() @ AnsemError::Unauthorized)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [BEEF_CONFIG_SEED], bump = beef_config.bump)]
    pub beef_config: Box<Account<'info, BeefConfig>>,
}

/// The tuning knob promised in the design: launch conservative, adjust with
/// data. Cannot change mint/vault (those are pinned at init).
pub fn set_beef_params_handler(
    ctx: Context<SetBeefParams>,
    divisor: u64,
    tick_bps: u16,
    bonus_cap_bps: u16,
    activity_window_secs: i64,
    secs_per_tick: i64,
) -> Result<()> {
    validate_params(divisor, secs_per_tick)?;
    let bc = &mut ctx.accounts.beef_config;
    bc.divisor = divisor;
    bc.tick_bps = tick_bps;
    bc.bonus_cap_bps = bonus_cap_bps;
    bc.activity_window_secs = activity_window_secs;
    bc.secs_per_tick = secs_per_tick;
    Ok(())
}

#[derive(Accounts)]
#[instruction(round_id: u64)]
pub struct StampBeef<'info> {
    // Permissionless: the payer just funds BeefRound rent. Emission math is
    // deterministic from frozen round + live vault state; a griefing deposit
    // into the vault only ever RAISES the players' emission.
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.config_bump)]
    pub config: Box<Account<'info, Config>>,

    #[account(seeds = [ROUND_SEED, round_id.to_le_bytes().as_ref()], bump = round.bump,
        constraint = round.round_id == round_id @ AnsemError::MinerRoundMismatch)]
    pub round: Box<Account<'info, Round>>,

    #[account(mut, seeds = [BEEF_CONFIG_SEED], bump = beef_config.bump)]
    pub beef_config: Box<Account<'info, BeefConfig>>,

    #[account(address = beef_config.beef_vault @ AnsemError::BadBeefVault)]
    pub beef_vault: Box<Account<'info, TokenAccount>>,

    // `init` (not init_if_needed) = the once-only stamp guard.
    #[account(init, payer = payer, space = 8 + BeefRound::INIT_SPACE,
        seeds = [BEEF_ROUND_SEED, round_id.to_le_bytes().as_ref()], bump)]
    pub beef_round: Box<Account<'info, BeefRound>>,

    pub system_program: Program<'info, System>,
}

pub fn stamp_beef_handler(ctx: Context<StampBeef>, round_id: u64) -> Result<()> {
    let round = &ctx.accounts.round;
    require!(round.state == STATE_CLAIMABLE, AnsemError::BadRoundState);
    // Only the newest round is stampable: an abandoned old round can never be
    // retro-stamped into a permanent total_owed leak (its shares would be
    // unrollable — every MinerPosition has moved on).
    require!(
        round_id == ctx.accounts.config.current_round_id,
        AnsemError::NotCurrentRound
    );

    let bc = &mut ctx.accounts.beef_config;
    let free = ctx.accounts.beef_vault.amount.saturating_sub(bc.total_owed);
    // Empty rounds emit nothing (a quiet night never drains the vault).
    let emission = if round.pot == 0 { 0 } else { free / bc.divisor };

    let br = &mut ctx.accounts.beef_round;
    br.round_id = round_id;
    br.emission = emission;
    br.bump = ctx.bumps.beef_round;

    bc.total_owed = bc.total_owed.checked_add(emission).ok_or(AnsemError::Overflow)?;
    Ok(())
}

#[derive(Accounts)]
#[instruction(round_id: u64)]
pub struct RollBeef<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(seeds = [ROUND_SEED, round_id.to_le_bytes().as_ref()], bump = round.bump,
        constraint = round.round_id == round_id @ AnsemError::MinerRoundMismatch)]
    pub round: Box<Account<'info, Round>>,

    // READ-ONLY: roll never mutates the ANSEM-path position.
    #[account(seeds = [MINER_SEED, authority.key().as_ref()], bump = miner.bump,
        constraint = miner.authority == authority.key() @ AnsemError::Unauthorized)]
    pub miner: Box<Account<'info, MinerPosition>>,

    #[account(seeds = [BEEF_ROUND_SEED, round_id.to_le_bytes().as_ref()], bump = beef_round.bump)]
    pub beef_round: Box<Account<'info, BeefRound>>,

    #[account(mut, seeds = [BEEF_CONFIG_SEED], bump = beef_config.bump)]
    pub beef_config: Box<Account<'info, BeefConfig>>,

    #[account(init_if_needed, payer = authority, space = 8 + BeefMiner::INIT_SPACE,
        seeds = [BEEF_MINER_SEED, authority.key().as_ref()], bump)]
    pub beef_miner: Box<Account<'info, BeefMiner>>,

    pub system_program: Program<'info, System>,
}

/// Accrue the hold-to-grow bonus up to `now`, recognizing the new liability.
/// Shared by roll (before dilution) and claim (before payout). Always sets
/// last_tick_ts = now so gate-closed dead time is skipped, never re-scanned.
fn accrue_bonus(bm: &mut BeefMiner, bc: &mut BeefConfig, now: i64) -> Result<()> {
    let ticks = math::beef_ticks(now, bm.last_tick_ts, bm.last_active_ts, bc.activity_window_secs, bc.secs_per_tick);
    let delta = math::beef_bonus_delta(ticks, bc.tick_bps, bm.bonus_bps, bc.bonus_cap_bps);
    if delta > 0 {
        let owed = math::beef_owed_delta(bm.unclaimed, delta);
        bm.bonus_bps += delta; // safe: beef_bonus_delta clamps to cap headroom
        bc.total_owed = bc.total_owed.checked_add(owed).ok_or(AnsemError::Overflow)?;
    }
    bm.last_tick_ts = now;
    Ok(())
}

pub fn roll_beef_handler(ctx: Context<RollBeef>, round_id: u64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let bm = &mut ctx.accounts.beef_miner;
    if bm.authority == Pubkey::default() {
        bm.authority = ctx.accounts.authority.key();
        bm.bump = ctx.bumps.beef_miner;
        bm.last_tick_ts = now;
        bm.last_active_ts = now;
    }

    // INVARIANT: roll never errors on game-state grounds — a failed roll would
    // abort the whole [roll, stake]/[roll, claim] bundle and block the player
    // from the ANSEM game. Already-rolled and moved-on positions are no-ops.
    if bm.last_rolled_round_id >= round_id || ctx.accounts.miner.round_id != round_id {
        return Ok(());
    }

    let bc = &mut ctx.accounts.beef_config;
    // 1. accrue the existing balance's bonus BEFORE the new share dilutes it
    accrue_bonus(bm, bc, now)?;

    // 2. pro-rata share of the frozen emission, then weighted-average dilution
    let stake_sum: u64 = ctx.accounts.miner.block_stake.iter().sum();
    let share = math::beef_share(ctx.accounts.beef_round.emission, stake_sum, ctx.accounts.round.pot);
    bm.bonus_bps = math::beef_dilute(bm.bonus_bps, bm.unclaimed, share);
    bm.unclaimed = bm.unclaimed.checked_add(share).ok_or(AnsemError::Overflow)?;

    // 3. this touch accompanies a played round -> keeps the daily streak alive
    bm.last_rolled_round_id = round_id;
    bm.last_active_ts = now;
    Ok(())
}

#[derive(Accounts)]
pub struct ClaimBeef<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(mut, seeds = [BEEF_CONFIG_SEED], bump = beef_config.bump)]
    pub beef_config: Box<Account<'info, BeefConfig>>,

    #[account(mut, seeds = [BEEF_MINER_SEED, authority.key().as_ref()], bump = beef_miner.bump,
        constraint = beef_miner.authority == authority.key() @ AnsemError::Unauthorized)]
    pub beef_miner: Box<Account<'info, BeefMiner>>,

    #[account(address = beef_config.beef_mint @ AnsemError::BadBeefVault)]
    pub beef_mint: Box<Account<'info, Mint>>,

    /// CHECK: same vault authority PDA that signs ANSEM payouts.
    #[account(seeds = [VAULT_AUTH_SEED], bump)]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(mut, address = beef_config.beef_vault @ AnsemError::BadBeefVault)]
    pub beef_vault: Box<Account<'info, TokenAccount>>,

    #[account(init_if_needed, payer = authority,
        associated_token::mint = beef_mint, associated_token::authority = authority)]
    pub player_beef_ata: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn claim_beef_handler(ctx: Context<ClaimBeef>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let bm = &mut ctx.accounts.beef_miner;
    let bc = &mut ctx.accounts.beef_config;

    // final accrual, then pay unclaimed * (1 + bonus)
    accrue_bonus(bm, bc, now)?;
    let payout = math::beef_payout(bm.unclaimed, bm.bonus_bps);

    if payout > 0 {
        // ctx.bumps carries the verified bump for any seeds-checked account —
        // no find_program_address re-derivation needed.
        let va_seeds: &[&[u8]] = &[VAULT_AUTH_SEED, &[ctx.bumps.vault_authority]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                TokenTransfer {
                    from: ctx.accounts.beef_vault.to_account_info(),
                    to: ctx.accounts.player_beef_ata.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                },
                &[va_seeds],
            ),
            payout,
        )?;
    }

    // saturating: floor-rounding interplay can leave dust either side; the
    // stamp-side floors leave a permanently growing free buffer that dominates.
    bc.total_owed = bc.total_owed.saturating_sub(payout);

    // THE reset: any claim restarts the hold-to-grow ramp from 1x.
    bm.unclaimed = 0;
    bm.bonus_bps = 0;
    bm.last_tick_ts = now;
    Ok(())
}
