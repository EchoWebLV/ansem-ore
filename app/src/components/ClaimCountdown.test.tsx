import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ClaimCountdown } from "./ClaimCountdown.js";

describe("ClaimCountdown", () => {
  it("shows CLAIM BY hh:mm:ss for time still on the clock", () => {
    // deadline 90_000s, now 86_400s -> 3_600s left = 01:00:00.
    render(<ClaimCountdown deadlineTs={90_000} nowMs={86_400_000} />);
    expect(screen.getByText("CLAIM BY 01:00:00")).toBeInTheDocument();
  });

  it("renders the full 24h window at the top of the countdown", () => {
    render(<ClaimCountdown deadlineTs={86_400} nowMs={0} />);
    expect(screen.getByText("CLAIM BY 24:00:00")).toBeInTheDocument();
  });

  it("hides itself once the window has closed (expired claim would fail)", () => {
    const { container } = render(<ClaimCountdown deadlineTs={1_000} nowMs={2_000_000} />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText(/CLAIM BY/)).toBeNull();
  });

  it("hides itself exactly at the deadline", () => {
    const { container } = render(<ClaimCountdown deadlineTs={1_000} nowMs={1_000_000} />);
    expect(container).toBeEmptyDOMElement();
  });
});
