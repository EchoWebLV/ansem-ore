import { describe, it, expect } from "vitest";
import { Connection, Keypair, ComputeBudgetProgram } from "@solana/web3.js";
import { Wallet } from "@coral-xyz/anchor";
import { createProgram } from "../src/program.js";
import { buildEntryInstructions } from "../src/instructions/entry.js";
import { GUM_PROGRAM_ID, PROGRAM_ID, DEFAULT_ER_VALIDATOR } from "../src/constants.js";
import { deriveSessionToken } from "../src/session.js";

describe("buildEntryInstructions", () => {
  const conn = new Connection("http://127.0.0.1:8899"); // .instruction() is offline
  const wallet = new Wallet(Keypair.generate());
  const l1 = createProgram(conn, wallet);

  it("batches computeBudget + session + join + delegate (no init) into one ordered list", async () => {
    const entry = await buildEntryInstructions(l1, conn, wallet, 7, DEFAULT_ER_VALIDATOR, 1_900_000_000, { includeInitMiner: false });
    // compute-budget, createSessionV2(gum), join_round(miner prog), delegate_miner(miner prog)
    expect(entry.instructions).toHaveLength(4);
    expect(entry.instructions[0].programId.equals(ComputeBudgetProgram.programId)).toBe(true);
    expect(entry.instructions[1].programId.equals(GUM_PROGRAM_ID)).toBe(true);
    expect(entry.instructions[2].programId.equals(PROGRAM_ID)).toBe(true);
    expect(entry.instructions[3].programId.equals(PROGRAM_ID)).toBe(true);
    // delegate_miner carries the validator as a remaining account
    expect(entry.instructions[3].keys.some((k) => k.pubkey.equals(DEFAULT_ER_VALIDATOR))).toBe(true);
    expect(entry.tokenPda.equals(deriveSessionToken(entry.sessionSigner.publicKey, wallet.publicKey))).toBe(true);
  });

  it("prepends init_miner when includeInitMiner is true", async () => {
    const entry = await buildEntryInstructions(l1, conn, wallet, 7, DEFAULT_ER_VALIDATOR, 1_900_000_000, { includeInitMiner: true });
    expect(entry.instructions).toHaveLength(5); // computeBudget, initMiner, session, join, delegate
    expect(entry.instructions[1].programId.equals(PROGRAM_ID)).toBe(true); // init_miner (miner program)
    expect(entry.instructions[2].programId.equals(GUM_PROGRAM_ID)).toBe(true); // session
  });
});
