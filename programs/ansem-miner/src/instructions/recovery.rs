use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::AnsemError;
use crate::state::{Config, MinerPosition, PlayerEscrow, Round, STATE_CLOSED, STATE_OPEN, STATE_SETTLED, STATE_VRF_PENDING};

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
    // STATE_VRF_PENDING is included so a VRF request that the oracle never
    // fulfills (queue misconfig, oracle down) can't strand the game + escrow
    // locks forever — a late settle_callback afterward no-ops on the closed round
    // (it requires state == VrfPending). A Settled round is likewise recoverable
    // pre-swap. All three pre-Claimable states resolve to Closed → refund.
    require!(
        round.state == STATE_OPEN
            || round.state == STATE_VRF_PENDING
            || round.state == STATE_SETTLED,
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

    #[account(mut, seeds = [CONFIG_SEED], bump = config.config_bump)]
    pub config: Account<'info, Config>,

    #[account(seeds = [ROUND_SEED, round_id.to_le_bytes().as_ref()], bump = round.bump,
        constraint = round.round_id == round_id @ AnsemError::MinerRoundMismatch)]
    pub round: Account<'info, Round>,

    #[account(mut, seeds = [ESCROW_SEED, authority.key().as_ref()], bump = escrow.bump,
        constraint = escrow.authority == authority.key() @ AnsemError::Unauthorized)]
    pub escrow: Account<'info, PlayerEscrow>,

    // Committed block_stake snapshot — read only in the reconciled branch to
    // learn how much to credit back. Seeded on the caller's wallet.
    #[account(seeds = [MINER_SEED, authority.key().as_ref()], bump = miner.bump)]
    pub miner: Account<'info, MinerPosition>,
}

pub fn refund_handler(ctx: Context<Refund>, round_id: u64) -> Result<()> {
    require!(ctx.accounts.round.state == STATE_CLOSED, AnsemError::RoundNotClosed);

    // A genuine participant of THIS round is either still locked (joined, not yet
    // reconciled) or already reconciled (the debit ran). The (active_round,
    // reconciled_round) pair also double-serves as the replay guard.
    let joined = ctx.accounts.escrow.active_round == round_id;
    let reconciled = ctx.accounts.escrow.reconciled_round == round_id;
    require!(joined || reconciled, AnsemError::NothingToRefund);

    if reconciled {
        // reconcile_miner already debited escrow from block_stake, but this round
        // never swapped — the lamports are still idle in pot_vault. Reverse the
        // debit so the player can withdraw. Consume reconciled_round to prevent a
        // second credit.
        require!(ctx.accounts.miner.round_id == round_id, AnsemError::MinerRoundMismatch);
        let staked: u64 = ctx.accounts.miner.block_stake.iter().sum();
        let escrow = &mut ctx.accounts.escrow;
        escrow.balance = escrow.balance.checked_add(staked).ok_or(AnsemError::Overflow)?;
        escrow.reconciled_round = 0;
        let cfg = &mut ctx.accounts.config;
        cfg.total_escrow_balance =
            cfg.total_escrow_balance.checked_add(staked).ok_or(AnsemError::Overflow)?;
    }

    // Release the withdraw-lock. Do NOT write last_claimed_round: the
    // (active_round, reconciled_round) guards already block a second refund, and
    // leaving last_claimed_round untouched preserves the player's ability to
    // claim an earlier, still-unclaimed round.
    ctx.accounts.escrow.active_round = 0;
    Ok(())
}
