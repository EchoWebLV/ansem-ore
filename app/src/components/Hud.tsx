"use client";
import { RoundState, type WireSnapshot } from "@ansem/sdk";
import { formatSol, stateLabel } from "../lib/format.js";
import { Countdown } from "./Countdown.js";
import type { RevealView } from "../hooks/use-reveal.js";

export interface HudProps {
  snapshot: WireSnapshot;
  nowMs?: number;
  /** Reveal overrides for the big counter + sub line (design prototype header). */
  reveal?: Pick<RevealView, "counter" | "sub" | "jackpotShown">;
}

/**
 * The design card header (docs/design/bull-board.html): .label / .big / .sub.
 * label = round + state · big = countdown (open) or the reveal counter ·
 * sub = pot line (open), "the bull awaits…" (settling), or the reveal line.
 */
export function Hud({ snapshot, nowMs, reveal }: HudProps) {
  const open = snapshot.state === RoundState.Open;
  const settling = snapshot.state === RoundState.VrfPending || snapshot.state === RoundState.Swapping;
  const gold = reveal?.sub?.gold === true;
  return (
    <div className="text-center">
      <div className="text-[12px] lg:text-[13px] tracking-[2px] text-[#8a8a93]">
        ROUND {snapshot.roundId} · <span>{stateLabel(snapshot.state)}</span>
      </div>
      <div
        className="font-mono text-[40px] lg:text-[64px] font-medium my-[2px] transition-colors duration-200"
        style={{
          color: gold ? "#e8c452" : "#35e07a",
          textShadow: gold ? "0 0 26px rgba(232,196,82,0.5)" : "0 0 20px rgba(53,224,122,0.35)",
        }}
      >
        {reveal?.counter ?? (open ? <Countdown deadlineTs={snapshot.deadlineTs} nowMs={nowMs} /> : "—")}
      </div>
      <div className="text-[12px] lg:text-[13px] min-h-[16px] text-[#8a8a93]">
        {reveal?.sub ? (
          <span style={gold ? { color: "#e8c452" } : undefined}>{reveal.sub.text}</span>
        ) : settling ? (
          "the bull awaits…"
        ) : (
          <>pot {formatSol(snapshot.pot)} · jackpot {formatSol(snapshot.jackpotPool)}</>
        )}
      </div>
    </div>
  );
}
