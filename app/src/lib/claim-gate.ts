import { RoundState } from "@ansem/sdk";

/**
 * True when entering a new round would forfeit the player's unfinished business with a
 * prior round — or would simply revert. Entering calls join_round, which (a) reverts with
 * RoundAlreadyJoined if escrow.active_round != 0, and (b) re-stamps miner.round_id + zeroes
 * block_stake (CRIT-1 fix), clobbering the reference that BOTH `claim` (claim.rs) AND
 * refund's reconciled-credit branch (recovery.rs) key on (miner.round_id == round_id).
 *
 * The gate is CONSERVATIVE by design: it is the ONLY guard against silent forfeiture, and
 * the staked-round state is polled (it lags on-chain, and is null while loading). So it
 * BLOCKS on any unresolved prior round unless it can prove nothing is at stake — a permissive
 * gate would open a forfeiture window during the Settled->Claimable lag or the initial null.
 * It still never permanently traps a player: claiming clears `unclaimed`, and refunding
 * clears the lock / reconciledRound, each of which flips the gate open.
 */
export function enterWouldForfeit(opts: {
  activeRound: number;
  stakedRound: number;
  lastClaimedRound: number;
  reconciledRound: number;
  stakedRoundState: RoundState | null;
}): boolean {
  // (A) Escrow still locked to a prior round -> join_round would revert. Blocks a
  // join-without-stake player whose cancelled round isn't refunded yet, and any
  // un-reconciled state. Cleared to 0 by reconcile_miner / refund.
  if (opts.activeRound !== 0) return true;

  // (B) A staked round whose payout / refund-credit is still keyed on miner.round_id.
  if (opts.stakedRound <= 0) return false;
  if (opts.lastClaimedRound >= opts.stakedRound) return false; // already claimed -> nothing at stake

  // Unclaimed. Safe to enter ONLY if we can prove the round carries nothing keyed on
  // miner.round_id: a Closed round we were never reconciled for (join-without-stake; its
  // recovery is the active_round refund handled by (A), not the miner reference). Every
  // other unclaimed case — Claimable (payout), Closed+reconciled (refund credit), and the
  // still-settling / unknown (null) states that will resolve to one of those — BLOCKS.
  if (opts.stakedRoundState === RoundState.Closed && opts.reconciledRound !== opts.stakedRound) return false;
  return true;
}
