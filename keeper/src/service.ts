import { PublicKey } from "@solana/web3.js";
import {
  ConfigState, RoundState, RoundStateData, fetchConfig, fetchRound, fetchMiner,
  configPda, roundPda, minerPda, sleep, DLP_PROGRAM_ID, l1Send,
  fetchBeefConfig, beefConfigPda, beefRoundPda, stampBeefIx,
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID,
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
import type { FullSnapshot, SnapshotExtras } from "./read/snapshot.js";
import { makeJackpotReader } from "./read/jackpot.js";
import { makeBeefStamper } from "./beef.js";
import { runBuyback, BuybackCtx, BUYBACK_TICK_CADENCE } from "./buyback.js";
import { runJanitor, JanitorCtx, JANITOR_TICK_CADENCE } from "./janitor.js";
import { startFloorRefresh, FloorRefresh } from "./floor.js";
import type { FetchLike } from "./jupiter.js";

export interface Service { start: () => Promise<void>; stop: () => Promise<void>; }

export interface ServiceDispatchState {
  config: ConfigState;
  round: RoundStateData | null;
}

export interface ServiceDispatchDeps {
  createAndDelegate: typeof createAndDelegate;
}

export interface CurrentRoundReadDeps {
  getAccountInfo: (address: PublicKey) => Promise<{ owner: PublicKey } | null>;
  fetchDecodedRound: (delegated: boolean, address: PublicKey) => Promise<RoundStateData>;
}

export async function readCurrentRoundView(
  currentRoundId: number,
  deps: CurrentRoundReadDeps,
): Promise<RoundView | null> {
  if (currentRoundId === 0) return null;
  const rpda = roundPda(currentRoundId);
  const info = await deps.getAccountInfo(rpda);
  if (!info) throw new Error(`current round ${currentRoundId} account is missing`);
  const delegated = info.owner.equals(DLP_PROGRAM_ID);
  const round = await deps.fetchDecodedRound(delegated, rpda);
  return { round, delegated };
}

const liveServiceDispatchDeps: ServiceDispatchDeps = { createAndDelegate };

export async function dispatchCrankAction(
  action: CrankAction,
  s: ServiceDispatchState,
  ctx: ActionCtx,
  deps: ServiceDispatchDeps = liveServiceDispatchDeps,
): Promise<void> {
  switch (action) {
    case CrankAction.CreateRound: {
      const currentRoundId = s.config.currentRoundId;
      if (!s.round) {
        if (currentRoundId !== 0) {
          throw new Error(`current round ${currentRoundId} is missing; refusing to create the next round`);
        }
        return deps.createAndDelegate(ctx, 1);
      }
      if (s.round.roundId !== currentRoundId) {
        throw new Error(`decoded round ID ${s.round.roundId} does not match current round ${currentRoundId}`);
      }
      if (s.round.state === RoundState.Claimable) {
        if (!ctx.beefStamper) {
          throw new Error(`current round ${currentRoundId} is Claimable but the BEEF stamper is unavailable`);
        }
        await ctx.beefStamper.stamp(currentRoundId);
      } else if (s.round.state !== RoundState.Closed) {
        throw new Error(`current round ${currentRoundId} is not terminal; refusing to create the next round`);
      }
      // Closed means the round was canceled before a successful swap. This includes funded
      // oracle-timeout cancellations, which have no Claimable transition or BEEF emission.
      return deps.createAndDelegate(ctx, currentRoundId + 1);
    }
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
      return;
  }
}

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
  let floor: FloorRefresh | undefined;
  let running = false;

  // Cached, null-safe read of the on-chain jackpot params (null until the JackpotConfig PDA
  // exists — keeper runs against both the current and the upgraded program). Uses the SDK's
  // typed fetchJackpotConfig now that the upgraded IDL carries the account.
  const readJackpot = makeJackpotReader(chain.program);
  // Last stamped BEEF emission (players' base units) surfaced as snapshot.beefPerRound. The
  // stamp crank (below) pushes each successful stamp's players' share here so the app's BEEF
  // drip counter reads a live value. Stays null until the first stamp lands.
  let lastBeefEmission: bigint | null = null;
  // Minted-BEEF stamp crank (plan Task 6 Step 2). Sources mint/vault/treasury from the on-chain
  // BeefConfig (never env) + the mint's owning token program; skips silently while BEEF is
  // uninitialized (mainnet today) and re-probes on each stamp attempt so a mid-flight init_beef
  // is picked up without a keeper restart. finalizeSettled swallows its initial stamp throw;
  // the Claimable CreateRound gate retries and propagates failure before advancing.
  const beefStamper = makeBeefStamper({
    probeConfig: async () => {
      const pda = beefConfigPda();
      const info = await chain.conn.getAccountInfo(pda, "confirmed");
      return info ? fetchBeefConfig(chain.program, pda) : null;
    },
    detectTokenProgram: async (mint) => {
      const info = await chain.conn.getAccountInfo(mint, "confirmed");
      if (!info) throw new Error(`BEEF mint account ${mint.toBase58()} not found`);
      if (info.owner.equals(TOKEN_PROGRAM_ID)) return TOKEN_PROGRAM_ID;
      if (info.owner.equals(TOKEN_2022_PROGRAM_ID)) return TOKEN_2022_PROGRAM_ID;
      throw new Error(
        `BEEF mint account ${mint.toBase58()} has unsupported owner ${info.owner.toBase58()}`,
      );
    },
    sendStamp: (roundId, cfg, tokenProgram) =>
      l1Send(() => stampBeefIx(
        chain.program, ctx.keeper, roundId,
        new PublicKey(cfg.beefMint), new PublicKey(cfg.beefVault), new PublicKey(cfg.beefTreasury),
        tokenProgram,
      ).rpc()),
    readEmission: async (roundId) => {
      const br: any = await chain.program.account.beefRound.fetch(beefRoundPda(roundId));
      return BigInt(br.emission.toString()); // BeefRound.emission == the players' 80% share
    },
    pushEmission: (emission) => { lastBeefEmission = emission; },
    log,
  });
  ctx.beefStamper = beefStamper;
  const getExtras = async (): Promise<SnapshotExtras> => {
    const jp = await readJackpot();
    return {
      jackpotTriggerOdds: jp.jackpotTriggerOdds,
      jackpotCapMult: jp.jackpotCapMult,
      listingTs: cfg.listingTs,
      beefPerRound: lastBeefEmission,
    };
  };

  const dispatch = (action: CrankAction, s: ServiceDispatchState) => dispatchCrankAction(action, s, ctx);

  // Read the current round by OWNERSHIP: while delegated the live copy is in the
  // ER (L1 anchor .fetch would fail the owner check), once committed it is on L1.
  const fetchRoundView = (currentRoundId: number): Promise<RoundView | null> =>
    readCurrentRoundView(currentRoundId, {
      getAccountInfo: (rpda) => chain.conn.getAccountInfo(rpda, "confirmed"),
      fetchDecodedRound: (delegated, rpda) =>
        fetchRound(delegated ? chain.erProgram : chain.program, rpda),
    });

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

      // BEEF stamp crank: boot-probe BeefConfig once (warms the cache + logs enabled/dormant).
      // Dormant on mainnet today; the crank lazily re-probes each stamp attempt so a later init_beef
      // is picked up with no restart.
      await beefStamper.init();

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

      // Stale-floor auto-refresh (spec 2026-07-14 D9). Real mode only — the floor
      // (config.min_swap_rate) is enforced solely in execute_swap_real, and only the
      // external ANSEM mint used in real mode is Jupiter-quotable. FLOOR_REFRESH_SECS<=0
      // disables it (ops kill switch). Runs off the main tick on its own timer.
      if (cfg.swapMode === "real" && cfg.floorRefreshSecs > 0) {
        floor = startFloorRefresh({
          program: chain.program, keeper: ctx.keeper,
          getConfig: () => fetchConfig(chain.program, configPda()),
          jupBaseUrl: cfg.jupBaseUrl, slippageBps: cfg.slippageBps,
          fetchImpl: ctx.fetchImpl, log,
        }, cfg.floorRefreshSecs);
        log.info("floor auto-refresh started", { everySecs: cfg.floorRefreshSecs });
      } else {
        log.info("floor auto-refresh disabled", { swapMode: cfg.swapMode, floorRefreshSecs: cfg.floorRefreshSecs });
      }

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
            getExtras,
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
    async stop() { running = false; floor?.stop(); await server?.close(); },
  };
}
