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
  useConnection: () => ({ connection: { getAccountInfo: async () => null, getBalance: async () => 59_102_330 } }),
}));
vi.mock("../hooks/use-player-state.js", () => ({
  usePlayerState: () => ({
    escrow: null,
    miner: null, config: null, loaded: true, refresh: () => {},
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
    // Pre-snapshot: the skeleton board paints instantly — full idle bull-head + connecting header.
    expect(screen.getByTestId("tile-24")).toBeInTheDocument();
    expect(screen.getByText(/round.+connecting/i)).toBeInTheDocument();

    act(() => { captured!.onStatus?.("connected"); captured!.onSnapshot(wireSnap()); });

    await waitFor(() => expect(screen.getByText(/Round 77/i)).toBeInTheDocument());
    expect(screen.getByTestId("tile-5")).toBeInTheDocument();
    expect(screen.getByText("ZZZZ…ZZZZ")).toBeInTheDocument();
    // The verify panel ships with the read-only board too — program link always present.
    expect(screen.getByText("VERIFY ON-CHAIN")).toBeInTheDocument();
  });

  it("hides the write column until a wallet + L1 program are present", () => {
    renderWithSnapshot(); // ctl.l1 = null, ctl.wallet = null
    expect(screen.queryByRole("button", { name: /stake · one approval/i })).toBeNull();
  });

  it("shows the direct-stake write column (one-approval rail + wallet balance) once connected", async () => {
    ctl.l1 = {}; ctl.wallet = { publicKey: { toBase58: () => "Wallet1111" } };
    renderWithSnapshot();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /stake · one approval/i })).toBeInTheDocument(),
    );
    // No escrow lifecycle anywhere in direct mode.
    expect(screen.queryByText(/ESCROW/)).toBeNull();
    expect(screen.queryByRole("button", { name: /enter round/i })).toBeNull();
    // Wallet balance surfaces so unaffordable stakes are self-explanatory.
    await waitFor(() => expect(screen.getByText(/wallet 0\.0591/i)).toBeInTheDocument());
  });

  it("keeps the replay button available after the next round opens (persistent replay)", () => {
    let captured: KeeperClientOpts | null = null;
    const factory = (opts: KeeperClientOpts): KeeperClient => { captured = opts; return { start: () => {}, stop: () => {} }; };
    render(<PlayBoard wsUrl="ws://x" httpUrl="http://x" nowMs={900_000} clientFactory={factory} />);
    act(() => {
      captured!.onStatus?.("connected");
      captured!.onSnapshot(wireSnap({ roundId: 77, state: RoundState.Settled, jackpotSquare: 3 }));
    });
    // The next round opens — previously the button died right here.
    act(() => { captured!.onSnapshot(wireSnap({ roundId: 78, state: RoundState.Open })); });
    expect(screen.getByRole("button", { name: /replay reveal/i })).toBeInTheDocument();
  });

  it("renders the abstract backdrop layer", () => {
    const factory = (): KeeperClient => ({ start: () => {}, stop: () => {} });
    render(<PlayBoard wsUrl="ws://x" httpUrl="http://x" clientFactory={factory} />);
    expect(screen.getByTestId("abstract-bg")).toBeInTheDocument();
  });
});
