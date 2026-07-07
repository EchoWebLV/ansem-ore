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
use crate::error::AnsemError;
use crate::state::{Config, MinerPosition, Round, STATE_OPEN};

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
    // AUTHORIZATION (§3B): keeper-only. Without this, delegate_round is
    // permissionless and anyone can transfer the Round PDA to the DLP pinned to
    // a validator they choose, freezing every L1 instruction on it (settle,
    // swap, cancel, claim) — for the current round OR any past CLAIMABLE round.
    #[account(seeds = [CONFIG_SEED], bump = config.config_bump,
        constraint = config.admin == payer.key() @ AnsemError::Unauthorized)]
    pub config: Account<'info, Config>,
    /// CHECK: delegated via the DLP CPI; UncheckedAccount avoids Anchor
    /// re-serializing after ownership transfers to the delegation program.
    #[account(mut, del, seeds = [ROUND_SEED, round_id.to_le_bytes().as_ref()], bump)]
    pub round: UncheckedAccount<'info>,
}

pub fn delegate_round_handler(ctx: Context<DelegateRound>, round_id: u64) -> Result<()> {
    // Defense-in-depth: only the CURRENT, still-OPEN round may be delegated — a
    // stale/past/already-settled round can never be handed to the DLP. The Round
    // is still program-owned here (pre-delegation), so we can read it. The borrow
    // is scoped so it is dropped before the delegate CPI touches the account.
    {
        let data = ctx.accounts.round.try_borrow_data()?;
        let r = Round::try_deserialize(&mut &data[..])?;
        require!(r.state == STATE_OPEN, AnsemError::BadRoundState);
        require!(r.round_id == ctx.accounts.config.current_round_id, AnsemError::NotCurrentRound);
    }

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
// The persistent MinerPosition is delegated at the start of each round (it is
// commit-AND-undelegated back to L1 at round end so reconcile_miner/claim can
// read it as a normal Account — see task 6). The account itself persists across
// rounds; only its delegation toggles.
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
    // AUTHORIZATION: admin-only (the round manager, consistent with M2a's
    // admin-trust model — admin also injects settle randomness). config is a
    // read-only clone on the ER. Without this, commit_round is permissionless
    // and an attacker could force-commit (undelegate) a live round mid-staking,
    // ending it for every player. `payer` is the ER fee payer, so admin-as-payer
    // is writable-safe.
    #[account(seeds = [CONFIG_SEED], bump = config.config_bump,
        constraint = config.admin == payer.key() @ AnsemError::Unauthorized)]
    pub config: Account<'info, Config>,
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
    // AUTHORIZATION (§3A): permissionless like `reconcile_miner` — any `payer`
    // (the keeper) can commit ANY miner, but ONLY once the round has left OPEN
    // (see the handler gate), so staking is closed and the block_stake snapshot
    // is final. Self-referential seeds mean no owner signature is needed.
    #[account(mut, seeds = [MINER_SEED, miner.authority.as_ref()], bump = miner.bump)]
    pub miner: Account<'info, MinerPosition>,
    // Read-only gate account: the round the miner staked. Still delegated and
    // available on the ER because commit_miner runs BEFORE commit_round. Used
    // only to prove staking is closed.
    #[account(seeds = [ROUND_SEED, miner.round_id.to_le_bytes().as_ref()], bump = round.bump)]
    pub round: Account<'info, Round>,
}

pub fn commit_miner_handler(ctx: Context<CommitMiner>) -> Result<()> {
    // Gate: staking must be closed. `stake` requires STATE_OPEN && now < deadline,
    // so a non-OPEN round guarantees the block_stake snapshot is final. This also
    // blocks the mid-round force-commit the removed owner-signature used to block.
    require!(
        ctx.accounts.round.round_id == ctx.accounts.miner.round_id,
        AnsemError::MinerRoundMismatch
    );
    require!(ctx.accounts.round.state != STATE_OPEN, AnsemError::CommitTooEarly);

    MagicIntentBundleBuilder::new(
        ctx.accounts.payer.to_account_info(),
        ctx.accounts.magic_context.to_account_info(),
        ctx.accounts.magic_program.to_account_info(),
    )
    .commit_and_undelegate(&[ctx.accounts.miner.to_account_info()])
    .build_and_invoke()?;
    Ok(())
}
