import { describe, it, expect, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import type { Program } from "@coral-xyz/anchor";
import type { AnsemMiner, BeefConfigState } from "@ansem/sdk";
import { useBeefConfig } from "./use-beef-config.js";

const l1 = {} as Program<AnsemMiner>; // stable reference (probe injected — l1 is unused)
const cfg = { beefMint: "M", beefVault: "V" } as unknown as BeefConfigState;

describe("useBeefConfig (the single BEEF gate)", () => {
  it("stays null while BEEF is uninitialized (probe resolves null) — chip + bundles stay pre-BEEF", async () => {
    const probe = vi.fn(async () => null);
    const { result } = renderHook(() => useBeefConfig(l1, { probe, pollMs: 10 }));
    expect(result.current).toBeNull();
    await waitFor(() => expect(probe).toHaveBeenCalled());
    expect(result.current).toBeNull();
  });

  it("resolves to the on-chain BeefConfig once present, then stops probing (permanent)", async () => {
    const probe = vi.fn(async () => cfg);
    const { result } = renderHook(() => useBeefConfig(l1, { probe, pollMs: 10 }));
    await waitFor(() => expect(result.current).toBe(cfg));
    const seen = probe.mock.calls.length;
    await new Promise((r) => setTimeout(r, 45)); // several poll intervals
    expect(probe.mock.calls.length).toBe(seen); // no more reads after it is found
  });

  it("never throws when disconnected (no program, no probe) — returns null", () => {
    const { result } = renderHook(() => useBeefConfig(undefined));
    expect(result.current).toBeNull();
  });
});
