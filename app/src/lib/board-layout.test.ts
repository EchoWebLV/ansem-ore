import { describe, it, expect } from "vitest";
import { bullCells, svgCells } from "./board-layout.js";

describe("bullCells", () => {
  const cells = bullCells();

  it("produces exactly 25 cells with unique ids 0..24 in order", () => {
    expect(cells).toHaveLength(25);
    expect(cells.map((c) => c.id)).toEqual(Array.from({ length: 25 }, (_, i) => i));
  });

  it("marks exactly two eye cells (|c|==1, r==0)", () => {
    expect(cells.filter((c) => c.eye)).toHaveLength(2);
  });

  it("normalizes every position into [0,1] x [0,1]", () => {
    for (const c of cells) {
      expect(c.left).toBeGreaterThanOrEqual(0);
      expect(c.left).toBeLessThanOrEqual(1);
      expect(c.top).toBeGreaterThanOrEqual(0);
      expect(c.top).toBeLessThanOrEqual(1);
    }
  });

  it("is left-right symmetric: every cell has a mirror at (1-left, top)", () => {
    const key = (l: number, t: number) => `${l.toFixed(6)}:${t.toFixed(6)}`;
    const present = new Set(cells.map((c) => key(c.left, c.top)));
    // Each cell's mirror across x=0.5 must also be a cell (center cells mirror to themselves).
    for (const c of cells) {
      expect(present.has(key(1 - c.left, c.top))).toBe(true);
    }
    // Exactly the 5 center-column cells sit on the axis of symmetry.
    expect(cells.filter((c) => Math.abs(c.left - 0.5) < 1e-9)).toHaveLength(5);
  });
});

describe("svgCells (design-prototype SVG geometry)", () => {
  const cells = svgCells();

  it("produces 25 hex cells with 2 eyes, ids in order", () => {
    expect(cells).toHaveLength(25);
    expect(cells.map((c) => c.id)).toEqual(Array.from({ length: 25 }, (_, i) => i));
    expect(cells.filter((c) => c.eye)).toHaveLength(2);
  });

  it("fits every cell center inside the 400x340 viewBox with margin", () => {
    for (const c of cells) {
      expect(c.cx).toBeGreaterThan(0);
      expect(c.cx).toBeLessThan(400);
      expect(c.cy).toBeGreaterThan(0);
      expect(c.cy).toBeLessThan(340);
      expect(c.r).toBeGreaterThan(0);
      // flat-top hexagon: 6 "x,y" pairs
      expect(c.points.split(" ")).toHaveLength(6);
    }
  });
});
