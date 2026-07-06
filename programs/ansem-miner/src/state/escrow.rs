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
    // Last round reconcile_miner debited for this player. Idempotency /
    // double-debit guard that lives on the escrow (which we own) rather than on
    // the MinerPosition — after commit-only the miner is DLP-owned on L1 and our
    // program cannot write to it. reconcile debits only when reconciled_round !=
    // the round being reconciled.
    pub reconciled_round: u64,
    pub bump: u8,
}
