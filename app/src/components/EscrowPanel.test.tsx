import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { EscrowPanel } from "./EscrowPanel.js";

describe("EscrowPanel", () => {
  it("shows the escrow balance in SOL", () => {
    render(<EscrowPanel balanceLamports={50_000_000n} locked={false} onDeposit={vi.fn()} onWithdraw={vi.fn()} busy={false} />);
    expect(screen.getByText(/0\.05/)).toBeInTheDocument();
  });
  it("calls onDeposit with a parsed BN when Deposit is clicked", () => {
    const onDeposit = vi.fn();
    render(<EscrowPanel balanceLamports={0n} locked={false} onDeposit={onDeposit} onWithdraw={vi.fn()} busy={false} />);
    fireEvent.change(screen.getByPlaceholderText(/amount/i), { target: { value: "0.1" } });
    fireEvent.click(screen.getByRole("button", { name: /deposit/i }));
    expect(onDeposit).toHaveBeenCalledTimes(1);
    expect(onDeposit.mock.calls[0][0].toString()).toBe("100000000");
  });
  it("disables Withdraw while the escrow is round-locked", () => {
    render(<EscrowPanel balanceLamports={50_000_000n} locked onDeposit={vi.fn()} onWithdraw={vi.fn()} busy={false} />);
    expect(screen.getByRole("button", { name: /withdraw/i })).toBeDisabled();
  });
});
