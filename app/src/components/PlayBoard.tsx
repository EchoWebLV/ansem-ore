"use client";
import { useCallback, useState } from "react";
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
import { Stage } from "./Stage.js";
import { VerifyPanel, type Receipt, type ReceiptInput } from "./VerifyPanel.js";

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

  // Receipts: every tx the player fires becomes a clickable explorer link below.
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const addReceipt = useCallback(
    (r: ReceiptInput) => setReceipts((xs) => [{ ...r, at: Date.now() }, ...xs].slice(0, 10)),
    [],
  );

  return (
    <main className="min-h-screen text-white px-4 py-4 pb-[max(24px,env(safe-area-inset-bottom))] flex flex-col gap-4 max-w-[520px] mx-auto">
      <div className="bg-aura" aria-hidden />
      <div className="dust" aria-hidden />
      <WalletBar />
      <div className="text-[10px] tracking-widest text-bull-muted text-right">
        KEEPER: {status.toUpperCase()}
      </div>
      {snapshot ? (
        <>
          {/* The design card (docs/design/bull-board.html): label/big/sub + SVG board,
              lifted onto a 3D holo stage. */}
          <Stage>
            <div className="w-full mx-auto max-w-[460px] bg-[#0b0b0e] border border-[#23232a] rounded-[18px] p-[18px] text-center shadow-[0_18px_60px_-24px_rgba(53,224,122,0.25)]">
              <Hud snapshot={snapshot} nowMs={nowMs} reveal={reveal} />
              <div className="board-float">
                <Board
                  snapshot={snapshot}
                  selectedSquares={selected}
                  onSelect={canPlay ? toggleSquare : undefined}
                  revealed={reveal.revealed}
                  jackpotShown={reveal.jackpotShown}
                />
              </div>
              {snapshot.state >= RoundState.Settled && snapshot.state !== RoundState.Closed && (
                <button
                  onClick={reveal.replay}
                  className="mt-2 rounded-full border border-[#35e07a] bg-transparent px-[18px] py-[8px] text-[13px] text-[#35e07a] hover:bg-[rgba(53,224,122,0.15)]"
                >▶ Replay reveal</button>
              )}
            </div>
          </Stage>
          {canPlay && (
            <PlayControls
              l1={l1!} wallet={wallet as unknown as WalletAdapter} snapshot={snapshot}
              selectedSquares={selected} onStaked={() => setSelected([])}
              onReceipt={addReceipt}
            />
          )}
          <Leaderboard leaderboard={snapshot.leaderboard} />
          <ActivityFeed events={events.length ? events : snapshot.recentEvents} />
          <VerifyPanel roundId={snapshot.roundId} receipts={receipts} />
        </>
      ) : (
        <div className="flex-1 flex items-center justify-center">
          <p className="text-bull-muted text-sm tracking-widest animate-pulse">WAITING FOR THE KEEPER…</p>
        </div>
      )}
    </main>
  );
}
