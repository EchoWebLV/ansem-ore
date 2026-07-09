import { Connection, PublicKey } from "@solana/web3.js";
import { Program } from "@coral-xyz/anchor";
import {
  AnsemMiner, roundPda, minerPda, escrowPda,
  createRoundIx, delegateRoundIx, requestSettleIx, commitRoundIx, commitMinerIx,
  reconcileMinerIx, executeSwapMockIx, cancelRoundIx, setRoundDurationIx, stampBeefIx,
  erRpcTolerant, retryPastDeadline, l1Send, awaitOwnerIs, flushCommit, fetchMiner,
  DLP_PROGRAM_ID, PROGRAM_ID,
} from "@ansem/sdk";
import type { Logger } from "../logger.js";
import { fetchJoinedWallets } from "../participants.js";

export interface ActionCtx {
  conn: Connection;
  erConn: Connection;
  program: Program<AnsemMiner>;
  erProgram: Program<AnsemMiner>;
  keeper: PublicKey;
  validator: PublicKey;
  vrfQueue: PublicKey;
  roundDurationSecs: number;
  /** Direct-stake mode: rounds stay on L1 (never delegated) so players can
   *  stake_direct against them; the commit/reconcile stages never fire. */
  directMode?: boolean;
  /** BEEF emission layer: set at startup if BeefConfig exists on-chain. */
  beefEnabled?: boolean;
  beefVault?: PublicKey;
  log: Logger;
}

// ---- Commit the delegated round back to L1 (before settle) ----

/** Injected surface so commit ordering/deferral is unit-testable. */
export interface CommitDeps {
  joinedWallets: () => Promise<PublicKey[]>;
  /** Resolves if the miner is committed OR safely skippable (unstaked / already on L1);
   *  throws only on a retry-able failure (clock lag / transient RPC). */
  commitMiner: (wallet: PublicKey) => Promise<void>;
  commitRound: () => Promise<void>;
}

/**
 * OPEN past-deadline, still delegated -> commit every joined miner, THEN the round
 * (undelegating it to L1). Defer `commit_round` until EVERY miner is on L1: a
 * retry-able commit failure (validator-clock lag -> CommitTooEarly) leaves the
 * round delegated so the next tick retries, rather than undelegating with miners
 * still stranded in the ER (which would break reconcile / the swap solvency gate).
 */
export async function commitToL1(_roundId: number, deps: CommitDeps): Promise<void> {
  const joined = await deps.joinedWallets();
  let allReady = true;
  for (const w of joined) {
    try { await deps.commitMiner(w); }
    catch { allReady = false; } // clock lag / transient -> retry next tick
  }
  if (!allReady) return; // do NOT undelegate the round until every miner has landed on L1
  await deps.commitRound();
}

/**
 * True when a commit_miner failure means "this miner isn't part of the CURRENT round".
 * commit_miner's `round` account is seed-bound to miner.round_id (delegation.rs), so a
 * miner stamped for another round fails ACCOUNT VALIDATION with ConstraintSeeds (2006),
 * or AccountNotInitialized (3012) if that round's PDA was never created — NOT the
 * handler's MinerRoundMismatch (which the seeds constraint makes unreachable; the old
 * skip matched it and so never fired, wedging the round). Such a miner has nothing to
 * contribute to this round's pot -> SKIP it so a stray account can't defer commit_round
 * forever. Everything else (CommitTooEarly clock lag, ER confirm flake, RPC error) is
 * retryable -> the caller rethrows and retries next tick.
 */
export function isNotThisRoundError(e: unknown): boolean {
  return /ConstraintSeeds|AccountNotInitialized|\b2006\b|\b3012\b|MinerRoundMismatch/i.test(String(e));
}

export function liveCommitDeps(ctx: ActionCtx, roundId: number): CommitDeps {
  const rpda = roundPda(roundId);
  return {
    joinedWallets: () => fetchJoinedWallets(ctx.conn, roundId),
    commitMiner: async (w) => {
      const mpda = minerPda(w);
      const info = await ctx.conn.getAccountInfo(mpda, "confirmed").catch(() => null);
      if (info && info.owner.toBase58() === PROGRAM_ID.toBase58()) return; // already undelegated to L1
      // Positive skip: only a miner stamped for THIS round is committable (commit_miner's
      // `round` is seed-bound to miner.round_id). Post the join_round-stamp fix every
      // joined miner is this round, so this normally never skips — it's the backstop that
      // keeps a stray/mismatched miner from deferring commit_round forever (the old wedge).
      const erMiner = await fetchMiner(ctx.erProgram, mpda).catch(() => null);
      if (erMiner && erMiner.roundId !== roundId) return;
      try {
        const sig = await commitMinerIx(ctx.erProgram, ctx.keeper, mpda, rpda)
          .rpc({ skipPreflight: true, commitment: "confirmed" });
        await flushCommit(sig, ctx.erConn);
      } catch (e) {
        // If the pre-read missed it, the mismatch still surfaces here as a seeds/init
        // error -> skip; otherwise it is retryable (see isNotThisRoundError).
        if (isNotThisRoundError(e)) return;
        throw e;
      }
    },
    commitRound: async () => {
      const info = await ctx.conn.getAccountInfo(rpda, "confirmed").catch(() => null);
      if (info && info.owner.toBase58() === PROGRAM_ID.toBase58()) return; // already undelegated
      await erRpcTolerant(() => commitRoundIx(ctx.erProgram, ctx.keeper, roundId)
        .rpc({ skipPreflight: true, commitment: "confirmed" }));
      await awaitOwnerIs(ctx.conn, rpda, PROGRAM_ID.toBase58());
      ctx.log.info("round committed back to L1", { roundId });
    },
  };
}

