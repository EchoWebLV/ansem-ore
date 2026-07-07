import { describe, it, expect } from "vitest";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { Wallet, BN } from "@coral-xyz/anchor";
import { createProgram } from "../src/program.js";
import { stakeIx, joinRoundIx, claimIx } from "../src/instructions/player.js";
import { delegateRoundIx, executeSwapMockIx } from "../src/instructions/keeper.js";
import { configPda, roundPda, minerPda, escrowPda, payoutVault } from "../src/pdas.js";

const program = () => createProgram(new Connection("http://127.0.0.1:9999"), new Wallet(Keypair.generate()));
const has = (ix: { keys: { pubkey: PublicKey }[] }, pk: PublicKey) =>
  ix.keys.some((k) => k.pubkey.equals(pk));

describe("instruction builders resolve the right accounts", () => {
  const wallet = Keypair.generate().publicKey;

  it("stake (wallet-signed) references config/round/miner/escrow and null session", async () => {
    const ix = await stakeIx(program(), wallet, wallet, 3, new BN(1000), 7, null).instruction();
    expect(has(ix, configPda())).toBe(true);
    expect(has(ix, roundPda(7))).toBe(true);
    expect(has(ix, minerPda(wallet))).toBe(true);
    expect(has(ix, escrowPda(wallet))).toBe(true);
  });

  it("joinRound references escrow + config", async () => {
    const ix = await joinRoundIx(program(), wallet, 7).instruction();
    expect(has(ix, escrowPda(wallet))).toBe(true);
    expect(has(ix, configPda())).toBe(true);
  });

  it("claim references payout vault + round", async () => {
    const ix = await claimIx(program(), wallet, 7).instruction();
    expect(has(ix, payoutVault())).toBe(true);
    expect(has(ix, roundPda(7))).toBe(true);
  });

  it("delegateRound includes the ER validator in remaining accounts", async () => {
    const validator = Keypair.generate().publicKey;
    const ix = await delegateRoundIx(program(), wallet, 7, validator).instruction();
    expect(has(ix, validator)).toBe(true);
  });

  it("executeSwapMock references payout vault + round", async () => {
    const ix = await executeSwapMockIx(program(), wallet, 7).instruction();
    expect(has(ix, payoutVault())).toBe(true);
    expect(has(ix, roundPda(7))).toBe(true);
  });
});
