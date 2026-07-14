import { Connection, PublicKey } from "@solana/web3.js";
import { Program } from "@coral-xyz/anchor";
import {
  AnsemMiner, BN, roundPda, minerPda, escrowPda, ataForMint,
  createRoundIx, delegateRoundIx, requestSettleIx, commitRoundIx, commitMinerIx,
  reconcileMinerIx, executeSwapMockIx, executeSwapRealIx, cancelRoundIx, setRoundDurationIx, stampBeefIx,
  erRpcTolerant, retryPastDeadline, l1Send, awaitOwnerIs, flushCommit, fetchMiner,
  DLP_PROGRAM_ID, PROGRAM_ID, TOKEN_PROGRAM_ID,
  type ConfigState, type RoundStateData,
} from "@ansem/sdk";
import type { Logger } from "../logger.js";
import { fetchJoinedWallets } from "../participants.js";
import { quoteSolToAnsem, FetchLike } from "../jupiter.js";

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
  // ---- Real-payout swap (plan 2026-07-14, Task 7) ----
  /** "real" routes finalize through Jupiter + execute_swap_real; "mock" mints synthetic ANSEM. */
  swapMode: "mock" | "real";
  jupBaseUrl: string;
  slippageBps: number;
  /** Owning program of config.ansem_mint (classic vs Token-2022), detected once at startup.
   *  Threads into the inventory-ATA derivation + execute_swap_real's tokenProgram account so
   *  a Token-2022 $ANSEM mint settles correctly. Defaults classic if unset. */
  tokenProgramId?: PublicKey;
  /** Alert floor (ANSEM base units): warn when keeper inventory drops below this. 0 disables. */
  inventoryMinAnsem: bigint;
  /** Injected so the Jupiter quote is stubbable in tests; defaults to global fetch in service. */
  fetchImpl: FetchLike;
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

// ---- Real-mode swap leg (Jupiter quote -> keeper-inventory execute_swap_real) ----

/** Injected surface so the quote / inventory-gate / send sequence is unit-testable. */
export interface RealSwapDeps {
  /** Quote net SOL (lamports) -> ANSEM base units via Jupiter. */
  quote: (netLamports: bigint) => Promise<bigint>;
  /** Current keeper ANSEM ATA balance (base units). */
  inventory: () => Promise<bigint>;
  /** Send execute_swap_real for `ansemOut`. */
  sendSwap: (ansemOut: bigint) => Promise<void>;
  log: Logger;
}

/**
 * SETTLED real-mode payout: fee off the pot, quote the net SOL -> ANSEM, then GATE on
 * keeper inventory. If the ATA can't cover the quoted payout we log an error and return
 * WITHOUT sending — the tick retries next pass (buyback refills between). Only when the
 * inventory covers it do we send execute_swap_real, which pulls the exact amount in-ix.
 * feeBps comes from the fetched config (never hardcoded).
 */
export async function realExecuteSwap(
  roundId: number,
  pot: bigint,
  feeBps: number,
  inventoryMin: bigint,
  deps: RealSwapDeps,
): Promise<void> {
  const fee = (pot * BigInt(feeBps)) / 10_000n;
  const net = pot - fee;
  const ansemOut = await deps.quote(net);
  const have = await deps.inventory();
  if (have < ansemOut) {
    deps.log.error("inventory short — real swap deferred (tick retries)", {
      roundId, need: ansemOut.toString(), have: have.toString(),
    });
    return; // NO send: leave the round SETTLED so the next tick retries after refill
  }
  if (inventoryMin > 0n && have < inventoryMin) {
    deps.log.warn("keeper ANSEM inventory below alert floor", {
      roundId, have: have.toString(), floor: inventoryMin.toString(),
    });
  }
  await deps.sendSwap(ansemOut);
}

/** Live real-swap deps: Jupiter quote + on-chain ATA balance + execute_swap_real send. */
export function liveRealSwapDeps(ctx: ActionCtx, roundId: number, config: ConfigState): RealSwapDeps {
  const ansemMint = new PublicKey(config.ansemMint);
  // Whichever program owns the mint (classic or Token-2022) — threaded into BOTH the
  // inventory-ATA derivation and execute_swap_real so the shapes match on-chain.
  const tokenProgramId = ctx.tokenProgramId ?? TOKEN_PROGRAM_ID;
  return {
    quote: (net) =>
      quoteSolToAnsem(
        { jupBaseUrl: ctx.jupBaseUrl, ansemMint: config.ansemMint, slippageBps: ctx.slippageBps },
        ctx.fetchImpl, net,
      ),
    inventory: async () => {
      const ata = ataForMint(ansemMint, ctx.keeper, tokenProgramId);
      const bal = await ctx.conn.getTokenAccountBalance(ata).catch(() => null);
      return bal ? BigInt(bal.value.amount) : 0n;
    },
    sendSwap: async (ansemOut) => {
      await l1Send(() =>
        executeSwapRealIx(ctx.program, ctx.keeper, roundId, new BN(ansemOut.toString()), ansemMint, tokenProgramId).rpc());
      ctx.log.info("round swapped (real) -> CLAIMABLE", { roundId, ansemOut: ansemOut.toString() });
    },
    log: ctx.log,
  };
}

export function liveFinalizeDeps(
  ctx: ActionCtx, roundId: number, config: ConfigState, round: RoundStateData,
): FinalizeDeps {
  const executeSwap = ctx.swapMode === "real"
    ? () => realExecuteSwap(roundId, round.pot, config.feeBps, ctx.inventoryMinAnsem, liveRealSwapDeps(ctx, roundId, config))
    : async () => {
        await l1Send(() => executeSwapMockIx(ctx.program, ctx.keeper, roundId).rpc());
        ctx.log.info("round swapped -> CLAIMABLE", { roundId });
      };
  return {
    joinedWallets: () => fetchJoinedWallets(ctx.conn, roundId),
    reconcileMiner: (w) =>
      l1Send(() => reconcileMinerIx(ctx.program, roundId, escrowPda(w), minerPda(w)).rpc()),
    executeSwap,
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
