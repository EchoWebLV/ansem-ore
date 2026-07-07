import { toBoardSnapshot, BoardSnapshot, RoundStateData, ConfigState } from "@ansem/sdk";
import type { KeeperEvent } from "./events.js";

export interface MinerRow { wallet: string; blockStake: bigint[]; }
export interface LeaderRow { wallet: string; totalStake: bigint; squares: number[]; }

export interface FullSnapshot extends BoardSnapshot {
  leaderboard: LeaderRow[];
  recentEvents: KeeperEvent[];
}

const sum = (xs: bigint[]): bigint => xs.reduce((a, b) => a + b, 0n);

export function buildFullSnapshot(
  round: RoundStateData,
  config: ConfigState,
  miners: MinerRow[],
  recentEvents: KeeperEvent[],
  updatedAt: number,
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
  return { ...board, leaderboard, recentEvents };
}
