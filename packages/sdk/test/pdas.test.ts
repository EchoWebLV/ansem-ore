// packages/sdk/test/pdas.test.ts
import { describe, it, expect } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { PROGRAM_ID, GUM_PROGRAM_ID } from "../src/constants.js";
import { configPda, roundPda, minerPda, escrowPda, potVaultPda, treasuryPda,
  vaultAuthPda, mintAuthPda, ansemMintPda, sessionTokenPda, jackpotConfigPda } from "../src/pdas.js";

describe("PDA derivations (vectors verified on devnet)", () => {
  it("static PDAs match known on-chain addresses", () => {
    expect(configPda().toBase58()).toBe("FFXTYowTfG8LXgi7EFX2cSaeDt8pxDdFEuTdvNBUUh7Z");
    expect(ansemMintPda().toBase58()).toBe("21p11FJseSYV6QQrMsg8tyfvM53Roj1ZTHqpoRnBZmDW");
    expect(mintAuthPda().toBase58()).toBe("HubMVzx9H1yp8eUHXce1oGu7ErC5WZgS9Zh4UdVZzKB5");
    expect(vaultAuthPda().toBase58()).toBe("9prJ9GV8NTyevD8S94dbpEXuNBeidEBnaR49Mzhw6fNw");
    expect(potVaultPda().toBase58()).toBe("5rrickgeHZJDDiS14T76d749iwSTnz6E538KaWtHDiiB");
    expect(treasuryPda().toBase58()).toBe("EjwB8X4toQJzPtcRhjtzm4RpAX2bLKrcNDurLgDxXD4G");
  });

  it("jackpotConfig PDA seeds on the program JACKPOT_CONFIG_SEED", () => {
    // seed "jackpot_config" (program constant) — matches keeper/src/read/jackpot.ts raw derivation
    expect(jackpotConfigPda().toBase58()).toBe("BjSQ4zvp4ztfXSDfyBbZU8vbtuAAuXQY3edNU1D2WiTo");
    expect(jackpotConfigPda().toBase58()).toBe(
      PublicKey.findProgramAddressSync([Buffer.from("jackpot_config")], PROGRAM_ID)[0].toBase58());
  });

  it("round PDA uses u64 LE round id", () => {
    const expected = PublicKey.findProgramAddressSync(
      [Buffer.from("round"), Buffer.from(new Uint8Array(new BigUint64Array([1n]).buffer))],
      PROGRAM_ID)[0];
    expect(roundPda(1).toBase58()).toBe(expected.toBase58());
  });

  it("miner/escrow seed on the wallet pubkey", () => {
    const w = new PublicKey("9FuMzZyQaTabe5PhXYZxSxRDgxx5576aByJtNXucBVbF");
    expect(minerPda(w).toBase58()).toBe(
      PublicKey.findProgramAddressSync([Buffer.from("miner"), w.toBuffer()], PROGRAM_ID)[0].toBase58());
    expect(escrowPda(w).toBase58()).toBe(
      PublicKey.findProgramAddressSync([Buffer.from("escrow"), w.toBuffer()], PROGRAM_ID)[0].toBase58());
  });

  it("session-token PDA derives against the gum program", () => {
    const signer = new PublicKey("9FuMzZyQaTabe5PhXYZxSxRDgxx5576aByJtNXucBVbF");
    const authority = new PublicKey("EjwB8X4toQJzPtcRhjtzm4RpAX2bLKrcNDurLgDxXD4G");
    const expected = PublicKey.findProgramAddressSync(
      [Buffer.from("session_token_v2"), PROGRAM_ID.toBuffer(), signer.toBuffer(), authority.toBuffer()],
      GUM_PROGRAM_ID)[0];
    expect(sessionTokenPda(signer, authority).toBase58()).toBe(expected.toBase58());
  });
});
