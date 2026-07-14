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
    expect(screen.getByLabelText("Round board")).toBeInTheDocument();
    const connecting = screen.getByText("CONNECTING");
    expect(connecting.parentElement).toHaveTextContent(/^— · CONNECTING$/);
    expect(connecting.closest(".font-mono")).toBeNull();
    expect(connecting.previousElementSibling).toHaveClass("font-mono");

    act(() => { captured!.onStatus?.("connected"); captured!.onSnapshot(wireSnap()); });

    await waitFor(() => expect(screen.getByLabelText("Round information")).toBeInTheDocument());
    const roundId = screen.getByText("#77");
    const roundState = screen.getByText("OPEN");
    expect(roundState.parentElement).toHaveTextContent(/^#77 · OPEN$/);
    expect(roundId).toHaveClass("font-mono");
    expect(roundState.closest(".font-mono")).toBeNull();
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
    expect(screen.getByLabelText("Betting and claims")).toBeInTheDocument();
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

  it("shows exactly ONE countdown and ONE liveness surface — no duplicated facts", () => {
    renderWithSnapshot(); // open round 77: deadline 1000s, now 900s -> 01:40
    // The HUD owns the timer; the strip must not render a second one.
    expect(screen.getAllByText("01:40")).toHaveLength(1);
    // The strip dot+label is the only keeper-status surface (old KEEPER: line gone).
    expect(screen.getByText("LIVE")).toBeInTheDocument();
    expect(screen.queryByText(/^KEEPER:/)).toBeNull();
  });

  it("renders the terminal shell without the removed ambient layers", () => {
    const factory = (): KeeperClient => ({ start: () => {}, stop: () => {} });
    render(<PlayBoard wsUrl="ws://x" httpUrl="http://x" clientFactory={factory} />);
    expect(screen.getByTestId("terminal-shell")).toBeInTheDocument();
    expect(screen.queryByTestId("abstract-bg")).toBeNull();
  });

  it("limits the skeleton loading pulse to motion-safe environments", () => {
    const factory = (): KeeperClient => ({ start: () => {}, stop: () => {} });
    render(<PlayBoard wsUrl="ws://x" httpUrl="http://x" clientFactory={factory} />);
    const countdown = screen.getByText("--:--");
    expect(countdown).toHaveClass("motion-safe:animate-pulse");
    expect(countdown).not.toHaveClass("animate-pulse");
  });

  it("limits the keeper loading pulse to motion-safe environments", () => {
    let captured: KeeperClientOpts | null = null;
    const factory = (opts: KeeperClientOpts): KeeperClient => { captured = opts; return { start: () => {}, stop: () => {} }; };
    render(<PlayBoard wsUrl="ws://x" httpUrl="http://x" clientFactory={factory} />);
    act(() => { captured!.onSnapshot(wireSnap()); });
    const dot = screen.getByText("LINKING…").previousElementSibling;
    expect(dot).not.toBeNull();
    expect(dot!).toHaveClass("motion-safe:animate-pulse");
    expect(dot!).not.toHaveClass("animate-pulse");
  });

  it("uses a neutral dot while reconnecting", () => {
    let captured: KeeperClientOpts | null = null;
    const factory = (opts: KeeperClientOpts): KeeperClient => { captured = opts; return { start: () => {}, stop: () => {} }; };
    render(<PlayBoard wsUrl="ws://x" httpUrl="http://x" clientFactory={factory} />);
    act(() => { captured!.onSnapshot(wireSnap()); captured!.onStatus?.("disconnected"); });
    const dot = screen.getByText("RECONNECTING…").previousElementSibling;
    expect(dot).not.toBeNull();
    expect(dot!).toHaveClass("bg-bull-muted");
    expect(dot!).not.toHaveClass("bg-bull-gold");
  });
});
