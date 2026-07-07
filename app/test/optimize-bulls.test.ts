import { describe, it, expect, beforeAll } from "vitest";
import { readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import sharp from "sharp";
import { optimizeBulls } from "../scripts/optimize-bulls.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, "../public/bulls");

describe("optimizeBulls", () => {
  beforeAll(async () => { await optimizeBulls(); }, 60_000);

  it("emits 25 webp tiles named NN.webp", () => {
    const files = readdirSync(outDir).filter((f) => f.endsWith(".webp")).sort();
    expect(files).toHaveLength(25);
    expect(files[0]).toBe("01.webp");
    expect(files[24]).toBe("25.webp");
  });

  it("downscales each tile to <= 256px on the long edge", async () => {
    const meta = await sharp(resolve(outDir, "01.webp")).metadata();
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(256);
  });

  it("is idempotent (re-running does not throw)", async () => {
    await expect(optimizeBulls()).resolves.not.toThrow();
    expect(existsSync(resolve(outDir, "13.webp"))).toBe(true);
  });
});
