// @vitest-environment node
// (web3.js findProgramAddressSync needs real curve/crypto; jsdom breaks it. writes.ts
//  has no DOM, and real browsers have WebCrypto — T4's devnet spike proves the derivation.)
import { describe, it, expect, vi } from "vitest";
import { Connection, Keypair, Transaction, TransactionInstruction, PublicKey } from "@solana/web3.js";
import { createProgram, DEFAULT_ER_VALIDATOR, BN } from "@ansem/sdk";
import { keypairWallet } from "./anchor.js";
import { enterRound, gaslessStake, directStake, claimRound, claimBeef } from "./writes.js";

// Tag each SDK instruction so a composed bundle's ORDER is assertable without decoding.
const TAG = { rollBeef: 1, claimDirect: 2, claimBeef: 3, stakeDirect: 4 } as const;
const tagsOf = (tx: Transaction) => tx.instructions.map((i) => i.data[0]);

/** Fake Program: methods.* yield a tagged instruction; provider.sendAndConfirm is spied. */
function fakeBundleProgram() {
  const mk = (tag: number) => ({
    accountsPartial: () => ({
      instruction: async () => new TransactionInstruction({ keys: [], programId: PublicKey.default, data: Buffer.from([tag]) }),
    }),
  });
  const sendAndConfirm = vi.fn(async () => "PROVIDER_SIG");
  const p = {
    provider: { sendAndConfirm },
    methods: {
      rollBeef: () => mk(TAG.rollBeef),
      claimDirect: () => mk(TAG.claimDirect),
      claimBeef: () => mk(TAG.claimBeef),
      stakeDirect: () => mk(TAG.stakeDirect),
    },
  };
  return { p: p as any, sendAndConfirm };
}

const OWNER = Keypair.generate().publicKey;
const MINT = Keypair.generate().publicKey;
const PROG = PublicKey.default; // token program id (only threaded into ATA seeds)

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

