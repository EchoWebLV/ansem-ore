use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::AnsemError;
use crate::math;
use crate::state::{Config, Round, STATE_OPEN, STATE_SETTLED};

#[derive(Accounts)]
pub struct Settle<'info> {
    pub admin: Signer<'info>,

    #[account(
        seeds = [CONFIG_SEED], bump = config.config_bump,
        constraint = config.admin == admin.key() @ AnsemError::Unauthorized
    )]
    pub config: Account<'info, Config>,

    #[account(mut, seeds = [ROUND_SEED, round.round_id.to_le_bytes().as_ref()], bump = round.bump)]
    pub round: Account<'info, Round>,
}

pub fn settle_handler(ctx: Context<Settle>, randomness: [u8; 32]) -> Result<()> {
    let round = &mut ctx.accounts.round;
    require!(round.state == STATE_OPEN, AnsemError::BadRoundState);
    let now = Clock::get()?.unix_timestamp;
    require!(now >= round.deadline_ts, AnsemError::RoundNotEnded);

    round.randomness = randomness;
    round.jackpot_square = math::jackpot_block(&randomness, b"jackpot");
    round.state = STATE_SETTLED;
    Ok(())
}
