use anchor_lang::prelude::*;

#[error_code]
pub enum AnsemError {
    #[msg("Numeric overflow")] Overflow,
    #[msg("Block index out of range (0..25)")] BadBlock,
    #[msg("Round is not open")] RoundNotOpen,
    #[msg("Round deadline has not passed")] RoundNotEnded,
    #[msg("Round deadline has passed")] RoundEnded,
    #[msg("Round is not in the required state")] BadRoundState,
    #[msg("Stake below minimum")] StakeTooSmall,
    #[msg("Stake exceeds per-round maximum")] StakeTooLarge,
    #[msg("Insufficient escrow balance")] InsufficientBalance,
    #[msg("Must claim previous round before staking a new one")] UnclaimedRound,
    #[msg("Round already claimed by this player")] AlreadyClaimed,
    #[msg("Cannot withdraw with an active unclaimed round")] WithdrawLocked,
    #[msg("Swap mode mismatch")] WrongSwapMode,
    #[msg("Unauthorized")] Unauthorized,
    #[msg("MinerPosition round mismatch")] MinerRoundMismatch,
}
