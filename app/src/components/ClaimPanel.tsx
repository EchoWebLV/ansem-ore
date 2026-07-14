"use client";
import { RoundState } from "@ansem/sdk";
import { ClaimCountdown } from "./ClaimCountdown.js";

export interface ClaimPanelProps {
  roundId: number; roundState: RoundState; lastClaimedRound: number; busy: boolean;
  onClaim: (roundId: number) => void; onRefund: (roundId: number) => void;
  /** Absolute claim-by deadline (unix secs) = round.deadlineTs + claimWindowSecs.
   *  Undefined until the staked round's deadline is known (or no claim window). */
  claimByTs?: number;
  /** Did this player actually win the staked round? true = paid (WON, gold claim);
   *  false = zero entitlement (pot rolled to the jackpot — the claim just clears the
   *  ledger so the player can restake); null/undefined = not known yet. The claim ix
   *  is identical in every case — only the dressing changes. NEVER flash WON before
   *  this resolves. */
  won?: boolean | null;
  /** Pins the countdown clock for tests. */
  nowMs?: number;
}

export function ClaimPanel({ roundId, roundState, lastClaimedRound, busy, onClaim, onRefund, claimByTs, won, nowMs }: ClaimPanelProps) {
  const claimable = roundState === RoundState.Claimable && lastClaimedRound < roundId;
  const refundable = roundState === RoundState.Closed;
  if (!claimable && !refundable) return null;
  // Honest label: only a real win says WON; a no-win claim just clears the round
  // (the pot rolled to the jackpot); unknown stays neutral until `won` resolves.
  const tag = refundable
    ? "· VOIDED"
    : won === true ? "· WON"
    : won === false ? "· NO WIN · pot rolled to the jackpot"
    : "· SETTLED";
  return (
    <section className={`terminal-panel flex flex-col gap-3 p-4 ${won === true && claimable ? "border-bull-gold/50" : ""}`}>
      <span className="terminal-label">Round #{roundId} {tag}</span>
      {claimable ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          {claimByTs !== undefined && <ClaimCountdown deadlineTs={claimByTs} nowMs={nowMs} tone={won === true ? "gold" : "neutral"} />}
          {won === false ? (
            <button disabled={busy} onClick={() => onClaim(roundId)} className="min-h-11 rounded-[9px] border border-bull-edge bg-bull-raised px-4 py-2 text-sm disabled:opacity-40">Clear round</button>
          ) : won === true ? (
            <button disabled={busy} onClick={() => onClaim(roundId)} className="min-h-11 rounded-[9px] bg-bull-gold px-4 py-2 text-sm font-bold text-[#141109] disabled:opacity-40">Claim ANSEM</button>
          ) : (
            <button disabled={busy} onClick={() => onClaim(roundId)} className="min-h-11 rounded-[9px] border border-bull-edge bg-bull-raised px-4 py-2 text-sm disabled:opacity-40">Resolve round</button>
          )}
        </div>
      ) : (
        <button disabled={busy} onClick={() => onRefund(roundId)} className="min-h-11 self-start rounded-[9px] border border-bull-edge bg-bull-raised px-4 py-2 text-sm disabled:opacity-40">Refund</button>
      )}
    </section>
  );
}
