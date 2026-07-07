import { describe, it, expect } from "vitest";
import { RoundState } from "@ansem/sdk";
import { decideAction, CrankAction, CrankState } from "../src/crank/decide.js";

const base: CrankState = {
  finalized: true,
  currentRoundId: 100,
  round: null,
  nowSec: 1000,
  vrfPendingSinceSec: null,
  graceSecs: 180,
};

describe("decideAction", () => {
  it("creates a round when finalized and none in flight", () => {
    expect(decideAction(base)).toBe(CrankAction.CreateRound);
  });

  it("creates a round when the current round is CLAIMABLE (finalized)", () => {
    expect(decideAction({ ...base, round: { state: RoundState.Claimable, deadlineTs: 0, roundId: 100 } }))
      .toBe(CrankAction.CreateRound);
  });

  it("creates a round when the current round is CLOSED", () => {
    expect(decideAction({ ...base, finalized: false, round: { state: RoundState.Closed, deadlineTs: 0, roundId: 100 } }))
      .toBe(CrankAction.CreateRound);
  });

  it("is idle while OPEN before the deadline", () => {
    expect(decideAction({ ...base, finalized: false, round: { state: RoundState.Open, deadlineTs: 2000, roundId: 100 } }))
      .toBe(CrankAction.Idle);
  });

  it("settles once OPEN passes the deadline", () => {
    expect(decideAction({ ...base, finalized: false, round: { state: RoundState.Open, deadlineTs: 999, roundId: 100 } }))
      .toBe(CrankAction.Settle);
  });

  it("awaits the oracle while VRF_PENDING within grace", () => {
    expect(decideAction({ ...base, finalized: false, vrfPendingSinceSec: 950,
      round: { state: RoundState.VrfPending, deadlineTs: 0, roundId: 100 } }))
      .toBe(CrankAction.AwaitOracle);
  });

  it("cancels a VRF_PENDING round that blew past the grace window", () => {
    expect(decideAction({ ...base, finalized: false, nowSec: 2000, vrfPendingSinceSec: 950,
      round: { state: RoundState.VrfPending, deadlineTs: 0, roundId: 100 } }))
      .toBe(CrankAction.Cancel);
  });

  it("finalizes a SETTLED round (commit -> reconcile -> swap)", () => {
    expect(decideAction({ ...base, finalized: false, round: { state: RoundState.Settled, deadlineTs: 0, roundId: 100 } }))
      .toBe(CrankAction.Finalize);
  });
});
