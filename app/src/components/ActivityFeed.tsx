"use client";
import { type KeeperEvent } from "@ansem/sdk";
import { eventToText } from "../lib/format.js";

export function ActivityFeed({ events }: { events: KeeperEvent[] }) {
  return (
    <div className="rounded-xl border border-bull-edge bg-bull-bg p-3">
      <h2 className="text-[10px] tracking-widest text-bull-muted mb-2">ACTIVITY</h2>
      {events.length === 0 ? (
        <p className="text-bull-muted text-sm">Waiting for the bull…</p>
      ) : (
        <ul className="space-y-1">
          {events.map((e, i) => (
            <li key={i} className="text-sm text-bull-muted">{eventToText(e)}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
