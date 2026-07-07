import { describe, it, expect } from "vitest";
import { KEEPER_NAME } from "../src/index.js";

describe("keeper scaffold", () => {
  it("exports a package identity", () => {
    expect(KEEPER_NAME).toBe("@ansem/keeper");
  });
});
