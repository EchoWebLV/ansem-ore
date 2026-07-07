import { describe, it, expect } from "vitest";
import { solToLamports, lamportsToSolStr } from "./amount.js";

describe("amount", () => {
  it("parses SOL strings to a lamports BN", () => {
    expect(solToLamports("1")?.toString()).toBe("1000000000");
    expect(solToLamports("0.05")?.toString()).toBe("50000000");
    expect(solToLamports("0.000000001")?.toString()).toBe("1"); // 1 lamport
  });
  it("rejects junk / non-positive / over-precise input", () => {
    expect(solToLamports("")).toBeNull();
    expect(solToLamports("abc")).toBeNull();
    expect(solToLamports("0")).toBeNull();
    expect(solToLamports("-1")).toBeNull();
    expect(solToLamports("0.0000000001")).toBeNull(); // sub-lamport precision
  });
  it("formats lamports back to a trimmed SOL string", () => {
    expect(lamportsToSolStr(1_000_000_000n)).toBe("1");
    expect(lamportsToSolStr(50_000_000n)).toBe("0.05");
    expect(lamportsToSolStr(0n)).toBe("0");
  });
});
