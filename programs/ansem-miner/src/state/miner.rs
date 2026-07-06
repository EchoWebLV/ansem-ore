use anchor_lang::prelude::*;
use crate::constants::GRID_SIZE;

#[account]
#[derive(InitSpace)]
pub struct MinerPosition {
    pub authority: Pubkey,
    pub round_id: u64,
    pub block_stake: [u64; GRID_SIZE],
    pub bump: u8,
    // Per-round flag: set true by reconcile_miner (L1) once this round's
    // block_stake has been debited from escrow; reset to false when the ER
    // stake handler enters a new round (miner.round_id != round.round_id).
    // Prevents double-debiting escrow for the same round.
    pub reconciled: bool,
}