describe("BEEF-aware harvest bundles (ordering invariant + pre-BEEF no-op)", () => {
  it("directStake with NO rollBeefRound composes exactly [stakeDirect…] — the unchanged pre-BEEF tx", async () => {
    const { p } = fakeBundleProgram();
    let captured: Transaction | null = null;
    const sig = await directStake({
      l1: p, owner: OWNER, roundId: 9, squares: [4, 17], amountPerSquare: new BN(10_000_000),
      send: async (tx) => { captured = tx; return "SIG"; },
    });
    expect(sig).toBe("SIG");
    expect(tagsOf(captured!)).toEqual([TAG.stakeDirect, TAG.stakeDirect]); // no roll prepended
  });

  it("directStake WITH rollBeefRound prepends rollBeef FIRST, then the stakes", async () => {
    const { p } = fakeBundleProgram();
    let captured: Transaction | null = null;
    await directStake({
      l1: p, owner: OWNER, roundId: 9, squares: [4, 17], amountPerSquare: new BN(10_000_000),
      rollBeefRound: 8, send: async (tx) => { captured = tx; return "SIG"; },
    });
    expect(tagsOf(captured!)).toEqual([TAG.rollBeef, TAG.stakeDirect, TAG.stakeDirect]); // roll before any stake
  });

  it("directStake treats rollBeefRound 0 as pre-BEEF (no roll — never rolls the genesis round)", async () => {
    const { p } = fakeBundleProgram();
    let captured: Transaction | null = null;
    await directStake({
      l1: p, owner: OWNER, roundId: 9, squares: [4], amountPerSquare: new BN(10_000_000),
      rollBeefRound: 0, send: async (tx) => { captured = tx; return "SIG"; },
    });
    expect(tagsOf(captured!)).toEqual([TAG.stakeDirect]);
  });

  it("claimRound with rollBeef=false composes exactly [claimDirect] — the unchanged pre-BEEF tx", async () => {
    const { p } = fakeBundleProgram();
    let captured: Transaction | null = null;
    await claimRound({
      l1: p, owner: OWNER, roundId: 12, ansemMint: MINT, ansemTokenProgramId: PROG,
      send: async (tx) => { captured = tx; return "SIG"; },
    });
    expect(tagsOf(captured!)).toEqual([TAG.claimDirect]);
  });

  it("claimRound with rollBeef=true composes [rollBeef(rid), claimDirect(rid)] — roll FIRST", async () => {
    const { p } = fakeBundleProgram();
    let captured: Transaction | null = null;
    await claimRound({
      l1: p, owner: OWNER, roundId: 12, ansemMint: MINT, ansemTokenProgramId: PROG,
      rollBeef: true, send: async (tx) => { captured = tx; return "SIG"; },
    });
    expect(tagsOf(captured!)).toEqual([TAG.rollBeef, TAG.claimDirect]);
  });

  it("claimBeef with no rollRound composes [claimBeef] alone", async () => {
    const { p } = fakeBundleProgram();
    let captured: Transaction | null = null;
    await claimBeef({
      l1: p, owner: OWNER, beefMint: MINT, beefVault: Keypair.generate().publicKey, tokenProgramId: PROG,
      send: async (tx) => { captured = tx; return "SIG"; },
    });
    expect(tagsOf(captured!)).toEqual([TAG.claimBeef]);
  });

  it("claimBeef WITH rollRound composes [rollBeef(stakedRound), claimBeef] — roll FIRST", async () => {
    const { p } = fakeBundleProgram();
    let captured: Transaction | null = null;
    await claimBeef({
      l1: p, owner: OWNER, beefMint: MINT, beefVault: Keypair.generate().publicKey, tokenProgramId: PROG,
      rollRound: 40, send: async (tx) => { captured = tx; return "SIG"; },
    });
    expect(tagsOf(captured!)).toEqual([TAG.rollBeef, TAG.claimBeef]);
  });

  it("defaults to the provider's single-popup sendAndConfirm when no sender is injected", async () => {
    const { p, sendAndConfirm } = fakeBundleProgram();
    const sig = await claimRound({ l1: p, owner: OWNER, roundId: 3, ansemMint: MINT, ansemTokenProgramId: PROG });
    expect(sig).toBe("PROVIDER_SIG");
    expect(sendAndConfirm).toHaveBeenCalledTimes(1);
  });
});

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

  it("treats a confirmed value.err as DEFINITIVE failure — throws and persists nothing even if the wallet is already joined", async () => {
    // Re-entry: join_round reverts (RoundAlreadyJoined), so the atomic entry — incl
    // createSessionV2 — reverts and NO session token minted. But escrow.active_round is
    // still set from the prior entry, so an escrow-based verifyLanded would false-positive.
    // A confirmed value.err must be definitive: throw without consulting verifyLanded, so
    // no phantom session is persisted. (verifyLanded injected true here proves it is ignored.)
    const conn = new Connection("http://127.0.0.1:8899");
    vi.spyOn(conn, "getLatestBlockhash").mockResolvedValue({ blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1 } as any);
    vi.spyOn(conn, "sendRawTransaction").mockResolvedValue("sigfail" as any);
    vi.spyOn(conn, "confirmTransaction").mockResolvedValue({ value: { err: { InstructionError: [3, "Custom"] } } } as any);
    const walletKp = Keypair.generate();
    const adapter = { publicKey: walletKp.publicKey, signTransaction: async (tx: Transaction) => { tx.partialSign(walletKp); return tx; }, signAllTransactions: async (t: Transaction[]) => t } as any;
    const l1 = createProgram(conn, keypairWallet(walletKp));

    let persisted = false;
    await expect(enterRound({
      l1, connection: conn, wallet: adapter, roundId: 7, validator: DEFAULT_ER_VALIDATOR,
      includeInitMiner: false, validUntilSec: 1_900_000_000,
      onLanded: () => { persisted = true; },
      verifyLanded: async () => true,   // simulates the phantom "already joined" false-positive; must be IGNORED
      waitJoined: async () => {}, waitDelegated: async () => {},
    })).rejects.toThrow(/failed on-chain/);
    expect(persisted).toBe(false);      // no phantom session for a failed entry
  });

  it("recovers the session when confirm throws but the DEFAULT verifyLanded finds the minted session token", async () => {
    // Default verifyLanded checks THIS entry's unique product — the session token PDA —
    // not escrow.active_round. Token present -> the entry landed -> recover the session.
    const conn = new Connection("http://127.0.0.1:8899");
    vi.spyOn(conn, "getLatestBlockhash").mockResolvedValue({ blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1 } as any);
    vi.spyOn(conn, "sendRawTransaction").mockResolvedValue("siglate" as any);
    vi.spyOn(conn, "confirmTransaction").mockRejectedValue(new Error("Transaction was not confirmed in 30.00 seconds"));
    vi.spyOn(conn, "getAccountInfo").mockResolvedValue({ lamports: 1 } as any); // session token exists on-chain
    const walletKp = Keypair.generate();
    const adapter = { publicKey: walletKp.publicKey, signTransaction: async (tx: Transaction) => { tx.partialSign(walletKp); return tx; }, signAllTransactions: async (t: Transaction[]) => t } as any;
    const l1 = createProgram(conn, keypairWallet(walletKp));

    let persisted = false;
    const res = await enterRound({
      l1, connection: conn, wallet: adapter, roundId: 7, validator: DEFAULT_ER_VALIDATOR,
      includeInitMiner: false, validUntilSec: 1_900_000_000,
      onLanded: () => { persisted = true; },
      waitJoined: async () => {}, waitDelegated: async () => {}, // default verifyLanded (token check) used
    });
    expect(persisted).toBe(true);       // session recovered via the token, not dropped
    expect(res.signature).toBe("siglate");
  });

  it("throws (no phantom session) when confirm throws and the session token is absent (entry did not land)", async () => {
    const conn = new Connection("http://127.0.0.1:8899");
    vi.spyOn(conn, "getLatestBlockhash").mockResolvedValue({ blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1 } as any);
    vi.spyOn(conn, "sendRawTransaction").mockResolvedValue("sigmiss" as any);
    vi.spyOn(conn, "confirmTransaction").mockRejectedValue(new Error("Transaction was not confirmed in 30.00 seconds"));
    vi.spyOn(conn, "getAccountInfo").mockResolvedValue(null); // session token never minted
    const walletKp = Keypair.generate();
    const adapter = { publicKey: walletKp.publicKey, signTransaction: async (tx: Transaction) => { tx.partialSign(walletKp); return tx; }, signAllTransactions: async (t: Transaction[]) => t } as any;
    const l1 = createProgram(conn, keypairWallet(walletKp));

    let persisted = false;
    await expect(enterRound({
      l1, connection: conn, wallet: adapter, roundId: 7, validator: DEFAULT_ER_VALIDATOR,
      includeInitMiner: false, validUntilSec: 1_900_000_000,
      onLanded: () => { persisted = true; },
      waitJoined: async () => {}, waitDelegated: async () => {},
    })).rejects.toThrow(/not confirmed/);
    expect(persisted).toBe(false);
  }, 15_000);
});

