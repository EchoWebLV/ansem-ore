import { describe, it, expect } from "vitest";
import { Connection, Keypair } from "@solana/web3.js";
import { erConnection, erProgramForSession } from "./anchor.js";
import { DEFAULT_ER_ENDPOINT } from "@ansem/sdk";

describe("anchor factories", () => {
  it("erConnection targets the MagicBlock regional endpoint", () => {
    const c = erConnection();
    expect(c.rpcEndpoint).toBe(DEFAULT_ER_ENDPOINT);
  });
  it("erProgramForSession builds a Program whose provider wallet is the session key (gasless fee payer)", () => {
    const sessionKp = Keypair.generate();
    const p = erProgramForSession(new Connection(DEFAULT_ER_ENDPOINT), sessionKp);
    expect(p.provider.publicKey?.equals(sessionKp.publicKey)).toBe(true);
  });
});
