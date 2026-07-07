import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ClaimPanel } from "./ClaimPanel.js";
import { RoundState } from "@ansem/sdk";

describe("ClaimPanel", () => {
  it("offers Claim for a Claimable round the player hasn't claimed", () => {
    const onClaim = vi.fn();
    render(<ClaimPanel roundId={7} roundState={RoundState.Claimable} lastClaimedRound={0} busy={false} onClaim={onClaim} onRefund={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /claim/i }));
    expect(onClaim).toHaveBeenCalledWith(7);
  });
  it("offers Refund for a Closed round", () => {
    const onRefund = vi.fn();
    render(<ClaimPanel roundId={7} roundState={RoundState.Closed} lastClaimedRound={0} busy={false} onClaim={vi.fn()} onRefund={onRefund} />);
    fireEvent.click(screen.getByRole("button", { name: /refund/i }));
    expect(onRefund).toHaveBeenCalledWith(7);
  });
  it("shows nothing actionable before Claimable", () => {
    render(<ClaimPanel roundId={7} roundState={RoundState.Open} lastClaimedRound={0} busy={false} onClaim={vi.fn()} onRefund={vi.fn()} />);
    expect(screen.queryByRole("button")).toBeNull();
  });
  it("shows nothing once the round is already claimed", () => {
    render(<ClaimPanel roundId={7} roundState={RoundState.Claimable} lastClaimedRound={7} busy={false} onClaim={vi.fn()} onRefund={vi.fn()} />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});
