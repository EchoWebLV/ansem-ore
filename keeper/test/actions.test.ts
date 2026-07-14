import { describe, it, expect } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { ataForMint, TOKEN_2022_PROGRAM_ID } from "@ansem/sdk";
import {
  commitToL1, CommitDeps, finalizeSettled, FinalizeDeps, isNotThisRoundError,
  realExecuteSwap, RealSwapDeps, liveRealSwapDeps, ActionCtx,
} from "../src/crank/actions.js";

const wallet = () => PublicKey.unique();

// A logger stub that records the level + fields of each call for assertions.
function recordingLog() {
  const errors: { m: string; f?: any }[] = [];
  const warns: { m: string; f?: any }[] = [];
  const log = {
    info: () => {},
    warn: (m: string, f?: any) => { warns.push({ m, f }); },
    error: (m: string, f?: any) => { errors.push({ m, f }); },
  };
  return { log, errors, warns };
}

describe("commitToL1", () => {
  it("commits every joined miner, then the round -- in order", async () => {
    const calls: string[] = [];
    const joined = [wallet(), wallet()];
    const deps: CommitDeps = {
      joinedWallets: async () => joined,
      commitMiner: async (w) => { calls.push(`commit:${joined.indexOf(w)}`); },
      commitRound: async () => { calls.push("commitRound"); },
    };
    await commitToL1(100, deps);
    expect(calls.indexOf("commit:0")).toBeLessThan(calls.indexOf("commitRound"));
    expect(calls.indexOf("commit:1")).toBeLessThan(calls.indexOf("commitRound"));
    expect(calls[calls.length - 1]).toBe("commitRound");
  });

  it("DEFERS commit_round when any miner commit throws (retry-able) so the round stays delegated", async () => {
    const joined = [wallet(), wallet()];
    let committedRound = false;
    const deps: CommitDeps = {
      joinedWallets: async () => joined,
      commitMiner: async (w) => { if (joined.indexOf(w) === 0) throw new Error("CommitTooEarly"); },
      commitRound: async () => { committedRound = true; },
    };
    await commitToL1(100, deps);
    expect(committedRound).toBe(false); // never undelegate with a miner still stranded in the ER
  });
});

describe("finalizeSettled", () => {
  it("reconciles every joined wallet, then swaps -- in order", async () => {
    const calls: string[] = [];
    const joined = [wallet(), wallet()];
    const deps: FinalizeDeps = {
      joinedWallets: async () => joined,
      reconcileMiner: async (w) => { calls.push(`reconcile:${joined.indexOf(w)}`); },
      executeSwap: async () => { calls.push("swap"); },
    };
    await finalizeSettled(100, deps);
    expect(calls.indexOf("reconcile:0")).toBeLessThan(calls.indexOf("swap"));
    expect(calls.indexOf("reconcile:1")).toBeLessThan(calls.indexOf("swap"));
    expect(calls[calls.length - 1]).toBe("swap");
  });

  it("does not swap if a reconcile throws (retry the whole finalize next tick)", async () => {
    const joined = [wallet(), wallet()];
    let swapped = false;
    const deps: FinalizeDeps = {
      joinedWallets: async () => joined,
      reconcileMiner: async (w) => { if (joined.indexOf(w) === 1) throw new Error("rpc flake"); },
      executeSwap: async () => { swapped = true; },
    };
    await expect(finalizeSettled(100, deps)).rejects.toThrow(/rpc flake/);
    expect(swapped).toBe(false);
  });
});

describe("isNotThisRoundError (commit_miner skip classifier)", () => {
  it("skips a miner whose round_id != current round (seeds constraint / 2006)", () => {
    expect(isNotThisRoundError(new Error("AnchorError: Error Code: ConstraintSeeds. Error Number: 2006. A seeds constraint was violated"))).toBe(true);
  });

  it("skips a miner whose current-round PDA was never created (AccountNotInitialized / 3012)", () => {
    expect(isNotThisRoundError(new Error("Error Code: AccountNotInitialized. Error Number: 3012."))).toBe(true);
  });

  it("does NOT skip retryable clock-lag / RPC errors (must retry commit_round, not abandon the round)", () => {
    expect(isNotThisRoundError(new Error("Error Code: CommitTooEarly. Error Number: 6023."))).toBe(false);
    expect(isNotThisRoundError(new Error("failed to send transaction: rpc flake / blockhash not found"))).toBe(false);
  });
});

