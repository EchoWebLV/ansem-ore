import { Connection, PublicKey } from "@solana/web3.js";
import { Program } from "@coral-xyz/anchor";
import {
  AnsemMiner, roundPda, minerPda, escrowPda,
  createRoundIx, delegateRoundIx, requestSettleIx, commitRoundIx, commitMinerIx,
  reconcileMinerIx, executeSwapMockIx, cancelRoundIx, setRoundDurationIx,
  erRpcTolerant, retryPastDeadline, l1Send, awaitOwnerIs, flushCommit,
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

export function liveCommitDeps(ctx: ActionCtx, roundId: number): CommitDeps {
  const rpda = roundPda(roundId);
  return {
    joinedWallets: () => fetchJoinedWallets(ctx.conn, roundId),
    commitMiner: async (w) => {
      const mpda = minerPda(w);
      const info = await ctx.conn.getAccountInfo(mpda, "confirmed").catch(() => null);
      if (info && info.owner.toBase58() === PROGRAM_ID.toBase58()) return; // already on L1
      try {
        const sig = await commitMinerIx(ctx.erProgram, ctx.keeper, mpda, rpda)
          .rpc({ skipPreflight: true, commitment: "confirmed" });
        await flushCommit(sig, ctx.erConn);
      } catch (e) {
        // Unstaked-this-round wallet: its miner.round_id != current round -> nothing
        // to commit for the pot. Skip (don't block commit_round). Everything else
        // (CommitTooEarly clock lag, ER confirm flake) is retry-able -> rethrow.
        if (/MinerRoundMismatch/i.test(String(e))) return;
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
  };
}

// ---- Single-shot L1 actions ----

/** finalized/terminal -> set duration, open + delegate the next round (id = current + 1). */
export async function createAndDelegate(ctx: ActionCtx, nextRoundId: number): Promise<void> {
  await l1Send(() => setRoundDurationIx(ctx.program, ctx.keeper, ctx.roundDurationSecs).rpc());
  await l1Send(() => createRoundIx(ctx.program, ctx.keeper, nextRoundId).rpc());
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
