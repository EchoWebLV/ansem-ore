import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, waitFor, fireEvent } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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

const globalCss = readFileSync(resolve(process.cwd(), "src/app/globals.css"), "utf8");

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
    expect(connecting.parentElement).toHaveTextContent(/^-- · CONNECTING$/);
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
    expect(screen.getByRole("heading", { name: "Verify on-chain" })).toBeInTheDocument();
  });

  it("hides the write column until a wallet + L1 program are present", () => {
    renderWithSnapshot(); // ctl.l1 = null, ctl.wallet = null
    expect(screen.queryByRole("button", { name: /place bet · one approval/i })).toBeNull();
  });

  it("shows the direct-stake write column (one-approval rail + wallet balance) once connected", async () => {
    ctl.l1 = {}; ctl.wallet = { publicKey: { toBase58: () => "Wallet1111" } };
    renderWithSnapshot();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /place bet · one approval/i })).toBeInTheDocument(),
    );
    expect(screen.getByLabelText("Betting and claims")).toBeInTheDocument();
    // No escrow lifecycle anywhere in direct mode.
    expect(screen.queryByText(/ESCROW/)).toBeNull();
    expect(screen.queryByRole("button", { name: /enter round/i })).toBeNull();
    // Wallet balance surfaces so unaffordable stakes are self-explanatory.
    await waitFor(() => expect(screen.getByText(/wallet balance/i)).toBeInTheDocument());
    expect(screen.getByText(/0\.0591.*SOL/i)).toBeInTheDocument();
  });

  it("keeps the replay button available after the next round opens (persistent replay)", () => {
    let captured: KeeperClientOpts | null = null;
    const factory = (opts: KeeperClientOpts): KeeperClient => { captured = opts; return { start: () => {}, stop: () => {} }; };
    render(<PlayBoard wsUrl="ws://x" httpUrl="http://x" nowMs={900_000} clientFactory={factory} />);
    act(() => {
      captured!.onStatus?.("connected");
      captured!.onSnapshot(wireSnap({ roundId: 77, state: RoundState.Claimable, jackpotSquare: 3 }));
    });
    // The next round opens — previously the button died right here.
    act(() => { captured!.onSnapshot(wireSnap({ roundId: 78, state: RoundState.Open })); });
    expect(screen.getByRole("button", { name: /replay reveal/i })).toHaveClass("min-h-11");
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

  it("keeps the three-column layout and gold flash at xl so 1024px remains single-column", () => {
    renderWithSnapshot();
    const layout = screen.getByTestId("terminal-layout");
    expect(layout.className).toContain("xl:grid-cols-");
    expect(layout.className).not.toContain("lg:grid-cols-");
    const board = screen.getByLabelText("Round board");
    expect(board).toHaveClass("xl:col-start-2", "xl:row-start-1", "xl:row-span-4");
    expect(board.className).not.toContain("lg:col-start");
  });

  it("restores safe-area-aware mobile shell padding", () => {
    const factory = (): KeeperClient => ({ start: () => {}, stop: () => {} });
    render(<PlayBoard wsUrl="ws://x" httpUrl="http://x" clientFactory={factory} />);
    expect(screen.getByTestId("terminal-shell")).toHaveClass("terminal-shell-safe");
  });

  it("keeps a persistent board footer with selection legend and internal Verify link", () => {
    renderWithSnapshot();
    expect(screen.getByTestId("board-footer")).toBeInTheDocument();
    expect(screen.getByText("Selected")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /verify/i })).toHaveAttribute("href", "#verify");
    expect(document.querySelector("#verify")).toBeInTheDocument();
  });

  it("threads chip removal back to the board and removes exactly that selected tile", async () => {
    ctl.l1 = {}; ctl.wallet = { publicKey: { toBase58: () => "Wallet1111" } };
    renderWithSnapshot();
    fireEvent.click(screen.getByTestId("tile-4"));
    const remove = await screen.findByRole("button", { name: /remove tile #05/i });
    expect(screen.getByTestId("tile-4")).toHaveAttribute("data-selected", "true");
    fireEvent.click(remove);
    expect(screen.queryByRole("button", { name: /remove tile #05/i })).toBeNull();
    expect(screen.getByTestId("tile-4")).toHaveAttribute("data-selected", "false");
  });

  it("disables ordinary tile transitions for reduced motion", () => {
    const reducedMotion = globalCss.match(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
    expect(reducedMotion).toContain(".cell-face");
    expect(reducedMotion).toContain("transition: none !important");
  });

  it("keeps safe-area, wallet target and declared font contracts in global CSS", () => {
    expect(globalCss).toMatch(/\.terminal-shell-safe[\s\S]*env\(safe-area-inset-bottom\)/);
    expect(globalCss).toMatch(/\.wallet-adapter-button[\s\S]*height: 44px !important/);
    expect(globalCss).toMatch(/\.wallet-adapter-button[\s\S]*white-space: nowrap/);
    expect(globalCss).not.toMatch(/font-family:\s*Inter/);
    expect(globalCss).toMatch(/font-family:\s*ui-sans-serif/);
  });

  it("scopes narrow-screen wallet truncation to the header trigger, never modal wallet rows", () => {
    const narrowWalletCss = globalCss.match(/@media \(max-width: 359px\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
    expect(narrowWalletCss).toContain(".terminal-topbar .wallet-adapter-button-trigger");
    expect(narrowWalletCss).not.toMatch(/^\s*\.wallet-adapter-button\s*[,\{]/m);
    expect(narrowWalletCss).not.toMatch(/^\s*\.wallet-adapter-button-trigger\s*[,\{]/m);
    expect(narrowWalletCss).not.toContain(".wallet-adapter-modal-list .wallet-adapter-button");
  });
});
