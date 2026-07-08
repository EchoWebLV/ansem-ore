"use client";
import { useState } from "react";
import { useAnchorWallet } from "@solana/wallet-adapter-react";
import { useKeeperSnapshot } from "../hooks/use-keeper-snapshot.js";
import type { KeeperClientOpts, KeeperClient } from "../lib/keeper-client.js";
import { useL1Program } from "../lib/anchor.js";
import type { WalletAdapter } from "../lib/writes.js";
import { Board } from "./Board.js";
import { Hud } from "./Hud.js";
import { Leaderboard } from "./Leaderboard.js";
import { ActivityFeed } from "./ActivityFeed.js";
import { WalletBar } from "./WalletBar.js";
import { PlayControls } from "./PlayControls.js";

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
  const l1 = useL1Program();
  const wallet = useAnchorWallet();
  const [selected, setSelected] = useState<number[]>([]);
  const toggleSquare = (id: number) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const canPlay = !!l1 && !!wallet;

  return (
    <main className="min-h-screen bg-black text-white px-4 py-4 flex flex-col gap-4 max-w-[520px] mx-auto">
      <WalletBar />
      <div className="text-[10px] tracking-widest text-bull-muted text-right">
        KEEPER: {status.toUpperCase()}
      </div>
      {snapshot ? (
        <>
          <Hud snapshot={snapshot} nowMs={nowMs} />
          <Board snapshot={snapshot} selectedSquares={selected} onSelect={canPlay ? toggleSquare : undefined} />
          {canPlay && (
            <PlayControls
              l1={l1!} wallet={wallet as unknown as WalletAdapter} snapshot={snapshot}
              selectedSquares={selected} onStaked={() => setSelected([])}
            />
          )}
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
