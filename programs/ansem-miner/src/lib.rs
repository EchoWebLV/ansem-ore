use anchor_lang::prelude::*;

pub mod constants;
pub mod error;
pub mod math;
pub mod state;
pub mod instructions;

use instructions::*;
use ephemeral_rollups_sdk::anchor::ephemeral;

declare_id!("8Q9EnK7ydn6ywo7ZxeqhubqYybf7FFNNwnz8JzJjXZjz");

// #[ephemeral] auto-injects `process_undelegation` + `InitializeAfterUndelegation`
// so delegated Round/MinerPosition PDAs can be undelegated back to L1.
#[ephemeral]
#[program]
pub mod ansem_miner {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        instructions::initialize::initialize_handler(ctx)
    }

    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        instructions::escrow::deposit(ctx, amount)
    }

    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        instructions::escrow::withdraw(ctx, amount)
    }

    pub fn create_round(ctx: Context<CreateRound>) -> Result<()> {
        instructions::round::create_round_handler(ctx)
    }

    pub fn init_miner(ctx: Context<InitMiner>) -> Result<()> {
        instructions::miner::init_miner_handler(ctx)
    }

    pub fn stake(ctx: Context<Stake>, block: u8, amount: u64) -> Result<()> {
        instructions::stake::stake_handler(ctx, block, amount)
    }

    pub fn settle(ctx: Context<Settle>, randomness: [u8; 32]) -> Result<()> {
        instructions::settle::settle_handler(ctx, randomness)
    }

    pub fn set_round_duration(ctx: Context<SetParams>, secs: i64) -> Result<()> {
        instructions::admin::set_round_duration(ctx, secs)
    }

    pub fn set_small_jackpot_odds(ctx: Context<SetParams>, odds: u32) -> Result<()> {
        instructions::admin::set_small_jackpot_odds(ctx, odds)
    }

    pub fn set_big_jackpot_odds(ctx: Context<SetParams>, odds: u32) -> Result<()> {
        instructions::admin::set_big_jackpot_odds(ctx, odds)
    }

    pub fn seed_small_jackpot(ctx: Context<SeedSmallJackpot>, amount: u64) -> Result<()> {
        instructions::admin::seed_small_jackpot(ctx, amount)
    }

    pub fn seed_big_jackpot(ctx: Context<SeedBigJackpot>, amount: u64) -> Result<()> {
        instructions::admin::seed_big_jackpot(ctx, amount)
    }

    pub fn execute_swap_mock(ctx: Context<ExecuteSwapMock>) -> Result<()> {
        instructions::swap::execute_swap_mock_handler(ctx)
    }

    pub fn claim(ctx: Context<Claim>, round_id: u64) -> Result<()> {
        instructions::claim::claim_handler(ctx, round_id)
    }

    pub fn cancel_round(ctx: Context<CancelRound>) -> Result<()> {
        instructions::recovery::cancel_round_handler(ctx)
    }

    pub fn refund(ctx: Context<Refund>, round_id: u64) -> Result<()> {
        instructions::recovery::refund_handler(ctx, round_id)
    }

    // ---- M2a: ER delegation lifecycle ----
    pub fn delegate_round(ctx: Context<DelegateRound>, round_id: u64) -> Result<()> {
        instructions::delegation::delegate_round_handler(ctx, round_id)
    }

    pub fn delegate_miner(ctx: Context<DelegateMiner>) -> Result<()> {
        instructions::delegation::delegate_miner_handler(ctx)
    }
}
