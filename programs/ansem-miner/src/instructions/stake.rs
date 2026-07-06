use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::AnsemError;
use crate::state::{Config, MinerPosition, PlayerEscrow, Round, STATE_OPEN};

#[derive(Accounts)]
pub struct Stake<'info> {
    // NOT `mut`: the handler never mutates the signer, and on the ER the Magic
    // program rejects any writable account that is neither delegated nor the
    // fee payer (InvalidWritableAccount). When the player is also the fee payer
    // (production self-pay), the tx marks them writable automatically anyway.
    pub authority: Signer<'info>,

    // Read-only clone in the ER — used only to read caps/budget, never written.
    #[account(seeds = [CONFIG_SEED], bump = config.config_bump)]
    pub config: Account<'info, Config>,

    // Delegated in the ER (writable there).
    #[account(mut, seeds = [ROUND_SEED, round.round_id.to_le_bytes().as_ref()], bump = round.bump)]
    pub round: Account<'info, Round>,

    // Delegated in the ER (writable there).
    #[account(
        mut, seeds = [MINER_SEED, authority.key().as_ref()], bump = miner.bump,
        constraint = miner.authority == authority.key() @ AnsemError::Unauthorized
    )]
    pub miner: Account<'info, MinerPosition>,

    // Read-only clone — soft budget check only (no `mut`; no debit here).
    #[account(
        seeds = [ESCROW_SEED, authority.key().as_ref()], bump = escrow.bump,
        constraint = escrow.authority == authority.key() @ AnsemError::Unauthorized
    )]
    pub escrow: Account<'info, PlayerEscrow>,
}

pub fn stake_handler(ctx: Context<Stake>, block: u8, amount: u64) -> Result<()> {
    require!((block as usize) < GRID_SIZE, AnsemError::BadBlock);

    let min_stake = ctx.accounts.config.min_stake;
    let max_stake_per_round = ctx.accounts.config.max_stake_per_round;
    let escrow_balance = ctx.accounts.escrow.balance;
    let escrow_active_round = ctx.accounts.escrow.active_round;

    let round = &mut ctx.accounts.round;
    let miner = &mut ctx.accounts.miner;

    require!(round.state == STATE_OPEN, AnsemError::RoundNotOpen);
    // Must have joined THIS round on L1 first (soft check against the read-only
    // escrow clone). Beyond enforcing join-before-stake, this closes a
    // self-inflicted under-debit: once reconcile_miner clears active_round, a
    // player cannot re-stake into the same round and dodge the escrow debit
    // (reconciled_round would skip the second debit).
    require!(escrow_active_round == round.round_id, AnsemError::NotCurrentRound);
    let now = Clock::get()?.unix_timestamp;
    require!(now < round.deadline_ts, AnsemError::RoundEnded);
    require!(amount >= min_stake, AnsemError::StakeTooSmall);

    // New-round entry: reset the persistent miner. The L1 `join_round` already
    // set escrow.active_round and enforced "prior round reconciled/clean", so
    // the ER path does NOT read/write escrow. (Reconciliation is tracked on the
    // escrow's reconciled_round, set by the L1 reconcile_miner.)
    if miner.round_id != round.round_id {
        miner.block_stake = [0u64; GRID_SIZE];
        miner.round_id = round.round_id;
    }

    // Per-round cap AND soft budget check against the (read-only) escrow clone.
    // The clone can be slightly stale, but escrow.balance only decreases via
    // withdraw — which is locked all round by active_round — so it is a safe
    // upper bound. The HARD accounting is L1 reconcile_miner.
    let prior: u64 = miner.block_stake.iter().sum();
    let new_total = prior.checked_add(amount).ok_or(AnsemError::Overflow)?;
    require!(new_total <= max_stake_per_round, AnsemError::StakeTooLarge);
    require!(new_total <= escrow_balance, AnsemError::InsufficientBalance);

    miner.block_stake[block as usize] =
        miner.block_stake[block as usize].checked_add(amount).ok_or(AnsemError::Overflow)?;
    round.block_sol[block as usize] =
        round.block_sol[block as usize].checked_add(amount).ok_or(AnsemError::Overflow)?;
    round.pot = round.pot.checked_add(amount).ok_or(AnsemError::Overflow)?;
    // NOTE: escrow debit + total_escrow_balance decrement intentionally removed —
    // relocated to L1 reconcile_miner (see round_entry.rs).
    Ok(())
}
