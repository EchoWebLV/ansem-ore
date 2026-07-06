// ER delegation lifecycle: delegate_round / delegate_miner (L1) + commit_round /
// commit_miner (ER). Delegation added in tasks 2-3; commits in task 6.
use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::delegate;
use ephemeral_rollups_sdk::cpi::DelegateConfig;

use crate::constants::*;

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
