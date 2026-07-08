import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { RoundState, type WireSnapshot } from "@ansem/sdk";
import { useReveal } from "./use-reveal.js";

const snap = (over: Partial<WireSnapshot> = {}): WireSnapshot => ({
  roundId: 9, state: RoundState.Open, deadlineTs: 0, pot: "0",
  blockSol: Array(25).fill("1000000000"), jackpotSquare: null, jackpotPool: "0",
  rolloverJackpot: "0", updatedAt: 1, leaderboard: [], recentEvents: [], ...over,
});

describe("useReveal", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("plays the full reveal once a round settles: 25 cells then the gold jackpot finale", () => {
    const settled = snap({ state: RoundState.Settled, jackpotSquare: 7, jackpotPool: "27720000" });
    const { result } = renderHook(() => useReveal(settled));
    expect(result.current.revealed).toEqual([]);
    act(() => { vi.advanceTimersByTime(320 + 25 * 105 + 4 * 90); });
    expect(result.current.revealed).toHaveLength(25);
    expect(result.current.jackpotShown).toBe(false);
    act(() => { vi.advanceTimersByTime(900 + 10); });
    expect(result.current.jackpotShown).toBe(true);
    expect(result.current.sub?.gold).toBe(true);
    expect(result.current.sub?.text).toMatch(/JACKPOT — bull #8/);
    expect(result.current.counter).toBe("27.72");
  });

  it("returns to the live board when the next round opens", () => {
    const settled = snap({ state: RoundState.Settled, jackpotSquare: 3 });
    const { result, rerender } = renderHook(({ s }) => useReveal(s), { initialProps: { s: settled } });
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(result.current.jackpotShown).toBe(true);
    rerender({ s: snap({ roundId: 10, state: RoundState.Open }) });
    expect(result.current.revealed).toBeNull();
    expect(result.current.counter).toBeNull();
  });

  it("a mid-reveal round transition leaves NO straggler cells lit on the fresh round", () => {
    const settled = snap({ state: RoundState.Settled, jackpotSquare: 3 });
    const { result, rerender } = renderHook(({ s }) => useReveal(s), { initialProps: { s: settled } });
    act(() => { vi.advanceTimersByTime(600); }); // reveal mid-flight (~3 cells in)
    expect(result.current.revealed!.length).toBeGreaterThan(0);
    rerender({ s: snap({ roundId: 10, state: RoundState.Open }) }); // next round opens NOW
    expect(result.current.revealed).toBeNull();
    act(() => { vi.advanceTimersByTime(10_000); }); // stale timers must stay inert
    expect(result.current.revealed).toBeNull();
    expect(result.current.jackpotShown).toBe(false);
  });

  it("does not replay the same settled round twice, but replay() does", () => {
    const settled = snap({ state: RoundState.Settled, jackpotSquare: 3 });
    const { result, rerender } = renderHook(({ s }) => useReveal(s), { initialProps: { s: settled } });
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(result.current.revealed).toHaveLength(25);
    rerender({ s: { ...settled, updatedAt: 2 } });
    act(() => { vi.advanceTimersByTime(100); });
    expect(result.current.revealed).toHaveLength(25); // untouched — no restart
    act(() => { result.current.replay(); });
    expect(result.current.revealed).toEqual([]);
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(result.current.revealed).toHaveLength(25);
  });
});
