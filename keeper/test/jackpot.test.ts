import { describe, it, expect } from "vitest";
import { decodeJackpotParams, makeJackpotReader, jackpotConfigPda } from "../src/read/jackpot.js";

/** anchor account buffer: 8-byte discriminator, trigger_odds u16 LE, cap_mult u16 LE, bump u8. */
const jackpotBuf = (triggerOdds: number, capMult: number, bump = 254): Buffer => {
  const b = Buffer.alloc(13);
  b.writeUInt16LE(triggerOdds, 8);
  b.writeUInt16LE(capMult, 10);
  b[12] = bump;
  return b;
};

describe("decodeJackpotParams", () => {
  it("decodes trigger_odds + cap_mult past the discriminator", () => {
    expect(decodeJackpotParams(jackpotBuf(25, 100))).toEqual({ jackpotTriggerOdds: 25, jackpotCapMult: 100 });
  });

  it("null / undefined / short buffers -> null fields (pre-upgrade program)", () => {
    expect(decodeJackpotParams(null)).toEqual({ jackpotTriggerOdds: null, jackpotCapMult: null });
    expect(decodeJackpotParams(undefined)).toEqual({ jackpotTriggerOdds: null, jackpotCapMult: null });
    expect(decodeJackpotParams(Buffer.alloc(8))).toEqual({ jackpotTriggerOdds: null, jackpotCapMult: null });
  });
});

describe("jackpotConfigPda", () => {
  it("derives deterministically", () => {
    expect(jackpotConfigPda().toBase58()).toBe(jackpotConfigPda().toBase58());
  });
});

describe("makeJackpotReader", () => {
  const connYielding = (data: Buffer | null, counter = { n: 0 }) => ({
    getAccountInfo: async () => { counter.n++; return data ? ({ data } as any) : null; },
  }) as any;

  it("returns nulls when the PDA does not exist (current program)", async () => {
    const read = makeJackpotReader(connYielding(null));
    expect(await read()).toEqual({ jackpotTriggerOdds: null, jackpotCapMult: null });
  });

  it("decodes the account when the PDA exists (upgraded program)", async () => {
    const read = makeJackpotReader(connYielding(jackpotBuf(25, 100)));
    expect(await read()).toEqual({ jackpotTriggerOdds: 25, jackpotCapMult: 100 });
  });

  it("caches within the TTL window (one RPC hit), refreshes after it", async () => {
    const counter = { n: 0 };
    let t = 1_000;
    const read = makeJackpotReader(connYielding(jackpotBuf(25, 100), counter), 60_000, () => t);
    await read();
    await read();
    expect(counter.n).toBe(1); // second call served from cache
    t += 60_001;
    await read();
    expect(counter.n).toBe(2); // TTL elapsed -> re-read
  });

  it("stays null-safe when the RPC throws", async () => {
    const conn = { getAccountInfo: async () => { throw new Error("rpc down"); } } as any;
    const read = makeJackpotReader(conn);
    expect(await read()).toEqual({ jackpotTriggerOdds: null, jackpotCapMult: null });
  });
});
