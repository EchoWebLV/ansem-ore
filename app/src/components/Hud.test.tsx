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
    expect(screen.getByLabelText("Round information")).toBeInTheDocument();
    const roundId = screen.getByText("#12");
    const roundState = screen.getByText("OPEN");
    expect(roundState.parentElement).toHaveTextContent(/^#12 · OPEN$/);
    expect(roundId).toHaveClass("font-mono");
    expect(roundState.closest(".font-mono")).toBeNull();
    expect(screen.getByText(/1 SOL/)).toBeInTheDocument();
    expect(screen.getByText("01:40")).toBeInTheDocument(); // 100s
  });

  it("labels the settled state as REVEALED", () => {
    render(<Hud snapshot={snap({ state: RoundState.Settled, jackpotSquare: 4 })} nowMs={900_000} />);
    const roundState = screen.getByText("REVEALED");
    expect(roundState.parentElement).toHaveTextContent(/^#12 · REVEALED$/);
    expect(roundState.closest(".font-mono")).toBeNull();
    expect(screen.getByText("--")).toBeInTheDocument();
  });

  it("shows the pool without duplicating the jackpot value", () => {
    // ONE FACT, ONE PLACE: even with a stamped pool AND a rollover present, the
    // HUD sub line must not duplicate the JackpotMeter's number.
    render(<Hud snapshot={snap({ jackpotPool: "27720000", rolloverJackpot: "3044903400" })} nowMs={900_000} />);
    expect(screen.getByText("Pool")).toBeInTheDocument();
    expect(screen.getByText("1 SOL")).toBeInTheDocument();
    expect(screen.queryByText(/jackpot/i)).toBeNull();
  });

  it("mounts an optional chip after the pool in the responsive HUD grid", () => {
    render(<Hud snapshot={snap()} nowMs={900_000} chipSlot={<button type="button">BEEF claim</button>} />);

    const header = screen.getByLabelText("Round information");
    const pool = screen.getByText("Pool").parentElement;
    const chipSlot = screen.getByTestId("hud-chip-slot");

    expect(header).toHaveClass("sm:grid-cols-[1fr_auto_1fr_auto]");
    expect(chipSlot).toHaveTextContent("BEEF claim");
    expect(chipSlot).toHaveClass("col-span-3", "sm:col-span-1", "sm:ml-3");
    expect(pool?.nextElementSibling).toBe(chipSlot);
  });

  it("omits the chip mount when no chip is supplied", () => {
    render(<Hud snapshot={snap()} nowMs={900_000} />);

    expect(screen.queryByTestId("hud-chip-slot")).toBeNull();
  });
});
