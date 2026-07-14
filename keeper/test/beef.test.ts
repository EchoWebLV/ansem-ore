import { describe, it, expect } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, BeefConfigState } from "@ansem/sdk";
import { makeBeefStamper, BeefStampDeps } from "../src/beef.js";
import { makeLogger } from "../src/logger.js";

const silentLog = makeLogger(() => {});

type DurableStampDeps = BeefStampDeps & {
  sleep: (ms: number) => Promise<void>;
};

// A representative pinned BeefConfig (launch params); only mint/vault/treasury are read by the
// stamper — the rest rides along from the on-chain fetch.
const CFG: BeefConfigState = {
  beefMint: PublicKey.unique().toBase58(),
  beefVault: PublicKey.unique().toBase58(),
  beefTreasury: PublicKey.unique().toBase58(),
  maxRoundMint: 210_000_000n, satLamports: 1_000_000_000n, hardCap: 21_000_000_000_000n,
  mintedTotal: 0n, treasuryBps: 2000, tickBps: 3, bonusCapBps: 30_000,
  activityWindowSecs: 86_400, secsPerTick: 60, totalOwed: 0n, bump: 254,
};

// Default deps: BEEF live + healthy, stamp lands, emission reads as the headline 84M players' share.
function harness(over: Partial<BeefStampDeps> = {}) {
  const calls = { probe: 0, send: [] as number[], read: [] as number[], pushed: [] as bigint[] };
  const deps: BeefStampDeps = {
    probeConfig: async () => { calls.probe++; return CFG; },
    detectTokenProgram: async () => TOKEN_PROGRAM_ID,
    sendStamp: async (roundId) => { calls.send.push(roundId); },
    readEmission: async (roundId) => { calls.read.push(roundId); return 84_000_000n; },
    pushEmission: (e) => { calls.pushed.push(e); },
    log: silentLog,
    ...over,
  };
  return { deps, calls, stamper: makeBeefStamper(deps) };
}

function durableHarness(over: Partial<DurableStampDeps> = {}) {
  const calls = {
    send: [] as number[],
    read: [] as number[],
    sleep: [] as number[],
    published: [] as bigint[],
  };
  const deps: DurableStampDeps = {
    probeConfig: async () => CFG,
    detectTokenProgram: async () => TOKEN_PROGRAM_ID,
    sendStamp: async (roundId) => { calls.send.push(roundId); },
    readEmission: async (roundId) => { calls.read.push(roundId); return 84_000_000n; },
    sleep: async (ms) => { calls.sleep.push(ms); },
    pushEmission: (emission) => { calls.published.push(emission); },
    log: silentLog,
    ...over,
  };
  return { calls, stamper: makeBeefStamper(deps) };
}

