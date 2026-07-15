import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ListingBanner } from "./ListingBanner.js";

describe("ListingBanner", () => {
  it("counts down to a configured future listing time", () => {
    // listing at 10_000s, now 4_000s -> 6_000s left -> "1h 40m"
    const { container } = render(<ListingBanner listingTs={10_000} nowMs={4_000_000} />);
    expect(screen.getByText(/BEEF LISTING IN/i)).toBeInTheDocument();
    expect(screen.getByText("1h 40m")).toBeInTheDocument();
    expect(container).not.toHaveTextContent("🥩");
    expect(container.querySelector(".border-l-bull-green")).toBeInTheDocument();
    expect(container.querySelector(".text-bull-green")).toBeInTheDocument();
    expect(container.querySelector(".border-l-bull-gold, .text-bull-gold")).toBeNull();
  });

  it("renders nothing when no listing time is configured", () => {
    const { container } = render(<ListingBanner nowMs={4_000_000} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing once the listing time has passed", () => {
    const { container } = render(<ListingBanner listingTs={1_000} nowMs={4_000_000} />);
    expect(container).toBeEmptyDOMElement();
  });
});
