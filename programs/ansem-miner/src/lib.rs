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
        instructions::initialize::handler(ctx)
    }

    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        instructions::escrow::deposit(ctx, amount)
    }

    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        instructions::escrow::withdraw(ctx, amount)
    }

    pub fn create_round(ctx: Context<CreateRound>) -> Result<()> {
        instructions::round::handler(ctx)
    }

    pub fn init_miner(ctx: Context<InitMiner>) -> Result<()> {
        instructions::miner::handler(ctx)
    }

    pub fn stake(ctx: Context<Stake>, block: u8, amount: u64) -> Result<()> {
        instructions::stake::handler(ctx, block, amount)
    }

    pub fn settle(ctx: Context<Settle>, randomness: [u8; 32]) -> Result<()> {
        instructions::settle::handler(ctx, randomness)
    }

    pub fn set_round_duration(ctx: Context<SetParams>, secs: i64) -> Result<()> {
        instructions::admin::set_round_duration(ctx, secs)
    }

    pub fn execute_swap_mock(ctx: Context<ExecuteSwapMock>) -> Result<()> {
        instructions::swap::handler(ctx)
    }

    // Test-support seam (M1 only): see instructions/admin.rs for rationale.
    // Lets integration tests simulate an externally-drained pot_vault so the
    // Insolvent guard in execute_swap_mock can be proven to actually revert.
    pub fn debug_drain_pot_vault(ctx: Context<DebugDrainPotVault>, amount: u64) -> Result<()> {
        instructions::admin::debug_drain_pot_vault(ctx, amount)
    }
}
