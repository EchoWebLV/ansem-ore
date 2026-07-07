import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import type { WireSnapshot, KeeperEvent } from "@ansem/sdk";
import { Leaderboard } from "./Leaderboard.js";
import { ActivityFeed } from "./ActivityFeed.js";

const leaderboard: WireSnapshot["leaderboard"] = [
  { wallet: "AAAAAAAAAAAAAAAA", totalStake: "50000000", squares: [1, 2] },
  { wallet: "BBBBBBBBBBBBBBBB", totalStake: "20000000", squares: [3] },
];

describe("Leaderboard", () => {
  it("renders each staker with short address, SOL and square count", () => {
    render(<Leaderboard leaderboard={leaderboard} />);
    expect(screen.getByText("AAAA…AAAA")).toBeInTheDocument();
    expect(screen.getByText(/0.05 SOL/)).toBeInTheDocument();
    expect(screen.getByText(/2 bulls/)).toBeInTheDocument();
  });

  it("shows an empty state when nobody has staked", () => {
    render(<Leaderboard leaderboard={[]} />);
    expect(screen.getByText(/no stakers yet/i)).toBeInTheDocument();
  });
});

describe("ActivityFeed", () => {
  it("renders one line per event, newest first", () => {
    const events: KeeperEvent[] = [
      { type: "round.claimable", roundId: 5 },
      { type: "round.open", roundId: 5, deadlineTs: 0 },
    ];
    render(<ActivityFeed events={events} />);
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("Round 5 claimable");
  });
});
