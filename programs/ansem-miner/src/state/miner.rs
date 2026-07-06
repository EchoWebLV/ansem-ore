use anchor_lang::prelude::*;
use crate::constants::GRID_SIZE;

#[account]
#[derive(InitSpace)]
pub struct MinerPosition {
    pub authority: Pubkey,
    pub round_id: u64,
    pub block_stake: [u64; GRID_SIZE],
    pub bump: u8,
}
