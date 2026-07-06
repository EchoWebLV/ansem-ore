use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::AnsemError;
use crate::state::{Config, Round, STATE_OPEN};

#[derive(Accounts)]
pub struct CreateRound<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(mut, seeds = [CONFIG_SEED], bump = config.config_bump)]
    pub config: Account<'info, Config>,

    #[account(
        init, payer = payer, space = 8 + Round::INIT_SPACE,
        seeds = [ROUND_SEED, (config.current_round_id + 1).to_le_bytes().as_ref()], bump
    )]
    pub round: Account<'info, Round>,

    pub system_program: Program<'info, System>,
}

pub fn create_round_handler(ctx: Context<CreateRound>) -> Result<()> {
    let cfg = &mut ctx.accounts.config;
    // Serialize rounds: the newest round must be finalized (Claimable/Closed)
    // before a new one can open. (current_round_id == 0 => no round yet, and
    // initialize sets current_round_finalized = true, so the first round passes.)
    require!(cfg.current_round_finalized, AnsemError::PriorRoundNotSettled);
    let new_id = cfg.current_round_id.checked_add(1).ok_or(AnsemError::Overflow)?;
    cfg.current_round_id = new_id;
    // The new round is Open and therefore not finalized.
    cfg.current_round_finalized = false;

    let now = Clock::get()?.unix_timestamp;
    let r = &mut ctx.accounts.round;
    r.round_id = new_id;
    r.deadline_ts = now + cfg.round_duration_secs;
    r.block_sol = [0u64; GRID_SIZE];
    r.pot = 0;
    r.state = STATE_OPEN;
    r.randomness = [0u8; 32];
    r.small_jackpot_hit = false;
    r.small_jackpot_block = 0;
    r.small_jackpot_pool = 0;
    r.big_jackpot_hit = false;
    r.big_jackpot_block = 0;
    r.big_jackpot_pool = 0;
    r.swap_proceeds = 0;
    r.bump = ctx.bumps.round;
    Ok(())
}
