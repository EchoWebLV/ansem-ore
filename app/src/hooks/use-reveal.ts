"use client";
import { useEffect, useRef, useState } from "react";
import { RoundState, ANSEM_DECIMALS, type WireSnapshot } from "@ansem/sdk";

/**
 * The design prototype's settle-reveal (docs/design/bull-board.html playReveal),
 * driven by real round data. When a round settles, cells unveil in shuffled order
 * with the prototype's pacing; the counter climbs with the cumulative revealed
 * stake; the finale flashes the REAL VRF jackpot square gold. Honest theater —
 * outcomes are fixed on-chain before the first frame.
 *
 * Empty (no-miner) rounds never settle — the keeper cancels them straight to
 * Closed with no VRF draw. Those get the SWEEP: every cell lights in turn, the
 * counter holds the rolling jackpot, and the finale says the pot rolls over.
 * No fake gold square — there was no draw, and we don't pretend there was.
 */
export interface RevealView {
  /** Cell ids revealed so far; null = no reveal in progress (live board shows stakes). */
  revealed: number[] | null;
  /** True once the finale flashed the jackpot square. */
  jackpotShown: boolean;
  /** Big-counter override while playing (e.g. "0.04"), gold on finale. */
  counter: string | null;
  /** Sub-line override while playing. */
  sub: { text: string; gold: boolean } | null;
  /** Which show is running: settle theater, the empty-round sweep, or none. */
  mode: "settle" | "sweep" | null;
  /** True when there is a finished reveal to (re-)watch — drives the replay button. */
  canReplay: boolean;
  /**
   * Non-null ONLY while a replay of a PAST round runs: the stored old snapshot.
   * The Board/Hud must render from it so the gold square lands where it did
   * on-chain (the live snapshot's jackpotSquare is null once a new round opens).
   */
  snapshotOverride: WireSnapshot | null;
  replay: () => void;
}

const STEP_BASE = 320, STEP_MS = 105, END_CHOKE = 90, FINALE_MS = 900;
/** How long the sweep finale lingers before handing the HUD back to the live round. */
const SWEEP_DWELL_MS = 2600;
/** Where the last real reveal is parked so ▶ Replay survives a page reload. */
const LAST_REVEAL_KEY = "ansem.lastReveal.v1";

