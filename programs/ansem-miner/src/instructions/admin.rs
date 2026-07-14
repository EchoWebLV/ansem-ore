use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::AnsemError;
use crate::state::{Config, JackpotConfig};

#[derive(Accounts)]
pub struct SetParams<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.config_bump,
        constraint = config.admin == admin.key() @ AnsemError::Unauthorized)]
    pub config: Account<'info, Config>,
}

pub fn set_round_duration(ctx: Context<SetParams>, secs: i64) -> Result<()> {
    ctx.accounts.config.round_duration_secs = secs;
    Ok(())
}

// The fee dial promised in the design (spec D5): fee currently needs a program
// upgrade to change (there was no setter). Launch sets 500 bps (5%). Hard-capped
// at 2000 bps (20%) so a mis-set can never confiscate more than a fifth of a pot
// (execute_swap's `pot - fee` also stays safely positive). Admin-gated via SetParams.
pub fn set_fee_bps(ctx: Context<SetParams>, fee_bps: u16) -> Result<()> {
    require!(fee_bps <= 2_000, AnsemError::BadFeeBps);
    ctx.accounts.config.fee_bps = fee_bps;
    Ok(())
}

// ---- Jackpot params PDA (spec D6): random-trigger + bet-scaled cap ----
// A NEW PDA (not Config — the live mainnet Config must not change size). init_jackpot_config
// must run in the SAME sitting as the program upgrade: swaps FAIL until it exists.
#[derive(Accounts)]
pub struct InitJackpotConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.config_bump,
        constraint = config.admin == admin.key() @ AnsemError::Unauthorized)]
    pub config: Account<'info, Config>,
    #[account(init, payer = admin, space = 8 + JackpotConfig::INIT_SPACE,
        seeds = [JACKPOT_CONFIG_SEED], bump)]
    pub jackpot_config: Account<'info, JackpotConfig>,
    pub system_program: Program<'info, System>,
}

pub fn init_jackpot_config(ctx: Context<InitJackpotConfig>) -> Result<()> {
    let jc = &mut ctx.accounts.jackpot_config;
    jc.trigger_odds = DEFAULT_JACKPOT_TRIGGER_ODDS; // 1-in-25
    jc.cap_mult = DEFAULT_JACKPOT_CAP_MULT; // 100x winning-square stake value
    jc.bump = ctx.bumps.jackpot_config;
    Ok(())
}

#[derive(Accounts)]
pub struct SetJackpotParams<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.config_bump,
        constraint = config.admin == admin.key() @ AnsemError::Unauthorized)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [JACKPOT_CONFIG_SEED], bump = jackpot_config.bump)]
    pub jackpot_config: Account<'info, JackpotConfig>,
}

// Tune the trigger odds + bite cap with data. trigger_odds 0|1 restores the legacy
// full-drain-every-winner behavior; cap_mult 0 = uncapped bite. Admin-gated.
pub fn set_jackpot_params(ctx: Context<SetJackpotParams>, trigger_odds: u16, cap_mult: u16) -> Result<()> {
    let jc = &mut ctx.accounts.jackpot_config;
    jc.trigger_odds = trigger_odds;
    jc.cap_mult = cap_mult;
    Ok(())
}

/// Set the per-square RETURN band (bps). `(0, 0)` => every non-jackpot square
/// returns 0% => the whole pot (plus rollover) goes to the jackpot square — the
/// max-variance / all-to-jackpot mode. Capped at `RETURN_MAX_BPS` so non-jackpot
/// returns can never exceed 50% (i.e. the jackpot is always >= half the pot).
pub fn set_return_band(ctx: Context<SetParams>, min_bps: u16, max_bps: u16) -> Result<()> {
    require!(
        min_bps <= max_bps && max_bps <= RETURN_MAX_BPS,
        AnsemError::BadReturnBand
    );
    ctx.accounts.config.mult_min_bps = min_bps;
    ctx.accounts.config.mult_max_bps = max_bps;
    Ok(())
}

// Set the execute_swap_real payout floor. `ansem_out` must be >= net_lamports *
// min_swap_rate / LAMPORTS_PER_SOL; 0 disables the check. The launch script derives
// it from a live Jupiter quote (×0.7) so a compromised keeper can never settle a
// round paying out far below market. Admin-gated via SetParams.
pub fn set_min_swap_rate(ctx: Context<SetParams>, rate: u64) -> Result<()> {
    ctx.accounts.config.min_swap_rate = rate;
    Ok(())
}

// Set the claim window (seconds after a round's deadline during which claims stay
// open; close_round refuses to reap a CLAIMABLE round any earlier). No floor: devnet
// soak + these tests use tiny windows, while the mainnet launch script sets 86_400
// (ORE's ONE_DAY forfeit precedent). Admin-gated via SetParams.
pub fn set_claim_window(ctx: Context<SetParams>, secs: i64) -> Result<()> {
    require!(secs >= 0, AnsemError::BadBeefParams);
    ctx.accounts.config.claim_window_secs = secs;
    Ok(())
}

// Launch cap tuner. min_stake / max_stake_per_round are otherwise frozen at
// initialize (0.01 / 100 SOL defaults); the launch policy caps max at 1 SOL and
// must be retunable WITHOUT a program upgrade — this is that knob. Enforces the
// invariant stake_direct depends on (0 < min <= max) so a bad bound can never
// brick staking (min > max would reject every stake; max == 0 the same). Admin-
// gated via SetParams.
pub fn set_stake_limits(
    ctx: Context<SetParams>,
    min_stake: u64,
    max_stake_per_round: u64,
) -> Result<()> {
    require!(
        min_stake <= max_stake_per_round && max_stake_per_round > 0,
        AnsemError::BadStakeBounds
    );
    let cfg = &mut ctx.accounts.config;
    cfg.min_stake = min_stake;
    cfg.max_stake_per_round = max_stake_per_round;
    Ok(())
}

// Admin-only migration/dev tool: close the Config PDA (rent -> admin) so a fresh
// `initialize` can run after a state-layout change (e.g. the M4b lottery redesign
// made the old on-chain Config binary-incompatible on devnet). `bump` is
// RECOMPUTED (not read from `config.config_bump`) so this also works on a Config
// written under the OLD struct layout, where that field sits at a different offset.
// DEVNET/TEST ONLY — this must be removed or hard-gated before any mainnet deploy,
// since it lets the admin wipe live game state.
#[derive(Accounts)]
pub struct CloseConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(mut, close = admin, seeds = [CONFIG_SEED], bump,
        constraint = config.admin == admin.key() @ AnsemError::Unauthorized)]
    pub config: Account<'info, Config>,
}

pub fn close_config(_ctx: Context<CloseConfig>) -> Result<()> {
    Ok(())
}

// Admin-only migration/dev tool: fast-forward the round cursor. A `close_config` +
// fresh `initialize` resets `current_round_id` to 0, but historical Round PDAs from
// earlier devnet runs still occupy the low ids and collide with `create_round`'s
// strict `init` ("account already in use"). Setting the cursor past them (e.g. to the
// current slot) makes the next `create_round` allocate a never-used id. Also marks the
// (nonexistent) current round finalized so a fresh round can open immediately.
// DEVNET/TEST ONLY — must be removed or hard-gated before any mainnet deploy, since it
// lets the admin skip or rewind the live round counter.
pub fn set_round_cursor(ctx: Context<SetParams>, new_id: u64) -> Result<()> {
    let cfg = &mut ctx.accounts.config;
    cfg.current_round_id = new_id;
    cfg.current_round_finalized = true;
    Ok(())
}
