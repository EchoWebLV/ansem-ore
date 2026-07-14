use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
// BEEF is now the program's OWN classic-SPL mint (6 decimals, spec 2026-07-14-
// beef-on-ansem-design D1/D4): its mint authority is the vault_authority PDA, so
// stamp_beef MINTS each round's emission (players' 80% into the vault buffer,
// treasury's 20% straight to the treasury ATA). The Token-2022-compatible
// interface layer is retained for generality — a classic SPL mint satisfies it.
use anchor_spl::token_interface::{self, Mint, MintTo, TokenAccount, TokenInterface, TransferChecked};

use crate::constants::*;
use crate::error::AnsemError;
use crate::math;
use crate::state::{BeefConfig, BeefMiner, BeefRound, Config, MinerPosition, Round, STATE_CLAIMABLE};

// BEEF mint-on-emission layer (spec 2026-07-14-beef-on-ansem-design; supersedes
// the dormant vault-drip plan 2026-07-09).
//
// INVARIANT — BEEF never blocks the game: a dust/empty round stamps emission 0;
// roll_beef no-ops (never errors) on already-rolled / round-mismatch so it can't
// abort a stake or claim bundle; every ANSEM instruction is untouched and takes
// no BEEF accounts.
//
// ORDERING (SDK-enforced): roll_beef must precede any block_stake-zeroing ix
// in a bundle — claim_direct zeroes stakes, stake_direct re-stamps the miner.

// Shared validation for the tunable emission/bonus params (init + set_beef_params).
// sat_lamports and secs_per_tick are denominators in the emission/bonus math, so
// both must be > 0. treasury_bps and hard_cap are validated at init only — they
// are init-PINNED (never tunable): raising the cap or the treasury split would
// break the published trust page.
fn validate_beef_params(sat_lamports: u64, secs_per_tick: i64) -> Result<()> {
    require!(sat_lamports > 0 && secs_per_tick > 0, AnsemError::BadBeefParams);
    Ok(())
}

#[derive(Accounts)]
pub struct InitBeef<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.config_bump,
        constraint = config.admin == admin.key() @ AnsemError::Unauthorized)]
    pub config: Box<Account<'info, Config>>,

    /// CHECK: existing payout vault authority PDA — reused as the BEEF vault owner
    /// AND (now) the BEEF mint authority. Declared BEFORE beef_mint so the
    /// mint-authority constraint below can reference its key.
    #[account(seeds = [VAULT_AUTH_SEED], bump = config.vault_auth_bump)]
    pub vault_authority: UncheckedAccount<'info>,

    // The program's OWN BEEF mint. Its mint authority MUST be the vault_authority
    // PDA so stamp_beef can mint the per-round emission; pinned here, then trusted
    // by pubkey everywhere else.
    #[account(constraint = beef_mint.mint_authority.contains(&vault_authority.key()) @ AnsemError::BadBeefParams)]
    pub beef_mint: Box<InterfaceAccount<'info, Mint>>,

    // The (vanity-address) token account that IS the players' emission buffer.
    // Created off-chain by ops; the program only pins mint + owner here.
    #[account(
        constraint = beef_vault.mint == beef_mint.key() @ AnsemError::BadBeefVault,
        constraint = beef_vault.owner == vault_authority.key() @ AnsemError::BadBeefVault,
    )]
    pub beef_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    // Treasury ATA — the 20% continuous cut is minted straight here. Pinned at
    // init; any owner (ops names it), only the mint is constrained.
    #[account(constraint = beef_treasury.mint == beef_mint.key() @ AnsemError::BadBeefVault)]
    pub beef_treasury: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(init, payer = admin, space = 8 + BeefConfig::INIT_SPACE,
        seeds = [BEEF_CONFIG_SEED], bump)]
    pub beef_config: Box<Account<'info, BeefConfig>>,

    pub system_program: Program<'info, System>,
}

