"use client";
import { type KeeperEvent } from "@ansem/sdk";
import { eventToText } from "../lib/format.js";

/** Settle, reveal and claim moments worth surfacing as round updates. */
function isHighlight(e: KeeperEvent): boolean {
  return (
    e.type === "round.settling" ||
    e.type === "round.revealed" ||
    e.type === "round.claimable"
  );
}

/**
 * Slim horizontal ticker of recent settle/claim events. Reads the same
 * `recentEvents` / live `events` stream the ActivityFeed uses, filtered to the
 * round's payoff phases, and marquees them. Two identical copies translate -50%
 * for a seamless loop (paused under prefers-reduced-motion). Empty — or a snapshot
 * from an older keeper with no events — degrades to a quiet idle line, never a crash.
 */
export function WinTicker({ events }: { events: KeeperEvent[] }) {
  const updates = (events ?? []).filter(isHighlight).slice(0, 12);

  if (updates.length === 0) {
    return (
      <p className="min-w-0 flex-1 truncate text-[11px] text-bull-muted">
        the ring is quiet · place a bet to wake the bull
      </p>
    );
  }

  const items = updates.map((e, i) => (
    <span key={i} className="text-[11px] text-bull-muted whitespace-nowrap">
      <span className="text-bull-dim" aria-hidden>◆</span> {eventToText(e)}
    </span>
  ));

  return (
    <div className="min-w-0 flex-1 overflow-hidden" role="marquee" aria-label="recent round updates">
      <div className="flex w-max ticker-marquee">
        {/* pr-6 makes each copy self-contained (trailing gap included) so -50% loops seamlessly */}
        <div className="flex items-center gap-6 pr-6 shrink-0">{items}</div>
        <div className="flex items-center gap-6 pr-6 shrink-0" aria-hidden>{items}</div>
      </div>
    </div>
  );
}
