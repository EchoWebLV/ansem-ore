"use client";
import { RoundState, type WireSnapshot } from "@ansem/sdk";
import type { ReactNode } from "react";
import { formatSol, stateLabel } from "../lib/format.js";
import { Countdown } from "./Countdown.js";
import type { RevealView } from "../hooks/use-reveal.js";

export interface HudProps {
  snapshot: WireSnapshot;
  nowMs?: number;
  /** Reveal overrides for the big counter + sub line (design prototype header). */
  reveal?: Pick<RevealView, "counter" | "sub" | "jackpotShown">;
  /** Optional mount point for a compact account chip, such as the future BeefChip. */
  chipSlot?: ReactNode;
}

export function Hud({ snapshot, nowMs, reveal, chipSlot }: HudProps) {
  const open = snapshot.state === RoundState.Open;
  const settling = snapshot.state === RoundState.VrfPending || snapshot.state === RoundState.Swapping;
  const gold = reveal?.sub?.gold === true;
  return (
    <header
      className={`grid min-h-[78px] grid-cols-[1fr_auto_1fr] items-center border-b border-bull-edge px-4 py-3${
        chipSlot ? " sm:grid-cols-[1fr_auto_1fr_auto]" : ""
      }`}
      aria-label="Round information"
    >
      <div>
        <span className="terminal-label">Round</span>
        <div className="mt-1 text-[14px] font-semibold">
          <strong className="font-mono">#{snapshot.roundId}</strong>
          {" · "}
          <span>{stateLabel(snapshot.state)}</span>
        </div>
      </div>
      <div className="text-center">
        <span className="terminal-label">{open ? "Closes in" : settling ? "Settling" : "Result"}</span>
        <div
          className="mt-1 font-mono text-[28px] font-medium tabular-nums"
          style={{ color: gold ? "#d6b75f" : "#f2f1e9" }}
        >
          {reveal?.counter ?? (open ? <Countdown deadlineTs={snapshot.deadlineTs} nowMs={nowMs} /> : "--")}
        </div>
        {reveal?.sub ? (
          <div className="mt-1 text-[10px] text-bull-muted">{reveal.sub.text}</div>
        ) : settling ? (
          <div className="mt-1 text-[10px] text-bull-muted">the bull awaits…</div>
        ) : null}
      </div>
      <div className="text-right">
        <span className="terminal-label">Pool</span>
        <strong className="mt-1 block font-mono text-[14px] font-semibold">{formatSol(snapshot.pot)}</strong>
      </div>
      {chipSlot ? (
        <div
          className="col-span-3 mt-2 justify-self-stretch sm:col-span-1 sm:ml-3 sm:mt-0 sm:justify-self-end"
          data-testid="hud-chip-slot"
        >
          {chipSlot}
        </div>
      ) : null}
    </header>
  );
}
