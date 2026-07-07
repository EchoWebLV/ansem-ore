import { RoundState, type KeeperEvent } from "@ansem/sdk";

const LAMPORTS_PER_SOL = 1_000_000_000;

/** Parse stringified lamports (wire form) into a SOL number. */
export function lamportsToSol(lamports: string): number {
  return Number(BigInt(lamports)) / LAMPORTS_PER_SOL;
}

/** Trim trailing zeros to <=4 decimals and suffix " SOL". */
export function formatSol(lamports: string): string {
  const sol = lamportsToSol(lamports);
  const s = sol.toFixed(4).replace(/\.?0+$/, "");
  return `${s} SOL`;
}

export function stateLabel(state: RoundState): string {
  switch (state) {
    case RoundState.Open: return "OPEN";
    case RoundState.VrfPending: return "SETTLING";
    case RoundState.Settled: return "REVEALED";
    case RoundState.Swapping: return "SWAPPING";
    case RoundState.Claimable: return "CLAIMABLE";
    case RoundState.Closed: return "VOID";
    default: return "—";
  }
}

/** Whole seconds until `deadlineTs` (unix secs), given `nowMs` (ms). Clamped at 0. */
export function secondsLeft(deadlineTs: number, nowMs: number): number {
  return Math.max(0, deadlineTs - Math.floor(nowMs / 1000));
}

export function formatCountdown(totalSecs: number): string {
  const s = Math.max(0, Math.floor(totalSecs));
  const mm = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

export function shortAddr(addr: string, head = 4, tail = 4): string {
  if (addr.length <= head + tail) return addr;
  return `${addr.slice(0, head)}…${addr.slice(-tail)}`;
}

/** One human-readable line per keeper event (square i -> "Bull #(i+1)"). */
export function eventToText(e: KeeperEvent): string {
  switch (e.type) {
    case "round.open": return `Round ${e.roundId} opened`;
    case "stake": return `Bull #${e.square + 1} staked → ${formatSol(e.totalStake)}`;
    case "round.settling": return `Round ${e.roundId} settling…`;
    case "round.revealed": return `Jackpot: Bull #${e.jackpotSquare + 1} struck the big pot`;
    case "round.claimable": return `Round ${e.roundId} claimable`;
  }
}