describe("finalizeSettled + BEEF stamp", () => {
  it("stamps AFTER the swap", async () => {
    const calls: string[] = [];
    await finalizeSettled(7, {
      joinedWallets: async () => [],
      reconcileMiner: async () => { calls.push("rec"); },
      executeSwap: async () => { calls.push("swap"); },
      stampBeef: async () => { calls.push("stamp"); },
    });
    expect(calls).toEqual(["swap", "stamp"]);
  });

  it("a throwing stamp is swallowed — BEEF never blocks finalize", async () => {
    const calls: string[] = [];
    await finalizeSettled(7, {
      joinedWallets: async () => [],
      reconcileMiner: async () => {},
      executeSwap: async () => { calls.push("swap"); },
      stampBeef: async () => { throw new Error("vault missing"); },
    });
    expect(calls).toEqual(["swap"]); // finalize completed despite the throw
  });

  it("no stampBeef dep (BEEF disabled) -> finalize unchanged", async () => {
    const calls: string[] = [];
    await finalizeSettled(7, {
      joinedWallets: async () => [],
      reconcileMiner: async () => {},
      executeSwap: async () => { calls.push("swap"); },
    });
    expect(calls).toEqual(["swap"]);
  });
});

describe("realExecuteSwap (real-mode payout guard)", () => {
  it("quotes net-of-fee SOL and sends execute_swap_real when inventory covers the payout", async () => {
    const { log } = recordingLog();
    let quotedNet: bigint | null = null;
    let sent: bigint | null = null;
    const deps: RealSwapDeps = {
      quote: async (net) => { quotedNet = net; return 1000n; },
      inventory: async () => 5000n,
      sendSwap: async (out) => { sent = out; },
      log,
    };
    // pot 1_000_000, feeBps 500 (5%) -> net 950_000
    await realExecuteSwap(42, 1_000_000n, 500, 0n, deps);
    expect(quotedNet).toBe(950_000n);
    expect(sent).toBe(1000n); // sends exactly the quoted ANSEM out
  });

  it("does NOT send and logs error when inventory is short (leave SETTLED, tick retries)", async () => {
    const { log, errors } = recordingLog();
    let sent = false;
    const deps: RealSwapDeps = {
      quote: async () => 10_000n,
      inventory: async () => 9_999n, // one base unit short of the payout
      sendSwap: async () => { sent = true; },
      log,
    };
    await realExecuteSwap(42, 1_000_000n, 0, 0n, deps);
    expect(sent).toBe(false);
    expect(errors).toHaveLength(1);
    expect(errors[0].m).toMatch(/inventory short/);
    expect(errors[0].f).toMatchObject({ need: "10000", have: "9999" });
  });

  it("warns (but still sends) when inventory covers the payout yet sits below the alert floor", async () => {
    const { log, warns } = recordingLog();
    let sent = false;
    const deps: RealSwapDeps = {
      quote: async () => 1000n,
      inventory: async () => 1500n, // covers the 1000 payout, below the 5000 floor
      sendSwap: async () => { sent = true; },
      log,
    };
    await realExecuteSwap(42, 1_000_000n, 0, 5000n, deps);
    expect(sent).toBe(true);
    expect(warns.some((w) => /below alert floor/.test(w.m))).toBe(true);
  });
});

// Token-2022 support: the keeper detects the ANSEM mint's owning program at startup and
// threads it through the inventory-ATA derivation (so the balance read hits the right ATA).
describe("liveRealSwapDeps inventory ATA respects the detected token program", () => {
  const mint = PublicKey.unique();
  const keeper = PublicKey.unique();

  // Minimal ctx: inventory() only touches conn.getTokenAccountBalance + keeper + tokenProgramId.
  const ctxWith = (tokenProgramId?: PublicKey) => {
    let captured: PublicKey | null = null;
    const conn = {
      getTokenAccountBalance: async (ata: PublicKey) => { captured = ata; return { value: { amount: "123" } }; },
    };
    const ctx = { conn, keeper, tokenProgramId } as unknown as ActionCtx;
    return { ctx, captured: () => captured };
  };
  const config = { ansemMint: mint } as any;

  it("derives the Token-2022 ATA when the mint is Token-2022", async () => {
    const { ctx, captured } = ctxWith(TOKEN_2022_PROGRAM_ID);
    const bal = await liveRealSwapDeps(ctx, 7, config).inventory();
    expect(bal).toBe(123n);
    expect(captured()!.equals(ataForMint(mint, keeper, TOKEN_2022_PROGRAM_ID))).toBe(true);
    // The 2022 ATA differs from the classic derivation for the same mint/owner.
    expect(captured()!.equals(ataForMint(mint, keeper))).toBe(false);
  });

  it("defaults to the classic ATA when tokenProgramId is unset", async () => {
    const { ctx, captured } = ctxWith(undefined);
    await liveRealSwapDeps(ctx, 7, config).inventory();
    expect(captured()!.equals(ataForMint(mint, keeper))).toBe(true);
  });
});
