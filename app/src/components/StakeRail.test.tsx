import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { StakeRail } from "./StakeRail.js";

describe("StakeRail (direct-stake)", () => {
  it("disables Stake until squares are selected and a valid amount is entered; stakes the amount on EACH selected square", () => {
    const onStake = vi.fn();
    const { rerender } = render(<StakeRail selectedSquares={[]} enabled busy={false} onStake={onStake} />);
    expect(screen.getByRole("button", { name: /place bet · one approval/i })).toBeDisabled();
    rerender(<StakeRail selectedSquares={[4, 9]} enabled busy={false} onStake={onStake} />);
    fireEvent.change(screen.getByLabelText(/amount per tile/i), { target: { value: "0.02" } });
    expect(screen.getByText(/0.04 SOL total/i)).toBeInTheDocument();
    const btn = screen.getByRole("button", { name: /place bet · one approval/i });
    expect(btn).not.toBeDisabled();
    fireEvent.click(btn);
    expect(onStake).toHaveBeenCalledWith([4, 9], expect.anything());
    expect(onStake.mock.calls[0][1].toString()).toBe("20000000"); // per-square lamports
  });

  it("shows the tile count and the per-square total for a multi-selection", () => {
    render(<StakeRail selectedSquares={[1, 2, 3]} enabled busy={false} onStake={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/amount per tile/i), { target: { value: "0.02" } });
    expect(screen.getByText(/3 tiles/i)).toBeInTheDocument();
    expect(screen.getByText(/0.06 SOL total/i)).toBeInTheDocument();
  });

  it("stays disabled while the rail is not enabled (round settling / unresolved prior round)", () => {
    render(<StakeRail selectedSquares={[4]} enabled={false} busy={false} onStake={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/amount per tile/i), { target: { value: "0.02" } });
    expect(screen.getByRole("button", { name: /place bet · one approval/i })).toBeDisabled();
  });

  it("shows the empty-state hint only when nothing is selected (the board itself shows the selection)", () => {
    const { rerender } = render(<StakeRail selectedSquares={[]} enabled busy={false} onStake={vi.fn()} />);
    expect(screen.getByText(/select tiles on the board/i)).toBeInTheDocument();
    rerender(<StakeRail selectedSquares={[4, 9]} enabled busy={false} onStake={vi.fn()} />);
    expect(screen.queryByText(/select tiles on the board/i)).not.toBeInTheDocument();
  });

  it("sets the existing amount input from 44px quick amount actions", () => {
    render(<StakeRail selectedSquares={[4]} enabled busy={false} onStake={vi.fn()} />);
    const quickAmount = screen.getByRole("button", { name: /set amount to 0\.05 sol/i });
    expect(quickAmount).toHaveClass("min-h-11");
    fireEvent.click(quickAmount);
    expect(screen.getByLabelText(/amount per tile/i)).toHaveValue("0.05");
    expect(screen.getByText(/0.05 SOL total/i)).toBeInTheDocument();
  });

  it("shows fee headroom passed from the existing stake gate", () => {
    render(<StakeRail selectedSquares={[4]} enabled busy={false} onStake={vi.fn()} feeReserveSol="0.005" />);
    expect(screen.getByText("0.005 SOL reserved for network fees")).toBeInTheDocument();
  });
});
