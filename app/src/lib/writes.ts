"use client";
import { Connection, PublicKey, Keypair, Transaction, TransactionInstruction } from "@solana/web3.js";
import type { Program, Wallet } from "@coral-xyz/anchor";
import {
  buildEntryInstructions, stakeIx, escrowPda, minerPda, fetchEscrow, fetchMiner,
  awaitEr, awaitOwnerIs, erRpcTolerant, DLP_PROGRAM_ID, BN, type AnsemMiner, type EscrowState,
} from "@ansem/sdk";

export interface WalletAdapter {
  publicKey: PublicKey;
  signTransaction: <T extends Transaction>(tx: T) => Promise<T>;
  signAllTransactions?: <T extends Transaction>(txs: T[]) => Promise<T[]>;
}

export interface EnterRoundArgs {
  l1: Program<AnsemMiner>; connection: Connection; wallet: WalletAdapter;
  roundId: number; validator: PublicKey; includeInitMiner: boolean; validUntilSec: number;
  waitJoined?: (fetchEsc: () => Promise<EscrowState | null>) => Promise<void>;
  waitDelegated?: () => Promise<void>;
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
  await a.connection.confirmTransaction(signature, "confirmed");

  // propagation waits before the first ER stake
  if (a.waitJoined) await a.waitJoined(() => fetchEscrow(a.l1, escrowPda(a.wallet.publicKey)));
  else await awaitEr(() => fetchEscrow(a.l1, escrowPda(a.wallet.publicKey)), (e) => (e?.activeRound ?? -1) === a.roundId, 30, 1000);
  if (a.waitDelegated) await a.waitDelegated();
  else await awaitOwnerIs(a.connection, minerPda(a.wallet.publicKey), DLP_PROGRAM_ID.toBase58());

  return { sessionSigner: entry.sessionSigner, tokenPda: entry.tokenPda, validUntil: entry.validUntil, signature };
}

export interface GaslessStakeArgs {
  er: Program<AnsemMiner>; ownerWallet: PublicKey; sessionSigner: Keypair; tokenPda: PublicKey;
  square: number; amount: BN; roundId: number;
}

/** Gasless ER stake: session-signed, skipPreflight, confirmed by re-reading miner.blockStake[square]. */
export async function gaslessStake(a: GaslessStakeArgs): Promise<void> {
  const target = a.amount.toString();
  for (let i = 0; i < 12; i++) {
    const m = await fetchMiner(a.er, minerPda(a.ownerWallet));
    if (m && m.blockStake[a.square]?.toString() === target && m.roundId === a.roundId) return;
    await erRpcTolerant(() =>
      stakeIx(a.er, a.sessionSigner.publicKey, a.ownerWallet, a.square, a.amount, a.roundId, a.tokenPda)
        .rpc({ skipPreflight: true, commitment: "confirmed" }),
    );
    await new Promise((r) => setTimeout(r, 2500));
  }
  await awaitEr(() => fetchMiner(a.er, minerPda(a.ownerWallet)), (m) => m?.blockStake[a.square]?.toString() === target, 20, 2000);
}
