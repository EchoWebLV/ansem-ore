"use client";
import { useCallback, useEffect, useState } from "react";
import { useAnchorWallet } from "@solana/wallet-adapter-react";
import { RoundState, type WireSnapshot } from "@ansem/sdk";
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
import { PhaseNav } from "./PhaseNav.js";
import { SoundToggle } from "./SoundToggle.js";
import { primeAudio } from "../lib/sound.js";
import { PlayControls } from "./PlayControls.js";
import { Stage } from "./Stage.js";
import { VerifyPanel, type Receipt, type ReceiptInput } from "./VerifyPanel.js";
import { Countdown } from "./Countdown.js";
import { JackpotMeter } from "./JackpotMeter.js";
import { WinTicker } from "./WinTicker.js";
import { ListingBanner } from "./ListingBanner.js";
import { stateLabel } from "../lib/format.js";

// Instant-boot placeholder: the real board geometry with zeroed data, so the
// page looks loaded the moment it paints while the keeper link comes up.
const SKELETON_SNAP: WireSnapshot = {
  roundId: 0, state: RoundState.Open, deadlineTs: 0, pot: "0",
  blockSol: Array(25).fill("0"), jackpotSquare: null, jackpotPool: "0",
  rolloverJackpot: "0", updatedAt: 0, leaderboard: [], recentEvents: [],
};

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

  // One-time audio unlock: browsers keep the AudioContext suspended until a user
  // gesture, so a spectator who never taps a tile would get a SILENT reveal. Any
  // first pointer-down on the page primes it.
  useEffect(() => {
    const h = () => primeAudio();
    window.addEventListener("pointerdown", h, { once: true });
    return () => window.removeEventListener("pointerdown", h);
  }, []);

  // Desktop (lg:) is a three-column command center: rails flank a bigger center
  // stage. Mobile keeps the exact single-column order — the grid placements below
  // only exist at lg and the DOM order IS the mobile order.
  const goldFinale = reveal.jackpotShown && reveal.sub?.gold === true;

  return (
    <main className="min-h-screen text-white px-4 py-4 pb-[max(24px,env(safe-area-inset-bottom))] flex flex-col gap-4 max-w-[520px] lg:max-w-[1280px] lg:px-8 mx-auto">
      <div className="abstract-bg" aria-hidden data-testid="abstract-bg" />
      <div className="bg-aura" aria-hidden />
      <div className="dust" aria-hidden />
      <div className="grid-floor hidden lg:block" aria-hidden />
      <div className="vignette hidden lg:block" aria-hidden />
      <PhaseNav>
        <SoundToggle />
        <WalletBar />
      </PhaseNav>
      <div className="text-[10px] tracking-widest text-bull-muted text-right">
        KEEPER: {status.toUpperCase()}
      </div>
      <ListingBanner />
      {snapshot ? (
        <>
          {/* Liveness strip: a persistent live clock/status + recent-wins marquee. */}
          <div className="flex items-center gap-3 rounded-xl border border-bull-edge bg-bull-bg px-3 py-2">
            <div className="flex items-center gap-2 shrink-0">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-bull-green animate-pulse" aria-hidden />
              <span className="text-[10px] tracking-widest text-bull-muted">LIVE</span>
              <span className="font-mono tabular-nums text-sm text-bull-green">
                {snapshot.state === RoundState.Open ? (
                  <Countdown deadlineTs={snapshot.deadlineTs} nowMs={nowMs} />
                ) : (
                  stateLabel(snapshot.state)
                )}
              </span>
            </div>
            <div className="h-4 w-px bg-bull-edge shrink-0" aria-hidden />
            <WinTicker events={events.length ? events : snapshot.recentEvents} />
          </div>
        <div className="flex flex-col gap-4 lg:grid lg:grid-cols-[minmax(240px,300px)_minmax(0,1fr)_minmax(280px,340px)] lg:gap-6 lg:items-start">
          {goldFinale && <div key={snapshot.roundId} className="gold-flash hidden lg:block" aria-hidden />}
          {/* The design card (docs/design/bull-board.html): label/big/sub + SVG board,
              lifted onto a 3D holo stage. Center column on desktop. */}
          <div className="lg:col-start-2 lg:row-start-1 lg:row-span-3">
            <Stage className="w-full mx-auto max-w-[460px] lg:max-w-[640px]">
              <div className="bg-[#0b0b0e] border border-[#23232a] rounded-[18px] p-[18px] lg:p-6 text-center shadow-[0_18px_60px_-24px_rgba(53,224,122,0.25)] lg:shadow-[0_30px_90px_-30px_rgba(53,224,122,0.35)]">
                {/* During a replay of a PAST round, Hud+Board render the stored old
                    snapshot (the gold square must land where it did on-chain); the
                    write column below keeps the LIVE snapshot. Ghost rounds aren't
                    clickable — the replay self-dismisses in seconds. */}
                <Hud snapshot={reveal.snapshotOverride ?? snapshot} nowMs={nowMs} reveal={reveal} />
                <div className="board-float">
                  <Board
                    snapshot={reveal.snapshotOverride ?? snapshot}
                    selectedSquares={selected}
                    onSelect={reveal.snapshotOverride ? undefined : canPlay ? toggleSquare : undefined}
                    revealed={reveal.revealed}
                    jackpotShown={reveal.jackpotShown}
                    revealMode={reveal.mode}
                  />
                </div>
                {reveal.canReplay && reveal.revealed === null && (
                  <button
                    onClick={reveal.replay}
                    className="mt-2 rounded-full border border-[#35e07a] bg-transparent px-[18px] py-[8px] text-[13px] text-[#35e07a] hover:bg-[rgba(53,224,122,0.15)]"
                  >▶ Replay reveal</button>
                )}
              </div>
            </Stage>
          </div>
          <div className="lg:col-start-1 lg:row-start-1">
            <JackpotMeter rolloverJackpot={snapshot.rolloverJackpot} triggerOdds={snapshot.jackpotTriggerOdds} />
          </div>
          {canPlay && (
            <div className="lg:col-start-3 lg:row-start-1">
              <PlayControls
                l1={l1!} wallet={wallet as unknown as WalletAdapter} snapshot={snapshot}
                selectedSquares={selected} onStaked={() => setSelected([])}
                onReceipt={addReceipt}
              />
            </div>
          )}
          <div className="lg:col-start-1 lg:row-start-2">
            <Leaderboard leaderboard={snapshot.leaderboard} />
          </div>
          <div className={canPlay ? "lg:col-start-3 lg:row-start-2" : "lg:col-start-3 lg:row-start-1"}>
            <ActivityFeed events={events.length ? events : snapshot.recentEvents} />
          </div>
          <div className="lg:col-start-1 lg:row-start-3">
            <VerifyPanel roundId={snapshot.roundId} receipts={receipts} />
          </div>
        </div>
        </>
      ) : (
        /* Pre-snapshot skeleton: the true board at rest (layout is static, so it
           paints instantly); live data swaps in place when the keeper answers. */
        <Stage className="w-full mx-auto max-w-[460px]">
          <div className="bg-[#0b0b0e] border border-[#23232a] rounded-[18px] p-[18px] text-center shadow-[0_18px_60px_-24px_rgba(53,224,122,0.25)]">
            <div className="text-center">
              <div className="text-[12px] lg:text-[13px] tracking-[2px] text-[#8a8a93]">
                ROUND — · CONNECTING
              </div>
              <div
                className="font-mono text-[40px] lg:text-[64px] font-medium my-[2px] animate-pulse"
                style={{ color: "#35e07a", textShadow: "0 0 20px rgba(53,224,122,0.35)" }}
              >
                --:--
              </div>
              <div className="text-[12px] lg:text-[13px] min-h-[16px] text-[#8a8a93]">
                linking to the keeper…
              </div>
            </div>
            <div className="board-float">
              <Board snapshot={SKELETON_SNAP} />
            </div>
          </div>
        </Stage>
      )}
    </main>
  );
}
