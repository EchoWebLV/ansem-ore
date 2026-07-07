"use client";
import { useMemo } from "react";
import { Connection, Keypair, Transaction, VersionedTransaction } from "@solana/web3.js";
import type { Program, Wallet } from "@coral-xyz/anchor";
import { useConnection, useAnchorWallet } from "@solana/wallet-adapter-react";
import {
  createProgram, createErProgram, DEFAULT_ER_ENDPOINT, DEFAULT_ER_WS_ENDPOINT, type AnsemMiner,
} from "@ansem/sdk";

/**
 * Browser-safe anchor Wallet backed by a Keypair. anchor's own `Wallet` (NodeWallet)
 * is Node-only and resolves to undefined in the browser, so we build the interface.
 */
export function keypairWallet(kp: Keypair): Wallet {
  const sign = <T extends Transaction | VersionedTransaction>(tx: T): T => {
    if (tx instanceof VersionedTransaction) tx.sign([kp]);
    else (tx as Transaction).partialSign(kp);
    return tx;
  };
  return {
    publicKey: kp.publicKey,
    payer: kp,
    signTransaction: async (tx) => sign(tx),
    signAllTransactions: async (txs) => txs.map(sign),
  } as Wallet;
}

/** A dedicated Connection to the MagicBlock ER (never the router — writes need the regional endpoint). */
export function erConnection(): Connection {
  const url = process.env.NEXT_PUBLIC_ER_ENDPOINT ?? DEFAULT_ER_ENDPOINT;
  const ws = process.env.NEXT_PUBLIC_ER_WS_ENDPOINT ?? DEFAULT_ER_WS_ENDPOINT;
  return new Connection(url, { wsEndpoint: ws, commitment: "confirmed" });
}

/** L1 program bound to the connected adapter wallet. `undefined` until a wallet connects. */
export function useL1Program(): Program<AnsemMiner> | undefined {
  const { connection } = useConnection();
  const wallet = useAnchorWallet();
  return useMemo(
    () => (wallet ? createProgram(connection, wallet as unknown as Wallet) : undefined),
    [connection, wallet],
  );
}

/** ER program whose provider wallet IS the session keypair → session pays fees → gasless stake, no popup. */
export function erProgramForSession(erConn: Connection, sessionKp: Keypair): Program<AnsemMiner> {
  return createErProgram(erConn, keypairWallet(sessionKp));
}
