"use client";
import { useEffect, useState } from "react";
import { secondsLeft, formatHms } from "../lib/format.js";

/**
 * "CLAIM BY hh:mm:ss" chip ticking down to `deadlineTs` (unix secs) =
 * round.deadlineTs + claimWindowSecs. Ticks once a second like {@link Countdown};
 * `nowMs` pins the clock for tests. Renders nothing once the window closes — an
 * expired claim would fail (the round is reaped by the janitor), so the chip
 * vanishing is the correct signal, not a stale "CLAIM BY 00:00:00".
 */
export function ClaimCountdown({ deadlineTs, nowMs }: { deadlineTs: number; nowMs?: number }) {
  const [tick, setTick] = useState(() => nowMs ?? Date.now());
  useEffect(() => {
    if (nowMs !== undefined) return; // pinned: no timer
    const id = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, [nowMs]);
  const now = nowMs ?? tick;
  const left = secondsLeft(deadlineTs, now);
  if (left <= 0) return null; // window closed -> hidden
  return (
    <span className="font-mono tabular-nums text-[10px] tracking-widest text-bull-gold/80 whitespace-nowrap">
      CLAIM BY {formatHms(left)}
    </span>
  );
}
