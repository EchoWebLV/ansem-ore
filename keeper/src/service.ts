import { PublicKey } from "@solana/web3.js";
import {
  ConfigState, RoundStateData, fetchConfig, fetchRound, fetchMiner,
  configPda, roundPda, minerPda, sleep, DLP_PROGRAM_ID,
  fetchBeefConfig, beefConfigPda, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID,
} from "@ansem/sdk";
import type { KeeperConfig } from "./env.js";
import { buildChain, Chain } from "./chain.js";
import { makeLogger, Logger } from "./logger.js";
import { runTick, TickState, RoundView } from "./crank/loop.js";
import { CrankAction } from "./crank/decide.js";
import {
  ActionCtx, createAndDelegate, requestSettle, cancelRound,
  commitToL1, liveCommitDeps, finalizeSettled, liveFinalizeDeps,
} from "./crank/actions.js";
import { fetchStakerWallets } from "./participants.js";
import { startReadServer, ReadServer } from "./read/server.js";
import type { FullSnapshot } from "./read/snapshot.js";
import { runBuyback, BuybackCtx, BUYBACK_TICK_CADENCE } from "./buyback.js";
import { runJanitor, JanitorCtx, JANITOR_TICK_CADENCE } from "./janitor.js";
import type { FetchLike } from "./jupiter.js";

export interface Service { start: () => Promise<void>; stop: () => Promise<void>; }

