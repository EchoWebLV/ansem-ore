// L1 round-entry accounting: join_round (up-front withdraw-lock) + reconcile_miner
// (debit escrow from the committed block_stake snapshot; single lock-release).
// Populated by M2a tasks 4 and 7.
use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::AnsemError;
use crate::state::{Config, PlayerEscrow};

// ---- Task 4: join_round (L1) ----
// Runs on L1 while `round` is delegated, so it must NOT touch the `round`
// account (reading a delegated account on L1 is unreliable). It validates the
// caller is entering the current round with a clean escrow, sets the withdraw
// lock (escrow.active_round), and performs NO balance change — the debit is
// relocated to reconcile_miner (task 7), from the committed block_stake
// snapshot. `withdraw` already refuses when active_round != 0, so this closes
// the withdraw-mid-round hole. The lock is released by reconcile_miner (the
// single release point), which handles both stakers and join-without-stake
// players, so no joiner can get permanently locked.
#[derive(Accounts)]
#[instruction(round_id: u64)]
pub struct JoinRound<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.config_bump)]
    pub config: Account<'info, Config>,
    #[account(
        mut, seeds = [ESCROW_SEED, authority.key().as_ref()], bump = escrow.bump,
        constraint = escrow.authority == authority.key() @ AnsemError::Unauthorized
    )]
    pub escrow: Account<'info, PlayerEscrow>,
}

pub fn join_round_handler(ctx: Context<JoinRound>, round_id: u64) -> Result<()> {
    let cfg = &ctx.accounts.config;
    require!(round_id == cfg.current_round_id, AnsemError::NotCurrentRound);
    let min_stake = cfg.min_stake;

    let escrow = &mut ctx.accounts.escrow;
    // Prior round must be fully reconciled/claimed before joining a new one.
    require!(escrow.active_round == 0, AnsemError::RoundAlreadyJoined);
    require!(escrow.balance >= min_stake, AnsemError::InsufficientBalance);
    // Up-front withdraw-lock; NO debit (the debit happens on L1 reconcile_miner
    // after the ER round commits, from the committed block_stake snapshot).
    escrow.active_round = round_id;
    Ok(())
}
