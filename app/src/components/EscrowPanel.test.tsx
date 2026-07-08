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
  it("blocks Withdraw on an empty escrow (the account doesn't exist before the first deposit)", () => {
    const onWithdraw = vi.fn();
    render(<EscrowPanel balanceLamports={0n} locked={false} onDeposit={vi.fn()} onWithdraw={onWithdraw} busy={false} />);
    fireEvent.change(screen.getByPlaceholderText(/amount/i), { target: { value: "1" } });
    expect(screen.getByRole("button", { name: /withdraw/i })).toBeDisabled();
    expect(screen.getByText(/nothing in escrow to withdraw yet/i)).toBeInTheDocument();
  });
  it("blocks Withdraw beyond the escrow balance but allows one within it", () => {
    const onWithdraw = vi.fn();
    render(<EscrowPanel balanceLamports={50_000_000n} locked={false} onDeposit={vi.fn()} onWithdraw={onWithdraw} busy={false} />);
    fireEvent.change(screen.getByPlaceholderText(/amount/i), { target: { value: "0.06" } });
    expect(screen.getByRole("button", { name: /withdraw/i })).toBeDisabled();
    expect(screen.getByText(/more than your escrow holds/i)).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText(/amount/i), { target: { value: "0.05" } });
    fireEvent.click(screen.getByRole("button", { name: /withdraw/i }));
    expect(onWithdraw).toHaveBeenCalledTimes(1);
  });

  it("shows the wallet balance and blocks a deposit larger than the wallet holds", () => {
    const onDeposit = vi.fn();
    render(<EscrowPanel balanceLamports={0n} walletLamports={59_102_330n} locked={false} onDeposit={onDeposit} onWithdraw={vi.fn()} busy={false} />);
    expect(screen.getByText(/wallet 0\.0591/i)).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText(/amount/i), { target: { value: "0.1" } });
    expect(screen.getByRole("button", { name: /deposit/i })).toBeDisabled();
    expect(screen.getByText(/more than your wallet holds/i)).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText(/amount/i), { target: { value: "0.03" } });
    fireEvent.click(screen.getByRole("button", { name: /deposit/i }));
    expect(onDeposit).toHaveBeenCalledTimes(1);
  });
});
