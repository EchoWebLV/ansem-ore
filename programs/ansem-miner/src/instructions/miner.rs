use anchor_lang::prelude::*;

use crate::constants::*;
use crate::state::MinerPosition;

#[derive(Accounts)]
pub struct InitMiner<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init, payer = authority, space = 8 + MinerPosition::INIT_SPACE,
        seeds = [MINER_SEED, authority.key().as_ref()], bump
    )]
    pub miner: Account<'info, MinerPosition>,

    pub system_program: Program<'info, System>,
}

pub fn init_miner_handler(ctx: Context<InitMiner>) -> Result<()> {
    let m = &mut ctx.accounts.miner;
    m.authority = ctx.accounts.authority.key();
    m.round_id = 0;
    m.block_stake = [0u64; GRID_SIZE];
    m.bump = ctx.bumps.miner;
    Ok(())
}
