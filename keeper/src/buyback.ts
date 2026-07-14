import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { Program } from "@coral-xyz/anchor";
import {
  AnsemMiner, BN, ConfigState, treasuryPda, sweepTreasuryIx, l1Send,
} from "@ansem/sdk";
import type { Logger } from "./logger.js";
import { JupCfg, FetchLike, swapSolToAnsem } from "./jupiter.js";

/** How many service ticks between buyback passes. */
export const BUYBACK_TICK_CADENCE = 20;

const solToLamports = (sol: number): bigint => BigInt(Math.round(sol * LAMPORTS_PER_SOL));

/**
 * Pure buyback sizing. Fires only above the `minSol` threshold; sweeps everything but
 * `keepSol` (rent + float) out of the treasury, then swaps the fee-net share to ANSEM —
 * the `feeBps` slice stays SOL as ops runway. Returns null below threshold.
 */
export function buybackPlan(
  treasuryLamports: bigint,
  feeBps: number,
  minSol: number,
  keepSol: number,
): { sweep: bigint; swap: bigint } | null {
  if (treasuryLamports <= solToLamports(minSol)) return null;
  const sweep = treasuryLamports - solToLamports(keepSol);
  if (sweep <= 0n) return null;
  const swap = sweep - (sweep * BigInt(feeBps)) / 10_000n;
  return { sweep, swap };
}

export interface BuybackCtx {
  conn: Connection;
  program: Program<AnsemMiner>;
  keeper: PublicKey;
  keypair: Keypair;
  fetchImpl: FetchLike;
  jupBaseUrl: string;
  slippageBps: number;
  minSol: number;
  keepSol: number;
  /** Fetched fresh each pass so feeBps + ansemMint track live config. */
  getConfig: () => Promise<ConfigState>;
  log: Logger;
}

/**
 * One buyback pass (real mode only, on cadence): read treasury lamports, and if above
 * the threshold sweep_treasury into the keeper wallet then buy ANSEM on Jupiter. Every
 * leg is logged. Uses live config for feeBps (SOL runway split) and ansemMint (buy target).
 */
export async function runBuyback(ctx: BuybackCtx): Promise<void> {
  const cfg = await ctx.getConfig();
  const treasury = treasuryPda();
  const bal = BigInt(await ctx.conn.getBalance(treasury, "confirmed"));
  const plan = buybackPlan(bal, cfg.feeBps, ctx.minSol, ctx.keepSol);
  if (!plan) return; // below threshold — nothing to sweep this pass

  ctx.log.info("buyback: sweeping treasury", { treasury: bal.toString(), sweep: plan.sweep.toString() });
  await l1Send(() => sweepTreasuryIx(ctx.program, ctx.keeper, new BN(plan.sweep.toString()), ctx.keeper).rpc());

  ctx.log.info("buyback: swapping SOL -> ANSEM", { swap: plan.swap.toString(), feeBps: cfg.feeBps });
  const jup: JupCfg = { jupBaseUrl: ctx.jupBaseUrl, ansemMint: cfg.ansemMint, slippageBps: ctx.slippageBps };
  const sig = await swapSolToAnsem(jup, ctx.conn, ctx.keypair, ctx.fetchImpl, plan.swap);
  ctx.log.info("buyback: swap confirmed", { sig });
}
