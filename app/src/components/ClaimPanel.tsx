"use client";
import { RoundState } from "@ansem/sdk";

export interface ClaimPanelProps {
  roundId: number; roundState: RoundState; lastClaimedRound: number; busy: boolean;
  onClaim: (roundId: number) => void; onRefund: (roundId: number) => void;
}

export function ClaimPanel({ roundId, roundState, lastClaimedRound, busy, onClaim, onRefund }: ClaimPanelProps) {
  const claimable = roundState === RoundState.Claimable && lastClaimedRound < roundId;
  const refundable = roundState === RoundState.Closed;
  if (!claimable && !refundable) return null;
  return (
    <section className="rounded-lg border border-bull-gold/30 p-3 flex items-center justify-between">
      <span className="text-bull-muted tracking-widest text-[10px]">
        ROUND #{roundId} {claimable ? "· WON" : "· VOIDED"}
      </span>
      {claimable ? (
        <button disabled={busy} onClick={() => onClaim(roundId)}
          className="rounded bg-bull-gold/25 text-bull-gold px-4 py-1 text-sm disabled:opacity-40">Claim ANSEM</button>
      ) : (
        <button disabled={busy} onClick={() => onRefund(roundId)}
          className="rounded border border-white/15 px-4 py-1 text-sm disabled:opacity-40">Refund</button>
      )}
    </section>
  );
}
