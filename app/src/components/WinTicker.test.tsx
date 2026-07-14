import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import type { KeeperEvent } from "@ansem/sdk";
import { WinTicker } from "./WinTicker.js";

describe("WinTicker", () => {
  it("marquees recent settle/claim events, skipping stakes and opens", () => {
    const events: KeeperEvent[] = [
      { type: "round.revealed", roundId: 8, jackpotSquare: 6 }, // -> Bull #7
      { type: "round.claimable", roundId: 8 },
      { type: "stake", roundId: 8, square: 0, totalStake: "20000000" }, // filtered out
      { type: "round.open", roundId: 8, deadlineTs: 0 }, // filtered out
    ];
    render(<WinTicker events={events} />);
    // duplicated for the seamless loop -> at least one copy of each highlight
    expect(screen.getAllByText(/Bull #7 struck the big pot/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Round 8 claimable/).length).toBeGreaterThan(0);
    // non-payoff lines never enter the wins ticker
    expect(screen.queryByText(/staked/)).toBeNull();
    expect(screen.queryByText(/Round 8 opened/)).toBeNull();
  });

  it("shows a quiet idle line when there are no settle/claim events", () => {
    render(<WinTicker events={[]} />);
    expect(screen.getByText(/the ring is quiet/i)).toBeInTheDocument();
  });
});
