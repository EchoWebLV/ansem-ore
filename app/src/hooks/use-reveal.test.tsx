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
  beforeEach(() => { vi.useFakeTimers(); window.localStorage.clear(); });
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

  it("no-winner settle: the finale is NOT gold and says the pot rolled into the jackpot", () => {
    // The square was drawn but nobody staked it -> jackpotPool 0, proceeds rolled into
    // the (now larger) rolloverJackpot. Honest theater: no gold, no fabricated win.
    const settled = snap({ state: RoundState.Settled, jackpotSquare: 4, jackpotPool: "0", rolloverJackpot: "12500000" });
    const { result } = renderHook(() => useReveal(settled));
    act(() => { vi.advanceTimersByTime(320 + 25 * 105 + 4 * 90); });
    expect(result.current.jackpotShown).toBe(false);
    act(() => { vi.advanceTimersByTime(900 + 10); });
    expect(result.current.jackpotShown).toBe(true);
    expect(result.current.sub?.gold).toBe(false);
    expect(result.current.sub?.text).toMatch(/nobody was on bull #5/);
    expect(result.current.sub?.text).toMatch(/pot rolls into the jackpot/);
    expect(result.current.counter).toBe("12.50"); // the growing jackpot, ANSEM units
  });

  it("labels the climbing settle counter as the POT being scanned, not winnings", () => {
    const settled = snap({ state: RoundState.Settled, jackpotSquare: 7, jackpotPool: "27720000" });
    const { result } = renderHook(() => useReveal(settled));
    act(() => { vi.advanceTimersByTime(320 + 3 * 105); }); // mid-cascade, a few cells in
    expect(result.current.sub?.gold).toBe(false);
    expect(result.current.sub?.text).toMatch(/pot \d+\.\d\d SOL/);
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

  it("plays the honest sweep when an empty round's cancel is sighted directly, then self-dismisses", () => {
    const open = snap({ roundId: 9, pot: "0", blockSol: Array(25).fill("0"), rolloverJackpot: "5000000" });
    const { result, rerender } = renderHook(({ s }) => useReveal(s), { initialProps: { s: open } });
    expect(result.current.revealed).toBeNull();
    rerender({ s: { ...open, state: RoundState.Closed } });
    expect(result.current.mode).toBe("sweep");
    expect(result.current.revealed).toEqual([]);
    act(() => { vi.advanceTimersByTime(320 + 25 * 105 + 4 * 90); });
    expect(result.current.revealed).toHaveLength(25);
    expect(result.current.jackpotShown).toBe(false);
    expect(result.current.counter).toBe("5.00"); // the rolling jackpot, ANSEM units
    expect(result.current.sub?.text).toMatch(/scanned · 25 of 25/);
    act(() => { vi.advanceTimersByTime(900 + 10); });
    expect(result.current.jackpotShown).toBe(true);
    expect(result.current.sub).toEqual({ text: "no miners — jackpot rolls to the next round", gold: false });
    expect(result.current.mode).toBe("sweep");
    // Unlike settle, the sweep hands the HUD back to the live round after a short dwell.
    act(() => { vi.advanceTimersByTime(2600 + 10); });
    expect(result.current.revealed).toBeNull();
    expect(result.current.jackpotShown).toBe(false);
    expect(result.current.counter).toBeNull();
    expect(result.current.sub).toBeNull();
    expect(result.current.mode).toBeNull();
  });

  it("plays NO theater when a round closes with a real pot (refund case)", () => {
    const open = snap({ roundId: 9, pot: "2000000000" });
    const { result, rerender } = renderHook(({ s }) => useReveal(s), { initialProps: { s: open } });
    rerender({ s: { ...open, state: RoundState.Closed } });
    expect(result.current.revealed).toBeNull();
    expect(result.current.mode).toBeNull();
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(result.current.revealed).toBeNull();
    expect(result.current.jackpotShown).toBe(false);
  });

  it("sweeps when a new round opens over an unhandled empty previous round (missed Closed frame)", () => {
    const prev = snap({ roundId: 9, pot: "0", blockSol: Array(25).fill("0") });
    const { result, rerender } = renderHook(({ s }) => useReveal(s), { initialProps: { s: prev } });
    act(() => { vi.advanceTimersByTime(5_000); });
    expect(result.current.revealed).toBeNull(); // merely-open rounds never sweep
    rerender({ s: snap({ roundId: 10, state: RoundState.Open, pot: "0", blockSol: Array(25).fill("0") }) });
    expect(result.current.mode).toBe("sweep");
    act(() => { vi.advanceTimersByTime(320 + 25 * 105 + 900 + 20); });
    expect(result.current.revealed).toHaveLength(25);
    expect(result.current.jackpotShown).toBe(true);
  });

  it("never sweeps on the very first snapshot (fresh page load into an open round)", () => {
    const { result } = renderHook(() =>
      useReveal(snap({ roundId: 42, pot: "0", blockSol: Array(25).fill("0") })),
    );
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(result.current.revealed).toBeNull();
    expect(result.current.mode).toBeNull();
  });

  it("settle theater reports mode 'settle' and persists until the next round (no self-dismiss)", () => {
    const settled = snap({ state: RoundState.Settled, jackpotSquare: 3 });
    const { result } = renderHook(() => useReveal(settled));
    expect(result.current.mode).toBe("settle");
    act(() => { vi.advanceTimersByTime(30_000); });
    expect(result.current.jackpotShown).toBe(true);
    expect(result.current.mode).toBe("settle");
    expect(result.current.revealed).toHaveLength(25);
  });

  it("replays the last settled round during the next open round from its own snapshot, then self-dismisses", () => {
    const settled = snap({ roundId: 9, state: RoundState.Settled, jackpotSquare: 7, jackpotPool: "27720000" });
    const { result, rerender } = renderHook(({ s }) => useReveal(s), { initialProps: { s: settled } });
    expect(result.current.canReplay).toBe(true); // old condition: current round is settled
    act(() => { vi.advanceTimersByTime(10_000); });
    rerender({ s: snap({ roundId: 10, state: RoundState.Open }) });
    expect(result.current.revealed).toBeNull();
    expect(result.current.canReplay).toBe(true); // the state where the old button died
    act(() => { result.current.replay(); });
    expect(result.current.snapshotOverride).toBe(settled); // Board must render the OLD round
    expect(result.current.mode).toBe("settle");
    expect(result.current.revealed).toEqual([]);
    act(() => { vi.advanceTimersByTime(320 + 25 * 105 + 900 + 20); });
    expect(result.current.revealed).toHaveLength(25);
    expect(result.current.jackpotShown).toBe(true);
    expect(result.current.sub?.text).toMatch(/JACKPOT — bull #8/);
    // Replays of past rounds self-dismiss after the dwell — back to the live board.
    act(() => { vi.advanceTimersByTime(2600 + 20); });
    expect(result.current.snapshotOverride).toBeNull();
    expect(result.current.revealed).toBeNull();
    expect(result.current.mode).toBeNull();
    expect(result.current.canReplay).toBe(true); // still replayable again
  });

  it("sweeps are not replayable — canReplay stays false when only an empty round has run", () => {
    const open = snap({ roundId: 9, pot: "0", blockSol: Array(25).fill("0") });
    const { result, rerender } = renderHook(({ s }) => useReveal(s), { initialProps: { s: open } });
    rerender({ s: { ...open, state: RoundState.Closed } });
    act(() => { vi.advanceTimersByTime(20_000); }); // sweep + dwell fully done
    expect(result.current.canReplay).toBe(false);
    rerender({ s: snap({ roundId: 10, state: RoundState.Open, pot: "0", blockSol: Array(25).fill("0") }) });
    expect(result.current.canReplay).toBe(false);
    act(() => { result.current.replay(); }); // must be a no-op
    expect(result.current.revealed).toBeNull();
    // Sweeps are never persisted either — nothing to hydrate after a reload.
    expect(window.localStorage.getItem("ansem.lastReveal.v1")).toBeNull();
  });

  it("canReplay is false on a fresh mount into an open round", () => {
    const { result } = renderHook(() => useReveal(snap({ roundId: 42 })));
    expect(result.current.canReplay).toBe(false);
  });

  it("persists the settled snapshot to localStorage for post-reload replay", () => {
    const settled = snap({ roundId: 9, state: RoundState.Settled, jackpotSquare: 7 });
    renderHook(() => useReveal(settled));
    const raw = window.localStorage.getItem("ansem.lastReveal.v1");
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!)).toMatchObject({ roundId: 9, jackpotSquare: 7 });
  });

  it("hydrates replay from localStorage — Replay exists right after a reload", () => {
    const stored = snap({ roundId: 8, state: RoundState.Settled, jackpotSquare: 4, jackpotPool: "5000000" });
    window.localStorage.setItem("ansem.lastReveal.v1", JSON.stringify(stored));
    const { result } = renderHook(() => useReveal(snap({ roundId: 9, state: RoundState.Open })));
    expect(result.current.canReplay).toBe(true);
    act(() => { result.current.replay(); });
    expect(result.current.snapshotOverride).toMatchObject({ roundId: 8, jackpotSquare: 4 });
    expect(result.current.mode).toBe("settle");
    act(() => { vi.advanceTimersByTime(320 + 25 * 105 + 900 + 20); });
    expect(result.current.jackpotShown).toBe(true);
    expect(result.current.sub?.text).toMatch(/bull #5/);
  });

  it("ignores garbage in the replay key — canReplay stays false, no throw", () => {
    window.localStorage.setItem("ansem.lastReveal.v1", "{not json");
    const { result } = renderHook(() => useReveal(snap({ roundId: 9 })));
    expect(result.current.canReplay).toBe(false);
    // Valid JSON with the wrong shape is discarded too (no jackpot square = no show).
    window.localStorage.setItem("ansem.lastReveal.v1", JSON.stringify({ blockSol: [], jackpotSquare: null }));
    const second = renderHook(() => useReveal(snap({ roundId: 9 })));
    expect(second.result.current.canReplay).toBe(false);
  });

  it("a newer settle overwrites the remembered show — replay plays the newest round", () => {
    const s9 = snap({ roundId: 9, state: RoundState.Settled, jackpotSquare: 3, jackpotPool: "1000000" });
    const { result, rerender } = renderHook(({ s }) => useReveal(s), { initialProps: { s: s9 } });
    act(() => { vi.advanceTimersByTime(10_000); });
    rerender({ s: snap({ roundId: 10, state: RoundState.Open }) });
    rerender({ s: snap({ roundId: 10, state: RoundState.Settled, jackpotSquare: 6, jackpotPool: "42000000" }) });
    act(() => { vi.advanceTimersByTime(10_000); });
    rerender({ s: snap({ roundId: 11, state: RoundState.Open }) });
    act(() => { result.current.replay(); });
    act(() => { vi.advanceTimersByTime(320 + 25 * 105 + 900 + 20); });
    expect(result.current.sub?.text).toMatch(/bull #7 struck/);
    expect(result.current.counter).toBe("42.00");
  });
});
