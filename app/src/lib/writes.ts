"use client";
import { Connection, PublicKey, Keypair, Transaction, TransactionInstruction } from "@solana/web3.js";
import type { Program, Wallet } from "@coral-xyz/anchor";
import {
  buildEntryInstructions, stakeIx, stakeDirectIx, escrowPda, minerPda, fetchEscrow, fetchMiner,
  awaitEr, awaitOwnerIs, erRpcTolerant, sleep, DLP_PROGRAM_ID, BN, type AnsemMiner, type EscrowState,
} from "@ansem/sdk";

export interface WalletAdapter {
  publicKey: PublicKey;
  signTransaction: <T extends Transaction>(tx: T) => Promise<T>;
  signAllTransactions?: <T extends Transaction>(txs: T[]) => Promise<T[]>;
}

export interface LandedSession { sessionSigner: Keypair; tokenPda: PublicKey; validUntil: number; }

export interface EnterRoundArgs {
  l1: Program<AnsemMiner>; connection: Connection; wallet: WalletAdapter;
  roundId: number; validator: PublicKey; includeInitMiner: boolean; validUntilSec: number;
  /** Fired the instant the entry tx CONFIRMS, before propagation waits — persist the session here. */
  onLanded?: (s: LandedSession) => void;
  /** Fallback when confirmTransaction throws/errs: resolve true iff the entry verifiably landed on-chain. */
  verifyLanded?: () => Promise<boolean>;
  waitJoined?: (fetchEsc: () => Promise<EscrowState | null>) => Promise<void>;
  waitDelegated?: () => Promise<void>;
}

// ---- Direct-stake engine (ORE model): ONE wallet approval, SOL moves
// wallet -> pot inside the tx. Multi-square = N stake_direct instructions in
// one transaction. No escrow, no session key, no delegation.

export interface DirectStakeArgs {
  l1: Program<AnsemMiner>;
  owner: PublicKey;
  roundId: number;
  squares: number[];
  amountPerSquare: BN;
  /** Injectable sender (tests). Defaults to the provider's sendAndConfirm (the single popup). */
  send?: (tx: Transaction) => Promise<string>;
}

export async function directStake(a: DirectStakeArgs): Promise<string> {
  if (a.squares.length === 0) throw new Error("pick at least one square");
  const ixs: TransactionInstruction[] = [];
  for (const sq of a.squares) {
    ixs.push(await stakeDirectIx(a.l1, a.owner, a.roundId, sq, a.amountPerSquare).instruction());
  }
  const tx = new Transaction().add(...ixs);
  const send = a.send ?? ((t: Transaction) =>
    (a.l1.provider as unknown as { sendAndConfirm: (tx: Transaction) => Promise<string> }).sendAndConfirm(t));
  return await send(tx);
}

/** ONE-POPUP entry: build the batch, session co-sign, wallet sign (single popup), send skipPreflight, wait. */
export async function enterRound(a: EnterRoundArgs): Promise<{ sessionSigner: Keypair; tokenPda: PublicKey; validUntil: number; signature: string }> {
  const entry = await buildEntryInstructions(
    a.l1, a.connection, a.wallet as unknown as Wallet,
    a.roundId, a.validator, a.validUntilSec, { includeInitMiner: a.includeInitMiner },
  );
  const tx = new Transaction().add(...(entry.instructions as TransactionInstruction[]));
  tx.feePayer = a.wallet.publicKey;
  tx.recentBlockhash = (await a.connection.getLatestBlockhash("confirmed")).blockhash;
  tx.partialSign(entry.sessionSigner);               // session co-signs (programmatic)
  const signed = await a.wallet.signTransaction(tx); // THE single wallet popup
  const signature = await a.connection.sendRawTransaction(signed.serialize(), { skipPreflight: true });

  // Confirm the entry. skipPreflight has TWO failure modes we must resolve before persisting
  // the session, or we corrupt the round for this player:
  //   (1) a tx that FAILS on-chain still "confirms" — with a non-null err. The entry is one
  //       atomic tx, so if it errs, createSessionV2 reverted and NO session token minted.
  //   (2) confirmTransaction can THROW (timeout / expired blockhash) on a tx that DID land.
  //       Dropping the session then locks the joined player out of staking all round.
  // (1) is DEFINITIVE -> throw immediately, never persist a phantom session. (2) is uncertain
  // -> proceed only if THIS entry verifiably landed. verifyLanded checks the entry's UNIQUE
  // product — the freshly-minted session token PDA — NOT escrow.active_round (a prior entry
  // could have set that; a re-entry whose join_round reverts with RoundAlreadyJoined would
  // then false-positive and persist a phantom session for a token that never minted).
  const escOf = () => fetchEscrow(a.l1, escrowPda(a.wallet.publicKey));
  const joined = (e: EscrowState | null) => (e?.activeRound ?? -1) === a.roundId;
  const verifyLanded = a.verifyLanded ?? (async () => {
    for (let i = 0; i < 8; i++) {
      const info = await a.connection.getAccountInfo(entry.tokenPda, "confirmed").catch(() => null);
      if (info) return true;
      await sleep(1000);
    }
    return false;
  });

  let confErr: unknown = null;
  let confirmed: { value: { err: unknown } } | null = null;
  try { confirmed = await a.connection.confirmTransaction(signature, "confirmed"); }
  catch (e) { confErr = e; }
  if (confirmed?.value?.err) {
    throw new Error(`entry tx ${signature} failed on-chain: ${JSON.stringify(confirmed.value.err)}`);
  }
  if (confErr && !(await verifyLanded())) throw confErr;

  // The entry has LANDED (session minted, joined, miner delegated). Persist the session now,
  // before the propagation waits below — a slow/timed-out wait must not strand a joined player
  // with a forgotten session key (they could then neither stake nor re-enter until finalize).
  const landed: LandedSession = { sessionSigner: entry.sessionSigner, tokenPda: entry.tokenPda, validUntil: entry.validUntil };
  a.onLanded?.(landed);

  // propagation waits before the first ER stake
  if (a.waitJoined) await a.waitJoined(escOf);
  else await awaitEr(escOf, joined, 30, 1000);
  if (a.waitDelegated) await a.waitDelegated();
  else await awaitOwnerIs(a.connection, minerPda(a.wallet.publicKey), DLP_PROGRAM_ID.toBase58());

  return { ...landed, signature };
}

