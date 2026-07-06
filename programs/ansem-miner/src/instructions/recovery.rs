use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::AnsemError;
use crate::state::{
    Config, MinerPosition, PlayerEscrow, Round, STATE_CLOSED, STATE_OPEN, STATE_SETTLED,
};

// ---------------------------------------------------------------------------
// cancel_round (admin escape hatch)
//
// The create_round serialization gate forbids opening a new round while the
// current one is still Open/Settled. Without a recovery path, a single round
// that is never settled (abandoned crank, admin oversight) would both halt the
// game (no new rounds) *and* strand its stakers' escrow forever. cancel_round
// walks such an abandoned, past-deadline round to Closed and re-arms
// current_round_finalized so play can resume. Bounded by the existing M1
// admin-trust model (admin already supplies settle randomness); it moves no
// funds — stakers recover their own stake via the permissionless `refund`.
// ---------------------------------------------------------------------------
#[derive(Accounts)]
pub struct CancelRound<'info> {
    pub admin: Signer<'info>,

    #[account(
        mut, seeds = [CONFIG_SEED], bump = config.config_bump,
        constraint = config.admin == admin.key() @ AnsemError::Unauthorized
    )]
    pub config: Account<'info, Config>,

    #[account(mut, seeds = [ROUND_SEED, round.round_id.to_le_bytes().as_ref()], bump = round.bump)]
    pub round: Account<'info, Round>,
}

pub fn cancel_round_handler(ctx: Context<CancelRound>) -> Result<()> {
    let round = &mut ctx.accounts.round;
    // Only a past-deadline round that never reached Claimable can be canceled.
    require!(
        round.state == STATE_OPEN || round.state == STATE_SETTLED,
        AnsemError::RoundNotCancelable
    );
    let now = Clock::get()?.unix_timestamp;
    require!(now >= round.deadline_ts, AnsemError::RoundNotCancelable);

    round.state = STATE_CLOSED;
    // Re-arm the lifecycle gate: under serialization the only non-finalized
    // round is the current one, which we just closed.
    ctx.accounts.config.current_round_finalized = true;
    Ok(())
}

// ---------------------------------------------------------------------------
// refund (permissionless, per-player)
//
// For a Closed round, return the player's own staked lamports back into their
// PlayerEscrow accounting so they can withdraw/stake again. Pure accounting: the
// SOL never left the commingled pot_vault (stake only moved it from the escrow
// tranche into the round's pot tranche), so we only reverse the bookkeeping —
// no lamport or token transfer, and nothing moves to any external sink. The
// dead round's `pot` is intentionally left stale (it is never swapped).
// ---------------------------------------------------------------------------
#[derive(Accounts)]
#[instruction(round_id: u64)]
pub struct Refund<'info> {
    pub authority: Signer<'info>,

    #[account(mut, seeds = [CONFIG_SEED], bump = config.config_bump)]
    pub config: Account<'info, Config>,

    #[account(seeds = [ROUND_SEED, round_id.to_le_bytes().as_ref()], bump = round.bump,
        constraint = round.round_id == round_id @ AnsemError::MinerRoundMismatch)]
    pub round: Account<'info, Round>,

    #[account(mut, seeds = [MINER_SEED, authority.key().as_ref()], bump = miner.bump,
        constraint = miner.authority == authority.key() @ AnsemError::Unauthorized)]
    pub miner: Account<'info, MinerPosition>,

    #[account(mut, seeds = [ESCROW_SEED, authority.key().as_ref()], bump = escrow.bump,
        constraint = escrow.authority == authority.key() @ AnsemError::Unauthorized)]
    pub escrow: Account<'info, PlayerEscrow>,
}

pub fn refund_handler(ctx: Context<Refund>, round_id: u64) -> Result<()> {
    require!(ctx.accounts.round.state == STATE_CLOSED, AnsemError::RoundNotClosed);

    let miner = &mut ctx.accounts.miner;
    let escrow = &mut ctx.accounts.escrow;

    // The player must have an unrefunded, unclaimed stake in exactly this round.
    require!(miner.round_id == round_id, AnsemError::MinerRoundMismatch);
    require!(escrow.active_round == round_id, AnsemError::NothingToRefund);

    let stake: u64 = miner.block_stake.iter().copied().sum();
    require!(stake > 0, AnsemError::NothingToRefund);

    // Reverse the stake-time accounting: lamports return from the round's pot
    // tranche to the player's idle escrow tranche (both inside pot_vault).
    escrow.balance = escrow.balance.checked_add(stake).ok_or(AnsemError::Overflow)?;
    ctx.accounts.config.total_escrow_balance = ctx
        .accounts
        .config
        .total_escrow_balance
        .checked_add(stake)
        .ok_or(AnsemError::Overflow)?;

    // Clear the active round and mark this round resolved for the player so a
    // second refund (or a claim) cannot double-pay.
    escrow.active_round = 0;
    escrow.last_claimed_round = round_id;
    Ok(())
}
