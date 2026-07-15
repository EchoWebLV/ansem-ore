import { RoundState, ANSEM_DECIMALS, type KeeperEvent } from "@ansem/sdk";

const LAMPORTS_PER_SOL = 1_000_000_000;
// Base-unit divisor for ANSEM display, derived from the single on-chain source of
// truth (`@ansem/sdk` ANSEM_DECIMALS = 6, verified against the mint). Never hardcode
// 1e6 — decimals live in one place so a re-mint is a one-line change.
const ANSEM_UNIT = 10 ** ANSEM_DECIMALS;

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

/** ANSEM base units -> "N ANSEM", trimmed to <=2 decimals (decimals from the SDK). */
export function formatAnsem(baseUnits: string): string {
  const n = Number(BigInt(baseUnits)) / ANSEM_UNIT;
  const s = n.toFixed(2).replace(/\.?0+$/, "");
  return `${s} ANSEM`;
}

// $BEEF is a classic-SPL, 6-decimal mint (spec 2026-07-14-beef-on-ansem-design D2;
// same base-unit scale as ANSEM, e.g. BEEF_MAX_ROUND_MINT = 210_000_000 = 210 BEEF).
const BEEF_UNIT = 10 ** 6;

/** BEEF base units -> "N BEEF", trimmed to <=2 decimals. Accepts bigint or wire string. */
export function formatBeef(baseUnits: bigint | string): string {
  const n = Number(BigInt(baseUnits)) / BEEF_UNIT;
  const s = n.toFixed(2).replace(/\.?0+$/, "");
  return `${s} BEEF`;
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

/**
 * Coarse human countdown for long horizons (the listing banner can be days out):
 * "Nd Nh Nm" once past a day, "Nh Nm" once past an hour, else mm:ss. Clamped at 0.
 */
export function formatUntil(totalSecs: number): string {
  const s = Math.max(0, Math.floor(totalSecs));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return formatCountdown(s); // under an hour -> mm:ss
}

/** hh:mm:ss for a duration in seconds. Used for the claim window (up to 24h — mm:ss would overflow). */
export function formatHms(totalSecs: number): string {
  const s = Math.max(0, Math.floor(totalSecs));
  const hh = String(Math.floor(s / 3600)).padStart(2, "0");
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
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
    case "round.revealed": return `Round ${e.roundId} revealed Bull #${e.jackpotSquare + 1}`;
    case "round.claimable": return `Round ${e.roundId} claimable`;
  }
}
