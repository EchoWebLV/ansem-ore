import { RoundState } from "@ansem/sdk";

export enum CrankAction {
  Idle = "idle",
  CreateRound = "create_round",
  Settle = "settle",
  AwaitOracle = "await_oracle",
  Finalize = "finalize",
  Cancel = "cancel",
}

export interface CrankRoundView {
  state: RoundState;
  deadlineTs: number;
  roundId: number;
}

export interface CrankState {
  finalized: boolean;                // config.current_round_finalized
  currentRoundId: number;            // config.current_round_id
  round: CrankRoundView | null;      // null when the current round PDA is absent
  nowSec: number;                    // wall-clock seconds
  vrfPendingSinceSec: number | null; // when the loop first observed VRF_PENDING
  graceSecs: number;                 // oracle grace window before cancel
}

/** The single next action for the crank. Pure; the loop supplies observed state. */
export function decideAction(s: CrankState): CrankAction {
  // No round in flight, or the current one is terminal -> open the next round.
  if (s.finalized || s.round === null) return CrankAction.CreateRound;

  switch (s.round.state) {
    case RoundState.Claimable:
    case RoundState.Closed:
      return CrankAction.CreateRound;

    case RoundState.Open:
      return s.nowSec < s.round.deadlineTs ? CrankAction.Idle : CrankAction.Settle;

    case RoundState.VrfPending: {
      const waited = s.vrfPendingSinceSec === null ? 0 : s.nowSec - s.vrfPendingSinceSec;
      return waited > s.graceSecs ? CrankAction.Cancel : CrankAction.AwaitOracle;
    }

    case RoundState.Settled:
      return CrankAction.Finalize;

    default: // Swapping (reserved/unused in mock) -- nothing safe to do; wait.
      return CrankAction.Idle;
  }
}
