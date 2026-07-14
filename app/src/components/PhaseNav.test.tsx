import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { PhaseNav } from "./PhaseNav";

describe("PhaseNav", () => {
  it("shows the BullStake wordmark", () => {
    render(<PhaseNav />);
    const t = screen.getByTestId("phase-nav").textContent ?? "";
    expect(t).toMatch(/bull\s*stake/i);
  });

  it("preserves the phase navigation accessible name", () => {
    render(<PhaseNav />);
    expect(screen.getByRole("navigation", { name: "BullStake phases" })).toBeInTheDocument();
  });

  it("marks Play as the current product location without advertising unshipped phases", () => {
    render(<PhaseNav />);
    expect(screen.getByText("Play")).toHaveAttribute("aria-current", "page");
    expect(screen.queryByText(/phase ii/i)).toBeNull();
    expect(screen.queryByText(/phase iii/i)).toBeNull();
  });

  it("keeps the brand logo and renders sound/wallet children", () => {
    const { container } = render(
      <PhaseNav>
        <button>WALLET</button>
      </PhaseNav>,
    );
    expect(container.querySelector('img[src="/bullstake-logo.svg"]')).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /wallet/i })).toBeInTheDocument();
  });
});
