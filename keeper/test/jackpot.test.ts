import { describe, it, expect } from "vitest";
import { makeJackpotReader, jackpotConfigPda } from "../src/read/jackpot.js";

/** A fake anchor Program whose jackpotConfig.fetch yields the given raw account (or throws
 *  "account does not exist" when null, mirroring an absent PDA on the current program). */
const programYielding = (
  raw: { triggerOdds: number; capMult: number; bump: number } | null,
  counter = { n: 0 },
) => ({
  account: {
    jackpotConfig: {
      fetch: async () => {
        counter.n++;
        if (!raw) throw new Error("Account does not exist or has no data");
        return raw;
      },
    },
  },
}) as any;

describe("jackpotConfigPda", () => {
  it("derives deterministically (re-exported from the SDK — single source of truth)", () => {
    expect(jackpotConfigPda().toBase58()).toBe(jackpotConfigPda().toBase58());
  });
});

describe("makeJackpotReader", () => {
  it("returns nulls when the PDA does not exist (current program)", async () => {
    const read = makeJackpotReader(programYielding(null));
    expect(await read()).toEqual({ jackpotTriggerOdds: null, jackpotCapMult: null });
  });

  it("decodes trigger_odds + cap_mult when the PDA exists (upgraded program)", async () => {
    const read = makeJackpotReader(programYielding({ triggerOdds: 25, capMult: 100, bump: 254 }));
    expect(await read()).toEqual({ jackpotTriggerOdds: 25, jackpotCapMult: 100 });
  });

  it("caches within the TTL window (one fetch), refreshes after it", async () => {
    const counter = { n: 0 };
    let t = 1_000;
    const read = makeJackpotReader(
      programYielding({ triggerOdds: 25, capMult: 100, bump: 254 }, counter), 60_000, () => t,
    );
    await read();
    await read();
    expect(counter.n).toBe(1); // second call served from cache
    t += 60_001;
    await read();
    expect(counter.n).toBe(2); // TTL elapsed -> re-read
  });

  it("stays null-safe when the fetch throws (transient RPC error)", async () => {
    const program = {
      account: { jackpotConfig: { fetch: async () => { throw new Error("rpc down"); } } },
    } as any;
    const read = makeJackpotReader(program);
    expect(await read()).toEqual({ jackpotTriggerOdds: null, jackpotCapMult: null });
  });
});
