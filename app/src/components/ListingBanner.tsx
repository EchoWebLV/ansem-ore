"use client";
import { useEffect, useState } from "react";
import { secondsLeft, formatUntil } from "../lib/format.js";

/** Build-time env (Next inlines NEXT_PUBLIC_*): the BEEF listing time, unix secs. */
const ENV_LISTING_TS = process.env.NEXT_PUBLIC_LISTING_TS;

/**
 * "BEEF LISTING IN <countdown>" banner. Renders ONLY when a listing time is
 * configured (`NEXT_PUBLIC_LISTING_TS`, unix secs) AND still in the future; an
 * absent env or a past date renders nothing. Ticks once a second like the round
 * countdown; `nowMs`/`listingTs` pin the clock + source for tests.
 */
export function ListingBanner({ nowMs, listingTs }: { nowMs?: number; listingTs?: number }) {
  const ts = listingTs ?? (ENV_LISTING_TS ? Number(ENV_LISTING_TS) : undefined);
  const [tick, setTick] = useState(() => nowMs ?? Date.now());
  useEffect(() => {
    if (nowMs !== undefined) return; // pinned: no timer
    const id = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, [nowMs]);

  if (ts === undefined || !Number.isFinite(ts)) return null; // not configured -> nothing
  const now = nowMs ?? tick;
  const left = secondsLeft(ts, now);
  if (left <= 0) return null; // listing time reached -> banner retires itself

  return (
    <div className="terminal-panel border-l-2 border-l-bull-green px-3 py-2 text-center">
      <span className="terminal-label text-bull-green">
        BEEF LISTING IN <span className="font-mono tabular-nums">{formatUntil(left)}</span>
      </span>
    </div>
  );
}
