import {
  ConfigState, RoundStateData, fetchConfig, fetchRound, fetchMiner,
  configPda, roundPda, minerPda, sleep,
} from "@ansem/sdk";
import type { KeeperConfig } from "./env.js";
import { buildChain, Chain } from "./chain.js";
import { makeLogger, Logger } from "./logger.js";
import { runTick, TickState } from "./crank/loop.js";
import { CrankAction } from "./crank/decide.js";
import {
  ActionCtx, createAndDelegate, requestSettle, cancelRound, finalizeRound, liveFinalizeDeps,
} from "./crank/actions.js";
import { fetchStakerWallets } from "./participants.js";
import { startReadServer, ReadServer } from "./read/server.js";
import type { FullSnapshot } from "./read/snapshot.js";

export interface Service { start: () => Promise<void>; stop: () => Promise<void>; }

export function createService(cfg: KeeperConfig, log: Logger = makeLogger()): Service {
  const chain: Chain = buildChain(cfg);
  const ctx: ActionCtx = {
    conn: chain.conn, erConn: chain.erConn, program: chain.program, erProgram: chain.erProgram,
    keeper: cfg.adminKeypair.publicKey, validator: cfg.validator, vrfQueue: cfg.vrfQueue,
    roundDurationSecs: cfg.roundDurationSecs, log,
  };
  let latest: FullSnapshot | null = null;
  let server: ReadServer | undefined;
  let running = false;

  const dispatch = async (action: CrankAction, s: { config: ConfigState; round: RoundStateData | null }) => {
    switch (action) {
      case CrankAction.CreateRound:
        return createAndDelegate(ctx, s.config.currentRoundId + 1);
      case CrankAction.Settle:
        if (s.round) await requestSettle(ctx, s.round.roundId);
        return;
      case CrankAction.Finalize:
        if (s.round) await finalizeRound(s.round.roundId, liveFinalizeDeps(ctx, s.round.roundId));
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

  return {
    async start() {
      server = await startReadServer(cfg.httpPort, () => latest);
      log.info("keeper up", { httpPort: server.port, keeper: ctx.keeper.toBase58() });
      running = true;
      let state: TickState = { prevSnapshot: null, vrfPendingSinceSec: null };
      while (running) {
        try {
          state = await runTick({
            fetchConfig: () => fetchConfig(chain.program, configPda()),
            fetchRound: async () => {
              const cfgState = await fetchConfig(chain.program, configPda());
              return fetchRound(chain.program, roundPda(cfgState.currentRoundId)).catch(() => null);
            },
            fetchMiners: async (roundId) => {
              const wallets = await fetchStakerWallets(chain.conn, roundId);
              const rows = await Promise.all(wallets.map(async (w) => {
                const m = await fetchMiner(chain.program, minerPda(w));
                return m ? { wallet: w.toBase58(), blockStake: m.blockStake } : null;
              }));
              return rows.filter((r): r is NonNullable<typeof r> => r !== null);
            },
            dispatch,
            broadcast: (snap, events) => server!.broadcast(snap, events),
            getSnapshot: (snap) => { latest = snap; },
            nowSec: () => Math.floor(Date.now() / 1000),
            graceSecs: cfg.graceSecs,
          }, state);
        } catch (e) {
          log.error("tick failed", { err: String(e) });
        }
        await sleep(cfg.pollMs);
      }
    },
    async stop() { running = false; await server?.close(); },
  };
}
