import { describe, it, expect, vi } from "vitest";
import { render, screen, act, waitFor } from "@testing-library/react";
import { RoundState, type WireSnapshot } from "@ansem/sdk";
import { PlayBoard } from "./PlayBoard.js";
import type { KeeperClient, KeeperClientOpts } from "../lib/keeper-client.js";

// WalletBar pulls in wallet-adapter (needs WalletProvider context + a browser
// wallet); stub it so this test focuses on the snapshot -> UI composition.
vi.mock("./WalletBar.js", () => ({ WalletBar: () => <div data-testid="wallet-bar" /> }));

const wireSnap = (over: Partial<WireSnapshot> = {}): WireSnapshot => ({
  roundId: 77, state: RoundState.Open, deadlineTs: 1_000, pot: "1000000000",
  blockSol: Array(25).fill("0"), jackpotSquare: null, jackpotPool: "0",
  rolloverJackpot: "0", updatedAt: 1,
  leaderboard: [{ wallet: "ZZZZZZZZZZZZZZZZ", totalStake: "1000000000", squares: [5] }],
  recentEvents: [], ...over,
});

describe("PlayBoard", () => {
  it("renders the live board + HUD + leaderboard from streamed snapshots", async () => {
    let captured: KeeperClientOpts | null = null;
    const factory = (opts: KeeperClientOpts): KeeperClient => { captured = opts; return { start: () => {}, stop: () => {} }; };

    render(<PlayBoard wsUrl="ws://x" httpUrl="http://x" nowMs={900_000} clientFactory={factory} />);
    // Before any snapshot: a waiting state.
    expect(screen.getByText(/waiting for the keeper/i)).toBeInTheDocument();

    act(() => { captured!.onStatus?.("connected"); captured!.onSnapshot(wireSnap()); });

    await waitFor(() => expect(screen.getByText(/Round 77/i)).toBeInTheDocument());
    expect(screen.getByTestId("tile-5")).toBeInTheDocument();
    expect(screen.getByText("ZZZZ…ZZZZ")).toBeInTheDocument();
  });
});
