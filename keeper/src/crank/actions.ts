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

/** Small injected surface so finalize's ordering/resilience is unit-testable. */
export interface FinalizeDeps {
  joinedWallets: () => Promise<PublicKey[]>;
  commitMiner: (wallet: PublicKey) => Promise<void>; // ER; may throw (retried/idempotent upstream)
  commitRound: () => Promise<void>;
  reconcileMiner: (wallet: PublicKey) => Promise<void>;
  executeSwap: () => Promise<void>;
}

/**
 * SETTLED -> CLAIMABLE. Commit every joined miner (while still delegated) THEN the
 * round; then reconcile every joined wallet (staked or not -- clears the lock) and
 * swap. Commit failures are swallowed per-miner (idempotent; a stale/early commit
 * self-heals on the next tick); reconcile+swap must still run.
 */
export async function finalizeRound(roundId: number, deps: FinalizeDeps): Promise<void> {
  const joined = await deps.joinedWallets();
  for (const w of joined) {
    try { await deps.commitMiner(w); } catch { /* idempotent: retry next tick / already committed */ }
  }
  await deps.commitRound();
  for (const w of joined) {
    await deps.reconcileMiner(w); // reconcile is idempotent (reconciled_round guard)
  }
  await deps.executeSwap();
}

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

/** Wire the real SDK/ER calls into FinalizeDeps for the live loop. */
export function liveFinalizeDeps(ctx: ActionCtx, roundId: number): FinalizeDeps {
  const rpda = roundPda(roundId);
  return {
    joinedWallets: () => fetchJoinedWallets(ctx.conn, roundId),
    commitMiner: async (w) => {
      const mpda = minerPda(w);
      const info = await ctx.conn.getAccountInfo(mpda, "confirmed").catch(() => null);
      if (info && info.owner.toBase58() === PROGRAM_ID.toBase58()) return; // already on L1
      const sig = await commitMinerIx(ctx.erProgram, ctx.keeper, mpda, rpda)
        .rpc({ skipPreflight: true, commitment: "confirmed" });
      await flushCommit(sig, ctx.erConn);
    },
    commitRound: async () => {
      await erRpcTolerant(() => commitRoundIx(ctx.erProgram, ctx.keeper, roundId)
        .rpc({ skipPreflight: true, commitment: "confirmed" }));
      await awaitOwnerIs(ctx.conn, rpda, PROGRAM_ID.toBase58());
    },
    reconcileMiner: async (w) =>
      l1Send(() => reconcileMinerIx(ctx.program, roundId, escrowPda(w), minerPda(w)).rpc()),
    executeSwap: async () =>
      l1Send(() => executeSwapMockIx(ctx.program, ctx.keeper, roundId).rpc()),
  };
}

/** finalized/terminal -> set duration, open + delegate the next round (id = current + 1). */
export async function createAndDelegate(ctx: ActionCtx, nextRoundId: number): Promise<void> {
  await l1Send(() => setRoundDurationIx(ctx.program, ctx.keeper, ctx.roundDurationSecs).rpc());
  await l1Send(() => createRoundIx(ctx.program, ctx.keeper, nextRoundId).rpc());
  await l1Send(() => delegateRoundIx(ctx.program, ctx.keeper, nextRoundId, ctx.validator)
    .rpc({ skipPreflight: true, commitment: "confirmed" }));
  await awaitOwnerIs(ctx.conn, roundPda(nextRoundId), DLP_PROGRAM_ID.toBase58());
  ctx.log.info("round opened + delegated", { roundId: nextRoundId });
}

/** OPEN past deadline -> request VRF settle; retry through clock-lag until it leaves OPEN. */
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
