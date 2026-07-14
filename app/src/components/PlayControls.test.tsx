import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { RoundState, fetchRound, type WireSnapshot } from "@ansem/sdk";
import type { Program } from "@coral-xyz/anchor";
import type { AnsemMiner } from "@ansem/sdk";
import type { WalletAdapter } from "../lib/writes.js";

vi.mock("@ansem/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ansem/sdk")>();
  return {
    ...actual,
    roundPda: vi.fn(() => ({})),
    beefRoundPda: vi.fn(() => ({})),
    fetchRound: vi.fn(() => new Promise(() => {})),
  };
});

// The exact live-play failure this file guards: a 59_102_330-lamport wallet firing a
// 100_000_000-lamport bet. The old escrow deposit sent that on-chain and died in
// simulation ("Transfer: insufficient lamports 59102330, need 100000000"). Direct
// mode must kill it CLIENT-SIDE: human message, no transaction ever built.
vi.mock("../lib/writes.js", () => ({
  directStake: vi.fn(async () => "SIGDIRECT"),
  claimRound: vi.fn(async () => "SIGCLAIM"),
}));
const beef = vi.hoisted(() => ({ accountExists: vi.fn(async () => true) }));
vi.mock("../lib/beef.js", () => ({ accountExists: beef.accountExists }));
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

// A resolved staked-round account for the fetchRound poll. Defaults describe a real WON
// draw (someone hit square 0, pool > 0) so the panel labels honestly; override per test.
const round = (over: Partial<{ state: RoundState; deadlineTs: number; jackpotSquare: number | null; jackpotPool: bigint }> = {}) =>
  ({ state: RoundState.Claimable, deadlineTs: 0, jackpotSquare: 0, jackpotPool: 10n, ...over } as Awaited<ReturnType<typeof fetchRound>>);

const renderControls = (selected: number[], beefLive?: boolean) =>
  render(
    <PlayControls
      l1={{} as Program<AnsemMiner>}
      wallet={{ publicKey: { toBase58: () => "Wallet1111" } } as unknown as WalletAdapter}
      snapshot={snap()}
      selectedSquares={selected}
      beefLive={beefLive}
    />,
  );

