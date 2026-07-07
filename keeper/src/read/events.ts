import { RoundState, BoardSnapshot } from "@ansem/sdk";
import type { KeeperEvent } from "@ansem/sdk";
export type { KeeperEvent } from "@ansem/sdk";

/** Typed events for the transition prev -> next. `prev = null` on cold start. */
export function diffEvents(prev: BoardSnapshot | null, next: BoardSnapshot): KeeperEvent[] {
  const out: KeeperEvent[] = [];

  // New round (cold start or id advanced) that is currently open.
  if ((!prev || next.roundId !== prev.roundId) && next.state === RoundState.Open) {
    out.push({ type: "round.open", roundId: next.roundId, deadlineTs: next.deadlineTs });
  }

  if (prev && next.roundId === prev.roundId) {
    // Per-square stake increases.
    for (let i = 0; i < next.blockSol.length; i++) {
      if (next.blockSol[i] > (prev.blockSol[i] ?? 0n)) {
        out.push({ type: "stake", roundId: next.roundId, square: i, totalStake: next.blockSol[i].toString() });
      }
    }
    // State transitions.
    if (prev.state === RoundState.Open && next.state === RoundState.VrfPending) {
      out.push({ type: "round.settling", roundId: next.roundId });
    }
    if (prev.state < RoundState.Settled && next.state === RoundState.Settled && next.jackpotSquare !== null) {
      out.push({ type: "round.revealed", roundId: next.roundId, jackpotSquare: next.jackpotSquare });
    }
    if (prev.state !== RoundState.Claimable && next.state === RoundState.Claimable) {
      out.push({ type: "round.claimable", roundId: next.roundId });
    }
  }
  return out;
}
