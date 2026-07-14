import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { PhaseNav } from "./PhaseNav";

describe("PhaseNav", () => {
  it("shows the BullStake wordmark", () => {
    render(<PhaseNav />);
    const t = screen.getByTestId("phase-nav").textContent ?? "";
    expect(t).toMatch(/bull\s*stake/i);
  });

  it("Phase I is enabled and marked as the current product", () => {
    render(<PhaseNav />);
    const p1 = screen.getByRole("button", { name: /phase i$/i });
    expect(p1).toBeEnabled();
    expect(p1).toHaveAttribute("aria-current", "page");
  });

  it("Phase II and Phase III are disabled", () => {
    render(<PhaseNav />);
    expect(screen.getByRole("button", { name: /phase ii$/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /phase iii$/i })).toBeDisabled();
  });
});
