import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { Disclaimer } from "./Disclaimer";

describe("Disclaimer", () => {
  it("states unofficial, mainnet real-SOL stakes, and the risk warning", () => {
    render(<Disclaimer />);
    const t = screen.getByTestId("disclaimer").textContent ?? "";
    expect(t).toMatch(/unofficial fan project/i);
    expect(t).toMatch(/not affiliated with or endorsed by Ansem/i);
    expect(t).toMatch(/mainnet/i);
    expect(t).toMatch(/real SOL/i);
    expect(t).toMatch(/afford to lose/i);
  });
});