describe("makeBeefStamper", () => {
  // ---- REQUIRED: stamp-skipped-when-no-config ----
  it("SKIPS when BeefConfig is uninitialized — no send, no throw, stays dormant", async () => {
    const { calls, stamper } = harness({ probeConfig: async () => null });
    await stamper.stamp(5); // must resolve (the game is untouched)
    expect(calls.send).toEqual([]);
    expect(calls.pushed).toEqual([]);
    expect(stamper.enabled()).toBe(false);
  });

  // ---- REQUIRED: emission-pushed-to-holder ----
  it("stamps then captures the frozen players' emission into the holder", async () => {
    const { calls, stamper } = harness();
    await stamper.stamp(7);
    expect(calls.send).toEqual([7]);
    expect(calls.read).toEqual([7]);
    expect(calls.pushed).toEqual([84_000_000n]); // BeefRound.emission -> snapshot.beefPerRound
    expect(stamper.enabled()).toBe(true);
  });

  // ---- REQUIRED: stamp-failure-doesn't-break-loop ----
  it("a stamp SEND-failure throws (finalizeSettled swallows it) and pushes no emission", async () => {
    const { calls, stamper } = harness({ sendStamp: async () => { throw new Error("BadRoundState"); } });
    await expect(stamper.stamp(9)).rejects.toThrow(/BadRoundState/);
    expect(calls.pushed).toEqual([]);
  });

  it("invalidates + re-probes on the NEXT stamp after a send-failure (transient recovery)", async () => {
    let mode: "fail" | "ok" = "fail";
    let probes = 0;
    const sent: number[] = [];
    const stamper = makeBeefStamper({
      probeConfig: async () => { probes++; return CFG; },
      detectTokenProgram: async () => TOKEN_PROGRAM_ID,
      sendStamp: async (r) => { if (mode === "fail") throw new Error("rpc flake"); sent.push(r); },
      readEmission: async () => 1n,
      pushEmission: () => {},
      log: silentLog,
    });
    await expect(stamper.stamp(1)).rejects.toThrow(/rpc flake/); // probe #1, send fails -> cache cleared
    expect(probes).toBe(1);
    expect(stamper.enabled()).toBe(false);
    mode = "ok";
    await stamper.stamp(2); // empty cache -> probe #2, send ok
    expect(probes).toBe(2);
    expect(sent).toEqual([2]);
  });

  it("picks up a MID-FLIGHT init_beef: dormant, then enabled on the next finalize (no restart)", async () => {
    let cfg: BeefConfigState | null = null; // BeefConfig absent at boot (mainnet today)
    const sent: number[] = [];
    const stamper = makeBeefStamper({
      probeConfig: async () => cfg,
      detectTokenProgram: async () => TOKEN_PROGRAM_ID,
      sendStamp: async (r) => { sent.push(r); },
      readEmission: async () => 84_000_000n,
      pushEmission: () => {},
      log: silentLog,
    });
    await stamper.stamp(1); // absent -> skip
    expect(sent).toEqual([]);
    expect(stamper.enabled()).toBe(false);
    cfg = CFG; // init_beef lands mid-flight
    await stamper.stamp(2); // lazy re-probe hits -> stamps
    expect(sent).toEqual([2]);
    expect(stamper.enabled()).toBe(true);
  });

  it("a post-stamp emission READ failure is non-fatal (stamp already landed; keeps prior value)", async () => {
    const { calls, stamper } = harness({ readEmission: async () => { throw new Error("read flake"); } });
    await stamper.stamp(3); // must RESOLVE — the capture is best-effort, the stamp is done
    expect(calls.send).toEqual([3]);
    expect(calls.pushed).toEqual([]);
    expect(stamper.enabled()).toBe(true); // a read hiccup does NOT invalidate the config cache
  });

  it("threads the detected token program (Token-2022) into the stamp send", async () => {
    let seenTp: PublicKey | null = null;
    const stamper = makeBeefStamper({
      probeConfig: async () => CFG,
      detectTokenProgram: async () => TOKEN_2022_PROGRAM_ID,
      sendStamp: async (_r, _cfg, tp) => { seenTp = tp; },
      readEmission: async () => 1n,
      pushEmission: () => {},
      log: silentLog,
    });
    await stamper.stamp(4);
    expect(seenTp!.equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
  });

  it("caches across stamps: a healthy BEEF re-probes only on failure, not every round", async () => {
    const { calls, stamper } = harness();
    await stamper.stamp(1);
    await stamper.stamp(2);
    await stamper.stamp(3);
    expect(calls.probe).toBe(1); // one probe, then served from cache
    expect(calls.send).toEqual([1, 2, 3]);
  });

  it("init() warms the cache from the boot probe (enabled path)", async () => {
    const { stamper, calls } = harness();
    await stamper.init();
    expect(stamper.enabled()).toBe(true);
    expect(calls.probe).toBe(1);
  });

  it("init() stays dormant when BeefConfig is absent (mainnet today)", async () => {
    const { stamper } = harness({ probeConfig: async () => null });
    await stamper.init();
    expect(stamper.enabled()).toBe(false);
  });

  describe("durable idempotent stamping", () => {
    it("publishes an existing BeefRound emission without sending a transaction", async () => {
      const emission = 81_234_567n;
      const { calls, stamper } = durableHarness({
        readEmission: async (roundId) => { calls.read.push(roundId); return emission; },
      });

      await stamper.stamp(41);

      expect(calls.send).toEqual([]);
      expect(calls.read).toEqual([41]);
      expect(calls.published).toEqual([emission]);
    });

    it("sends once, then waits for delayed BeefRound reads before publishing", async () => {
      let sent = false;
      let readsAfterSend = 0;
      const emission = 82_345_678n;
      const { calls, stamper } = durableHarness({
        sendStamp: async (roundId) => { calls.send.push(roundId); sent = true; },
        readEmission: async (roundId) => {
          calls.read.push(roundId);
          if (!sent || ++readsAfterSend < 3) throw new Error("BeefRound unavailable");
          return emission;
        },
      });

      await stamper.stamp(42);

      expect(calls.send).toEqual([42]);
      expect(calls.read).toEqual([42, 42, 42, 42]);
      expect(calls.sleep.length).toBeGreaterThan(0);
      expect(calls.published).toEqual([emission]);
    });

    it("recovers a landed-account send error through the next stamp's pre-read", async () => {
      let landed = false;
      const emission = 83_456_789n;
      const { calls, stamper } = durableHarness({
        sendStamp: async (roundId) => {
          calls.send.push(roundId);
          landed = true;
          throw new Error("confirmation lost");
        },
        readEmission: async (roundId) => {
          calls.read.push(roundId);
          if (!landed) throw new Error("BeefRound unavailable");
          return emission;
        },
      });

      await expect(stamper.stamp(43)).rejects.toThrow(/confirmation lost/);

      expect(calls.send).toEqual([43]);
      expect(calls.read).toEqual([43]);
      expect(calls.published).toEqual([]);

      await stamper.stamp(43);

      expect(calls.send).toEqual([43]);
      expect(calls.read).toEqual([43, 43]);
      expect(calls.published).toEqual([emission]);
    });

    it("throws when BeefRound reads are exhausted and never fabricates an emission", async () => {
      const { calls, stamper } = durableHarness({
        readEmission: async (roundId) => {
          calls.read.push(roundId);
          throw new Error("BeefRound unavailable");
        },
      });

      await expect(stamper.stamp(44)).rejects.toThrow(/BeefRound unavailable/);

      expect(calls.send).toEqual([44]);
      expect(calls.read.length).toBeGreaterThan(1);
      expect(calls.sleep.length).toBeGreaterThan(0);
      expect(calls.published).toEqual([]);
    });
  });
});