describe("PlayControls (direct mode) — wallet-balance stake gate", () => {
  beforeEach(() => {
    vi.mocked(directStake).mockClear();
    beef.accountExists.mockClear();
    beef.accountExists.mockResolvedValue(true);
    // Default the staked-round poll back to pending (never resolves) so a test only sees
    // a live ClaimPanel when it opts in with mockResolvedValue.
    vi.mocked(fetchRound).mockReset();
    vi.mocked(fetchRound).mockReturnValue(new Promise<never>(() => {}));
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

  it("pre-BEEF (beefLive unset): the stake stays the exact single-tx bundle — no rollBeef requested, BEEF never probed", async () => {
    renderControls([4]);
    await waitFor(() => expect(screen.getByText(/wallet balance/i)).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText(/amount per tile/i), { target: { value: "0.01" } });
    fireEvent.click(screen.getByRole("button", { name: /place bet · one approval/i }));
    await waitFor(() => expect(directStake).toHaveBeenCalledTimes(1));
    expect(vi.mocked(directStake).mock.calls[0][0].rollBeefRound).toBeNull();
    expect(beef.accountExists).not.toHaveBeenCalled(); // the BEEF path is never touched pre-launch
  });

  it("BEEF-live: staking a new round prepends rollBeef(priorStampedRound) so the un-rolled share survives", async () => {
    // prior round 6, already cleared (blockStake all zero) -> staking the new round is allowed
    player.miner = { roundId: 6, blockStake: Array<bigint>(25).fill(0n) };
    player.config = { multMaxBps: 0 };
    renderControls([4, 17], true);
    await waitFor(() => expect(screen.getByText(/wallet balance/i)).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText(/amount per tile/i), { target: { value: "0.01" } });
    fireEvent.click(screen.getByRole("button", { name: /place bet · one approval/i }));
    await waitFor(() => expect(directStake).toHaveBeenCalledTimes(1));
    expect(vi.mocked(directStake).mock.calls[0][0].rollBeefRound).toBe(6); // roll the prior round FIRST
    expect(vi.mocked(directStake).mock.calls[0][0].squares).toEqual([4, 17]);
  });

  it("BEEF-live but the prior round was never stamped: no roll — BEEF never blocks the stake", async () => {
    beef.accountExists.mockResolvedValue(false); // BeefRound(prior) absent -> a roll would abort the tx
    player.miner = { roundId: 6, blockStake: Array<bigint>(25).fill(0n) };
    player.config = { multMaxBps: 0 };
    renderControls([4], true);
    await waitFor(() => expect(screen.getByText(/wallet balance/i)).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText(/amount per tile/i), { target: { value: "0.01" } });
    fireEvent.click(screen.getByRole("button", { name: /place bet · one approval/i }));
    await waitFor(() => expect(directStake).toHaveBeenCalledTimes(1));
    expect(vi.mocked(directStake).mock.calls[0][0].rollBeefRound).toBeNull();
  });

  // --- claim panel takes the bet-slip slot -------------------------------------------
  it("claim pending: the ClaimPanel takes the bet-slip slot — the slip and the amber gate both vanish", async () => {
    // prior round 6 drew a real win (pot > 0 on the player's square) and is Claimable now
    vi.mocked(fetchRound).mockResolvedValue(round({ state: RoundState.Claimable, jackpotSquare: 0, jackpotPool: 10n }));
    player.miner = { roundId: 6, blockStake: [1n, ...Array<bigint>(24).fill(0n)] };
    player.config = { multMaxBps: 0 };
    renderControls([4]);
    await waitFor(() => expect(screen.getByRole("button", { name: /claim ansem/i })).toBeInTheDocument());
    expect(screen.getByText(/· WON/)).toBeInTheDocument();          // honest win labeling survives
    expect(screen.getByText("claim to bet the next round")).toBeInTheDocument(); // gate folded into the panel
    // the bet slip is gone — one action surface at a time
    expect(screen.queryByLabelText(/amount per tile/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /place bet · one approval/i })).toBeNull();
    expect(screen.queryByText(/Bet slip/i)).toBeNull();
    // and the standalone amber "…below first" hint is not shown alongside
    expect(screen.queryByText(/below first/i)).toBeNull();
  });

  it("refund pending: a Closed prior round shows the Refund panel in the slot, not the slip", async () => {
    vi.mocked(fetchRound).mockResolvedValue(round({ state: RoundState.Closed, jackpotSquare: null, jackpotPool: 0n }));
    player.miner = { roundId: 6, blockStake: [1n, ...Array<bigint>(24).fill(0n)] };
    player.config = { multMaxBps: 0 };
    renderControls([4]);
    await waitFor(() => expect(screen.getByRole("button", { name: /refund/i })).toBeInTheDocument());
    expect(screen.getByText(/· VOIDED/)).toBeInTheDocument();
    expect(screen.getByText("refund to bet the next round")).toBeInTheDocument();
    expect(screen.queryByLabelText(/amount per tile/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /place bet · one approval/i })).toBeNull();
  });

  it("offerable but still settling (VrfPending): the bet slip stays — no claim/refund surface yet", async () => {
    vi.mocked(fetchRound).mockResolvedValue(round({ state: RoundState.VrfPending, jackpotSquare: null, jackpotPool: 0n }));
    player.miner = { roundId: 6, blockStake: [1n, ...Array<bigint>(24).fill(0n)] };
    player.config = { multMaxBps: 0 };
    renderControls([4]);
    await waitFor(() => expect(screen.getByText(/wallet balance/i)).toBeInTheDocument());
    // slip present; still-settling rounds keep the existing gate copy, no action surface
    expect(screen.getByLabelText(/amount per tile/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /claim ansem|clear round|resolve round|refund/i })).toBeNull();
  });

  // --- beefBanked wiring -------------------------------------------------------------
  it("BEEF-live + this round's BeefRound exists: the claim panel notes the BEEF share is banked", async () => {
    beef.accountExists.mockResolvedValue(true); // BeefRound(stakedRound) present -> claim bundles rollBeef
    vi.mocked(fetchRound).mockResolvedValue(round({ state: RoundState.Claimable, jackpotSquare: 0, jackpotPool: 10n }));
    player.miner = { roundId: 6, blockStake: [1n, ...Array<bigint>(24).fill(0n)] };
    player.config = { multMaxBps: 0 };
    renderControls([4], true);
    await waitFor(() => expect(screen.getByText("beef share banked · bonus keeps growing")).toBeInTheDocument());
  });

  it("pre-BEEF (beefLive unset): the claim panel never notes a BEEF bank, even when Claimable", async () => {
    vi.mocked(fetchRound).mockResolvedValue(round({ state: RoundState.Claimable, jackpotSquare: 0, jackpotPool: 10n }));
    player.miner = { roundId: 6, blockStake: [1n, ...Array<bigint>(24).fill(0n)] };
    player.config = { multMaxBps: 0 };
    renderControls([4]); // beefLive unset
    await waitFor(() => expect(screen.getByRole("button", { name: /claim ansem/i })).toBeInTheDocument());
    expect(screen.queryByText(/beef share banked/i)).toBeNull();
    expect(beef.accountExists).not.toHaveBeenCalled(); // the BEEF probe never runs pre-launch
  });

  it("BEEF-live but this round's BeefRound probe is absent: no BEEF-bank note (never fabricated)", async () => {
    beef.accountExists.mockResolvedValue(false); // probe returns false -> claim degrades to the plain ix
    vi.mocked(fetchRound).mockResolvedValue(round({ state: RoundState.Claimable, jackpotSquare: 0, jackpotPool: 10n }));
    player.miner = { roundId: 6, blockStake: [1n, ...Array<bigint>(24).fill(0n)] };
    player.config = { multMaxBps: 0 };
    renderControls([4], true);
    await waitFor(() => expect(screen.getByRole("button", { name: /claim ansem/i })).toBeInTheDocument());
    expect(screen.queryByText(/beef share banked/i)).toBeNull();
  });
});
