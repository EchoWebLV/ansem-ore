import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { RoundState, type WireSnapshot } from "@ansem/sdk";
import { Hud } from "./Hud.js";

const snap = (over: Partial<WireSnapshot> = {}): WireSnapshot => ({
  roundId: 12, state: RoundState.Open, deadlineTs: 1_000, pot: "1000000000",
  blockSol: Array(25).fill("0"), jackpotSquare: null, jackpotPool: "500000000",
  rolloverJackpot: "0", updatedAt: 1, leaderboard: [], recentEvents: [], ...over,
});

describe("Hud", () => {
  it("shows round number, state and pot", () => {
    // Pin now so the countdown is deterministic: deadline 1000s, now 900s -> 100s left.
    render(<Hud snapshot={snap()} nowMs={900_000} />);
    expect(screen.getByText(/Round 12/i)).toBeInTheDocument();
    expect(screen.getByText("OPEN")).toBeInTheDocument();
    expect(screen.getByText(/1 SOL/)).toBeInTheDocument();
    expect(screen.getByText("01:40")).toBeInTheDocument(); // 100s
  });

  it("labels the settled state as REVEALED", () => {
    render(<Hud snapshot={snap({ state: RoundState.Settled, jackpotSquare: 4 })} nowMs={900_000} />);
    expect(screen.getByText("REVEALED")).toBeInTheDocument();
  });
});
