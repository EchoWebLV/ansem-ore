import { describe, it, expect } from "vitest";
import { buybackPlan } from "../src/buyback.js";

const SOL = 1_000_000_000n;

describe("buybackPlan", () => {
  it("returns null below the min-SOL threshold", () => {
    // 0.04 SOL treasury vs 0.05 min -> nothing to do
    expect(buybackPlan(40_000_000n, 500, 0.05, 0.01)).toBeNull();
  });

  it("sweeps all but the keep-float and swaps only the fee-net share", () => {
    // 1 SOL treasury, feeBps 500 (5%), min 0.05, keep 0.01
    const plan = buybackPlan(SOL, 500, 0.05, 0.01);
    expect(plan).not.toBeNull();
    expect(plan!.sweep).toBe(990_000_000n);                 // 1e9 - 0.01e9
    expect(plan!.swap).toBe(940_500_000n);                  // sweep - 5% (fee slice stays SOL)
    expect(plan!.sweep - plan!.swap).toBe(49_500_000n);     // the SOL ops-runway slice
  });

  it("swaps the entire sweep when feeBps is 0", () => {
    const plan = buybackPlan(SOL, 0, 0.05, 0.01);
    expect(plan!.swap).toBe(plan!.sweep);
  });

  it("returns null when the keep-float would consume the whole balance", () => {
    // above min (0.05) but keep (0.1) exceeds the balance -> sweep <= 0
    expect(buybackPlan(60_000_000n, 500, 0.05, 0.1)).toBeNull();
  });
});