export function createService(cfg: KeeperConfig, log: Logger = makeLogger()): Service {
  const chain: Chain = buildChain(cfg);
  const ctx: ActionCtx = {
    conn: chain.conn, erConn: chain.erConn, program: chain.program, erProgram: chain.erProgram,
    keeper: cfg.adminKeypair.publicKey, validator: cfg.validator, vrfQueue: cfg.vrfQueue,
    roundDurationSecs: cfg.roundDurationSecs, directMode: cfg.directMode,
    swapMode: cfg.swapMode, jupBaseUrl: cfg.jupBaseUrl, slippageBps: cfg.slippageBps,
    inventoryMinAnsem: BigInt(Math.trunc(cfg.inventoryMinAnsem)),
    fetchImpl: (globalThis as unknown as { fetch: FetchLike }).fetch,
    log,
  };
  let latest: FullSnapshot | null = null;
  let server: ReadServer | undefined;
  let running = false;

  const dispatch = async (action: CrankAction, s: { config: ConfigState; round: RoundStateData | null }) => {
    switch (action) {
      case CrankAction.CreateRound:
        return createAndDelegate(ctx, s.config.currentRoundId + 1);
      case CrankAction.CommitToL1:
        if (s.round) await commitToL1(s.round.roundId, liveCommitDeps(ctx, s.round.roundId));
        return;
      case CrankAction.Settle:
        if (s.round) await requestSettle(ctx, s.round.roundId);
        return;
      case CrankAction.Finalize:
        if (s.round) await finalizeSettled(s.round.roundId, liveFinalizeDeps(ctx, s.round.roundId, s.config, s.round));
        return;
      case CrankAction.Cancel:
        if (s.round) await cancelRound(ctx, s.round.roundId);
        return;
      case CrankAction.AwaitOracle:
      case CrankAction.Idle:
      default:
        return; // nothing to do this tick
    }
  };

  // Read the current round by OWNERSHIP: while delegated the live copy is in the
  // ER (L1 anchor .fetch would fail the owner check), once committed it is on L1.
  const fetchRoundView = async (currentRoundId: number): Promise<RoundView | null> => {
    if (currentRoundId === 0) return null;
    const rpda = roundPda(currentRoundId);
    const info = await chain.conn.getAccountInfo(rpda, "confirmed"); // RPC error -> tick retry
    if (!info) return null;
    const delegated = info.owner.toBase58() === DLP_PROGRAM_ID.toBase58();
    const round = await fetchRound(delegated ? chain.erProgram : chain.program, rpda).catch(() => null);
    return round ? { round, delegated } : null;
  };

  return {
    async start() {
      server = await startReadServer(cfg.httpPort, () => latest);
      log.info("keeper up", { httpPort: server.port, keeper: ctx.keeper.toBase58() });

      // Detect the ANSEM mint's owning token program ONCE (classic vs Token-2022) so the
      // real-swap inventory ATA + execute_swap_real tokenProgram match the mint on-chain.
      // Real $ANSEM is Token-2022; the devnet mock PDA mint is classic. Defaults classic.
      try {
        const cfg0 = await fetchConfig(chain.program, configPda());
        const mintInfo = await chain.conn.getAccountInfo(new PublicKey(cfg0.ansemMint), "confirmed");
        ctx.tokenProgramId = mintInfo && mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID)
          ? TOKEN_2022_PROGRAM_ID
          : TOKEN_PROGRAM_ID;
        ctx.log.info("ANSEM mint token program detected", {
          mint: new PublicKey(cfg0.ansemMint).toBase58(),
          tokenProgram: ctx.tokenProgramId.toBase58(),
          token2022: ctx.tokenProgramId.equals(TOKEN_2022_PROGRAM_ID),
        });
      } catch {
        ctx.tokenProgramId = TOKEN_PROGRAM_ID;
        ctx.log.info("ANSEM mint token program detection failed — defaulting classic");
      }

      // BEEF emission layer: enabled iff BeefConfig exists on-chain at startup.
      try {
        const bc = await fetchBeefConfig(ctx.program, beefConfigPda());
        ctx.beefEnabled = true;
        ctx.beefVault = bc.beefVault;
        ctx.log.info("BEEF emission enabled", { vault: bc.beefVault.toBase58() });
      } catch {
        ctx.log.info("BEEF not initialized — emission stamping disabled");
      }

      // Periodic maintenance cranks (own ctx so they can run off the main tick).
      const buybackCtx: BuybackCtx = {
        conn: chain.conn, program: chain.program, keeper: ctx.keeper, keypair: cfg.adminKeypair,
        fetchImpl: ctx.fetchImpl, jupBaseUrl: cfg.jupBaseUrl, slippageBps: cfg.slippageBps,
        minSol: cfg.buybackMinSol, keepSol: cfg.treasuryKeepSol,
        getConfig: () => fetchConfig(chain.program, configPda()), log,
      };
      const janitorCtx: JanitorCtx = {
        program: chain.program, keeper: ctx.keeper,
        getClaimWindowSecs: async () => (await fetchConfig(chain.program, configPda())).claimWindowSecs,
        nowSec: () => Math.floor(Date.now() / 1000), log,
      };

      running = true;
      let tick = 0;
      let state: TickState = { prevSnapshot: null, vrfPendingSinceSec: null };
      while (running) {
        try {
          state = await runTick({
            fetchConfig: () => fetchConfig(chain.program, configPda()),
            fetchRound: fetchRoundView,
            fetchMiners: async (roundId) => {
              const wallets = await fetchStakerWallets(chain.conn, roundId);
              const rows = await Promise.all(wallets.map(async (w) => {
                const m = await fetchMiner(chain.program, minerPda(w));
                return m ? { wallet: w.toBase58(), blockStake: m.blockStake } : null;
              }));
              // Post the CRIT-1 join_round-stamp fix, a join-without-stake miner also
              // carries round_id == roundId, so keep only wallets that actually staked
              // (some square > 0) — the leaderboard stays "stakers only".
              return rows.filter((r): r is NonNullable<typeof r> => r !== null && r.blockStake.some((v) => v > 0n));
            },
            dispatch,
            broadcast: (snap, events) => server!.broadcast(snap, events),
            getSnapshot: (snap) => { latest = snap; },
            nowSec: () => Math.floor(Date.now() / 1000),
            graceSecs: cfg.graceSecs,
          }, state);
          tick++;
          // Real-mode inventory refill from treasury fees (buyback), and permissionless
          // rent reclamation for closeable rounds (janitor — runs in mock + real). Each
          // is self-contained: a failure logs and is retried on its next cadence hit.
          if (cfg.swapMode === "real" && tick % BUYBACK_TICK_CADENCE === 0) {
            await runBuyback(buybackCtx).catch((e) => log.error("buyback failed", { err: String(e) }));
          }
          if (tick % JANITOR_TICK_CADENCE === 0) {
            await runJanitor(janitorCtx).catch((e) => log.error("janitor failed", { err: String(e) }));
          }
        } catch (e) {
          log.error("tick failed", { err: String(e) });
        }
        await sleep(cfg.pollMs);
      }
    },
    async stop() { running = false; await server?.close(); },
  };
}
