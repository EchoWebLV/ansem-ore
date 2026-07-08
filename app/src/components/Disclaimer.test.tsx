import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { Disclaimer } from "./Disclaimer";

describe("Disclaimer", () => {
  it("states unofficial, devnet-only, no-real-funds", () => {
    render(<Disclaimer />);
    const t = screen.getByTestId("disclaimer").textContent ?? "";
    expect(t).toMatch(/unofficial fan project/i);
    expect(t).toMatch(/not affiliated with or endorsed by Ansem/i);
    expect(t).toMatch(/devnet/i);
    expect(t).toMatch(/no real funds|test tokens/i);
  });
});
