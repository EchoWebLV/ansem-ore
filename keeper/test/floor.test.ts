import { describe, it, expect } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { computeFloorUpdate, runFloorRefreshOnce, FloorRefreshDeps } from "../src/floor.js";
import { FetchLike } from "../src/jupiter.js";
import { makeLogger } from "../src/logger.js";

// Reference numbers from spec D9: floor was pinned at init to 182,446,494 ANSEM/SOL while the
// market moved to ~285,000,000. target = 92% of market = 262,200,000; band = ±5% of target.
const MARKET = 285_000_000n;
const TARGET = 262_200_000n; // 285_000_000 * 9200 / 10000
const STALE_INIT_FLOOR = 182_446_494n;

describe("computeFloorUpdate", () => {
  it("inside band -> null (no admin tx spam on noise)", () => {
    expect(computeFloorUpdate(MARKET, TARGET)).toBeNull();          // dead-center
    expect(computeFloorUpdate(MARKET, 260_000_000n)).toBeNull();    // within ±5%
  });

  it("stored floor below band -> returns the new target (the live D9 bug)", () => {
    expect(computeFloorUpdate(MARKET, STALE_INIT_FLOOR)).toBe(TARGET);
  });

  it("stored floor above band -> returns the new (lower) target", () => {
    // Market fell to 200e6; the 262.2e6 floor is now far above band -> retarget down.
    // target = 200_000_000 * 0.92 = 184_000_000.
    expect(computeFloorUpdate(200_000_000n, TARGET)).toBe(184_000_000n);
  });

  it("zero-market edge: positive floor reads as above-band and retargets to 0", () => {
    // Documents WHY the loop guards a non-positive quote — acting on this would zero the floor.
    expect(computeFloorUpdate(0n, TARGET)).toBe(0n);
    expect(computeFloorUpdate(0n, 0n)).toBeNull(); // already at (degenerate) target
  });

  it("band boundaries are inclusive", () => {
    const lo = (TARGET * 9500n) / 10_000n; // 249_090_000
    const hi = (TARGET * 10_500n) / 10_000n; // 275_310_000
    expect(computeFloorUpdate(MARKET, lo)).toBeNull();
    expect(computeFloorUpdate(MARKET, hi)).toBeNull();
    expect(computeFloorUpdate(MARKET, lo - 1n)).toBe(TARGET); // just below -> update
    expect(computeFloorUpdate(MARKET, hi + 1n)).toBe(TARGET); // just above -> update
  });

  it("honors custom target/drift bps", () => {
    // target 100% of market, 0% drift band -> any mismatch updates, exact match is null.
    expect(computeFloorUpdate(MARKET, MARKET, 10_000n, 0n)).toBeNull();
    expect(computeFloorUpdate(MARKET, MARKET - 1n, 10_000n, 0n)).toBe(MARKET);
  });
});

// ---- runFloorRefreshOnce: the quote -> decide -> send pass ----

const quoteReturning = (outAmount: string): FetchLike =>
  async () => ({ ok: true, status: 200, json: async () => ({ outAmount }), text: async () => "" });

const silentLog = makeLogger(() => {});
const KEEPER = PublicKey.default;

/** A fake anchor Program that records the rate handed to set_min_swap_rate. */
function recordingProgram() {
  let sentRate: string | null = null;
  const program = {
    methods: {
      setMinSwapRate: (rate: any) => ({
        accountsPartial: () => ({ rpc: async () => { sentRate = rate.toString(); return "sig"; } }),
      }),
    },
  } as any;
  return { program, sent: () => sentRate };
}

/** A fake Program that fails the test if any instruction is built (proves NO send). */
const noSendProgram = () => ({ methods: new Proxy({}, { get() { throw new Error("unexpected send"); } }) }) as any;

const baseDeps = (over: Partial<FloorRefreshDeps>): FloorRefreshDeps => ({
  program: noSendProgram(),
  keeper: KEEPER,
  getConfig: async () => ({ ansemMint: "AnsemMint1111111111", minSwapRate: TARGET } as any),
  jupBaseUrl: "https://jup.test/swap/v1",
  slippageBps: 100,
  fetchImpl: quoteReturning("285000000"),
  log: silentLog,
  ...over,
});

describe("runFloorRefreshOnce", () => {
  it("sends set_min_swap_rate with the new target when the stored floor is out of band", async () => {
    const { program, sent } = recordingProgram();
    await runFloorRefreshOnce(baseDeps({
      program,
      getConfig: async () => ({ ansemMint: "M", minSwapRate: STALE_INIT_FLOOR } as any),
      fetchImpl: quoteReturning("285000000"),
    }));
    expect(sent()).toBe(TARGET.toString());
  });

  it("does not send when the stored floor is already in band", async () => {
    // noSendProgram throws if an ix is built; in-band means we never build one.
    await expect(runFloorRefreshOnce(baseDeps({
      getConfig: async () => ({ ansemMint: "M", minSwapRate: TARGET } as any),
      fetchImpl: quoteReturning("285000000"),
    }))).resolves.toBeUndefined();
  });

  it("skips (no send) on a non-positive Jupiter quote — never zeroes the floor", async () => {
    await expect(runFloorRefreshOnce(baseDeps({
      getConfig: async () => ({ ansemMint: "M", minSwapRate: TARGET } as any),
      fetchImpl: quoteReturning("0"),
    }))).resolves.toBeUndefined();
  });

  it("quotes 1 SOL against the live config ansemMint", async () => {
    let seenUrl = "";
    const spyFetch: FetchLike = async (url) => {
      seenUrl = url;
      return { ok: true, status: 200, json: async () => ({ outAmount: "285000000" }), text: async () => "" };
    };
    await runFloorRefreshOnce(baseDeps({
      getConfig: async () => ({ ansemMint: "TheAnsemCA", minSwapRate: TARGET } as any),
      fetchImpl: spyFetch,
    }));
    expect(seenUrl).toContain("outputMint=TheAnsemCA");
    expect(seenUrl).toContain("amount=1000000000"); // exactly 1 SOL
  });
});
