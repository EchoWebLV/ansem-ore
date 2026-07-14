import { toBoardSnapshot, RoundStateData, ConfigState } from "@ansem/sdk";
import type { MinerRow, LeaderRow, FullSnapshot as SdkFullSnapshot, KeeperEvent } from "@ansem/sdk";
export type { MinerRow, LeaderRow } from "@ansem/sdk";

/**
 * Slowly-changing / config-adjacent fields folded into the snapshot at build time
 * (spec 2026-07-14 D8/D9 liveness package). All optional/null so the keeper serves a
 * valid snapshot against BOTH the current and the upgraded program:
 * - jackpotTriggerOdds / jackpotCapMult: from the JackpotConfig PDA (null until it exists).
 * - listingTs: BEEF listing unix ts from env LISTING_TS (null when unset).
 * - beefPerRound: last stamped BEEF emission (players' base units). Null until the minted
 *   BEEF stamp crank lands — see the TODO seam in crank/actions.ts (plan Task 6 Step 2, deferred).
 */
export interface SnapshotExtras {
  jackpotTriggerOdds: number | null;
  jackpotCapMult: number | null;
  listingTs: number | null;
  beefPerRound: bigint | null;
}

export const EMPTY_EXTRAS: SnapshotExtras = {
  jackpotTriggerOdds: null, jackpotCapMult: null, listingTs: null, beefPerRound: null,
};

/**
 * Keeper-served snapshot = the SDK board/leaderboard shape plus `claimWindowSecs`
 * (from the fetched config) so the app can render a "claim by HH:MM" countdown on
 * unclaimed claimable rounds, plus the liveness `SnapshotExtras`. Extended here (not in
 * the SDK) to keep the wire type additive and out of the SDK's WireSnapshot drift guard.
 */
export interface FullSnapshot extends SdkFullSnapshot, SnapshotExtras {
  claimWindowSecs: number;
}

const sum = (xs: bigint[]): bigint => xs.reduce((a, b) => a + b, 0n);

export function buildFullSnapshot(
  round: RoundStateData,
  config: ConfigState,
  miners: MinerRow[],
  recentEvents: KeeperEvent[],
  updatedAt: number,
  extras: SnapshotExtras = EMPTY_EXTRAS,
): FullSnapshot {
  const board = toBoardSnapshot(round, config, updatedAt);
  const leaderboard: LeaderRow[] = miners
    .map((m) => ({
      wallet: m.wallet,
      totalStake: sum(m.blockStake),
      squares: m.blockStake.flatMap((v, i) => (v > 0n ? [i] : [])),
    }))
    .filter((r) => r.totalStake > 0n)
    .sort((a, b) => (b.totalStake > a.totalStake ? 1 : b.totalStake < a.totalStake ? -1 : 0));
  return { ...board, leaderboard, recentEvents, claimWindowSecs: config.claimWindowSecs, ...extras };
}
