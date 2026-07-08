import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { StakeRail } from "./StakeRail.js";

describe("StakeRail", () => {
  it("disables Stake until squares are selected and a valid amount is entered; stakes the amount on EACH selected square", () => {
    const onStake = vi.fn();
    const { rerender } = render(<StakeRail selectedSquares={[]} sessionValid busy={false} onStake={onStake} />);
    expect(screen.getByRole("button", { name: /stake/i })).toBeDisabled();
    rerender(<StakeRail selectedSquares={[4, 9]} sessionValid busy={false} onStake={onStake} />);
    fireEvent.change(screen.getByPlaceholderText(/amount/i), { target: { value: "0.02" } });
    const btn = screen.getByRole("button", { name: /stake/i });
    expect(btn).not.toBeDisabled();
    fireEvent.click(btn);
    expect(onStake).toHaveBeenCalledWith([4, 9], expect.anything());
    expect(onStake.mock.calls[0][1].toString()).toBe("20000000"); // per-square lamports
  });

  it("shows the tile count and the per-square total for a multi-selection", () => {
    render(<StakeRail selectedSquares={[1, 2, 3]} sessionValid busy={false} onStake={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText(/amount/i), { target: { value: "0.02" } });
    expect(screen.getByText(/3 tiles/i)).toBeInTheDocument();
    expect(screen.getByText(/0.06 SOL total/i)).toBeInTheDocument();
  });

  it("prompts to enter the round when the session is invalid", () => {
    render(<StakeRail selectedSquares={[4]} sessionValid={false} busy={false} onStake={vi.fn()} />);
    expect(screen.getByText(/enter the round/i)).toBeInTheDocument();
  });
});
