// ER delegation lifecycle: delegate_round / delegate_miner (L1) + commit_round /
// commit_miner (ER). Delegation added in tasks 2-3; commits in task 6.
use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::{commit, delegate};
use ephemeral_rollups_sdk::cpi::DelegateConfig;
// FoldableIntentBuilder is the trait that provides `build_and_invoke` on the
// CommitIntentBuilder / CommitAndUndelegateIntentBuilder returned by
// `.commit()` / `.commit_and_undelegate()` — must be in scope to call it.
use ephemeral_rollups_sdk::ephem::{FoldableIntentBuilder, MagicIntentBundleBuilder};

use crate::constants::*;
use crate::state::{MinerPosition, Round};

// ---- Task 2: delegate_round (L1) ----
// Hands the already-inited Round PDA to the delegation program so staking can
// run in the ER. Must be called AFTER create_round (Anchor `init` can't run on a
// delegated account). Optional ER validator pubkey in remaining_accounts[0].
#[delegate]
#[derive(Accounts)]
#[instruction(round_id: u64)]
pub struct DelegateRound<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: delegated via the DLP CPI; UncheckedAccount avoids Anchor
    /// re-serializing after ownership transfers to the delegation program.
    #[account(mut, del, seeds = [ROUND_SEED, round_id.to_le_bytes().as_ref()], bump)]
    pub round: UncheckedAccount<'info>,
}

pub fn delegate_round_handler(ctx: Context<DelegateRound>, round_id: u64) -> Result<()> {
    ctx.accounts.delegate_round(
        &ctx.accounts.payer,
        &[ROUND_SEED, &round_id.to_le_bytes()],
        DelegateConfig {
            validator: ctx.remaining_accounts.first().map(|a| a.key()),
            ..Default::default()
        },
    )?;
    Ok(())
}

// ---- Task 3: delegate_miner (L1) ----
// The persistent MinerPosition is delegated ONCE (after init_miner) and stays
// delegated across rounds (committed each round, never undelegated — see task 6).
#[delegate]
#[derive(Accounts)]
pub struct DelegateMiner<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: delegated via the DLP CPI.
    #[account(mut, del, seeds = [MINER_SEED, payer.key().as_ref()], bump)]
    pub miner: UncheckedAccount<'info>,
}

pub fn delegate_miner_handler(ctx: Context<DelegateMiner>) -> Result<()> {
    let payer_key = ctx.accounts.payer.key();
    ctx.accounts.delegate_miner(
        &ctx.accounts.payer,
        &[MINER_SEED, payer_key.as_ref()],
        DelegateConfig {
            validator: ctx.remaining_accounts.first().map(|a| a.key()),
            ..Default::default()
        },
    )?;
    Ok(())
}

// ---- Task 6: commit_round (ER) — commit AND undelegate ----
// Runs on the ER at round end. `commit_and_undelegate` flushes the Round's final
// state to L1 AND returns ownership to our program so `settle`/`execute_swap_mock`
// /`claim` can mutate it on L1. Pure commit (no mutation this ix) → no
// `round.exit()` needed (that's only for mutate-then-commit in one ix).
// `#[commit]` injects `magic_context` + `magic_program`.
#[commit]
#[derive(Accounts)]
pub struct CommitRound<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [ROUND_SEED, round.round_id.to_le_bytes().as_ref()], bump = round.bump)]
    pub round: Account<'info, Round>,
}

pub fn commit_round_handler(ctx: Context<CommitRound>) -> Result<()> {
    MagicIntentBundleBuilder::new(
        ctx.accounts.payer.to_account_info(),
        ctx.accounts.magic_context.to_account_info(),
        ctx.accounts.magic_program.to_account_info(),
    )
    .commit_and_undelegate(&[ctx.accounts.round.to_account_info()])
    .build_and_invoke()?;
    Ok(())
}

// ---- Task 6: commit_miner (ER) — commit AND undelegate ----
// Flushes the MinerPosition's block_stake snapshot to L1 AND returns ownership
// to our program so reconcile_miner and claim can read it as a normal
// `Account<MinerPosition>` (a committed-but-still-delegated account is DLP-owned
// on L1, which anchor's owner check rejects). The persistent miner is simply
// re-delegated (delegate_miner) at the start of each new round — cheap, and it
// keeps the L1 read path idiomatic. Pure commit → no `miner.exit()`.
#[commit]
#[derive(Accounts)]
pub struct CommitMiner<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [MINER_SEED, miner.authority.as_ref()], bump = miner.bump)]
    pub miner: Account<'info, MinerPosition>,
}

pub fn commit_miner_handler(ctx: Context<CommitMiner>) -> Result<()> {
    MagicIntentBundleBuilder::new(
        ctx.accounts.payer.to_account_info(),
        ctx.accounts.magic_context.to_account_info(),
        ctx.accounts.magic_program.to_account_info(),
    )
    .commit_and_undelegate(&[ctx.accounts.miner.to_account_info()])
    .build_and_invoke()?;
    Ok(())
}
