use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::AnsemError;
use crate::state::Config;

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
