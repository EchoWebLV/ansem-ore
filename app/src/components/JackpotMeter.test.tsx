import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { JackpotMeter } from "./JackpotMeter.js";

describe("JackpotMeter", () => {
  it("shows the rolling jackpot in ANSEM (base units, never lamports)", () => {
    // 3_044_903_400 base units / 1e6 = 3044.9 ANSEM
    render(<JackpotMeter rolloverJackpot="3044903400" />);
    expect(screen.getByText("3044.9")).toBeInTheDocument();
    expect(screen.getByText("ANSEM")).toBeInTheDocument();
    expect(screen.getByText(/grows every miss/i)).toBeInTheDocument();
  });

  it("degrades to 0 ANSEM when the field is missing (older snapshot)", () => {
    render(<JackpotMeter />);
    expect(screen.getByText("0")).toBeInTheDocument();
    expect(screen.getByText("ANSEM")).toBeInTheDocument();
  });

  it("renders the 1-in-N odds line only when triggerOdds is present", () => {
    const { rerender } = render(<JackpotMeter rolloverJackpot="0" />);
    expect(screen.queryByText(/1-in-/)).toBeNull();
    rerender(<JackpotMeter rolloverJackpot="0" triggerOdds={25} />);
    expect(screen.getByText(/jackpot round odds 1-in-25/i)).toBeInTheDocument();
  });
});
