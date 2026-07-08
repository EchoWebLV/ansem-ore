import { describe, it, expect } from "vitest";
import { RoundState } from "@ansem/sdk";
import { enterWouldForfeit } from "./claim-gate.js";

// Entering a new round (a) reverts if escrow.active_round != 0 (RoundAlreadyJoined), and
// (b) re-stamps miner.round_id, clobbering the reference BOTH claim (claim.rs) and refund's
// reconciled-credit branch (recovery.rs) key on. The gate must be CONSERVATIVE: block on any
// unresolved prior round unless we can PROVE nothing is at stake — otherwise a lagging/
// unknown round-state (the 5s poll trailing Settled->Claimable, or the initial null) opens a
// silent-forfeiture window. It must still never permanently trap a player.
describe("enterWouldForfeit", () => {
  const S = (o: Partial<Parameters<typeof enterWouldForfeit>[0]> = {}) => ({
    activeRound: 0, stakedRound: 5, lastClaimedRound: 0, reconciledRound: 0,
    stakedRoundState: RoundState.Claimable, ...o,
  });

  it("blocks while escrow is still locked to a prior round (join_round would revert)", () => {
    expect(enterWouldForfeit(S({ activeRound: 4, stakedRound: 0, stakedRoundState: null }))).toBe(true);
  });

  it("blocks a claimable-but-unclaimed payout (winner forfeiture)", () => {
    expect(enterWouldForfeit(S({ stakedRoundState: RoundState.Claimable }))).toBe(true);
  });

  it("blocks CONSERVATIVELY while the staked-round state is still unknown/loading (null)", () => {
    expect(enterWouldForfeit(S({ stakedRoundState: null }))).toBe(true);
  });

  it("blocks while the staked round is still settling (Settled / VrfPending) — it will become Claimable", () => {
    expect(enterWouldForfeit(S({ stakedRoundState: RoundState.Settled }))).toBe(true);
    expect(enterWouldForfeit(S({ stakedRoundState: RoundState.VrfPending }))).toBe(true);
  });

  it("blocks a reconciled stake awaiting its Closed-round refund credit", () => {
    expect(enterWouldForfeit(S({ stakedRoundState: RoundState.Closed, reconciledRound: 5 }))).toBe(true);
  });

  it("allows once the claimable round has been claimed", () => {
    expect(enterWouldForfeit(S({ lastClaimedRound: 5, stakedRoundState: RoundState.Claimable }))).toBe(false);
  });

  it("allows a join-without-stake player whose round was cancelled and lock already released (nothing keyed on miner.round_id)", () => {
    expect(enterWouldForfeit(S({ activeRound: 0, stakedRoundState: RoundState.Closed, reconciledRound: 0 }))).toBe(false);
  });

  it("allows a fresh player with no staked round and no lock", () => {
    expect(enterWouldForfeit(S({ activeRound: 0, stakedRound: 0, stakedRoundState: null }))).toBe(false);
  });
});
