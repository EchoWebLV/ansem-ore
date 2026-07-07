// @vitest-environment node
// (web3.js findProgramAddressSync needs real curve/crypto; jsdom breaks it. writes.ts
//  has no DOM, and real browsers have WebCrypto — T4's devnet spike proves the derivation.)
import { describe, it, expect, vi } from "vitest";
import { Connection, Keypair, Transaction, PublicKey } from "@solana/web3.js";
import { createProgram, DEFAULT_ER_VALIDATOR } from "@ansem/sdk";
import { keypairWallet } from "./anchor.js";
import { enterRound } from "./writes.js";

describe("enterRound (one-popup contract)", () => {
  it("builds ONE tx, session-co-signs, then calls wallet.signTransaction exactly once, sends skipPreflight", async () => {
    const conn = new Connection("http://127.0.0.1:8899"); // stub the network calls used by enterRound:
    vi.spyOn(conn, "getLatestBlockhash").mockResolvedValue({ blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1 } as any);
    const sendRaw = vi.spyOn(conn, "sendRawTransaction").mockResolvedValue("sig123" as any);
    vi.spyOn(conn, "confirmTransaction").mockResolvedValue({ value: { err: null } } as any);

    const walletKp = Keypair.generate();
    const signTransaction = vi.fn(async (tx: Transaction) => { tx.partialSign(walletKp); return tx; });
    const signAllTransactions = vi.fn(async (txs: Transaction[]) => txs);
    const adapter = { publicKey: walletKp.publicKey, signTransaction, signAllTransactions } as any;
    const l1 = createProgram(conn, keypairWallet(walletKp));

    const res = await enterRound({
      l1, connection: conn, wallet: adapter, roundId: 7,
      validator: DEFAULT_ER_VALIDATOR, includeInitMiner: false, validUntilSec: 1_900_000_000,
      waitJoined: async () => {}, waitDelegated: async () => {}, // skip on-chain polls in the unit test
    });

    expect(signTransaction).toHaveBeenCalledTimes(1);          // ONE popup
    expect(sendRaw).toHaveBeenCalledTimes(1);
    expect(sendRaw.mock.calls[0][1]).toMatchObject({ skipPreflight: true });
    expect(res.sessionSigner).toBeInstanceOf(Keypair);
    expect(res.tokenPda).toBeInstanceOf(PublicKey);
    expect(res.signature).toBe("sig123");
  });
});
