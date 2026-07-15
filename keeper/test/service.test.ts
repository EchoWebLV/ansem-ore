import { describe, it, expect, vi } from "vitest";
import { PublicKey } from "@solana/web3.js";
import {
  DLP_PROGRAM_ID, RoundState, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, roundPda,
} from "@ansem/sdk";
import { CrankAction } from "../src/crank/decide.js";
import { runTick, TickDeps } from "../src/crank/loop.js";
import type { ActionCtx } from "../src/crank/actions.js";
import type { BeefStampDeps } from "../src/beef.js";
import { dispatchCrankAction, readCurrentRoundView } from "../src/service.js";

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

  it("does not dispatch when the current-round read fails", async () => {
    const { deps, dispatched } = makeDeps({
      fetchRound: async () => { throw new Error("round RPC failed"); },
    });

    await expect(runTick(deps, { prevSnapshot: null, vrfPendingSinceSec: null }))
      .rejects.toThrow(/round RPC failed/);
    expect(dispatched).toEqual([]);
  });
});

describe("live current-round reader", () => {
  it("returns null without RPC reads only for the initial currentRoundId zero", async () => {
    const getAccountInfo = vi.fn(async () => null);
    const fetchDecodedRound = vi.fn(async () => openRound);

    await expect(readCurrentRoundView(0, { getAccountInfo, fetchDecodedRound }))
      .resolves.toBeNull();
    expect(getAccountInfo).not.toHaveBeenCalled();
    expect(fetchDecodedRound).not.toHaveBeenCalled();
  });

  it("rejects when a nonzero current-round account is missing", async () => {
    const getAccountInfo = vi.fn(async () => null);
    const fetchDecodedRound = vi.fn(async () => openRound);

    await expect(readCurrentRoundView(100, { getAccountInfo, fetchDecodedRound }))
      .rejects.toThrow(/current round 100.*account.*missing/i);
    expect(getAccountInfo).toHaveBeenCalledWith(roundPda(100));
    expect(fetchDecodedRound).not.toHaveBeenCalled();
  });

  it("propagates a typed current-round fetch failure", async () => {
    const getAccountInfo = vi.fn(async () => ({ owner: DLP_PROGRAM_ID }));
    const fetchDecodedRound = vi.fn(async () => { throw new Error("round decode RPC failed"); });

    await expect(readCurrentRoundView(100, { getAccountInfo, fetchDecodedRound }))
      .rejects.toThrow(/round decode RPC failed/);
    expect(fetchDecodedRound).toHaveBeenCalledWith(true, roundPda(100));
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
  it("creates round 1 when the initial currentRoundId is zero and no round exists", async () => {
    const stamp = vi.fn(async () => undefined);
    const { dispatch, createAndDelegate } = makeDispatchHarness(stamp);

    await dispatch(CrankAction.CreateRound, {
      config: { ...config, currentRoundId: 0 },
      round: null,
    });

    expect(stamp).not.toHaveBeenCalled();
    expect(createAndDelegate).toHaveBeenCalledTimes(1);
    expect(createAndDelegate.mock.calls[0]?.[1]).toBe(1);
  });

  it("rejects a missing nonzero current round", async () => {
    const stamp = vi.fn(async () => undefined);
    const { dispatch, createAndDelegate } = makeDispatchHarness(stamp);

    await expect(dispatch(CrankAction.CreateRound, { config, round: null }))
      .rejects.toThrow(/current round 100.*missing/i);

    expect(stamp).not.toHaveBeenCalled();
    expect(createAndDelegate).not.toHaveBeenCalled();
  });

  it("rejects a decoded round whose ID does not match config", async () => {
    const stamp = vi.fn(async () => undefined);
    const { dispatch, createAndDelegate } = makeDispatchHarness(stamp);

    await expect(dispatch(CrankAction.CreateRound, {
      config,
      round: { ...openRound, roundId: 99, state: RoundState.Claimable },
    })).rejects.toThrow(/round ID 99.*current round 100/i);

    expect(stamp).not.toHaveBeenCalled();
    expect(createAndDelegate).not.toHaveBeenCalled();
  });

  it.each([
    ["Open", RoundState.Open],
    ["VrfPending", RoundState.VrfPending],
    ["Settled", RoundState.Settled],
    ["Swapping", RoundState.Swapping],
  ])("rejects stale CreateRound dispatch for a nonterminal %s round", async (_name, state) => {
    const stamp = vi.fn(async () => undefined);
    const { dispatch, createAndDelegate } = makeDispatchHarness(stamp);

    await expect(dispatch(CrankAction.CreateRound, {
      config,
      round: { ...openRound, state },
    })).rejects.toThrow(/round 100.*not terminal/i);

    expect(stamp).not.toHaveBeenCalled();
    expect(createAndDelegate).not.toHaveBeenCalled();
  });

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

  it("blocks creation on a failed Claimable stamp even when the stamper cache is disabled", async () => {
    const stamp = vi.fn(async () => { throw new Error("probe failed"); });
    const { dispatch, createAndDelegate } = makeDispatchHarness(stamp, false);

    await expect(dispatch(CrankAction.CreateRound, {
      config,
      round: { ...openRound, state: RoundState.Claimable },
    })).rejects.toThrow(/probe failed/);

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

  it("creates after a funded Closed cancellation without attempting a BEEF stamp", async () => {
    const stamp = vi.fn(async () => undefined);
    const { dispatch, createAndDelegate } = makeDispatchHarness(stamp);

    await dispatch(CrankAction.CreateRound, {
      config,
      round: { ...openRound, state: RoundState.Closed, pot: 15n },
    });

    expect(stamp).not.toHaveBeenCalled();
    expect(createAndDelegate).toHaveBeenCalledTimes(1);
  });
});

const liveServiceConfig: any = {
  adminKeypair: { publicKey: {} }, validator: {}, vrfQueue: {}, roundDurationSecs: 60,
  directMode: false, swapMode: "mock", jupBaseUrl: "https://example.invalid", slippageBps: 100,
  inventoryMinAnsem: 0, listingTs: null,
};

async function captureLiveBeefDeps(
  getAccountInfo: ReturnType<typeof vi.fn>,
  fetchBeefConfig: ReturnType<typeof vi.fn>,
) {
  vi.resetModules();
  let stampDeps: BeefStampDeps | undefined;

  vi.doMock("@ansem/sdk", async () => {
    const actual = await vi.importActual<typeof import("@ansem/sdk")>("@ansem/sdk");
    return { ...actual, fetchBeefConfig };
  });
  vi.doMock("../src/chain.js", () => ({
    buildChain: () => ({
      conn: { getAccountInfo }, erConn: {}, program: {}, erProgram: {},
    }),
  }));
  vi.doMock("../src/beef.js", () => ({
    makeBeefStamper: (deps: BeefStampDeps) => {
      stampDeps = deps;
      return {
        init: vi.fn(async () => undefined),
        stamp: vi.fn(async () => undefined),
        enabled: () => false,
      };
    },
  }));

  const { createService } = await import("../src/service.js");
  createService(liveServiceConfig, { info: vi.fn(), warn: vi.fn(), error: vi.fn() });
  if (!stampDeps) throw new Error("service did not construct its BEEF stamper");
  return stampDeps;
}

describe("live BeefConfig probe", () => {
  it("propagates transient fetch failures for an existing BeefConfig account", async () => {
    const getAccountInfo = vi.fn(async () => ({
      data: Buffer.alloc(0), executable: false, lamports: 1,
      owner: PublicKey.unique(), rentEpoch: 0,
    }));
    const fetchBeefConfig = vi.fn(async () => { throw new Error("BEEF config RPC failed"); });
    const { probeConfig } = await captureLiveBeefDeps(getAccountInfo, fetchBeefConfig);

    await expect(probeConfig()).rejects.toThrow(/BEEF config RPC failed/);

    expect(getAccountInfo).toHaveBeenCalledTimes(1);
    expect(fetchBeefConfig).toHaveBeenCalledTimes(1);
  });

  it("returns null without decoding when the BeefConfig account is genuinely absent", async () => {
    const getAccountInfo = vi.fn(async () => null);
    const fetchBeefConfig = vi.fn(async () => { throw new Error("must not decode an absent account"); });
    const { probeConfig } = await captureLiveBeefDeps(getAccountInfo, fetchBeefConfig);

    await expect(probeConfig()).resolves.toBeNull();

    expect(getAccountInfo).toHaveBeenCalledTimes(1);
    expect(fetchBeefConfig).not.toHaveBeenCalled();
  });
});

describe("live BEEF mint token-program detection", () => {
  const unusedConfigFetch = vi.fn(async () => { throw new Error("unused"); });
  const mint = PublicKey.unique();

  it("propagates a mint-account RPC failure", async () => {
    const getAccountInfo = vi.fn(async () => { throw new Error("mint RPC failed"); });
    const { detectTokenProgram } = await captureLiveBeefDeps(getAccountInfo, unusedConfigFetch);

    await expect(detectTokenProgram(mint)).rejects.toThrow(/mint RPC failed/);
  });

  it("fails explicitly when the BEEF mint account is missing", async () => {
    const getAccountInfo = vi.fn(async () => null);
    const { detectTokenProgram } = await captureLiveBeefDeps(getAccountInfo, unusedConfigFetch);

    await expect(detectTokenProgram(mint)).rejects.toThrow(new RegExp(`BEEF mint account ${mint.toBase58()}.*not found`, "i"));
  });

  it("selects classic SPL from the mint account owner", async () => {
    const getAccountInfo = vi.fn(async () => ({ owner: TOKEN_PROGRAM_ID }));
    const { detectTokenProgram } = await captureLiveBeefDeps(getAccountInfo, unusedConfigFetch);

    await expect(detectTokenProgram(mint)).resolves.toEqual(TOKEN_PROGRAM_ID);
  });

  it("selects Token-2022 from the mint account owner", async () => {
    const getAccountInfo = vi.fn(async () => ({ owner: TOKEN_2022_PROGRAM_ID }));
    const { detectTokenProgram } = await captureLiveBeefDeps(getAccountInfo, unusedConfigFetch);

    await expect(detectTokenProgram(mint)).resolves.toEqual(TOKEN_2022_PROGRAM_ID);
  });

  it("rejects a mint account owned by an unsupported program", async () => {
    const unsupportedOwner = PublicKey.unique();
    const getAccountInfo = vi.fn(async () => ({ owner: unsupportedOwner }));
    const { detectTokenProgram } = await captureLiveBeefDeps(getAccountInfo, unusedConfigFetch);

    await expect(detectTokenProgram(mint)).rejects.toThrow(
      new RegExp(`unsupported.*${unsupportedOwner.toBase58()}`, "i"),
    );
  });
});
