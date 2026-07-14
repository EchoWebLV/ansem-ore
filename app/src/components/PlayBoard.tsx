"use client";
import { useCallback, useEffect, useState } from "react";
import { useAnchorWallet } from "@solana/wallet-adapter-react";
import { RoundState, type WireSnapshot } from "@ansem/sdk";
import { useKeeperSnapshot } from "../hooks/use-keeper-snapshot.js";
import { useReveal } from "../hooks/use-reveal.js";
import { useBeefConfig } from "../hooks/use-beef-config.js";
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
import { JackpotMeter } from "./JackpotMeter.js";
import { WinTicker } from "./WinTicker.js";
import { ListingBanner } from "./ListingBanner.js";
import { BeefChip } from "./BeefChip.js";

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
  // BEEF gate: the on-chain BeefConfig probe (null pre-launch / when disconnected). Drives
  // BOTH the HUD chip mount and the claim/stake bundle ordering, so they never diverge.
  const beefConfig = useBeefConfig(l1);
  const [selected, setSelected] = useState<number[]>([]);
  const toggleSquare = (id: number) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const canPlay = !!l1 && !!wallet;
  const removeSquare = (id: number) => setSelected((s) => s.filter((square) => square !== id));

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

  // Wide desktop (xl:) is a three-column command center: rails flank a bigger center
  // stage. Mobile keeps the exact single-column order — the grid placements below
  // only exist at xl and the DOM order IS the mobile order.
  const goldFinale = reveal.jackpotShown && reveal.sub?.gold === true;

  // ONE liveness surface: keeper status folds into the strip's dot + label.
  const liveness =
    status === "connected"
      ? { dot: "bg-bull-green", label: "LIVE", pulse: false }
      : status === "connecting"
        ? { dot: "bg-bull-dim", label: "LINKING…", pulse: true }
        : { dot: "bg-bull-muted", label: "RECONNECTING…", pulse: false };

  return (
    <main
      data-testid="terminal-shell"
      className="terminal-shell-safe mx-auto flex min-h-screen max-w-[1430px] flex-col gap-3 px-3 text-bull-ink sm:px-4 lg:px-7"
    >
      <PhaseNav>
        <SoundToggle />
        <WalletBar />
      </PhaseNav>
      <ListingBanner />
      {snapshot ? (
        <>
          <div className="terminal-status-strip flex items-center gap-3 border-b border-bull-edge py-2">
            <div className="flex shrink-0 items-center gap-2">
              <span
                className={`h-1.5 w-1.5 rounded-full ${liveness.dot}${liveness.pulse ? " motion-safe:animate-pulse" : ""}`}
                aria-hidden
              />
              <span className="terminal-label">{liveness.label}</span>
            </div>
            <div className="h-4 w-px shrink-0 bg-bull-edge" aria-hidden />
            <WinTicker events={events.length ? events : snapshot.recentEvents} />
          </div>
          {goldFinale && <div key={snapshot.roundId} className="gold-flash hidden xl:block" aria-hidden />}
          <div data-testid="terminal-layout" className="grid items-start gap-3 xl:grid-cols-[minmax(190px,232px)_minmax(520px,1fr)_minmax(284px,326px)]">
            <section aria-label="Round board" className="xl:col-start-2 xl:row-start-1 xl:row-span-4">
              <Stage className="w-full">
                <div className="terminal-panel overflow-hidden">
                  <Hud
                    snapshot={reveal.snapshotOverride ?? snapshot}
                    nowMs={nowMs}
                    reveal={reveal}
                    chipSlot={
                      beefConfig && canPlay ? (
                        <BeefChip l1={l1!} wallet={wallet as unknown as WalletAdapter} beefConfig={beefConfig} />
                      ) : undefined
                    }
                  />
                  <Board
                    snapshot={reveal.snapshotOverride ?? snapshot}
                    selectedSquares={selected}
                    onSelect={reveal.snapshotOverride ? undefined : canPlay ? toggleSquare : undefined}
                    revealed={reveal.revealed}
                    jackpotShown={reveal.jackpotShown}
                    revealMode={reveal.mode}
                  />
                  <div data-testid="board-footer" className="flex min-h-14 flex-wrap items-center justify-between gap-2 border-t border-bull-edge px-3 py-2">
                    <div className="flex items-center gap-3 text-[11px] text-bull-muted" aria-label="Board selection legend">
                      <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm border border-bull-ink" aria-hidden />Selected</span>
                      <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-bull-green/40" aria-hidden />Staked</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <a href="#verify" className="inline-flex min-h-11 items-center px-2 text-[11px] font-semibold text-bull-muted hover:text-bull-green">Verify</a>
                      {reveal.canReplay && reveal.revealed === null && (
                      <button
                        onClick={reveal.replay}
                        className="min-h-11 rounded-[9px] border border-bull-edge bg-bull-raised px-4 py-2 text-[12px] font-semibold text-bull-ink hover:border-bull-green"
                      >
                        Replay reveal
                      </button>
                      )}
                    </div>
                  </div>
                </div>
              </Stage>
            </section>
            {canPlay && (
              <section aria-label="Betting and claims" className="xl:col-start-3 xl:row-start-1">
                <PlayControls
                  l1={l1!}
                  wallet={wallet as unknown as WalletAdapter}
                  snapshot={snapshot}
                  selectedSquares={selected}
                  onRemoveSquare={removeSquare}
                  onStaked={() => setSelected([])}
                  onReceipt={addReceipt}
                  beefLive={!!beefConfig}
                />
              </section>
            )}
            <div className="xl:col-start-1 xl:row-start-1">
              <JackpotMeter rolloverJackpot={snapshot.rolloverJackpot} triggerOdds={snapshot.jackpotTriggerOdds} />
            </div>
            <div className="xl:col-start-1 xl:row-start-2">
              <Leaderboard leaderboard={snapshot.leaderboard} />
            </div>
            <div className={canPlay ? "xl:col-start-3 xl:row-start-2" : "xl:col-start-3 xl:row-start-1"}>
              <ActivityFeed events={events.length ? events : snapshot.recentEvents} />
            </div>
            <div id="verify" className="xl:col-start-1 xl:row-start-3 scroll-mt-4">
              <VerifyPanel roundId={snapshot.roundId} receipts={receipts} />
            </div>
          </div>
        </>
      ) : (
        <section aria-label="Round board">
          <Stage className="mx-auto w-full max-w-[680px]">
            <div className="terminal-panel overflow-hidden">
              <header className="grid min-h-[78px] grid-cols-[1fr_auto_1fr] items-center border-b border-bull-edge px-4 py-3">
                <div>
                  <span className="terminal-label">Round</span>
                  <strong className="mt-1 block text-[14px]">
                    <span className="font-mono">--</span>
                    {" · "}
                    <span>CONNECTING</span>
                  </strong>
                </div>
                <div className="text-center">
                  <span className="terminal-label">Linking</span>
                  <div className="mt-1 font-mono text-[28px] motion-safe:animate-pulse">--:--</div>
                </div>
                <div className="text-right">
                  <span className="terminal-label">Pool</span>
                  <strong className="mt-1 block text-[14px]">--</strong>
                </div>
              </header>
              <Board snapshot={SKELETON_SNAP} />
            </div>
          </Stage>
        </section>
      )}
    </main>
  );
}
