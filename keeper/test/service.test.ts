import { describe, it, expect, vi } from "vitest";
import { RoundState } from "@ansem/sdk";
import { CrankAction } from "../src/crank/decide.js";
import { runTick, TickDeps } from "../src/crank/loop.js";
import type { ActionCtx } from "../src/crank/actions.js";
import { dispatchCrankAction } from "../src/service.js";

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

  it("dispatches Settle once a STAKED round is back on L1 (undelegated) past the deadline", async () => {
    const { deps, dispatched } = makeDeps({
      fetchRound: async () => ({ round: { ...openRound, pot: 15n }, delegated: false }), nowSec: () => 6000,
    });
    await runTick(deps, { prevSnapshot: null, vrfPendingSinceSec: null });
    expect(dispatched).toEqual([CrankAction.Settle]);
  });

  it("dispatches Cancel for an EMPTY round (pot 0) undelegated past the deadline", async () => {
    const { deps, dispatched } = makeDeps({
      fetchRound: async () => ({ round: openRound, delegated: false }), nowSec: () => 6000,
    });
    await runTick(deps, { prevSnapshot: null, vrfPendingSinceSec: null });
    expect(dispatched).toEqual([CrankAction.Cancel]);
  });

  it("stamps vrfPendingSinceSec the first tick a round is VRF_PENDING", async () => {
    const pending = { ...openRound, state: RoundState.VrfPending };
    const { deps } = makeDeps({ fetchRound: async () => ({ round: pending as any, delegated: false }), nowSec: () => 6000 });
    const next = await runTick(deps, { prevSnapshot: null, vrfPendingSinceSec: null });
    expect(next.vrfPendingSinceSec).toBe(6000);
  });
});

function makeDispatchHarness(stamp: (roundId: number) => Promise<void>, enabled = true) {
  const createAndDelegate = vi.fn(async (_ctx: ActionCtx, _roundId: number) => undefined);
  const ctx = {
    beefStamper: {
      init: vi.fn(async () => undefined),
      stamp,
      enabled: () => enabled,
    },
  } as unknown as ActionCtx;
  return {
    createAndDelegate,
    dispatch: (action: CrankAction, state: Parameters<typeof dispatchCrankAction>[1]) =>
      dispatchCrankAction(action, state, ctx, { createAndDelegate }),
  };
}

describe("CreateRound service dispatch", () => {
  it("rejects and does not create when the current Claimable round's BEEF stamp fails", async () => {
    const stamp = vi.fn(async () => { throw new Error("stamp failed"); });
    const { dispatch, createAndDelegate } = makeDispatchHarness(stamp);

    await expect(dispatch(CrankAction.CreateRound, {
      config,
      round: { ...openRound, state: RoundState.Claimable },
    })).rejects.toThrow(/stamp failed/);

    expect(stamp).toHaveBeenCalledWith(100);
    expect(createAndDelegate).not.toHaveBeenCalled();
  });

  it("creates exactly once after stamping the current Claimable round", async () => {
    const stamp = vi.fn(async () => undefined);
    const { dispatch, createAndDelegate } = makeDispatchHarness(stamp);

    await dispatch(CrankAction.CreateRound, {
      config,
      round: { ...openRound, state: RoundState.Claimable },
    });

    expect(stamp).toHaveBeenCalledWith(100);
    expect(createAndDelegate).toHaveBeenCalledTimes(1);
  });

  it("creates after an empty Closed round without attempting a BEEF stamp", async () => {
    const stamp = vi.fn(async () => undefined);
    const { dispatch, createAndDelegate } = makeDispatchHarness(stamp);

    await dispatch(CrankAction.CreateRound, {
      config,
      round: { ...openRound, state: RoundState.Closed, pot: 0n },
    });

    expect(stamp).not.toHaveBeenCalled();
    expect(createAndDelegate).toHaveBeenCalledTimes(1);
  });
});
