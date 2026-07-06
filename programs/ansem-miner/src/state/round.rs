use anchor_lang::prelude::*;
use crate::constants::GRID_SIZE;

pub const STATE_OPEN: u8 = 0;
pub const STATE_VRF_PENDING: u8 = 1; // reserved for M2
pub const STATE_SETTLED: u8 = 2;
pub const STATE_SWAPPING: u8 = 3;    // reserved for mainnet
pub const STATE_CLAIMABLE: u8 = 4;
pub const STATE_CLOSED: u8 = 5;

#[account]
#[derive(InitSpace)]
pub struct Round {
    pub round_id: u64,
    pub deadline_ts: i64,
    pub block_sol: [u64; GRID_SIZE],
    pub pot: u64,
    pub state: u8,
    pub randomness: [u8; 32],
    pub jackpot_hit: bool,
    pub jackpot_block: u8,
    pub swap_proceeds: u64,
    pub bump: u8,
}
