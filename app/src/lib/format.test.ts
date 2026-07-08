import { describe, it, expect } from "vitest";
import { RoundState } from "@ansem/sdk";
import { lamportsToSol, formatSol, formatAnsem, stateLabel, secondsLeft, formatCountdown, shortAddr, eventToText } from "./format.js";

describe("format helpers", () => {
  it("lamportsToSol parses stringified lamports without precision loss", () => {
    expect(lamportsToSol("1000000000")).toBeCloseTo(1);
    expect(lamportsToSol("20000000")).toBeCloseTo(0.02);
    expect(lamportsToSol("0")).toBe(0);
  });

  it("formatSol renders a trimmed SOL string", () => {
    expect(formatSol("1000000000")).toBe("1 SOL");
    expect(formatSol("20000000")).toBe("0.02 SOL");
  });

  it("formatAnsem renders 1e6 base units as a trimmed ANSEM string", () => {
    expect(formatAnsem("27720000")).toBe("27.72 ANSEM");
    expect(formatAnsem("3044903400")).toBe("3044.9 ANSEM");
    expect(formatAnsem("0")).toBe("0 ANSEM");
  });

  it("stateLabel maps each RoundState", () => {
    expect(stateLabel(RoundState.Open)).toBe("OPEN");
    expect(stateLabel(RoundState.VrfPending)).toBe("SETTLING");
    expect(stateLabel(RoundState.Settled)).toBe("REVEALED");
    expect(stateLabel(RoundState.Claimable)).toBe("CLAIMABLE");
    expect(stateLabel(RoundState.Closed)).toBe("VOID");
  });

  it("secondsLeft clamps at zero and formatCountdown renders mm:ss", () => {
    expect(secondsLeft(1_000, 500_000)).toBe(500); // deadline 1000s, now 500s
    expect(secondsLeft(1_000, 2_000_000)).toBe(0); // past deadline -> clamped
    expect(formatCountdown(65)).toBe("01:05");
    expect(formatCountdown(0)).toBe("00:00");
  });

  it("shortAddr abbreviates a base58 pubkey", () => {
    expect(shortAddr("ABCDEFGHIJKLMNOP")).toBe("ABCD…MNOP");
  });

  it("eventToText renders each keeper event", () => {
    expect(eventToText({ type: "round.open", roundId: 5, deadlineTs: 0 })).toBe("Round 5 opened");
    expect(eventToText({ type: "stake", roundId: 5, square: 3, totalStake: "20000000" })).toContain("Bull #4");
    expect(eventToText({ type: "round.settling", roundId: 5 })).toBe("Round 5 settling…");
    expect(eventToText({ type: "round.revealed", roundId: 5, jackpotSquare: 6 })).toContain("Bull #7");
    expect(eventToText({ type: "round.claimable", roundId: 5 })).toBe("Round 5 claimable");
  });
});
