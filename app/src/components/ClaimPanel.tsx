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
  /** Terse muted note shown under the label. Carries the essential gate message when
   *  the panel occupies the bet-slip slot ("resolve this round to bet again"), so the
   *  standalone amber hint isn't shown alongside. Absent → no note. */
  gateNote?: string;
  /** The claim transaction will bundle the BEEF roll for this round: its BEEF share is
   *  banked (rollBeef prepended) before claim_direct zeroes the stake it's derived from.
   *  Set ONLY when the bundle is genuine (BEEF live AND this round's BeefRound exists);
   *  absent/false → no line. States a real on-chain effect, nothing more (D12). */
  beefBanked?: boolean;
}

export function ClaimPanel({ roundId, roundState, lastClaimedRound, busy, onClaim, onRefund, claimByTs, won, nowMs, gateNote, beefBanked }: ClaimPanelProps) {
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
      {gateNote && <p className="text-[11px] text-bull-muted">{gateNote}</p>}
      {claimable ? (
        <div className="flex flex-col gap-2">
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
          {beefBanked && <p className="text-[10px] text-bull-muted">beef share banked · bonus keeps growing</p>}
        </div>
      ) : (
        <button disabled={busy} onClick={() => onRefund(roundId)} className="min-h-11 self-start rounded-[9px] border border-bull-edge bg-bull-raised px-4 py-2 text-sm disabled:opacity-40">Refund</button>
      )}
    </section>
  );
}
