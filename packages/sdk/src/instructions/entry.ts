import { Connection, PublicKey, Keypair, TransactionInstruction, ComputeBudgetProgram } from "@solana/web3.js";
import { Program, Wallet } from "@coral-xyz/anchor";
import { AnsemMiner } from "../idl/ansem_miner.js";
import { initMinerIx, joinRoundIx, delegateMinerIx } from "./player.js";
import { buildCreateSessionIx } from "../session.js";

export interface BatchedEntry {
  instructions: TransactionInstruction[];
  sessionSigner: Keypair;
  tokenPda: PublicKey;
  validUntil: number;
}

/**
 * Assemble the ONE-POPUP round entry as a single transaction's instructions, in order:
 *   [computeBudget, initMiner?, createSessionV2, joinRound, delegateMiner]
 * The caller builds a Transaction from these, sets feePayer = ownerWallet, co-signs with
 * `sessionSigner`, then wallet-signs (the single popup) and sends with skipPreflight.
 * `delegateMiner` mutates account ownership via a DLP CPI, so the send MUST use skipPreflight.
 */
export async function buildEntryInstructions(
  l1: Program<AnsemMiner>, connection: Connection, ownerWallet: Wallet,
  roundId: number, validator: PublicKey, validUntilSec: number,
  opts: { includeInitMiner: boolean; computeUnits?: number },
): Promise<BatchedEntry> {
  const owner = ownerWallet.publicKey;
  const { sessionSigner, tokenPda, ix: sessionIx, validUntil } =
    await buildCreateSessionIx(connection, ownerWallet, validUntilSec);
  const join = await joinRoundIx(l1, owner, roundId).instruction();
  const delegate = await delegateMinerIx(l1, owner, validator).instruction();

  const instructions: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: opts.computeUnits ?? 400_000 }),
  ];
  if (opts.includeInitMiner) instructions.push(await initMinerIx(l1, owner).instruction());
  instructions.push(sessionIx, join, delegate);

  return { instructions, sessionSigner, tokenPda, validUntil };
}
