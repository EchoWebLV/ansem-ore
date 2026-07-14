// @vitest-environment node
import { describe, it, expect, vi } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { beefPayout, accountExists } from "./beef.js";

describe("beefPayout (program parity — never over-states a claim)", () => {
  it("returns the bare unclaimed when the bonus is zero", () => {
    expect(beefPayout(21_000_000n, 0)).toBe(21_000_000n);
  });

  it("applies the hold-to-grow bonus exactly like the program (floor of unclaimed*(10000+bonus)/10000)", () => {
    // 21_000_000 * (10000 + 3000)/10000 = 21_000_000 * 1.3 = 27_300_000
    expect(beefPayout(21_000_000n, 3_000)).toBe(27_300_000n);
    // the +300% cap (30_000 bps) => 4x
    expect(beefPayout(21_000_000n, 30_000)).toBe(84_000_000n);
  });

  it("FLOORS the division the same way u128 integer math does (never rounds up)", () => {
    // 7 * (10000 + 1)/10000 = 7.0007 -> floors to 7, never 8
    expect(beefPayout(7n, 1)).toBe(7n);
    // 100003 * 10001/10000 = 100013.0003 -> 100013
    expect(beefPayout(100_003n, 1)).toBe(100_013n);
  });

  it("is zero for an empty balance (nothing a claim could pay)", () => {
    expect(beefPayout(0n, 30_000)).toBe(0n);
  });
});

describe("accountExists (invariant-safe existence probe)", () => {
  const pk = PublicKey.default;

  it("true when the account is present", async () => {
    const conn = { getAccountInfo: vi.fn(async () => ({ lamports: 1 })) } as any;
    expect(await accountExists(conn, pk)).toBe(true);
  });

  it("false when the account is missing", async () => {
    const conn = { getAccountInfo: vi.fn(async () => null) } as any;
    expect(await accountExists(conn, pk)).toBe(false);
  });

  it("false (never throws) when the RPC read fails — degrades to a plain, unblocked action", async () => {
    const conn = { getAccountInfo: vi.fn(async () => { throw new Error("rpc down"); }) } as any;
    expect(await accountExists(conn, pk)).toBe(false);
  });
});
