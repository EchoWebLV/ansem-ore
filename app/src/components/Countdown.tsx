"use client";
import { useEffect, useState } from "react";
import { secondsLeft, formatCountdown } from "../lib/format.js";

/** Live mm:ss to `deadlineTs`. `nowMs` (optional) pins the clock for tests. */
export function Countdown({ deadlineTs, nowMs }: { deadlineTs: number; nowMs?: number }) {
  const [tick, setTick] = useState(() => nowMs ?? Date.now());
  useEffect(() => {
    if (nowMs !== undefined) return; // pinned: no timer
    const id = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, [nowMs]);
  const now = nowMs ?? tick;
  return <span className="font-mono tabular-nums">{formatCountdown(secondsLeft(deadlineTs, now))}</span>;
}
