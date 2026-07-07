import { describe, it, expect } from "vitest";
import { RoundState } from "@ansem/sdk";
import { diffEvents } from "../src/read/events.js";
import type { BoardSnapshot } from "@ansem/sdk";

const grid = (over: Record<number, bigint> = {}) =>
  Array.from({ length: 25 }, (_, i) => over[i] ?? 0n);

const snap = (over: Partial<BoardSnapshot>): BoardSnapshot => ({
  roundId: 100, state: RoundState.Open, deadlineTs: 5000, pot: 0n, blockSol: grid(),
  jackpotSquare: null, jackpotPool: 0n, rolloverJackpot: 0n, updatedAt: 0, ...over,
});

describe("diffEvents", () => {
  it("emits round.open for a brand-new open round", () => {
    const ev = diffEvents(null, snap({}));
    expect(ev).toEqual([{ type: "round.open", roundId: 100, deadlineTs: 5000 }]);
  });

  it("emits round.open when the round id advances", () => {
    const ev = diffEvents(snap({ roundId: 100 }), snap({ roundId: 101 }));
    expect(ev.some((e) => e.type === "round.open" && e.roundId === 101)).toBe(true);
  });

  it("emits a stake event when a square's stake grows", () => {
    const ev = diffEvents(snap({ blockSol: grid({ 3: 2n }) }), snap({ blockSol: grid({ 3: 9n }), pot: 9n }));
    expect(ev).toContainEqual({ type: "stake", roundId: 100, square: 3, totalStake: "9" });
  });

  it("emits round.settling on Open->VrfPending", () => {
    const ev = diffEvents(snap({}), snap({ state: RoundState.VrfPending }));
    expect(ev).toContainEqual({ type: "round.settling", roundId: 100 });
  });

  it("emits round.revealed on ->Settled with the jackpot square", () => {
    const ev = diffEvents(snap({ state: RoundState.VrfPending }),
      snap({ state: RoundState.Settled, jackpotSquare: 7 }));
    expect(ev).toContainEqual({ type: "round.revealed", roundId: 100, jackpotSquare: 7 });
  });

  it("emits round.claimable on ->Claimable", () => {
    const ev = diffEvents(snap({ state: RoundState.Settled }), snap({ state: RoundState.Claimable }));
    expect(ev).toContainEqual({ type: "round.claimable", roundId: 100 });
  });

  it("emits nothing on an identical snapshot", () => {
    const s = snap({ blockSol: grid({ 1: 1n }) });
    expect(diffEvents(s, s)).toEqual([]);
  });
});