// ---- Finalize a SETTLED round on L1 (reconcile + swap) ----

/** Injected surface so reconcile-before-swap ordering is unit-testable. */
export interface FinalizeDeps {
  joinedWallets: () => Promise<PublicKey[]>;
  reconcileMiner: (wallet: PublicKey) => Promise<void>;
  executeSwap: () => Promise<void>;
  /** BEEF emission stamp — best-effort, always after the swap. Optional: absent
   *  when BEEF isn't initialized. A throw here must never block finalize. */
  stampBeef?: () => Promise<void>;
}

/**
 * SETTLED -> CLAIMABLE. Reconcile every joined wallet (staked or not -- clears the
 * withdraw-lock) THEN swap. reconcile is idempotent (reconciled_round guard), so a
 * throw here just retries the whole finalize next tick before the swap runs.
 */
export async function finalizeSettled(_roundId: number, deps: FinalizeDeps): Promise<void> {
  const joined = await deps.joinedWallets();
  for (const w of joined) {
    await deps.reconcileMiner(w);
  }
  await deps.executeSwap();
  if (deps.stampBeef) {
    try { await deps.stampBeef(); }
    catch { /* best-effort: BEEF never blocks the game (invariant) */ }
  }
}

export function liveFinalizeDeps(ctx: ActionCtx, roundId: number): FinalizeDeps {
  return {
    joinedWallets: () => fetchJoinedWallets(ctx.conn, roundId),
    reconcileMiner: (w) =>
      l1Send(() => reconcileMinerIx(ctx.program, roundId, escrowPda(w), minerPda(w)).rpc()),
    executeSwap: async () => {
      await l1Send(() => executeSwapMockIx(ctx.program, ctx.keeper, roundId).rpc());
      ctx.log.info("round swapped -> CLAIMABLE", { roundId });
    },
    stampBeef: ctx.beefEnabled && ctx.beefVault ? async () => {
      await l1Send(() => stampBeefIx(ctx.program, ctx.keeper, roundId, ctx.beefVault!).rpc());
      ctx.log.info("beef emission stamped", { roundId });
    } : undefined,
  };
}

// ---- Single-shot L1 actions ----

/** finalized/terminal -> set duration, open (+ delegate unless direct mode) the next round. */
export async function createAndDelegate(ctx: ActionCtx, nextRoundId: number): Promise<void> {
  await l1Send(() => setRoundDurationIx(ctx.program, ctx.keeper, ctx.roundDurationSecs).rpc());
  await l1Send(() => createRoundIx(ctx.program, ctx.keeper, nextRoundId).rpc());
  if (ctx.directMode) {
    // Direct-stake: the round stays program-owned on L1 so stake_direct txs can
    // write it. No delegation, no commit later — the keeper goes straight to
    // settle at the deadline.
    ctx.log.info("round opened (direct L1)", { roundId: nextRoundId });
    return;
  }
  await l1Send(() => delegateRoundIx(ctx.program, ctx.keeper, nextRoundId, ctx.validator)
    .rpc({ skipPreflight: true, commitment: "confirmed" }));
  await awaitOwnerIs(ctx.conn, roundPda(nextRoundId), DLP_PROGRAM_ID.toBase58());
  ctx.log.info("round opened + delegated", { roundId: nextRoundId });
}

/** OPEN past deadline, on L1 -> request VRF settle; retry through clock-lag until it leaves OPEN. */
export async function requestSettle(ctx: ActionCtx, roundId: number): Promise<void> {
  await retryPastDeadline(
    () => requestSettleIx(ctx.program, ctx.keeper, roundId, 7, ctx.vrfQueue).rpc({ commitment: "confirmed" }),
    `request_settle round ${roundId}`,
  );
  ctx.log.info("request_settle posted", { roundId });
}

/** Grace exceeded / stranded -> cancel (past-deadline gated); players refund off-loop. */
export async function cancelRound(ctx: ActionCtx, roundId: number): Promise<void> {
  await retryPastDeadline(
    () => cancelRoundIx(ctx.program, ctx.keeper, roundId).rpc(),
    `cancel round ${roundId}`,
  );
  ctx.log.warn("round cancelled (grace exceeded / stranded)", { roundId });
}
