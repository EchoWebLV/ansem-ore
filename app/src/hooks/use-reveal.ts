"use client";
import { useEffect, useRef, useState } from "react";
import { RoundState, ANSEM_DECIMALS, type WireSnapshot } from "@ansem/sdk";

/**
 * The design prototype's settle-reveal (docs/design/bull-board.html playReveal),
 * driven by real round data. When a round settles, cells unveil in shuffled order
 * with the prototype's pacing; the counter climbs with the cumulative revealed
 * stake; the finale flashes the REAL VRF jackpot square gold. Honest theater —
 * outcomes are fixed on-chain before the first frame.
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
  replay: () => void;
}

const STEP_BASE = 320, STEP_MS = 105, END_CHOKE = 90, FINALE_MS = 900;

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
  const playedRound = useRef<number>(0);
  const timers = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  // Generation token: bumped on every play/reset so a straggler timer from a
  // previous round's reveal can never write state after the board moved on.
  const gen = useRef(0);

  const clear = () => { gen.current++; timers.current.forEach(clearTimeout); timers.current = []; };

  const play = (snap: WireSnapshot) => {
    clear();
    const g = gen.current;
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
        setSub({ text: `bull #${id + 1} mined · ${k + 1} of ${n} revealed`, gold: false });
      }, STEP_BASE + k * STEP_MS + extra));
    });
    timers.current.push(setTimeout(() => {
      if (gen.current !== g) return;
      setJackpotShown(true);
      if (snap.jackpotSquare !== null) {
        // jackpotPool is ANSEM base units (never lamports) — divide by the SDK's ANSEM_DECIMALS.
        setCounter((Number(BigInt(snap.jackpotPool || "0")) / 10 ** ANSEM_DECIMALS).toFixed(2));
        setSub({ text: `★ JACKPOT — bull #${snap.jackpotSquare + 1} struck the big pot`, gold: true });
      }
    }, STEP_BASE + n * STEP_MS + FINALE_MS));
  };

  useEffect(() => {
    if (!snapshot) return;
    if (snapshot.state >= RoundState.Settled && snapshot.state !== RoundState.Closed) {
      if (playedRound.current !== snapshot.roundId) {
        playedRound.current = snapshot.roundId;
        play(snapshot);
      }
    } else if (snapshot.state === RoundState.Open && playedRound.current !== snapshot.roundId) {
      // A fresh round opened — back to the live board (unconditional; kills stragglers).
      clear();
      setRevealed(null);
      setJackpotShown(false);
      setCounter(null);
      setSub(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot?.roundId, snapshot?.state]);

  useEffect(() => clear, []);

  return {
    revealed, jackpotShown, counter, sub,
    replay: () => { if (snapshot && snapshot.state >= RoundState.Settled) play(snapshot); },
  };
}
