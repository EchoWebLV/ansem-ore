import { describe, it, expect } from "vitest";
import { makeLogger } from "../src/logger.js";

describe("makeLogger", () => {
  it("emits a single JSON line with level, msg, and fields", () => {
    const lines: string[] = [];
    const log = makeLogger((l) => lines.push(l), () => 1720000000000);
    log.info("round opened", { roundId: 42 });
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.level).toBe("info");
    expect(parsed.msg).toBe("round opened");
    expect(parsed.roundId).toBe(42);
    expect(parsed.t).toBe(1720000000000);
  });

  it("serializes bigint fields as strings", () => {
    const lines: string[] = [];
    const log = makeLogger((l) => lines.push(l), () => 0);
    log.warn("pot", { pot: 123n });
    expect(JSON.parse(lines[0]).pot).toBe("123");
  });
});
