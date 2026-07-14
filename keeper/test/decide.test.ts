import { describe, it, expect } from "vitest";
import { RoundState } from "@ansem/sdk";
import { decideAction, CrankAction, CrankState } from "../src/crank/decide.js";

const base: CrankState = {
  finalized: true,
  currentRoundId: 100,
  round: null,
  roundDelegated: false,
  nowSec: 1000,
  vrfPendingSinceSec: null,
  graceSecs: 180,
};

describe("decideAction", () => {
  it("creates a round when finalized and none in flight", () => {
    expect(decideAction(base)).toBe(CrankAction.CreateRound);
  });

  it("creates a round when the current round is CLAIMABLE (finalized)", () => {
    expect(decideAction({ ...base, round: { state: RoundState.Claimable, deadlineTs: 0, roundId: 100, pot: 0n } }))
      .toBe(CrankAction.CreateRound);
  });

  it("creates a round when the current round is CLOSED", () => {
    expect(decideAction({ ...base, finalized: false, round: { state: RoundState.Closed, deadlineTs: 0, roundId: 100, pot: 0n } }))
      .toBe(CrankAction.CreateRound);
  });

  it("is idle while OPEN before the deadline", () => {
    expect(decideAction({ ...base, finalized: false, roundDelegated: true, round: { state: RoundState.Open, deadlineTs: 2000, roundId: 100, pot: 15n } }))
      .toBe(CrankAction.Idle);
  });

  it("commits to L1 when OPEN passes the deadline but the round is still delegated", () => {
    expect(decideAction({ ...base, finalized: false, roundDelegated: true, round: { state: RoundState.Open, deadlineTs: 999, roundId: 100, pot: 15n } }))
      .toBe(CrankAction.CommitToL1);
  });

  it("settles once OPEN passes the deadline and the round is back on L1 (undelegated) with stakes", () => {
    expect(decideAction({ ...base, finalized: false, roundDelegated: false, round: { state: RoundState.Open, deadlineTs: 999, roundId: 100, pot: 15n } }))
      .toBe(CrankAction.Settle);
  });

  it("cancels (never settles) an EMPTY OPEN round past the deadline — zero VRF spend on quiet hours", () => {
    expect(decideAction({ ...base, finalized: false, roundDelegated: false, round: { state: RoundState.Open, deadlineTs: 999, roundId: 100, pot: 0n } }))
      .toBe(CrankAction.Cancel);
  });

  it("still commits an empty DELEGATED round to L1 first (cancel_round only runs on L1)", () => {
    expect(decideAction({ ...base, finalized: false, roundDelegated: true, round: { state: RoundState.Open, deadlineTs: 999, roundId: 100, pot: 0n } }))
      .toBe(CrankAction.CommitToL1);
  });

  it("awaits the oracle while VRF_PENDING within grace", () => {
    expect(decideAction({ ...base, finalized: false, vrfPendingSinceSec: 950,
      round: { state: RoundState.VrfPending, deadlineTs: 0, roundId: 100, pot: 15n } }))
      .toBe(CrankAction.AwaitOracle);
  });

  it("cancels a VRF_PENDING round that blew past the grace window", () => {
    expect(decideAction({ ...base, finalized: false, nowSec: 2000, vrfPendingSinceSec: 950,
      round: { state: RoundState.VrfPending, deadlineTs: 0, roundId: 100, pot: 15n } }))
      .toBe(CrankAction.Cancel);
  });

  it("finalizes a SETTLED round (reconcile -> swap; commit already happened pre-settle)", () => {
    expect(decideAction({ ...base, finalized: false, round: { state: RoundState.Settled, deadlineTs: 0, roundId: 100, pot: 15n } }))
      .toBe(CrankAction.Finalize);
  });
});
