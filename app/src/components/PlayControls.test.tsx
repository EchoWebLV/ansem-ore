import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { RoundState, type WireSnapshot } from "@ansem/sdk";
import type { Program } from "@coral-xyz/anchor";
import type { AnsemMiner } from "@ansem/sdk";
import type { WalletAdapter } from "../lib/writes.js";

vi.mock("@ansem/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ansem/sdk")>();
  return {
    ...actual,
    roundPda: vi.fn(() => ({})),
    fetchRound: vi.fn(() => new Promise(() => {})),
  };
});

// The exact live-play failure this file guards: a 59_102_330-lamport wallet firing a
// 100_000_000-lamport bet. The old escrow deposit sent that on-chain and died in
// simulation ("Transfer: insufficient lamports 59102330, need 100000000"). Direct
// mode must kill it CLIENT-SIDE: human message, no transaction ever built.
vi.mock("../lib/writes.js", () => ({ directStake: vi.fn(async () => "SIGDIRECT") }));
vi.mock("@solana/wallet-adapter-react", () => ({
  useConnection: () => ({ connection: { getBalance: async () => 59_102_330 } }),
}));
const player = vi.hoisted(() => ({
  miner: null as null | { roundId: number; blockStake: bigint[] },
  config: null as null | { multMaxBps: number },
  loaded: true,
}));
vi.mock("../hooks/use-player-state.js", () => ({
  usePlayerState: () => ({ ...player, refresh: () => {} }),
}));

import { PlayControls } from "./PlayControls.js";
import { directStake } from "../lib/writes.js";

const snap = (over: Partial<WireSnapshot> = {}): WireSnapshot => ({
  roundId: 77, state: RoundState.Open, deadlineTs: 0, pot: "0",
  blockSol: Array(25).fill("0"), jackpotSquare: null, jackpotPool: "0",
  rolloverJackpot: "0", updatedAt: 1, leaderboard: [], recentEvents: [], ...over,
});

const renderControls = (selected: number[]) =>
  render(
    <PlayControls
      l1={{} as Program<AnsemMiner>}
      wallet={{ publicKey: { toBase58: () => "Wallet1111" } } as unknown as WalletAdapter}
      snapshot={snap()}
      selectedSquares={selected}
    />,
  );

describe("PlayControls (direct mode) — wallet-balance stake gate", () => {
  beforeEach(() => {
    vi.mocked(directStake).mockClear();
    player.miner = null;
    player.config = null;
    player.loaded = true;
  });

  it("blocks the goal scenario client-side: 0.1 SOL bet on a 0.0591 wallet never builds a tx", async () => {
    renderControls([4, 17]); // 2 tiles × 0.05 = the exact 100_000_000 lamports
    await waitFor(() => expect(screen.getByText(/wallet balance/i)).toBeInTheDocument());
    expect(screen.getByText(/0\.0591.*SOL/i)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/amount per tile/i), { target: { value: "0.05" } });
    fireEvent.click(screen.getByRole("button", { name: /place bet · one approval/i }));
    await waitFor(() =>
      expect(screen.getByText(/more than your wallet holds/i)).toBeInTheDocument(),
    );
    expect(directStake).not.toHaveBeenCalled(); // nothing reached the RPC — no simulation to fail
  });

  it("lets an affordable bet through to directStake with the picked squares", async () => {
    renderControls([4, 17]);
    await waitFor(() => expect(screen.getByText(/wallet balance/i)).toBeInTheDocument());
    expect(screen.getByText(/0\.0591.*SOL/i)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/amount per tile/i), { target: { value: "0.01" } });
    fireEvent.click(screen.getByRole("button", { name: /place bet · one approval/i }));
    await waitFor(() => expect(directStake).toHaveBeenCalledTimes(1));
    expect(vi.mocked(directStake).mock.calls[0][0].squares).toEqual([4, 17]);
    expect(screen.queryByText(/more than your wallet holds/i)).toBeNull();
  });

  it("uses Resolve round gate copy while a prior-round outcome is unknown", async () => {
    player.miner = { roundId: 6, blockStake: [1n, ...Array<bigint>(24).fill(0n)] };
    player.config = { multMaxBps: 0 };
    renderControls([4]);
    await waitFor(() => expect(screen.getByText(/wallet balance/i)).toBeInTheDocument());
    expect(screen.getByText("Resolve round 6 below first to stake again.")).toBeInTheDocument();
    expect(screen.queryByText(/Claim round 6 below first/i)).toBeNull();
  });

  it("shows the existing 0.005 SOL network-fee reserve in the bet slip", async () => {
    renderControls([4]);
    await waitFor(() => expect(screen.getByText(/wallet balance/i)).toBeInTheDocument());
    expect(screen.getByText("0.005 SOL reserved for network fees")).toBeInTheDocument();
  });
});
