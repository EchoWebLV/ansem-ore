import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { PhaseNav } from "./PhaseNav";

describe("PhaseNav", () => {
  it("shows the BullStake wordmark", () => {
    render(<PhaseNav />);
    const t = screen.getByTestId("phase-nav").textContent ?? "";
    expect(t).toMatch(/bull\s*stake/i);
  });

  it("uses a product-header navigation accessible name", () => {
    render(<PhaseNav />);
    expect(screen.getByRole("navigation", { name: "BullStake product navigation" })).toBeInTheDocument();
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

  it("keeps the mobile action slot on one line", () => {
    render(
      <PhaseNav>
        <button>SELECT WALLET</button>
      </PhaseNav>,
    );
    const actions = screen.getByRole("button", { name: /select wallet/i }).parentElement;
    expect(actions).toHaveClass("shrink-0", "whitespace-nowrap");
  });

  it("uses the page shell padding only once on mobile", () => {
    render(<PhaseNav />);
    expect(screen.getByTestId("phase-nav")).toHaveClass("px-0");
  });

  it("keeps the wordmark visible and applies a narrow treatment below 360px", () => {
    const { container } = render(<PhaseNav><button>SELECT WALLET</button></PhaseNav>);
    expect(screen.getByText(/Bull/).parentElement).toHaveClass("whitespace-nowrap");
    expect(container.querySelector('img[src="/bullstake-logo.svg"]')).toHaveClass("max-[359px]:hidden");
    expect(screen.getByTestId("phase-nav")).toHaveClass("gap-2", "min-[360px]:gap-4");
  });
});
