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

  it("open-state sub shows the pot ONLY — the jackpot lives exclusively in the meter card", () => {
    // ONE FACT, ONE PLACE: even with a stamped pool AND a rollover present, the
    // HUD sub line must not duplicate the JackpotMeter's number.
    render(<Hud snapshot={snap({ jackpotPool: "27720000", rolloverJackpot: "3044903400" })} nowMs={900_000} />);
    expect(screen.getByText(/pot 1 SOL/)).toBeInTheDocument();
    expect(screen.queryByText(/jackpot/i)).toBeNull();
  });
});
