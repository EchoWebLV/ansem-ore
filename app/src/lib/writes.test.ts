// @vitest-environment node
// (web3.js findProgramAddressSync needs real curve/crypto; jsdom breaks it. writes.ts
//  has no DOM, and real browsers have WebCrypto — T4's devnet spike proves the derivation.)
import { describe, it, expect, vi } from "vitest";
import { Connection, Keypair, Transaction, PublicKey } from "@solana/web3.js";
import { createProgram, DEFAULT_ER_VALIDATOR, BN } from "@ansem/sdk";
import { keypairWallet } from "./anchor.js";
import { enterRound, gaslessStake } from "./writes.js";

/** Stateful fake ER Program: minerPosition.fetch reflects state; stake() applies block_stake += amount. */
function fakeEr(initial: bigint[], roundId = 7) {
  const state = { roundId, blockStake: [...initial] };
  let calls = 0;
  const er = {
    account: { minerPosition: { fetch: async () => ({
      authority: { toBase58: () => "Owner1111" },
      roundId: { toNumber: () => state.roundId },
      blockStake: state.blockStake.map((v) => ({ toString: () => v.toString() })),
    }) } },
    methods: {
      stake: (square: number, amount: { toString: () => string }) => ({
        accountsPartial: () => ({
          rpc: async () => { state.blockStake[square] += BigInt(amount.toString()); calls++; },
        }),
      }),
    },
  };
  return { er, state, calls: () => calls };
}

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

  it("persists the session on confirm (onLanded) BEFORE the propagation waits", async () => {
    const conn = new Connection("http://127.0.0.1:8899");
    vi.spyOn(conn, "getLatestBlockhash").mockResolvedValue({ blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1 } as any);
    vi.spyOn(conn, "sendRawTransaction").mockResolvedValue("sig" as any);
    vi.spyOn(conn, "confirmTransaction").mockResolvedValue({ value: { err: null } } as any);
    const walletKp = Keypair.generate();
    const adapter = { publicKey: walletKp.publicKey, signTransaction: async (tx: Transaction) => { tx.partialSign(walletKp); return tx; }, signAllTransactions: async (t: Transaction[]) => t } as any;
    const l1 = createProgram(conn, keypairWallet(walletKp));

    const order: string[] = [];
    await enterRound({
      l1, connection: conn, wallet: adapter, roundId: 7, validator: DEFAULT_ER_VALIDATOR,
      includeInitMiner: false, validUntilSec: 1_900_000_000,
      onLanded: () => order.push("landed"),
      waitJoined: async () => { order.push("waitJoined"); },
      waitDelegated: async () => { order.push("waitDelegated"); },
    });
    expect(order).toEqual(["landed", "waitJoined", "waitDelegated"]); // persisted before waits
  });
});

describe("gaslessStake (additive, single-send)", () => {
  it("adds amount to the square's existing stake with exactly one send (no runaway, no no-op)", async () => {
    const initial = Array(25).fill(0n); initial[0] = 100_000_000n; // 0.1 already on square 0
    const { er, state, calls } = fakeEr(initial, 7);
    await gaslessStake({
      er: er as any, ownerWallet: Keypair.generate().publicKey, sessionSigner: Keypair.generate(),
      tokenPda: Keypair.generate().publicKey, square: 0, amount: new BN(200_000_000), roundId: 7,
    });
    expect(state.blockStake[0]).toBe(300_000_000n); // 0.1 + 0.2, added (not overwritten to 0.2)
    expect(calls()).toBe(1);                        // single send — no runaway multiply
  }, 15_000);
});