/**
 * Fake ER that simulates the ON-CHAIN new-round reset: the first stake whose target
 * round differs from the miner's stored round zeroes block_stake and restamps the
 * round before applying `+= amount` (mirrors stake.rs). Lets us exercise the
 * cross-round baseline: a miner that still holds LAST round's stake on the square.
 */
function fakeErReset(initial: bigint[], staleRound: number, currentRound: number) {
  const state = { roundId: staleRound, blockStake: [...initial] };
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
          rpc: async () => {
            if (state.roundId !== currentRound) { state.blockStake = Array(25).fill(0n); state.roundId = currentRound; }
            state.blockStake[square] += BigInt(amount.toString());
            calls++;
          },
        }),
      }),
    },
  };
  return { er, state, calls: () => calls };
}

/** Fake ER whose Nth miner fetch throws (transient RPC error -> fetchMiner swallows to null). */
function fakeErFailOnFetch(failAt: number) {
  const state = { roundId: 7, blockStake: Array(25).fill(0n) as bigint[] };
  let calls = 0, fetches = 0;
  const er = {
    account: { minerPosition: { fetch: async () => {
      if (++fetches === failAt) throw new Error("transient ER read failure");
      return {
        authority: { toBase58: () => "Owner1111" },
        roundId: { toNumber: () => state.roundId },
        blockStake: state.blockStake.map((v) => ({ toString: () => v.toString() })),
      };
    } } },
    methods: {
      stake: (square: number, amount: { toString: () => string }) => ({
        accountsPartial: () => ({ rpc: async () => { state.blockStake[square] += BigInt(amount.toString()); calls++; } }),
      }),
    },
  };
  return { er, state, calls: () => calls };
}

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

  it("does NOT over-stake when the ER miner still holds LAST round's stake on the square", async () => {
    // 0.1 left over from round 6 on square 0; we stake 0.05 into round 7. The stale
    // 0.1 must count as 0 for the round-7 baseline (it is zeroed on-chain by the
    // first round-7 stake), so exactly ONE send lands and the square holds 0.05 —
    // NOT the runaway multiply the pre-fix absolute baseline produced.
    const initial = Array(25).fill(0n); initial[0] = 100_000_000n;
    const { er, state, calls } = fakeErReset(initial, 6, 7);
    await gaslessStake({
      er: er as any, ownerWallet: Keypair.generate().publicKey, sessionSigner: Keypair.generate(),
      tokenPda: Keypair.generate().publicKey, square: 0, amount: new BN(50_000_000), roundId: 7,
    });
    expect(state.blockStake[0]).toBe(50_000_000n); // exactly the new 0.05
    expect(calls()).toBe(1);                       // one send — stale cross-round baseline ignored
  }, 20_000);

  it("does NOT double-send when a mid-loop read fails right after the stake landed", async () => {
    // Fresh round 7. Send lands on the first attempt (fetch #2), then the very next
    // read (fetch #3) throws. A transient read failure must read as "unknown", never
    // as 0 — otherwise the non-idempotent additive stake is sent again (0.4 not 0.2).
    const { er, state, calls } = fakeErFailOnFetch(3);
    await gaslessStake({
      er: er as any, ownerWallet: Keypair.generate().publicKey, sessionSigner: Keypair.generate(),
      tokenPda: Keypair.generate().publicKey, square: 0, amount: new BN(200_000_000), roundId: 7,
    });
    expect(state.blockStake[0]).toBe(200_000_000n); // exactly 0.2 — not doubled
    expect(calls()).toBe(1);                        // the failed read did not trigger a resend
  }, 20_000);

  it("does NOT silently drop an additive re-stake when the baseline read blips then recovers", async () => {
    // 0.1 already on square 0 this round (7). A read blip fails the first few baseline reads;
    // the baseline must RETRY past the blip to the real 0.1 — never degrade an unknown read to
    // 0 (which would make the first live read look 'already landed' and drop the +0.2).
    const state = { roundId: 7, blockStake: Array(25).fill(0n) as bigint[] };
    state.blockStake[0] = 100_000_000n;
    let fetches = 0, calls = 0;
    const er = {
      account: { minerPosition: { fetch: async () => {
        if (++fetches <= 5) throw new Error("baseline read blip");
        return { authority: { toBase58: () => "o" }, roundId: { toNumber: () => state.roundId }, blockStake: state.blockStake.map((v) => ({ toString: () => v.toString() })) };
      } } },
      methods: { stake: (sq: number, amt: { toString: () => string }) => ({ accountsPartial: () => ({ rpc: async () => { state.blockStake[sq] += BigInt(amt.toString()); calls++; } }) }) },
    };
    await gaslessStake({ er: er as any, ownerWallet: Keypair.generate().publicKey, sessionSigner: Keypair.generate(), tokenPda: Keypair.generate().publicKey, square: 0, amount: new BN(200_000_000), roundId: 7 });
    expect(state.blockStake[0]).toBe(300_000_000n); // 0.1 + 0.2 — the blip did NOT poison the baseline
    expect(calls).toBe(1);
  }, 20_000);

  it("throws instead of silently proceeding when the ER baseline is persistently unreadable (never guesses 0)", async () => {
    const er = {
      account: { minerPosition: { fetch: async () => { throw new Error("ER unreadable"); } } },
      methods: { stake: () => ({ accountsPartial: () => ({ rpc: async () => {} }) }) },
    };
    await expect(gaslessStake({ er: er as any, ownerWallet: Keypair.generate().publicKey, sessionSigner: Keypair.generate(), tokenPda: Keypair.generate().publicKey, square: 0, amount: new BN(50_000_000), roundId: 7 })).rejects.toThrow();
  }, 20_000);

  it("does NOT double-send when the post-stake read lags with a stale cross-round snapshot", async () => {
    // Fresh round 7 entry; miner still on round 6 (blockStake 0). After the stake lands
    // (roundId->7), one lagging read still returns the pre-write round-6 snapshot — which must
    // be treated as UNKNOWN (retry), not as "this round = 0" (which would resend the += stake).
    const state = { roundId: 6, blockStake: Array(25).fill(0n) as bigint[] };
    let calls = 0, staked = false, servedStale = false;
    const snap = (rid: number, bs: bigint[]) => ({ authority: { toBase58: () => "o" }, roundId: { toNumber: () => rid }, blockStake: bs.map((v) => ({ toString: () => v.toString() })) });
    const er = {
      account: { minerPosition: { fetch: async () => {
        if (staked && !servedStale) { servedStale = true; return snap(6, Array(25).fill(0n)); } // one lagging pre-write read
        return snap(state.roundId, state.blockStake);
      } } },
      methods: { stake: (sq: number, amt: { toString: () => string }) => ({ accountsPartial: () => ({ rpc: async () => { state.roundId = 7; state.blockStake[sq] += BigInt(amt.toString()); staked = true; calls++; } }) }) },
    };
    await gaslessStake({ er: er as any, ownerWallet: Keypair.generate().publicKey, sessionSigner: Keypair.generate(), tokenPda: Keypair.generate().publicKey, square: 0, amount: new BN(50_000_000), roundId: 7 });
    expect(state.blockStake[0]).toBe(50_000_000n); // exactly one increment despite the lagging read
    expect(calls).toBe(1);
  }, 20_000);
});