function shuffle<T>(a: T[]): T[] {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function useReveal(snapshot: WireSnapshot | null): RevealView {
  const [revealed, setRevealed] = useState<number[] | null>(null);
  const [jackpotShown, setJackpotShown] = useState(false);
  const [counter, setCounter] = useState<string | null>(null);
  const [sub, setSub] = useState<{ text: string; gold: boolean } | null>(null);
  const [mode, setMode] = useState<"settle" | "sweep" | null>(null);
  const [snapshotOverride, setSnapshotOverride] = useState<WireSnapshot | null>(null);
  // Bumped once when hydration restores a stored reveal, so canReplay (computed
  // from a ref at render time) surfaces without waiting for the next snapshot.
  const [, forceRender] = useState(0);
  // The id of the round whose ENDING has been handled (settle theater, sweep, or refund).
  const playedRound = useRef<number>(0);
  // The last REAL settle's snapshot (carries blockSol/jackpotSquare/jackpotPool),
  // kept so the show can be re-watched anytime. Sweeps are not stored — replay
  // is for actual jackpot reveals only.
  const lastFinished = useRef<WireSnapshot | null>(null);
  // Previous snapshot (any frame), null on first load — how we spot a missed cancel window.
  const lastSnap = useRef<WireSnapshot | null>(null);
  // True while a sweep is mid-flight, so the next round's open can't cut it short.
  const sweeping = useRef(false);
  const timers = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  // Generation token: bumped on every play/reset so a straggler timer from a
  // previous round's reveal can never write state after the board moved on.
  const gen = useRef(0);

  const clear = () => { gen.current++; timers.current.forEach(clearTimeout); timers.current = []; };

  const resetToLive = () => {
    clear();
    sweeping.current = false;
    setSnapshotOverride(null);
    setRevealed(null);
    setJackpotShown(false);
    setCounter(null);
    setSub(null);
    setMode(null);
  };

  const play = (
    snap: WireSnapshot,
    { selfDismiss = false, override = null }: { selfDismiss?: boolean; override?: WireSnapshot | null } = {},
  ) => {
    clear();
    sweeping.current = false;
    const g = gen.current;
    // Replays of past rounds hand their OWN snapshot to the board; natural
    // settles clear any lingering ghost from an interrupted replay.
    setSnapshotOverride(override);
    setMode("settle");
    setRevealed([]);
    setJackpotShown(false);
    const n = 25;
    const order = shuffle(Array.from({ length: n }, (_, i) => i));
    let cum = 0n;
    order.forEach((id, k) => {
      const extra = k > n - 5 ? (k - (n - 5)) * END_CHOKE : 0;
      timers.current.push(setTimeout(() => {
        if (gen.current !== g) return;
        cum += BigInt(snap.blockSol[id] ?? "0");
        setRevealed((r) => [...(r ?? []), id]);
        setCounter((Number(cum) / 1e9).toFixed(2));
        // Label the climbing number as the POT being scanned, not the player's take —
        // the only money-won language allowed is the actual-winner finale below.
        setSub({ text: `bull #${id + 1} mined · ${k + 1} of ${n} · pot ${(Number(cum) / 1e9).toFixed(2)} SOL`, gold: false });
      }, STEP_BASE + k * STEP_MS + extra));
    });
    timers.current.push(setTimeout(() => {
      if (gen.current !== g) return;
      setJackpotShown(true);
      if (snap.jackpotSquare !== null) {
        // jackpotPool > 0 ⟺ someone was on the drawn square and gets paid; == 0 ⟺ no
        // winner, the pot rolled into config.rolloverJackpot. Only a real winner earns gold —
        // honest theater never fabricates a win.
        const pool = BigInt(snap.jackpotPool || "0");
        if (pool > 0n) {
          // jackpotPool is ANSEM base units (never lamports) — divide by the SDK's ANSEM_DECIMALS.
          setCounter((Number(pool) / 10 ** ANSEM_DECIMALS).toFixed(2));
          setSub({ text: `★ JACKPOT — bull #${snap.jackpotSquare + 1} struck the big pot`, gold: true });
        } else {
          // Settled, but nobody staked the drawn square — no gold. The counter holds the
          // growing jackpot the same way the sweep does (the rolloverJackpot fallback).
          setCounter((Number(BigInt(snap.rolloverJackpot || "0")) / 10 ** ANSEM_DECIMALS).toFixed(2));
          setSub({ text: `nobody was on bull #${snap.jackpotSquare + 1} — pot rolls into the jackpot`, gold: false });
        }
      }
    }, STEP_BASE + n * STEP_MS + FINALE_MS));
    if (selfDismiss) {
      // Replay runs mid-Open-round must hand the board back, not squat on the
      // live HUD — same dwell the sweep uses.
      timers.current.push(setTimeout(() => {
        if (gen.current !== g) return;
        resetToLive();
      }, STEP_BASE + n * STEP_MS + FINALE_MS + SWEEP_DWELL_MS));
    }
  };

  /**
   * The empty-round show: same cascade pacing as the settle reveal, but honest —
   * no gold square (no draw happened). The counter holds the CURRENT rolling
   * jackpot; the finale announces the rollover; then, unlike settle, it hands
   * the HUD back after a short dwell (the next round is usually already open).
   */
  const playSweep = (snap: WireSnapshot) => {
    clear();
    sweeping.current = true;
    const g = gen.current;
    setSnapshotOverride(null); // sweeps always narrate the live board
    setMode("sweep");
    setRevealed([]);
    setJackpotShown(false);
    const n = 25;
    const order = shuffle(Array.from({ length: n }, (_, i) => i));
    // The jackpot people are watching roll: the stamped pool if any, else the
    // config rollover still building — the same fallback the HUD's jackpot line uses.
    const pool = BigInt(snap.jackpotPool || "0");
    const rolling = (Number(pool > 0n ? pool : BigInt(snap.rolloverJackpot || "0")) / 10 ** ANSEM_DECIMALS).toFixed(2);
    order.forEach((id, k) => {
      const extra = k > n - 5 ? (k - (n - 5)) * END_CHOKE : 0;
      timers.current.push(setTimeout(() => {
        if (gen.current !== g) return;
        setRevealed((r) => [...(r ?? []), id]);
        setCounter(rolling);
        setSub({ text: `bull #${id + 1} scanned · ${k + 1} of ${n}`, gold: false });
      }, STEP_BASE + k * STEP_MS + extra));
    });
    timers.current.push(setTimeout(() => {
      if (gen.current !== g) return;
      setJackpotShown(true);
      setSub({ text: "no miners — jackpot rolls to the next round", gold: false });
    }, STEP_BASE + n * STEP_MS + FINALE_MS));
    // Self-dismiss: the sweep must not squat on the (already open) next round's HUD.
    timers.current.push(setTimeout(() => {
      if (gen.current !== g) return;
      resetToLive();
    }, STEP_BASE + n * STEP_MS + FINALE_MS + SWEEP_DWELL_MS));
  };

  useEffect(() => {
    if (!snapshot) return;
    const prev = lastSnap.current;
    if (snapshot.state >= RoundState.Settled && snapshot.state !== RoundState.Closed) {
      if (playedRound.current !== snapshot.roundId) {
        playedRound.current = snapshot.roundId;
        play(snapshot);
        lastFinished.current = snapshot; // latest real reveal wins the replay slot
        // Best-effort persistence: replay should survive a reload (quota/SSR misses are fine).
        try { window.localStorage?.setItem(LAST_REVEAL_KEY, JSON.stringify(snapshot)); } catch { /* ignore */ }
      }
    } else if (snapshot.state === RoundState.Closed && playedRound.current !== snapshot.roundId) {
      playedRound.current = snapshot.roundId;
      if (BigInt(snapshot.pot || "0") === 0n) {
        // Cancelled empty round, sighted directly — play the honest sweep.
        playSweep(snapshot);
      } else {
        // Refund case (real pot, round scrapped) — celebration would be wrong.
        resetToLive();
      }
    } else if (snapshot.state === RoundState.Open && playedRound.current !== snapshot.roundId) {
      if (
        prev !== null &&
        prev.roundId !== snapshot.roundId &&
        playedRound.current !== prev.roundId &&
        BigInt(prev.pot || "0") === 0n
      ) {
        // The empty round's brief Closed window was missed entirely; the sweep
        // decision comes FIRST so the reset below can't swallow it.
        playedRound.current = prev.roundId;
        playSweep(snapshot);
      } else if (!sweeping.current) {
        // A fresh round opened — back to the live board (kills stragglers).
        // Skipped while a sweep is mid-flight: it self-dismisses on its own.
        resetToLive();
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot?.roundId, snapshot?.state]);

  // Record every frame AFTER the decision effect read the previous one (effects
  // run in declaration order), so `lastSnap` always holds the true prior frame —
  // including pot growth ticks that never re-fire the decision effect.
  useEffect(() => { lastSnap.current = snapshot; });

  // One-time hydration: restore the last real reveal after a reload. Runs in an
  // effect (not render) so SSR markup stays canReplay-false and hydration matches.
  useEffect(() => {
    if (lastFinished.current !== null || typeof window === "undefined") return;
    try {
      const raw = window.localStorage?.getItem(LAST_REVEAL_KEY);
      if (!raw) return;
      const stored = JSON.parse(raw) as WireSnapshot;
      // Minimal shape check: a replayable show needs a full board and a real draw.
      if (Array.isArray(stored?.blockSol) && stored.blockSol.length === 25 && stored.jackpotSquare != null) {
        lastFinished.current = stored;
        forceRender((x) => x + 1);
      }
    } catch { /* corrupted key — replay simply stays unavailable */ }
  }, []);

  useEffect(() => clear, []);

  return {
    revealed, jackpotShown, counter, sub, mode, snapshotOverride,
    canReplay:
      lastFinished.current !== null ||
      (snapshot !== null && snapshot.state >= RoundState.Settled && snapshot.state !== RoundState.Closed),
    replay: () => {
      if (snapshot && snapshot.state >= RoundState.Settled && snapshot.state !== RoundState.Closed) {
        // The settled round is still on screen — replay it in place (persists
        // until the next round opens, exactly the old behavior).
        play(snapshot);
        return;
      }
      const lf = lastFinished.current;
      if (!lf) return;
      // Replaying a PAST round: run its show from its own snapshot, then
      // self-dismiss so the live round gets its board back.
      play(lf, { selfDismiss: true, override: lf });
    },
  };
}
