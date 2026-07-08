import { describe, it, expect } from "vitest";
import { explorerTx, explorerAddress } from "./explorer.js";

describe("explorer links", () => {
  it("builds a devnet tx link", () => {
    expect(explorerTx("SIG123")).toBe("https://explorer.solana.com/tx/SIG123?cluster=devnet");
  });
  it("builds a devnet address link", () => {
    expect(explorerAddress("ADDR456")).toBe("https://explorer.solana.com/address/ADDR456?cluster=devnet");
  });
});
