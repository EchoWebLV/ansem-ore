import { PublicKey } from "@solana/web3.js";
import { Program } from "@coral-xyz/anchor";
import { AnsemMiner, RoundState, closeRoundIx, l1Send } from "@ansem/sdk";
import type { Logger } from "./logger.js";

/** How many service ticks between janitor passes. */
export const JANITOR_TICK_CADENCE = 12;
/** Cap on close_round txs sent per pass (keeps a single tick bounded). */
export const MAX_CLOSE_PER_PASS = 20;

/** Minimal round shape the selector needs (decoded from getProgramAccounts). */
export interface CloseableRound {
  roundId: number;
  state: RoundState;
  deadlineTs: number;
  pot: bigint;
}

/**
 * Pure: which rounds are safe to close_round right now (mirrors the on-chain gates in
 * instructions/janitor.rs). A CLAIMABLE round once its claim window has fully elapsed
 * (forfeits the unclaimed remainder into the jackpot), OR an EMPTY cancelled round
 * (CLOSED && pot == 0). A NON-EMPTY cancelled round is never closed — its refund_direct
 * path must stay alive. Capped at MAX_CLOSE_PER_PASS.
 */
export function selectCloseable(
  rounds: CloseableRound[],
  claimWindowSecs: number,
  nowSec: number,
): number[] {
  return rounds
    .filter(
      (r) =>
        (r.state === RoundState.Claimable && nowSec >= r.deadlineTs + claimWindowSecs) ||
        (r.state === RoundState.Closed && r.pot === 0n),
    )
    .map((r) => r.roundId)
    .slice(0, MAX_CLOSE_PER_PASS);
}

export interface JanitorCtx {
  program: Program<AnsemMiner>;
  keeper: PublicKey;
  /** Fetched fresh each pass so the claim window tracks live config. */
  getClaimWindowSecs: () => Promise<number>;
  nowSec: () => number;
  log: Logger;
}

// Defensive numeric coercion — anchor decodes u64/i64 fields as BN, u8 as number.
const asNum = (x: any): number => (typeof x?.toNumber === "function" ? x.toNumber() : Number(x));
const asBig = (x: any): bigint => (typeof x?.toString === "function" ? BigInt(x.toString()) : BigInt(x));

/**
 * One janitor pass: enumerate every current-layout Round account (anchor's `.all()`
 * applies the Round discriminator memcmp; we additionally pin the exact current
 * account size so it never tries to bulk-decode a foreign-length account), then send
 * up to MAX_CLOSE_PER_PASS close_round txs, reclaiming rent to config.admin (the
 * keeper). Each send is best-effort — a failed close just retries next pass.
 *
 * Why the `dataSize` filter is load-bearing: `getProgramAccounts` returns EVERY
 * program-owned account carrying the Round discriminator, including rounds written by
 * an earlier Round layout (a different byte length) — e.g. devnet still holds ~1600
 * rounds from pre-`close_round` builds that can never be reaped. Anchor's `.all()`
 * borsh-decodes each and THROWS on the first size mismatch, which would kill every
 * janitor pass (and a discriminator-squatting account could do the same on any
 * cluster). Pinning `dataSize` to the current `Round` size returns only decodable,
 * current-layout rounds.
 */
export async function runJanitor(ctx: JanitorCtx): Promise<void> {
  const claimWindowSecs = await ctx.getClaimWindowSecs();
  const all = await ctx.program.account.round.all([
    { dataSize: ctx.program.account.round.size },
  ]);
  const rounds: CloseableRound[] = all.map(({ account }: any) => ({
    roundId: asNum(account.roundId),
    state: account.state as RoundState,
    deadlineTs: asNum(account.deadlineTs),
    pot: asBig(account.pot),
  }));
  const ids = selectCloseable(rounds, claimWindowSecs, ctx.nowSec());
  for (const roundId of ids) {
    try {
      await l1Send(() => closeRoundIx(ctx.program, ctx.keeper, roundId, ctx.keeper).rpc());
      ctx.log.info("round closed (rent reclaimed)", { roundId });
    } catch (e) {
      ctx.log.warn("close_round failed (retry next pass)", { roundId, err: String(e) });
    }
  }
}
