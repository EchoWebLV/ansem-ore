import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { StakeRail } from "./StakeRail.js";

describe("StakeRail", () => {
  it("disables Stake until a square is selected and a valid amount is entered", () => {
    const onStake = vi.fn();
    const { rerender } = render(<StakeRail selectedSquare={null} sessionValid busy={false} onStake={onStake} />);
    expect(screen.getByRole("button", { name: /stake/i })).toBeDisabled();
    rerender(<StakeRail selectedSquare={4} sessionValid busy={false} onStake={onStake} />);
    fireEvent.change(screen.getByPlaceholderText(/amount/i), { target: { value: "0.02" } });
    const btn = screen.getByRole("button", { name: /stake/i });
    expect(btn).not.toBeDisabled();
    fireEvent.click(btn);
    expect(onStake).toHaveBeenCalledWith(4, expect.objectContaining({ toString: expect.any(Function) }));
    expect(onStake.mock.calls[0][1].toString()).toBe("20000000");
  });
  it("prompts to enter the round when the session is invalid", () => {
    render(<StakeRail selectedSquare={4} sessionValid={false} busy={false} onStake={vi.fn()} />);
    expect(screen.getByText(/enter the round/i)).toBeInTheDocument();
  });
});
