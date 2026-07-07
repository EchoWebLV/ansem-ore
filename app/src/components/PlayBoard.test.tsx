import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, waitFor } from "@testing-library/react";
import { RoundState, type WireSnapshot } from "@ansem/sdk";
import type { KeeperClient, KeeperClientOpts } from "../lib/keeper-client.js";

// WalletBar pulls in wallet-adapter (needs WalletProvider context + a browser
// wallet); stub it so this test focuses on the snapshot -> UI composition.
vi.mock("./WalletBar.js", () => ({ WalletBar: () => <div data-testid="wallet-bar" /> }));

// The write column mounts hooks that touch wallet-adapter context + derive PDAs
// (which jsdom's crypto can't do). Mock the seams so the test exercises GATING only;
// real on-chain behaviour is verified by the human devnet runbook (T15).
const ctl = vi.hoisted(() => ({ l1: null as unknown, wallet: null as unknown }));
vi.mock("../lib/anchor.js", () => ({
  useL1Program: () => ctl.l1,
  erConnection: () => ({}),
  erProgramForSession: () => ({}),
}));
vi.mock("@solana/wallet-adapter-react", () => ({
  useAnchorWallet: () => ctl.wallet,
  useConnection: () => ({ connection: { getAccountInfo: async () => null } }),
}));
vi.mock("../hooks/use-player-state.js", () => ({
  usePlayerState: () => ({
    escrow: { balance: 50_000_000n, activeRound: 0, reconciledRound: 0, lastClaimedRound: 0 },
    miner: null, config: null, refresh: () => {},
  }),
}));
vi.mock("../hooks/use-session.js", () => ({
  useSession: () => ({ session: null, signer: null, valid: false, persist: () => {}, clear: () => {} }),
}));

import { PlayBoard } from "./PlayBoard.js";

const wireSnap = (over: Partial<WireSnapshot> = {}): WireSnapshot => ({
  roundId: 77, state: RoundState.Open, deadlineTs: 1_000, pot: "1000000000",
  blockSol: Array(25).fill("0"), jackpotSquare: null, jackpotPool: "0",
  rolloverJackpot: "0", updatedAt: 1,
  leaderboard: [{ wallet: "ZZZZZZZZZZZZZZZZ", totalStake: "1000000000", squares: [5] }],
  recentEvents: [], ...over,
});

function renderWithSnapshot() {
  let captured: KeeperClientOpts | null = null;
  const factory = (opts: KeeperClientOpts): KeeperClient => { captured = opts; return { start: () => {}, stop: () => {} }; };
  render(<PlayBoard wsUrl="ws://x" httpUrl="http://x" nowMs={900_000} clientFactory={factory} />);
  act(() => { captured!.onStatus?.("connected"); captured!.onSnapshot(wireSnap()); });
}

describe("PlayBoard", () => {
  beforeEach(() => { ctl.l1 = null; ctl.wallet = null; });

  it("renders the live board + HUD + leaderboard from streamed snapshots", async () => {
    let captured: KeeperClientOpts | null = null;
    const factory = (opts: KeeperClientOpts): KeeperClient => { captured = opts; return { start: () => {}, stop: () => {} }; };

    render(<PlayBoard wsUrl="ws://x" httpUrl="http://x" nowMs={900_000} clientFactory={factory} />);
    expect(screen.getByText(/waiting for the keeper/i)).toBeInTheDocument();

    act(() => { captured!.onStatus?.("connected"); captured!.onSnapshot(wireSnap()); });

    await waitFor(() => expect(screen.getByText(/Round 77/i)).toBeInTheDocument());
    expect(screen.getByTestId("tile-5")).toBeInTheDocument();
    expect(screen.getByText("ZZZZ…ZZZZ")).toBeInTheDocument();
  });

  it("hides the write column until a wallet + L1 program are present", () => {
    renderWithSnapshot(); // ctl.l1 = null, ctl.wallet = null
    expect(screen.queryByText(/ESCROW/)).toBeNull();
  });

  it("shows the write column (escrow + one-popup entry) once connected", async () => {
    ctl.l1 = {}; ctl.wallet = { publicKey: { toBase58: () => "Wallet1111" } };
    renderWithSnapshot();
    await waitFor(() => expect(screen.getByText(/ESCROW/)).toBeInTheDocument());
    expect(screen.getByText(/0\.05 SOL/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /enter round/i })).toBeInTheDocument();
  });
});
