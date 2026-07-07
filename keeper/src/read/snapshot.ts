import { toBoardSnapshot, RoundStateData, ConfigState } from "@ansem/sdk";
import type { MinerRow, LeaderRow, FullSnapshot, KeeperEvent } from "@ansem/sdk";
export type { MinerRow, LeaderRow, FullSnapshot } from "@ansem/sdk";

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
