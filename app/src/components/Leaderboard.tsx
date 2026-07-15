"use client";
import { type WireSnapshot } from "@ansem/sdk";
import { formatSol, shortAddr } from "../lib/format.js";

export function Leaderboard({ leaderboard }: { leaderboard: WireSnapshot["leaderboard"] }) {
  return (
    <div className="terminal-panel p-4">
      <h2 className="text-[12px] font-semibold text-bull-ink">Leaderboard</h2>
      {leaderboard.length === 0 ? (
        <p className="mt-3 text-sm text-bull-muted">No stakers yet.</p>
      ) : (
        <ol className="mt-2">
          {leaderboard.map((row, i) => (
            <li key={row.wallet} className="flex items-center justify-between border-b border-bull-edge/70 py-2 font-mono text-sm last:border-0">
              <span className="flex items-center gap-2 text-bull-muted">
                <span className="terminal-label w-4 text-right">{i + 1}</span>
                <span>{shortAddr(row.wallet)}</span>
              </span>
              <span className="text-bull-ink">
                {formatSol(row.totalStake)} · {row.squares.length} bulls
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
