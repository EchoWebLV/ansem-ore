import { describe, it, expect } from "vitest";
import { quoteSolToAnsem, SOL_MINT, JupCfg, FetchLike } from "../src/jupiter.js";

const cfg: JupCfg = { jupBaseUrl: "https://jup.test/swap/v1", ansemMint: "AnsemMint1111111111", slippageBps: 100 };
const okQuote = (outAmount: string): FetchLike =>
  async () => ({ ok: true, status: 200, json: async () => ({ outAmount }), text: async () => "" });

describe("quoteSolToAnsem", () => {
  it("parses outAmount from the /quote response as a bigint (no precision loss)", async () => {
    expect(await quoteSolToAnsem(cfg, okQuote("123456789012345"), 1_000_000_000n)).toBe(123456789012345n);
  });

  it("builds the quote URL: SOL input, config ANSEM output, amount + slippageBps", async () => {
    let seen = "";
    const fetchImpl: FetchLike = async (url) => {
      seen = url;
      return { ok: true, status: 200, json: async () => ({ outAmount: "1" }), text: async () => "" };
    };
    await quoteSolToAnsem(cfg, fetchImpl, 5_000_000n);
    expect(seen).toContain(`${cfg.jupBaseUrl}/quote`);
    expect(seen).toContain(`inputMint=${SOL_MINT}`);
    expect(seen).toContain(`outputMint=${cfg.ansemMint}`);
    expect(seen).toContain("amount=5000000");
    expect(seen).toContain("slippageBps=100");
  });

  it("throws on a non-ok response", async () => {
    const fetchImpl: FetchLike = async () => ({ ok: false, status: 429, json: async () => ({}), text: async () => "rate limited" });
    await expect(quoteSolToAnsem(cfg, fetchImpl, 1n)).rejects.toThrow(/jupiter quote failed: 429/);
  });

  it("throws when the quote is missing outAmount", async () => {
    const fetchImpl: FetchLike = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => "" });
    await expect(quoteSolToAnsem(cfg, fetchImpl, 1n)).rejects.toThrow(/missing outAmount/);
  });
});
