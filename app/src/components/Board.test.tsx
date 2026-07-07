import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { RoundState } from "@ansem/sdk";
import { Board } from "./Board.js";
import type { WireSnapshot } from "@ansem/sdk";

const snap = (over: Partial<WireSnapshot> = {}): WireSnapshot => ({
  roundId: 1, state: RoundState.Open, deadlineTs: 0, pot: "100",
  blockSol: Array(25).fill("0"), jackpotSquare: null, jackpotPool: "0",
  rolloverJackpot: "0", updatedAt: 1, leaderboard: [], recentEvents: [], ...over,
});

describe("Board", () => {
  it("renders 25 tiles keyed by on-chain square", () => {
    render(<Board snapshot={snap()} />);
    for (let i = 0; i < 25; i++) {
      expect(screen.getByTestId(`tile-${i}`)).toBeInTheDocument();
    }
  });

  it("lights a staked square green (data-lit)", () => {
    const blockSol = Array(25).fill("0"); blockSol[3] = "60"; blockSol[8] = "40";
    render(<Board snapshot={snap({ blockSol, pot: "100" })} />);
    expect(screen.getByTestId("tile-3")).toHaveAttribute("data-lit", "true");
    expect(screen.getByTestId("tile-0")).toHaveAttribute("data-lit", "false");
  });

  it("flags the jackpot square gold only once settled", () => {
    const settled = snap({ state: RoundState.Settled, jackpotSquare: 7 });
    render(<Board snapshot={settled} />);
    expect(screen.getByTestId("tile-7")).toHaveAttribute("data-jackpot", "true");
  });

  it("renders nothing-jackpot while still open", () => {
    render(<Board snapshot={snap({ state: RoundState.Open, jackpotSquare: null })} />);
    expect(screen.getByTestId("tile-7")).toHaveAttribute("data-jackpot", "false");
  });
});
