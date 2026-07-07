import { describe, it, expect } from "vitest";
import { Keypair } from "@solana/web3.js";
import { PROGRAM_ID } from "../src/constants.js";
import { deriveSessionToken, isSessionValid } from "../src/session.js";
import { sessionTokenPda } from "../src/pdas.js";

describe("session helpers", () => {
  it("deriveSessionToken matches the PDA rule", () => {
    const signer = Keypair.generate().publicKey;
    const authority = Keypair.generate().publicKey;
    expect(deriveSessionToken(signer, authority).toBase58())
      .toBe(sessionTokenPda(signer, authority, PROGRAM_ID).toBase58());
  });

  it("isSessionValid checks now < valid_until with a safety margin", () => {
    const now = 1_000_000;
    expect(isSessionValid(now + 600, now, 30)).toBe(true);   // 10 min left
    expect(isSessionValid(now + 10, now, 30)).toBe(false);   // inside 30s margin
    expect(isSessionValid(now - 5, now, 30)).toBe(false);    // expired
  });
});
