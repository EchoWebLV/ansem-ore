// L1 round-entry accounting: join_round (up-front withdraw-lock) + reconcile_miner
// (debit escrow from the committed block_stake snapshot; single lock-release).
// Populated by M2a tasks 4 and 7.
use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::AnsemError;
use crate::state::{Config, MinerPosition, PlayerEscrow};

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

// ---- Task 7: reconcile_miner (L1) ----
// Permissionless (pure accounting, mirrors `refund`). Runs on L1 AFTER the ER
// round has committed (commit_miner flushed the block_stake snapshot to L1). It
// is the SINGLE lock-release point: it debits escrow from the committed
// block_stake and clears escrow.active_round for BOTH stakers and
// join-without-stake players — so no joiner can get permanently locked (a
// non-staker who could neither claim (round_id mismatch) nor refund (round not
// cancelled) would otherwise be stuck).
//
// Solvency-safe: after the debit the staked lamports leave total_escrow_balance
// (now backing round.pot instead). The existing execute_swap_mock check
// (pot_vault >= total_escrow_balance + round.pot) therefore refuses the swap
// until EVERY staker is reconciled — an un-reconciled staker makes the check
// stricter, never unsafe. Withdrawing the idle remainder after unlock drops
// pot_vault and total_escrow_balance by the same amount, leaving `available`
// unchanged, so round.pot's backing is never touched.
#[derive(Accounts)]
#[instruction(round_id: u64)]
pub struct ReconcileMiner<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.config_bump)]
    pub config: Account<'info, Config>,
    // Declared before `miner` so the miner PDA seeds can reference its authority.
    #[account(mut, seeds = [ESCROW_SEED, escrow.authority.as_ref()], bump = escrow.bump)]
    pub escrow: Account<'info, PlayerEscrow>,
    /// CHECK: the committed (post commit_miner) MinerPosition snapshot for
    /// `escrow`'s authority. It is an UncheckedAccount — NOT `Account<Miner>` —
    /// because after commit-only the miner is still DLP-owned on L1, so Anchor's
    /// owner check would reject it. We only READ it (manual try_deserialize);
    /// we never write it (a program cannot mutate an account it doesn't own).
    /// The seeds constraint pins it to the correct PDA for this escrow.
    #[account(seeds = [MINER_SEED, escrow.authority.as_ref()], bump)]
    pub miner: UncheckedAccount<'info>,
}

pub fn reconcile_miner_handler(ctx: Context<ReconcileMiner>, round_id: u64) -> Result<()> {
    // Only a genuine joiner of THIS round (join_round set active_round).
    require!(ctx.accounts.escrow.active_round == round_id, AnsemError::NotCurrentRound);

    // Read the committed snapshot without an owner check (miner may be DLP-owned).
    let (staked, staked_this_round) = {
        let data = ctx.accounts.miner.try_borrow_data()?;
        let miner = MinerPosition::try_deserialize(&mut &data[..])?;
        (miner.block_stake.iter().sum::<u64>(), miner.round_id == round_id)
    };

    // Debit only if this player actually staked this round AND hasn't already
    // been reconciled for it (guards the re-join → re-reconcile double-debit).
    // A join-without-stake player falls through with no debit.
    let escrow = &mut ctx.accounts.escrow;
    if staked_this_round && escrow.reconciled_round != round_id {
        escrow.balance = escrow.balance.checked_sub(staked).ok_or(AnsemError::Overflow)?;
        escrow.reconciled_round = round_id;
        let cfg = &mut ctx.accounts.config;
        cfg.total_escrow_balance =
            cfg.total_escrow_balance.checked_sub(staked).ok_or(AnsemError::Overflow)?;
    }

    // Single lock-release point: unlock withdrawal of the idle remainder.
    ctx.accounts.escrow.active_round = 0;
    Ok(())
}
