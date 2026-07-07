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
