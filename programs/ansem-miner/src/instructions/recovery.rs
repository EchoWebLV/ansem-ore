use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::AnsemError;
use crate::state::{Config, PlayerEscrow, Round, STATE_CLOSED, STATE_OPEN, STATE_SETTLED};

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
    let current_round_id = ctx.accounts.config.current_round_id;
    let round = &mut ctx.accounts.round;
    // Only a past-deadline round that never reached Claimable can be canceled.
    require!(
        round.state == STATE_OPEN || round.state == STATE_SETTLED,
        AnsemError::RoundNotCancelable
    );
    // Defense-in-depth: only the current round is ever cancelable. Under M1's
    // serialization gate this is already implied (older rounds are Claimable/
    // Closed and fail the state check above), but asserting it explicitly keeps
    // the invariant enforced when M2's async VRF/crank flow reworks the lifecycle.
    require!(round.round_id == current_round_id, AnsemError::RoundNotCancelable);
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
// Release a Closed round's withdraw-lock for the calling player. Under the
// M2a reconcile-at-commit escrow model, `stake` (on the ER) never debits
// escrow — the debit happens only in `reconcile_miner`, which runs on a
// *committed* round. A Closed (cancelled) round is never committed and thus
// never reconciled, so no lamports were ever moved out of the player's escrow
// tranche: there is NOTHING to credit back. refund therefore only clears
// escrow.active_round so the player can withdraw/stake again.
//
// This also frees a join-without-stake player (joined the round, round then
// cancelled before they staked): they hold the lock but have no stake, so the
// gate is escrow.active_round — NOT miner.round_id — which is why the miner
// account is not needed here. Pure accounting: no lamport/token transfer, no
// external sink. The dead round's `pot` is intentionally left stale.
// ---------------------------------------------------------------------------
#[derive(Accounts)]
#[instruction(round_id: u64)]
pub struct Refund<'info> {
    pub authority: Signer<'info>,

    #[account(seeds = [ROUND_SEED, round_id.to_le_bytes().as_ref()], bump = round.bump,
        constraint = round.round_id == round_id @ AnsemError::MinerRoundMismatch)]
    pub round: Account<'info, Round>,

    #[account(mut, seeds = [ESCROW_SEED, authority.key().as_ref()], bump = escrow.bump,
        constraint = escrow.authority == authority.key() @ AnsemError::Unauthorized)]
    pub escrow: Account<'info, PlayerEscrow>,
}

pub fn refund_handler(ctx: Context<Refund>, round_id: u64) -> Result<()> {
    require!(ctx.accounts.round.state == STATE_CLOSED, AnsemError::RoundNotClosed);

    let escrow = &mut ctx.accounts.escrow;
    // The player must be locked to exactly this round (they joined it). A second
    // refund fails here because active_round is set to 0 below.
    require!(escrow.active_round == round_id, AnsemError::NothingToRefund);

    // No credit: in the reconcile-at-commit model `stake` never debited escrow,
    // and a Closed round is never reconciled, so there is nothing to reverse —
    // refund only releases the withdraw-lock.
    escrow.active_round = 0;
    escrow.last_claimed_round = round_id;
    Ok(())
}