pub fn init_beef_handler(
    ctx: Context<InitBeef>,
    max_round_mint: u64,
    sat_lamports: u64,
    hard_cap: u64,
    treasury_bps: u16,
    tick_bps: u16,
    bonus_cap_bps: u16,
    activity_window_secs: i64,
    secs_per_tick: i64,
) -> Result<()> {
    validate_beef_params(sat_lamports, secs_per_tick)?;
    // Init-only pins: split capped at 50% and a positive cap. Never re-settable.
    require!(treasury_bps <= 5_000 && hard_cap > 0, AnsemError::BadBeefParams);
    let bc = &mut ctx.accounts.beef_config;
    bc.beef_mint = ctx.accounts.beef_mint.key();
    bc.beef_vault = ctx.accounts.beef_vault.key();
    bc.beef_treasury = ctx.accounts.beef_treasury.key();
    bc.max_round_mint = max_round_mint;
    bc.sat_lamports = sat_lamports;
    bc.hard_cap = hard_cap;
    bc.minted_total = 0;
    bc.treasury_bps = treasury_bps;
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
/// data. Tunes the emission CURVE (max_round_mint / sat_lamports) and the bonus
/// knobs. CANNOT change mint / vault / treasury / hard_cap / treasury_bps — those
/// are init-pinned trust commitments (raising the cap or the split would break
/// the trust page).
pub fn set_beef_params_handler(
    ctx: Context<SetBeefParams>,
    max_round_mint: u64,
    sat_lamports: u64,
    tick_bps: u16,
    bonus_cap_bps: u16,
    activity_window_secs: i64,
    secs_per_tick: i64,
) -> Result<()> {
    validate_beef_params(sat_lamports, secs_per_tick)?;
    let bc = &mut ctx.accounts.beef_config;
    bc.max_round_mint = max_round_mint;
    bc.sat_lamports = sat_lamports;
    bc.tick_bps = tick_bps;
    bc.bonus_cap_bps = bonus_cap_bps;
    bc.activity_window_secs = activity_window_secs;
    bc.secs_per_tick = secs_per_tick;
    Ok(())
}

#[derive(Accounts)]
#[instruction(round_id: u64)]
pub struct StampBeef<'info> {
    // Permissionless: the payer just funds BeefRound rent. Emission is
    // deterministic from the frozen round + config (nothing an attacker
    // controls) — the stamp mints the exact per-round emission.
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.config_bump)]
    pub config: Box<Account<'info, Config>>,

    #[account(seeds = [ROUND_SEED, round_id.to_le_bytes().as_ref()], bump = round.bump,
        constraint = round.round_id == round_id @ AnsemError::MinerRoundMismatch)]
    pub round: Box<Account<'info, Round>>,

    #[account(mut, seeds = [BEEF_CONFIG_SEED], bump = beef_config.bump)]
    pub beef_config: Box<Account<'info, BeefConfig>>,

    // The BEEF mint — mut because stamp_beef mints this round's emission from it.
    #[account(mut, address = beef_config.beef_mint @ AnsemError::BadBeefVault)]
    pub beef_mint: Box<InterfaceAccount<'info, Mint>>,

    /// CHECK: vault authority PDA — the BEEF mint authority; signs the mint CPI.
    #[account(seeds = [VAULT_AUTH_SEED], bump = config.vault_auth_bump)]
    pub vault_authority: UncheckedAccount<'info>,

    // Players' 80% is minted into the emission buffer (roll_beef splits it out).
    #[account(mut, address = beef_config.beef_vault @ AnsemError::BadBeefVault)]
    pub beef_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    // Treasury's 20% is minted straight here.
    #[account(mut, address = beef_config.beef_treasury @ AnsemError::BadBeefVault)]
    pub beef_treasury: Box<InterfaceAccount<'info, TokenAccount>>,

    // `init` (not init_if_needed) = the once-only stamp guard.
    #[account(init, payer = payer, space = 8 + BeefRound::INIT_SPACE,
        seeds = [BEEF_ROUND_SEED, round_id.to_le_bytes().as_ref()], bump)]
    pub beef_round: Box<Account<'info, BeefRound>>,

    pub token_program: Interface<'info, TokenInterface>,
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

    // Read config scalars up front — no borrow of beef_config is held across the
    // mint CPIs. Emission = pot-scaled decayed curve, clamped to the cap remainder
    // (belt-and-suspenders: the decay factor makes overshoot near-impossible, but
    // the clamp guards integer rounding at the very last dust of the cap).
    let pot = round.pot;
    let bc = &ctx.accounts.beef_config;
    let total = math::beef_emission(pot, bc.max_round_mint, bc.sat_lamports, bc.minted_total, bc.hard_cap)
        .min(bc.hard_cap.saturating_sub(bc.minted_total));
    let treasury_cut = (total as u128 * bc.treasury_bps as u128 / 10_000u128) as u64;
    let players = total - treasury_cut;
    let vault_auth_bump = ctx.accounts.config.vault_auth_bump;

    // vault_authority PDA is the mint authority; it signs both mint CPIs.
    // NOTE: anchor-lang 1.0.2's CpiContext takes the program ID (.key()), matching
    // every other CPI in this repo (swap.rs / claim_beef / sweep.rs).
    let va_seeds: &[&[u8]] = &[VAULT_AUTH_SEED, &[vault_auth_bump]];
    if players > 0 {
        token_interface::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                MintTo {
                    mint: ctx.accounts.beef_mint.to_account_info(),
                    to: ctx.accounts.beef_vault.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                },
                &[va_seeds],
            ),
            players,
        )?;
    }
    if treasury_cut > 0 {
        token_interface::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                MintTo {
                    mint: ctx.accounts.beef_mint.to_account_info(),
                    to: ctx.accounts.beef_treasury.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                },
                &[va_seeds],
            ),
            treasury_cut,
        )?;
    }

    let br = &mut ctx.accounts.beef_round;
    br.round_id = round_id;
    br.emission = players; // roll_beef splits only the players' share
    br.bump = ctx.bumps.beef_round;

    let bc = &mut ctx.accounts.beef_config;
    // minted_total counts BOTH shares (cap accounting); total_owed tracks only the
    // players' claimable liability (buffered in the vault, drawn by claim_beef).
    bc.minted_total = bc.minted_total.checked_add(total).ok_or(AnsemError::Overflow)?;
    bc.total_owed = bc.total_owed.checked_add(players).ok_or(AnsemError::Overflow)?;
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
    pub beef_mint: Box<InterfaceAccount<'info, Mint>>,

    /// CHECK: same vault authority PDA that signs ANSEM payouts.
    #[account(seeds = [VAULT_AUTH_SEED], bump)]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(mut, address = beef_config.beef_vault @ AnsemError::BadBeefVault)]
    pub beef_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(init_if_needed, payer = authority,
        associated_token::mint = beef_mint, associated_token::authority = authority,
        associated_token::token_program = token_program)]
    pub player_beef_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn claim_beef_handler(ctx: Context<ClaimBeef>) -> Result<()> {
    // transfer_checked needs the mint decimals; scalar copy up front (Token-2022 shape).
    let beef_decimals = ctx.accounts.beef_mint.decimals;
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
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.beef_vault.to_account_info(),
                    mint: ctx.accounts.beef_mint.to_account_info(),
                    to: ctx.accounts.player_beef_ata.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                },
                &[va_seeds],
            ),
            payout,
            beef_decimals,
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
