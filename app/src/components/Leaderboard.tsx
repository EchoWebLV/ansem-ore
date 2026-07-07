"use client";
import { type WireSnapshot } from "@ansem/sdk";
import { formatSol, shortAddr } from "../lib/format.js";

export function Leaderboard({ leaderboard }: { leaderboard: WireSnapshot["leaderboard"] }) {
  return (
    <div className="rounded-xl border border-bull-edge bg-bull-bg p-3">
      <h2 className="text-[10px] tracking-widest text-bull-muted mb-2">LEADERBOARD</h2>
      {leaderboard.length === 0 ? (
        <p className="text-bull-muted text-sm">No stakers yet.</p>
      ) : (
        <ol className="space-y-1">
          {leaderboard.map((row, i) => (
            <li key={row.wallet} className="flex items-center justify-between text-sm font-mono">
              <span className="flex items-center gap-2 text-bull-muted">
                <span className="text-bull-edge w-4 text-right">{i + 1}</span>
                <span>{shortAddr(row.wallet)}</span>
              </span>
              <span className="text-bull-green">
                {formatSol(row.totalStake)} · {row.squares.length} bulls
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
