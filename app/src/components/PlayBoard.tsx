"use client";
import { useKeeperSnapshot } from "../hooks/use-keeper-snapshot.js";
import type { KeeperClientOpts, KeeperClient } from "../lib/keeper-client.js";
import { Board } from "./Board.js";
import { Hud } from "./Hud.js";
import { Leaderboard } from "./Leaderboard.js";
import { ActivityFeed } from "./ActivityFeed.js";
import { WalletBar } from "./WalletBar.js";

export interface PlayBoardProps {
  wsUrl: string;
  httpUrl: string;
  /** Pins the countdown clock for tests. */
  nowMs?: number;
  /** Injectable keeper client (tests). */
  clientFactory?: (opts: KeeperClientOpts) => KeeperClient;
}

export function PlayBoard({ wsUrl, httpUrl, nowMs, clientFactory }: PlayBoardProps) {
  const { snapshot, events, status } = useKeeperSnapshot({ wsUrl, httpUrl, clientFactory });

  return (
    <main className="min-h-screen bg-black text-white px-4 py-4 flex flex-col gap-4 max-w-[520px] mx-auto">
      <WalletBar />
      <div className="text-[10px] tracking-widest text-bull-muted text-right">
        KEEPER: {status.toUpperCase()}
      </div>
      {snapshot ? (
        <>
          <Hud snapshot={snapshot} nowMs={nowMs} />
          <Board snapshot={snapshot} />
          <Leaderboard leaderboard={snapshot.leaderboard} />
          <ActivityFeed events={events.length ? events : snapshot.recentEvents} />
        </>
      ) : (
        <div className="flex-1 flex items-center justify-center">
          <p className="text-bull-muted text-sm tracking-widest">WAITING FOR THE KEEPER…</p>
        </div>
      )}
    </main>
  );
}
