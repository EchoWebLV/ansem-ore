import { RoundState } from "@ansem/sdk";

export enum CrankAction {
  Idle = "idle",
  CreateRound = "create_round",
  CommitToL1 = "commit_to_l1",
  Settle = "settle",
  AwaitOracle = "await_oracle",
  Finalize = "finalize",
  Cancel = "cancel",
}

export interface CrankRoundView {
  state: RoundState;
  deadlineTs: number;
  roundId: number;
  pot: bigint; // live pot — an empty (pot == 0) past-deadline round is cancelled, not settled
}

export interface CrankState {
  finalized: boolean;                // config.current_round_finalized
  currentRoundId: number;            // config.current_round_id
  round: CrankRoundView | null;      // null when the current round PDA is absent
  roundDelegated: boolean;           // round PDA owner == DLP (live copy lives in the ER)
  nowSec: number;                    // wall-clock seconds
  vrfPendingSinceSec: number | null; // when the loop first observed VRF_PENDING
  graceSecs: number;                 // oracle grace window before cancel
}

/**
 * The single next action for the crank. Pure; the loop supplies observed state.
 *
 * Order matches the PROVEN devnet flow (tests/ansem-miner-devnet.ts) and the
 * on-chain `commit_miner` gate (`now >= deadline_ts`, delegation.rs) which keeps
 * the natural COMMIT-THEN-SETTLE order: at the deadline the round is committed
 * back to L1 first (commit_miner all + commit_round, undelegating it), THEN
 * `request_settle` runs on L1, THEN reconcile + swap. NOT settle-first.
 */
export function decideAction(s: CrankState): CrankAction {
  // Only currentRoundId=0 can legitimately have no round. A missing nonzero round is an
  // ambiguous read failure, so fail closed and let the next tick retry instead of advancing.
  if (s.round === null) {
    return s.currentRoundId === 0 ? CrankAction.CreateRound : CrankAction.Idle;
  }

  // The decoded round is authoritative for action selection. In particular, a finalized flag
  // observed from a newer RPC slot must not override an older nonterminal round read.
  switch (s.round.state) {
    case RoundState.Claimable:
    case RoundState.Closed:
      return CrankAction.CreateRound;

    case RoundState.Open:
      if (s.nowSec < s.round.deadlineTs) return CrankAction.Idle;
      // Past deadline: while still delegated we must commit the round back to L1
      // (its live state is in the ER); once program-owned on L1 we can settle.
      if (s.roundDelegated) return CrankAction.CommitToL1;
      // Empty round (nobody staked) -> cancel instead of settling: cancel_round needs
      // no VRF, so quiet hours cost zero oracle fee. cancel_round runs on L1, so this
      // only fires once undelegated (a delegated empty round commits back first, above).
      if (s.round.pot === 0n) return CrankAction.Cancel;
      return CrankAction.Settle;

    case RoundState.VrfPending: {
      const waited = s.vrfPendingSinceSec === null ? 0 : s.nowSec - s.vrfPendingSinceSec;
      return waited > s.graceSecs ? CrankAction.Cancel : CrankAction.AwaitOracle;
    }

    case RoundState.Settled:
      return CrankAction.Finalize; // commit already done pre-settle -> reconcile + swap

    default: // Swapping (reserved/unused in mock) -- nothing safe to do; wait.
      return CrankAction.Idle;
  }
}
