use anchor_lang::prelude::*;

pub mod constants;
pub mod error;
pub mod math;
pub mod state;
pub mod instructions;

use instructions::*;

declare_id!("8Q9EnK7ydn6ywo7ZxeqhubqYybf7FFNNwnz8JzJjXZjz");

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

    pub fn set_jackpot_odds(ctx: Context<SetParams>, odds: u32) -> Result<()> {
        instructions::admin::set_jackpot_odds(ctx, odds)
    }

    pub fn seed_jackpot(ctx: Context<SeedJackpot>, amount: u64) -> Result<()> {
        instructions::admin::seed_jackpot(ctx, amount)
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
}
