use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct PlayerEscrow {
    pub authority: Pubkey,
    pub balance: u64,
    pub deposited_total: u64,
    pub withdrawn_total: u64,
    pub last_claimed_round: u64,
    pub active_round: u64, // round with unclaimed stakes; 0 = none
    pub bump: u8,
}