export interface GaslessStakeArgs {
  er: Program<AnsemMiner>; ownerWallet: PublicKey; sessionSigner: Keypair; tokenPda: PublicKey;
  square: number; amount: BN; roundId: number;
}

/**
 * Gasless ER stake: session-signed, skipPreflight. On-chain `stake` is ADDITIVE + atomic
 * (`block_stake[sq] += amount`), so we confirm on a DELTA from the pre-stake snapshot and
 * resend ONLY until our stake for THIS round has landed. Two subtleties the delta must
 * respect, or the non-idempotent additive stake gets sent more than once:
 *
 *  1. Cross-round staleness: the miner keeps LAST round's `block_stake` until the first
 *     stake of the NEW round zeroes it on-chain (stake.rs). A miner whose `roundId` isn't
 *     the round we're staking therefore contributes 0 to THIS round's baseline — counting
 *     its stale value would make the delta compare against last round's amount and resend
 *     until the cumulative exceeds it (runaway over-stake).
 *  2. Read failures: `fetchMiner` swallows RPC errors to `null`, indistinguishable from a
 *     genuine 0. We treat a failed read as UNKNOWN (retry), never as 0 — so a transient
 *     read right after a landed stake can't look like "not landed" and double-send.
 *
 * `readStaked()` folds both in: null = unknown, else this round's stake on the square.
 */
export async function gaslessStake(a: GaslessStakeArgs): Promise<void> {
  const miner = minerPda(a.ownerWallet);
  const read = () => fetchMiner(a.er, miner); // null = UNKNOWN (fetchMiner swallows RPC errors), never 0

  // Baseline = this round's existing stake on the square (0 for a fresh entry, the prior
  // amount for an additive re-stake). A stale CROSS-ROUND snapshot counts as 0, but a FAILED
  // read must never degrade to 0 — that would make an existing same-round stake read as
  // "already landed" and silently drop the new one. Retry through a transient blip; if the ER
  // stays unreadable, throw rather than guess.
  let baseline: bigint | null = null;
  for (let i = 0; i < 8 && baseline === null; i++) {
    const m = await read();
    if (m) baseline = m.roundId === a.roundId ? m.blockStake[a.square] : 0n;
    else await sleep(1000);
  }
  if (baseline === null) throw new Error("gaslessStake: ER miner unreadable — could not establish a baseline; retry the stake");
  const before = baseline;
  const target = before + BigInt(a.amount.toString());

  // Land exactly one additive `+amount`. The landed signal is unambiguous: a confirmed read
  // for THIS round whose square reached `target`. Once we have sent, a read that is null OR
  // still shows a different round is UNKNOWN (keep waiting, never resend); we resend only on a
  // confirmed this-round read still below target. This closes both the transient-null and the
  // stale-cross-round double-send windows of the non-idempotent additive stake.
  let sent = false;
  for (let i = 0; i < 12; i++) {
    const m = await read();
    const thisRound = m !== null && m.roundId === a.roundId;
    if (thisRound && m.blockStake[a.square] >= target) return;        // landed
    if (sent && (m === null || !thisRound)) { await sleep(1500); continue; } // unknown after send -> wait, don't resend
    try {
      await erRpcTolerant(() =>
        stakeIx(a.er, a.sessionSigner.publicKey, a.ownerWallet, a.square, a.amount, a.roundId, a.tokenPda)
          .rpc({ skipPreflight: true, commitment: "confirmed" }),
      );
    } catch { /* send failed; the loop re-checks and only resends on a confirmed not-landed read */ }
    sent = true;
    await sleep(2500);
  }
  await awaitEr(read, (m) => m !== null && m.roundId === a.roundId && m.blockStake[a.square] >= target, 20, 2000);
}
