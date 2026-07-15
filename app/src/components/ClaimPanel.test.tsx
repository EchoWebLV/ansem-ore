import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ClaimPanel } from "./ClaimPanel.js";
import { RoundState } from "@ansem/sdk";

describe("ClaimPanel", () => {
  it("offers Resolve for a Claimable round whose outcome is unknown", () => {
    const onClaim = vi.fn();
    render(<ClaimPanel roundId={7} roundState={RoundState.Claimable} lastClaimedRound={0} busy={false} onClaim={onClaim} onRefund={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /resolve round/i }));
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

  it("shows the CLAIM BY countdown alongside the Claim button when a deadline is set", () => {
    // claimByTs 90_000s, now 86_400s -> 3_600s left = 01:00:00.
    render(<ClaimPanel roundId={7} roundState={RoundState.Claimable} lastClaimedRound={0} busy={false}
      onClaim={vi.fn()} onRefund={vi.fn()} claimByTs={90_000} nowMs={86_400_000} />);
    expect(screen.getByText("CLAIM BY 01:00:00")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /resolve round/i })).toBeInTheDocument();
  });

  it("keeps the claim deadline neutral when a settled round has no win", () => {
    render(<ClaimPanel roundId={7} roundState={RoundState.Claimable} lastClaimedRound={0} busy={false}
      won={false} onClaim={vi.fn()} onRefund={vi.fn()} claimByTs={90_000} nowMs={86_400_000} />);
    const deadline = screen.getByText("CLAIM BY 01:00:00");
    expect(deadline).toHaveClass("text-bull-muted");
    expect(deadline).not.toHaveClass("text-bull-gold/80");
  });

  it("keeps the claim deadline neutral while the outcome is unresolved", () => {
    render(<ClaimPanel roundId={7} roundState={RoundState.Claimable} lastClaimedRound={0} busy={false}
      won={null} onClaim={vi.fn()} onRefund={vi.fn()} claimByTs={90_000} nowMs={86_400_000} />);
    const deadline = screen.getByText("CLAIM BY 01:00:00");
    expect(deadline).toHaveClass("text-bull-muted");
    expect(deadline).not.toHaveClass("text-bull-gold/80");
  });

  it("uses a gold claim deadline only for a proven win", () => {
    render(<ClaimPanel roundId={7} roundState={RoundState.Claimable} lastClaimedRound={0} busy={false}
      won={true} onClaim={vi.fn()} onRefund={vi.fn()} claimByTs={90_000} nowMs={86_400_000} />);
    const deadline = screen.getByText("CLAIM BY 01:00:00");
    expect(deadline).toHaveClass("text-bull-gold/80");
    expect(deadline).not.toHaveClass("text-bull-muted");
  });

  it("hides the countdown once the claim window has expired (button remains until the round is reaped)", () => {
    render(<ClaimPanel roundId={7} roundState={RoundState.Claimable} lastClaimedRound={0} busy={false}
      onClaim={vi.fn()} onRefund={vi.fn()} claimByTs={1_000} nowMs={2_000_000} />);
    expect(screen.queryByText(/CLAIM BY/)).toBeNull();
    expect(screen.getByRole("button", { name: /resolve round/i })).toBeInTheDocument();
  });

  it("omits the countdown when no claim-by deadline is provided", () => {
    render(<ClaimPanel roundId={7} roundState={RoundState.Claimable} lastClaimedRound={0} busy={false}
      onClaim={vi.fn()} onRefund={vi.fn()} />);
    expect(screen.queryByText(/CLAIM BY/)).toBeNull();
  });

  it("won: labels a real win WON with the gold Claim ANSEM button", () => {
    const onClaim = vi.fn();
    render(<ClaimPanel roundId={7} roundState={RoundState.Claimable} lastClaimedRound={0} busy={false}
      won={true} onClaim={onClaim} onRefund={vi.fn()} />);
    expect(screen.getByText(/· WON/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /claim ansem/i }));
    expect(onClaim).toHaveBeenCalledWith(7);
  });

  it("no-win: reads as NO WIN and the button just clears the round (same claim ix)", () => {
    const onClaim = vi.fn();
    render(<ClaimPanel roundId={7} roundState={RoundState.Claimable} lastClaimedRound={0} busy={false}
      won={false} onClaim={onClaim} onRefund={vi.fn()} />);
    expect(screen.getByText(/NO WIN/)).toBeInTheDocument();
    expect(screen.getByText(/pot rolled to the jackpot/)).toBeInTheDocument();
    expect(screen.queryByText(/· WON/)).toBeNull();
    expect(screen.queryByRole("button", { name: /claim ansem/i })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /clear round/i }));
    expect(onClaim).toHaveBeenCalledWith(7); // identical ix — clears the miner ledger
  });

  it("unknown outcome stays neutral (SETTLED) — never flashes WON before it knows", () => {
    const onClaim = vi.fn();
    render(<ClaimPanel roundId={7} roundState={RoundState.Claimable} lastClaimedRound={0} busy={false}
      won={null} onClaim={onClaim} onRefund={vi.fn()} />);
    expect(screen.getByText(/· SETTLED/)).toBeInTheDocument();
    expect(screen.queryByText(/· WON/)).toBeNull();
    expect(screen.queryByRole("button", { name: /claim ansem/i })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /resolve round/i }));
    expect(onClaim).toHaveBeenCalledWith(7);
  });

  it("gives claim, clear, resolve and refund actions a 44px minimum target", () => {
    const common = { roundId: 7, lastClaimedRound: 0, busy: false, onClaim: vi.fn(), onRefund: vi.fn() };
    const { rerender } = render(<ClaimPanel {...common} roundState={RoundState.Claimable} won />);
    expect(screen.getByRole("button", { name: /claim ansem/i })).toHaveClass("min-h-11");
    rerender(<ClaimPanel {...common} roundState={RoundState.Claimable} won={false} />);
    expect(screen.getByRole("button", { name: /clear round/i })).toHaveClass("min-h-11");
    rerender(<ClaimPanel {...common} roundState={RoundState.Claimable} won={null} />);
    expect(screen.getByRole("button", { name: /resolve round/i })).toHaveClass("min-h-11");
    rerender(<ClaimPanel {...common} roundState={RoundState.Closed} />);
    expect(screen.getByRole("button", { name: /refund/i })).toHaveClass("min-h-11");
  });

  it("a Closed round still refunds and reads VOIDED regardless of won", () => {
    const onRefund = vi.fn();
    render(<ClaimPanel roundId={7} roundState={RoundState.Closed} lastClaimedRound={0} busy={false}
      won={false} onClaim={vi.fn()} onRefund={onRefund} />);
    expect(screen.getByText(/· VOIDED/)).toBeInTheDocument();
    expect(screen.queryByText(/NO WIN/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /refund/i }));
    expect(onRefund).toHaveBeenCalledWith(7);
  });

  it("gateNote: renders the folded-in gate message under the label (panel took the bet-slip slot)", () => {
    render(<ClaimPanel roundId={7} roundState={RoundState.Claimable} lastClaimedRound={0} busy={false}
      won={false} gateNote="clear to bet the next round" onClaim={vi.fn()} onRefund={vi.fn()} />);
    expect(screen.getByText("clear to bet the next round")).toBeInTheDocument();
    // still the honest no-win labeling — the note never fabricates a win
    expect(screen.getByText(/NO WIN/)).toBeInTheDocument();
  });

  it("omits the gate note when none is provided (default) — a bare panel stays bare", () => {
    render(<ClaimPanel roundId={7} roundState={RoundState.Claimable} lastClaimedRound={0} busy={false}
      won={false} onClaim={vi.fn()} onRefund={vi.fn()} />);
    expect(screen.queryByText(/to bet the next round/i)).toBeNull();
  });

  it("beefBanked: shows the terse BEEF-bank sub-line under the claim action, muted (never gold)", () => {
    render(<ClaimPanel roundId={7} roundState={RoundState.Claimable} lastClaimedRound={0} busy={false}
      won={true} beefBanked onClaim={vi.fn()} onRefund={vi.fn()} />);
    const line = screen.getByText("beef share banked · bonus keeps growing");
    expect(line).toBeInTheDocument();
    expect(line).toHaveClass("text-bull-muted"); // D12: muted, not gold
    expect(line.className).not.toMatch(/bull-gold/);
  });

  it("omits the BEEF-bank line when beefBanked is absent (default) — never fabricated pre-BEEF", () => {
    render(<ClaimPanel roundId={7} roundState={RoundState.Claimable} lastClaimedRound={0} busy={false}
      won={true} onClaim={vi.fn()} onRefund={vi.fn()} />);
    expect(screen.queryByText(/beef share banked/i)).toBeNull();
  });

  it("never shows the BEEF-bank line on a refund (Closed) — refunds don't roll BEEF", () => {
    render(<ClaimPanel roundId={7} roundState={RoundState.Closed} lastClaimedRound={0} busy={false}
      beefBanked onClaim={vi.fn()} onRefund={vi.fn()} />);
    expect(screen.queryByText(/beef share banked/i)).toBeNull();
    expect(screen.getByRole("button", { name: /refund/i })).toBeInTheDocument();
  });
});
