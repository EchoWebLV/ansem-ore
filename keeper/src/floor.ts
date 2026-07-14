import { PublicKey } from "@solana/web3.js";
import { Program } from "@coral-xyz/anchor";
import { AnsemMiner, BN, ConfigState, l1Send, setMinSwapRateIx } from "@ansem/sdk";
import type { Logger } from "./logger.js";
import { JupCfg, FetchLike, quoteSolToAnsem } from "./jupiter.js";

/** One SOL in lamports — the quote size for the ANSEM-per-SOL market rate. */
const ONE_SOL_LAMPORTS = 1_000_000_000n;

/**
 * Pure floor-drift decision (spec 2026-07-14 D9). Keep `config.min_swap_rate` at
 * `targetBps` (default 9200 = 92%) of the live Jupiter ANSEM-per-SOL rate. Return the
 * new target only when the STORED floor has drifted outside `driftBps` (default 500 = 5%)
 * of that target — otherwise null (in band, don't spam admin txs on market noise).
 *
 * Rate units: ANSEM base units per 1 SOL (matches scripts/_mainnet-init.mjs MIN_SWAP_RATE
 * and config.min_swap_rate). Integer bigint math throughout — no float drift.
 *
 * Zero-market edge: a 0 market rate yields target 0, so a positive stored floor reads as
 * "above band" and this returns 0n. The loop MUST guard a non-positive quote before acting
 * on that (setting the floor to 0 would remove all payout protection) — see runFloorRefreshOnce.
 */
export function computeFloorUpdate(
  marketRate: bigint,
  storedFloor: bigint,
  targetBps = 9200n,
  driftBps = 500n,
): bigint | null {
  const target = (marketRate * targetBps) / 10_000n;
  const lo = (target * (10_000n - driftBps)) / 10_000n;
  const hi = (target * (10_000n + driftBps)) / 10_000n;
  return storedFloor >= lo && storedFloor <= hi ? null : target;
}

export interface FloorRefreshDeps {
  /** Program bound to the keeper wallet (config.admin) — signs set_min_swap_rate. */
  program: Program<AnsemMiner>;
  /** config.admin (the keeper hot key). */
  keeper: PublicKey;
  /** Fetched fresh each pass so the stored floor + ansemMint track live config. */
  getConfig: () => Promise<ConfigState>;
  jupBaseUrl: string;
  slippageBps: number;
  /** Injectable fetch (stubbable in tests); the service passes global fetch. */
  fetchImpl: FetchLike;
  log: Logger;
}

/**
 * One floor-refresh pass: quote 1 SOL -> ANSEM on Jupiter, compare against the stored
 * floor, and send `set_min_swap_rate` (keeper IS config.admin) when drift demands it.
 * Best-effort — every failure is logged and swallowed by the caller; the floor never
 * blocks settlement. A non-positive quote is skipped so a bad route can never zero the floor.
 */
export async function runFloorRefreshOnce(deps: FloorRefreshDeps): Promise<void> {
  const cfg = await deps.getConfig();
  const jup: JupCfg = { jupBaseUrl: deps.jupBaseUrl, ansemMint: cfg.ansemMint, slippageBps: deps.slippageBps };
  const marketRate = await quoteSolToAnsem(jup, deps.fetchImpl, ONE_SOL_LAMPORTS);
  if (marketRate <= 0n) {
    deps.log.warn("floor: non-positive market quote — skipping", { market: marketRate.toString() });
    return;
  }
  const next = computeFloorUpdate(marketRate, cfg.minSwapRate);
  if (next === null) {
    deps.log.info("floor: in band — no update", {
      market: marketRate.toString(), floor: cfg.minSwapRate.toString(),
    });
    return;
  }
  deps.log.info("floor: drift detected — updating min_swap_rate", {
    market: marketRate.toString(), old: cfg.minSwapRate.toString(), next: next.toString(),
  });
  await l1Send(() => setMinSwapRateIx(deps.program, deps.keeper, new BN(next.toString())).rpc());
  deps.log.info("floor: min_swap_rate updated", {
    old: cfg.minSwapRate.toString(), next: next.toString(),
  });
}

export interface FloorRefresh { stop: () => void; }

/**
 * Start the periodic floor-refresh loop (default 300s, env `FLOOR_REFRESH_SECS`). Fires
 * once immediately (corrects a stale floor on the keeper redeploy — the live bug D9 fixes),
 * then on the interval. Passes are non-overlapping (an in-flight guard) and error-isolated.
 * Returns a stop handle for graceful shutdown.
 */
export function startFloorRefresh(deps: FloorRefreshDeps, intervalSecs: number): FloorRefresh {
  let inFlight = false;
  const runSafe = async () => {
    if (inFlight) return;
    inFlight = true;
    try { await runFloorRefreshOnce(deps); }
    catch (e) { deps.log.error("floor refresh failed", { err: String(e) }); }
    finally { inFlight = false; }
  };
  void runSafe();
  const timer = setInterval(() => { void runSafe(); }, intervalSecs * 1000);
  // Don't let this timer alone keep the process alive (SIGTERM/SIGINT still drain cleanly).
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
