import type { BoardSnapshot } from "./accounts.js";
import type { RoundState } from "./constants.js";

/** A staker's per-square stake snapshot (in-memory, keeper-side). */
export interface MinerRow { wallet: string; blockStake: bigint[]; }

/** One leaderboard entry (in-memory, keeper-side). */
export interface LeaderRow { wallet: string; totalStake: bigint; squares: number[]; }

/** Typed keeper events for a prev -> next board transition (already wire-safe: no bigint fields). */
export type KeeperEvent =
  | { type: "round.open"; roundId: number; deadlineTs: number }
  | { type: "stake"; roundId: number; square: number; totalStake: string }
  | { type: "round.settling"; roundId: number }
  | { type: "round.revealed"; roundId: number; jackpotSquare: number }
  | { type: "round.claimable"; roundId: number };

/** The full live board state the keeper holds in memory and serves to browsers. */
export interface FullSnapshot extends BoardSnapshot {
  leaderboard: LeaderRow[];
  recentEvents: KeeperEvent[];
}

/**
 * The JSON shape actually received over WS/REST: identical to FullSnapshot but with
 * every bigint serialized to a decimal string (keeper's jsonSafe replacer). Consumers
 * parse these with BigInt(...) at format time (no precision loss).
 */
export interface WireSnapshot {
  roundId: number; state: RoundState; deadlineTs: number;
  pot: string; blockSol: string[]; jackpotSquare: number | null;
  jackpotPool: string; rolloverJackpot: string; updatedAt: number;
  leaderboard: { wallet: string; totalStake: string; squares: number[] }[];
  recentEvents: KeeperEvent[];
}

/** A live WS push frame. */
export interface WireMessage { snapshot: WireSnapshot; events: KeeperEvent[]; }

/** Recursively replace `bigint` with its decimal-string wire form. */
type Stringify<T> =
  T extends bigint ? string :
  T extends (infer U)[] ? Stringify<U>[] :
  T extends object ? { [K in keyof T]: Stringify<T[K]> } :
  T;

// Compile-time drift guard: the serialized shape of FullSnapshot must stay assignable
// to WireSnapshot, so adding a bigint field to BoardSnapshot/FullSnapshot without
// mirroring it here is a type error. `recentEvents` (KeeperEvent[]) is already
// wire-safe (no bigint fields), so it is excluded to keep the union mapping simple.
type _WireDriftGuard =
  Stringify<Omit<FullSnapshot, "recentEvents">> extends Omit<WireSnapshot, "recentEvents"> ? true : never;
const _wireDriftOk: _WireDriftGuard = true;
void _wireDriftOk;
