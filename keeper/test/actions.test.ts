import { describe, it, expect } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { commitToL1, CommitDeps, finalizeSettled, FinalizeDeps, isNotThisRoundError } from "../src/crank/actions.js";

const wallet = () => PublicKey.unique();

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
