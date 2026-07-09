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
