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
}
