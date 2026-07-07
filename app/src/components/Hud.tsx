"use client";
import { type WireSnapshot } from "@ansem/sdk";
import { formatSol, stateLabel } from "../lib/format.js";
import { Countdown } from "./Countdown.js";

export interface HudProps { snapshot: WireSnapshot; nowMs?: number; }

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center px-3">
      <span className="text-[10px] tracking-widest text-bull-muted">{label}</span>
      <span className="text-lg font-mono text-bull-green">{children}</span>
    </div>
  );
}

export function Hud({ snapshot, nowMs }: HudProps) {
  return (
    <div className="rounded-xl border border-bull-edge bg-bull-bg py-3 px-2">
      <div className="flex items-center justify-between px-3 pb-2">
        <span className="font-mono text-sm text-white">Round {snapshot.roundId}</span>
        <span className="font-mono text-xs tracking-widest text-bull-green">{stateLabel(snapshot.state)}</span>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-y-2">
        <Stat label="POOL">{formatSol(snapshot.pot)}</Stat>
        <Stat label="JACKPOT">{formatSol(snapshot.jackpotPool)}</Stat>
        <Stat label="ENDS IN"><Countdown deadlineTs={snapshot.deadlineTs} nowMs={nowMs} /></Stat>
      </div>
    </div>
  );
}
