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
    // Two independent jackpot tiers. `*_pool` is the payout pool SNAPSHOT frozen
    // at swap time (vault.amount * tier_bps / 10_000); every claimant divides
    // against this fixed value, never the live vault balance, so payouts are
    // order-independent. Mirrors how swap_proceeds is snapshotted. See spec §2.
    pub small_jackpot_hit: bool,
    pub small_jackpot_block: u8,
    pub small_jackpot_pool: u64,
    pub big_jackpot_hit: bool,
    pub big_jackpot_block: u8,
    pub big_jackpot_pool: u64,
    pub swap_proceeds: u64,
    pub bump: u8,
}
