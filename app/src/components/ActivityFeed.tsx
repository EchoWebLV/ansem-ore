"use client";
import { type KeeperEvent } from "@ansem/sdk";
import { eventToText } from "../lib/format.js";

export function ActivityFeed({ events }: { events: KeeperEvent[] }) {
  return (
    <div className="terminal-panel p-4">
      <h2 className="text-[12px] font-semibold text-bull-ink">Recent activity</h2>
      {events.length === 0 ? (
        <p className="mt-3 text-sm text-bull-muted">Waiting for the bull…</p>
      ) : (
        <ul className="mt-2">
          {events.map((e, i) => (
            <li key={i} className="border-b border-bull-edge/70 py-2 text-sm text-bull-muted last:border-0">{eventToText(e)}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
