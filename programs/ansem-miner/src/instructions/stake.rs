use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::AnsemError;
use crate::state::{Config, MinerPosition, PlayerEscrow, Round, STATE_OPEN};

#[derive(Accounts)]
pub struct Stake<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(mut, seeds = [CONFIG_SEED], bump = config.config_bump)]
    pub config: Account<'info, Config>,

    #[account(mut, seeds = [ROUND_SEED, round.round_id.to_le_bytes().as_ref()], bump = round.bump)]
    pub round: Account<'info, Round>,

    #[account(
        mut, seeds = [MINER_SEED, authority.key().as_ref()], bump = miner.bump,
        constraint = miner.authority == authority.key() @ AnsemError::Unauthorized
    )]
    pub miner: Account<'info, MinerPosition>,

    #[account(
        mut, seeds = [ESCROW_SEED, authority.key().as_ref()], bump = escrow.bump,
        constraint = escrow.authority == authority.key() @ AnsemError::Unauthorized
    )]
    pub escrow: Account<'info, PlayerEscrow>,
}

pub fn handler(ctx: Context<Stake>, block: u8, amount: u64) -> Result<()> {
    require!((block as usize) < GRID_SIZE, AnsemError::BadBlock);

    let min_stake = ctx.accounts.config.min_stake;
    let max_stake_per_round = ctx.accounts.config.max_stake_per_round;

    let round = &mut ctx.accounts.round;
    let miner = &mut ctx.accounts.miner;
    let escrow = &mut ctx.accounts.escrow;

    require!(round.state == STATE_OPEN, AnsemError::RoundNotOpen);
    let now = Clock::get()?.unix_timestamp;
    require!(now < round.deadline_ts, AnsemError::RoundEnded);
    require!(amount >= min_stake, AnsemError::StakeTooSmall);
    require!(amount <= escrow.balance, AnsemError::InsufficientBalance);

    // reset persistent miner position for a new round (must have claimed prior)
    if miner.round_id != round.round_id {
        require!(escrow.active_round == 0, AnsemError::UnclaimedRound);
        miner.block_stake = [0u64; GRID_SIZE];
        miner.round_id = round.round_id;
        escrow.active_round = round.round_id;
    }

    // per-round cap
    let prior: u64 = miner.block_stake.iter().sum();
    require!(prior + amount <= max_stake_per_round, AnsemError::StakeTooLarge);

    miner.block_stake[block as usize] = miner.block_stake[block as usize]
        .checked_add(amount).ok_or(AnsemError::Overflow)?;
    round.block_sol[block as usize] = round.block_sol[block as usize]
        .checked_add(amount).ok_or(AnsemError::Overflow)?;
    round.pot = round.pot.checked_add(amount).ok_or(AnsemError::Overflow)?;
    escrow.balance -= amount;

    // `amount` moves from idle escrow into this round's pot within the same
    // physical pot_vault; it is no longer an outstanding escrow liability
    // (it is now owed to this round's stakers via round.pot instead).
    ctx.accounts.config.total_escrow_balance = ctx.accounts.config.total_escrow_balance
        .checked_sub(amount).ok_or(AnsemError::Overflow)?;
    Ok(())
}
