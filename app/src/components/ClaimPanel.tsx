"use client";
import { RoundState } from "@ansem/sdk";
import { ClaimCountdown } from "./ClaimCountdown.js";

export interface ClaimPanelProps {
  roundId: number; roundState: RoundState; lastClaimedRound: number; busy: boolean;
  onClaim: (roundId: number) => void; onRefund: (roundId: number) => void;
  /** Absolute claim-by deadline (unix secs) = round.deadlineTs + claimWindowSecs.
   *  Undefined until the staked round's deadline is known (or no claim window). */
  claimByTs?: number;
  /** Pins the countdown clock for tests. */
  nowMs?: number;
}

export function ClaimPanel({ roundId, roundState, lastClaimedRound, busy, onClaim, onRefund, claimByTs, nowMs }: ClaimPanelProps) {
  const claimable = roundState === RoundState.Claimable && lastClaimedRound < roundId;
  const refundable = roundState === RoundState.Closed;
  if (!claimable && !refundable) return null;
  return (
    <section className="rounded-lg border border-bull-gold/30 p-3 flex items-center justify-between gap-3">
      <span className="text-bull-muted tracking-widest text-[10px]">
        ROUND #{roundId} {claimable ? "· WON" : "· VOIDED"}
      </span>
      {claimable ? (
        <div className="flex items-center gap-3">
          {claimByTs !== undefined && <ClaimCountdown deadlineTs={claimByTs} nowMs={nowMs} />}
          <button disabled={busy} onClick={() => onClaim(roundId)}
            className="rounded bg-bull-gold/25 text-bull-gold px-4 py-1 text-sm disabled:opacity-40">Claim ANSEM</button>
        </div>
      ) : (
        <button disabled={busy} onClick={() => onRefund(roundId)}
          className="rounded border border-white/15 px-4 py-1 text-sm disabled:opacity-40">Refund</button>
      )}
    </section>
  );
}
