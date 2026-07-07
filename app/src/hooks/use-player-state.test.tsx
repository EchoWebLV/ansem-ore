import { describe, it, expect } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { Keypair } from "@solana/web3.js";
import { usePlayerState } from "./use-player-state.js";

describe("usePlayerState", () => {
  it("loads escrow + miner + config via injected fetchers", async () => {
    const wallet = Keypair.generate().publicKey;
    const fakeProgram = {} as any;
    const fetchers = {
      escrow: async () => ({ authority: wallet.toBase58(), balance: 50_000_000n, depositedTotal: 50_000_000n, withdrawnTotal: 0n, lastClaimedRound: 0, activeRound: 7, reconciledRound: 0 }),
      miner: async () => ({ authority: wallet.toBase58(), roundId: 7, blockStake: Array(25).fill(0n) }),
      config: async () => ({ currentRoundId: 7, currentRoundFinalized: false, minStake: 1000n, maxStakePerRound: 10n ** 12n } as any),
    };
    const { result } = renderHook(() => usePlayerState({ program: fakeProgram, wallet, pollMs: 0, fetchers }));
    await waitFor(() => expect(result.current.escrow?.activeRound).toBe(7));
    expect(result.current.miner?.roundId).toBe(7);
    expect(result.current.config?.currentRoundId).toBe(7);
  });
});
