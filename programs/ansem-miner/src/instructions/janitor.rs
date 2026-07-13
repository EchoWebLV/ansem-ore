use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::AnsemError;
use crate::state::{Config, Round, STATE_CLAIMABLE, STATE_CLOSED};

// ---- close_round janitor (plan 2026-07-14, Task 5) ----
// Permissionless rent-recycler that reaps a finished round's on-chain footprint.
// The caller is ANY signer — the only gates are TIME and STATE, so a keeper crank
// (or anyone) can close old rounds without holding the admin key. Rent always
// refunds to config.admin (the keeper funded the round's rent at create_round),
// pinned by the admin_dest address constraint. Two reap paths:
//   • STATE_CLAIMABLE: only after deadline + claim_window_secs. The unclaimed
//     remainder (entitlement_total - claimed_proceeds) is forfeited into
//     rollover_jackpot — a pure earmark move WITHIN ansem_obligations (rollover
//     grows, obligations unchanged; the physical ANSEM stays in payout_vault, now
//     backing the next jackpot instead of this round's stragglers).
//   • STATE_CLOSED (cancelled): only if EMPTY (pot == 0). A non-empty cancelled
//     round must keep its account alive so refund_direct can still return stakes.
// Any other state is not closeable.
#[derive(Accounts)]
pub struct CloseRound<'info> {
    // Permissionless — the gates are time + state, not a signer identity.
    pub caller: Signer<'info>,

    #[account(mut, seeds = [CONFIG_SEED], bump = config.config_bump)]
    pub config: Account<'info, Config>,

    #[account(
        mut, close = admin_dest,
        seeds = [ROUND_SEED, round.round_id.to_le_bytes().as_ref()], bump = round.bump
    )]
    pub round: Account<'info, Round>,

    /// CHECK: rent refund target — pinned to config.admin (the keeper funded the
    /// round rent), validated only as the `close` lamport sink.
    #[account(mut, address = config.admin @ AnsemError::Unauthorized)]
    pub admin_dest: UncheckedAccount<'info>,
}

pub fn close_round_handler(ctx: Context<CloseRound>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let round = &ctx.accounts.round;
    let cfg = &mut ctx.accounts.config;
    if round.state == STATE_CLAIMABLE {
        require!(
            now >= round.deadline_ts.saturating_add(cfg.claim_window_secs),
            AnsemError::ClaimWindowOpen
        );
        // Forfeit the unclaimed remainder into the next jackpot. Pure earmark
        // move inside ansem_obligations: rollover grows, obligations unchanged.
        let forfeited = round.entitlement_total.saturating_sub(round.claimed_proceeds);
        cfg.rollover_jackpot = cfg
            .rollover_jackpot
            .checked_add(forfeited)
            .ok_or(AnsemError::Overflow)?;
    } else if round.state == STATE_CLOSED {
        // Cancelled rounds: only EMPTY ones may be reaped — a non-empty
        // cancelled round still owes refund_direct its block_stake data.
        require!(round.pot == 0, AnsemError::RoundNotCloseable);
    } else {
        return err!(AnsemError::RoundNotCloseable);
    }
    // The `close = admin_dest` account constraint reclaims the rent to config.admin.
    Ok(())
}
