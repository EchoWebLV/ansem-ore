import { describe, it, expect } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { finalizeRound, FinalizeDeps } from "../src/crank/actions.js";

const wallet = () => PublicKey.unique();

describe("finalizeRound", () => {
  it("commits every joined miner, then the round, then reconciles all, then swaps -- in order", async () => {
    const calls: string[] = [];
    const joined = [wallet(), wallet()];
    const deps: FinalizeDeps = {
      joinedWallets: async () => joined,
      commitMiner: async (w) => { calls.push(`commit:${joined.indexOf(w)}`); },
      commitRound: async () => { calls.push("commitRound"); },
      reconcileMiner: async (w) => { calls.push(`reconcile:${joined.indexOf(w)}`); },
      executeSwap: async () => { calls.push("swap"); },
    };
    await finalizeRound(100, deps);

    // Both commits precede commitRound; both reconciles precede swap; swap last.
    expect(calls.indexOf("commit:0")).toBeLessThan(calls.indexOf("commitRound"));
    expect(calls.indexOf("commit:1")).toBeLessThan(calls.indexOf("commitRound"));
    expect(calls.indexOf("commitRound")).toBeLessThan(calls.indexOf("reconcile:0"));
    expect(calls.indexOf("reconcile:0")).toBeLessThan(calls.indexOf("swap"));
    expect(calls.indexOf("reconcile:1")).toBeLessThan(calls.indexOf("swap"));
    expect(calls[calls.length - 1]).toBe("swap");
  });

  it("continues reconciling even if one miner commit throws (idempotent/self-healing)", async () => {
    const joined = [wallet(), wallet()];
    const reconciled: number[] = [];
    const deps: FinalizeDeps = {
      joinedWallets: async () => joined,
      commitMiner: async (w) => { if (joined.indexOf(w) === 0) throw new Error("CommitTooEarly"); },
      commitRound: async () => {},
      reconcileMiner: async (w) => { reconciled.push(joined.indexOf(w)); },
      executeSwap: async () => {},
    };
    await finalizeRound(100, deps);
    expect(reconciled).toEqual([0, 1]); // both still reconciled
  });
});
