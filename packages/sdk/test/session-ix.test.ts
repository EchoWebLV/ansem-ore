import { describe, it, expect } from "vitest";
import { Connection, Keypair } from "@solana/web3.js";
import { Wallet } from "@coral-xyz/anchor";
import { buildCreateSessionIx, deriveSessionToken } from "../src/session.js";
import { GUM_PROGRAM_ID, PROGRAM_ID } from "../src/constants.js";

describe("buildCreateSessionIx", () => {
  it("builds an offline gum createSessionV2 instruction with the right program + token PDA", async () => {
    const conn = new Connection("http://127.0.0.1:8899"); // never called — .instruction() is offline
    const owner = new Wallet(Keypair.generate());
    const validUntil = 1_900_000_000;
    const { sessionSigner, tokenPda, ix, validUntil: vu } = await buildCreateSessionIx(conn, owner, validUntil);
    expect(vu).toBe(validUntil);
    expect(ix.programId.equals(GUM_PROGRAM_ID)).toBe(true);
    expect(tokenPda.equals(deriveSessionToken(sessionSigner.publicKey, owner.publicKey, PROGRAM_ID))).toBe(true);
    // the token PDA must be one of the instruction's account metas
    expect(ix.keys.some((k) => k.pubkey.equals(tokenPda))).toBe(true);
  });
});
