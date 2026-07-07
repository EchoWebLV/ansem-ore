// packages/sdk/test/wire.test.ts
import { describe, it, expect } from "vitest";
import { RoundState, GRID_SIZE } from "../src/constants.js";
import type { FullSnapshot, WireSnapshot } from "../src/wire.js";

// The keeper serializes with this exact replacer (see keeper/src/read/server.ts).
const jsonSafe = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);

describe("wire snapshot contract", () => {
  it("serializes bigints to strings and preserves the 25-square grid", () => {
    const snap: FullSnapshot = {
      roundId: 42, state: RoundState.Open, deadlineTs: 1_700_000_000, pot: 1234n,
      blockSol: Array.from({ length: GRID_SIZE }, (_, i) => BigInt(i)),
      jackpotSquare: null, jackpotPool: 0n, rolloverJackpot: 500n, updatedAt: 1_700_000_001,
      leaderboard: [{ wallet: "abc", totalStake: 999n, squares: [3, 7] }],
      recentEvents: [{ type: "round.open", roundId: 42, deadlineTs: 1_700_000_000 }],
    };
    const wire = JSON.parse(JSON.stringify(snap, jsonSafe)) as WireSnapshot;
    expect(typeof wire.pot).toBe("string");
    expect(wire.pot).toBe("1234");
    expect(wire.blockSol).toHaveLength(GRID_SIZE);
    expect(typeof wire.blockSol[5]).toBe("string");
    expect(typeof wire.leaderboard[0].totalStake).toBe("string");
    expect(wire.leaderboard[0].squares).toEqual([3, 7]);
    expect(wire.recentEvents[0].type).toBe("round.open");
  });
});
