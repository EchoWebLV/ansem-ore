import { describe, it, expect } from "vitest";
import { RoundState } from "@ansem/sdk";
import { buildFullSnapshot, MinerRow } from "../src/read/snapshot.js";
import type { KeeperEvent } from "../src/read/events.js";

const grid = (over: Record<number, bigint> = {}) =>
  Array.from({ length: 25 }, (_, i) => over[i] ?? 0n);

const round = {
  roundId: 100, deadlineTs: 5000, blockSol: grid({ 3: 10n, 7: 5n }), pot: 15n,
  state: RoundState.Open, randomness: new Array(32).fill(0), jackpotSquare: 0,
  jackpotPool: 0n, swapProceeds: 0n,
};
const config = {
  admin: "A", ansemMint: "M", swapMode: 0, currentRoundId: 100, roundDurationSecs: 60,
  feeBps: 0, multMinBps: 5000, multMaxBps: 5000, minStake: 0n, maxStakePerRound: 0n,
  mockRate: 1n, totalEscrowBalance: 100n, rolloverJackpot: 4n, currentRoundFinalized: false,
};

describe("buildFullSnapshot", () => {
  it("wraps the SDK BoardSnapshot and appends a stake-sorted leaderboard", () => {
    const miners: MinerRow[] = [
      { wallet: "alice", blockStake: grid({ 3: 8n }) },
      { wallet: "bob", blockStake: grid({ 3: 2n, 7: 5n }) },
    ];
    const events: KeeperEvent[] = [{ type: "round.open", roundId: 100, deadlineTs: 5000 }];
    const snap = buildFullSnapshot(round as any, config as any, miners, events, 999);

    expect(snap.roundId).toBe(100);
    expect(snap.state).toBe(RoundState.Open);
    expect(snap.pot).toBe(15n);
    expect(snap.blockSol[3]).toBe(10n);
    expect(snap.jackpotSquare).toBeNull(); // hidden pre-settle
    expect(snap.updatedAt).toBe(999);
    // bob has 7 total, alice 8 -> alice first
    expect(snap.leaderboard.map((r) => r.wallet)).toEqual(["alice", "bob"]);
    expect(snap.leaderboard[0].totalStake).toBe(8n);
    expect(snap.recentEvents).toHaveLength(1);
  });

  it("reveals the jackpot square once settled", () => {
    const settled = { ...round, state: RoundState.Settled, jackpotSquare: 7 };
    const snap = buildFullSnapshot(settled as any, config as any, [], [], 1);
    expect(snap.jackpotSquare).toBe(7);
  });
});
