import { describe, it, expect, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useKeeperSnapshot } from "./use-keeper-snapshot.js";
import type { KeeperClient, KeeperClientOpts } from "../lib/keeper-client.js";
import type { WireSnapshot } from "@ansem/sdk";

const wireSnap = (roundId: number): WireSnapshot => ({
  roundId, state: 0, deadlineTs: 0, pot: "0", blockSol: Array(25).fill("0"),
  jackpotSquare: null, jackpotPool: "0", rolloverJackpot: "0", updatedAt: 1,
  leaderboard: [], recentEvents: [],
});

describe("useKeeperSnapshot", () => {
  it("exposes the latest snapshot and status from an injected client factory", async () => {
    let captured: KeeperClientOpts | null = null;
    const factory = vi.fn((opts: KeeperClientOpts): KeeperClient => {
      captured = opts;
      return { start: () => {}, stop: () => {} };
    });

    const { result } = renderHook(() =>
      useKeeperSnapshot({ wsUrl: "ws://x", httpUrl: "http://x", clientFactory: factory }));

    expect(result.current.status).toBe("connecting");
    expect(result.current.snapshot).toBeNull();

    act(() => { captured!.onStatus?.("connected"); captured!.onSnapshot(wireSnap(9)); });
    await waitFor(() => expect(result.current.snapshot?.roundId).toBe(9));
    expect(result.current.status).toBe("connected");
  });

  it("accumulates events newest-first, capped", async () => {
    let captured: KeeperClientOpts | null = null;
    const factory = (opts: KeeperClientOpts): KeeperClient => { captured = opts; return { start: () => {}, stop: () => {} }; };
    const { result } = renderHook(() =>
      useKeeperSnapshot({ wsUrl: "ws://x", httpUrl: "http://x", clientFactory: factory, maxEvents: 3 }));

    act(() => { captured!.onEvents?.([{ type: "round.open", roundId: 1, deadlineTs: 0 }]); });
    act(() => { captured!.onEvents?.([{ type: "round.claimable", roundId: 1 }]); });
    await waitFor(() => expect(result.current.events).toHaveLength(2));
    expect(result.current.events[0].type).toBe("round.claimable"); // newest first
  });
});
