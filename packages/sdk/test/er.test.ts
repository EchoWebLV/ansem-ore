import { describe, it, expect } from "vitest";
import { erRpcTolerant, retryPastDeadline, l1Send } from "../src/er.js";

describe("resilience helpers", () => {
  it("erRpcTolerant swallows known ER-flake errors", async () => {
    await expect(erRpcTolerant(async () => { throw new Error("Blockhash not found"); })).resolves.toBeUndefined();
  });
  it("erRpcTolerant rethrows unknown errors", async () => {
    await expect(erRpcTolerant(async () => { throw new Error("custom program error: 0x2"); })).rejects.toThrow();
  });
  it("retryPastDeadline retries on RoundNotEnded then succeeds", async () => {
    let calls = 0;
    await retryPastDeadline(async () => { if (++calls < 3) throw new Error("RoundNotEnded"); }, "t", 5, 1);
    expect(calls).toBe(3);
  });
  it("l1Send retries on 429 then succeeds", async () => {
    let calls = 0;
    await l1Send(async () => { if (++calls < 2) throw new Error("429 Too Many Requests"); }, 4, 1);
    expect(calls).toBe(2);
  });
});
