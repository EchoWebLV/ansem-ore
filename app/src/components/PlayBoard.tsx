"use client";
import { useState } from "react";
import { useAnchorWallet } from "@solana/wallet-adapter-react";
import { RoundState } from "@ansem/sdk";
import { useKeeperSnapshot } from "../hooks/use-keeper-snapshot.js";
import { useReveal } from "../hooks/use-reveal.js";
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
  const reveal = useReveal(snapshot);
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
          {/* The design card (docs/design/bull-board.html): label/big/sub + SVG board. */}
          <div className="w-full mx-auto max-w-[460px] bg-[#0b0b0e] border border-[#23232a] rounded-[18px] p-[18px] text-center">
            <Hud snapshot={snapshot} nowMs={nowMs} reveal={reveal} />
            <Board
              snapshot={snapshot}
              selectedSquares={selected}
              onSelect={canPlay ? toggleSquare : undefined}
              revealed={reveal.revealed}
              jackpotShown={reveal.jackpotShown}
            />
            {snapshot.state >= RoundState.Settled && snapshot.state !== RoundState.Closed && (
              <button
                onClick={reveal.replay}
                className="mt-2 rounded-full border border-[#35e07a] bg-transparent px-[18px] py-[6px] text-[13px] text-[#35e07a] hover:bg-[rgba(53,224,122,0.15)]"
              >▶ Replay reveal</button>
            )}
          </div>
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
