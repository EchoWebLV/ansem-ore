import { describe, it, expect } from "vitest";
import { RoundState } from "@ansem/sdk";
import { CrankAction } from "../src/crank/decide.js";
import { runTick, TickDeps } from "../src/crank/loop.js";

const grid = () => Array.from({ length: 25 }, () => 0n);
const config: any = { currentRoundId: 100, currentRoundFinalized: false, rolloverJackpot: 0n, multMinBps: 5000, multMaxBps: 5000 };
const openRound: any = {
  roundId: 100, deadlineTs: 5000, blockSol: grid(), pot: 0n, state: RoundState.Open,
  randomness: new Array(32).fill(0), jackpotSquare: 0, jackpotPool: 0n, swapProceeds: 0n,
};

function makeDeps(over: Partial<TickDeps> = {}) {
  const dispatched: CrankAction[] = [];
  let broadcasts = 0;
  const deps: TickDeps = {
    fetchConfig: async () => config,
    fetchRound: async () => ({ round: openRound, delegated: false }),
    fetchMiners: async () => [],
    dispatch: async (a) => { dispatched.push(a); },
    broadcast: () => { broadcasts++; },
    nowSec: () => 4000, // before deadline
    ...over,
  };
  return { deps, dispatched, broadcasts: () => broadcasts };
}

describe("runTick", () => {
  it("builds+broadcasts a snapshot and dispatches Idle while OPEN pre-deadline", async () => {
    const { deps, dispatched, broadcasts } = makeDeps();
    const next = await runTick(deps, { prevSnapshot: null, vrfPendingSinceSec: null });
    expect(dispatched).toEqual([CrankAction.Idle]);
    expect(next.prevSnapshot?.roundId).toBe(100);
    expect(broadcasts()).toBe(1);
  });

  it("dispatches CommitToL1 once OPEN passes the deadline while still delegated", async () => {
    const { deps, dispatched } = makeDeps({
      fetchRound: async () => ({ round: openRound, delegated: true }), nowSec: () => 6000,
    });
    await runTick(deps, { prevSnapshot: null, vrfPendingSinceSec: null });
    expect(dispatched).toEqual([CrankAction.CommitToL1]);
  });

  it("dispatches Settle once the round is back on L1 (undelegated) past the deadline", async () => {
    const { deps, dispatched } = makeDeps({
      fetchRound: async () => ({ round: openRound, delegated: false }), nowSec: () => 6000,
    });
    await runTick(deps, { prevSnapshot: null, vrfPendingSinceSec: null });
    expect(dispatched).toEqual([CrankAction.Settle]);
  });

  it("stamps vrfPendingSinceSec the first tick a round is VRF_PENDING", async () => {
    const pending = { ...openRound, state: RoundState.VrfPending };
    const { deps } = makeDeps({ fetchRound: async () => ({ round: pending as any, delegated: false }), nowSec: () => 6000 });
    const next = await runTick(deps, { prevSnapshot: null, vrfPendingSinceSec: null });
    expect(next.vrfPendingSinceSec).toBe(6000);
  });
});
