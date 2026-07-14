"use client";
import { formatAnsem } from "../lib/format.js";

/**
 * Jackpot odometer. `rolloverJackpot` is the rolling pot in ANSEM base units
 * (6 decimals) — NOT lamports: misses feed it and a random jackpot round pays it
 * out. `triggerOdds` (1-in-N) is forward-looking — snapshots from an older keeper
 * omit it, so the odds line renders only when the field is present. Missing/empty
 * jackpot value degrades to "0 ANSEM" rather than crashing (null-safe against the
 * keeper being upgraded in parallel).
 */
export function JackpotMeter({
  rolloverJackpot,
  triggerOdds,
}: {
  rolloverJackpot?: string | null;
  triggerOdds?: number | null;
}) {
  // formatAnsem always returns "<amount> ANSEM"; split for an odometer look
  // (big digits, small unit). `|| "0"` mirrors the Hud's null-safe read.
  const [amount, unit] = formatAnsem(rolloverJackpot || "0").split(" ");
  const showOdds = typeof triggerOdds === "number" && triggerOdds > 1;
  return (
    <div className="terminal-panel p-4 text-center">
      <h2 className="text-[12px] font-semibold text-bull-ink">Jackpot</h2>
      <div className="mt-3 font-mono tabular-nums text-[30px] font-medium leading-none text-bull-gold lg:text-[36px]">
        {/* keyed on the value so a change replays the odometer pop */}
        <span key={amount} className="odometer-pop inline-block">{amount}</span>
        <span className="ml-1 align-middle text-[12px] text-bull-muted">{unit}</span>
      </div>
      <p className="terminal-label mt-3">grows every miss</p>
      {showOdds && (
        <p className="terminal-label mt-1">{`jackpot round odds 1-in-${triggerOdds}`}</p>
      )}
    </div>
  );
}
