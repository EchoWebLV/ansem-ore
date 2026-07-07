import { readdirSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import sharp from "sharp";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(here, "../../generated/bulls");   // repo-root generated/bulls
const OUT = resolve(here, "../public/bulls");
const MAX = 256;

/** Downscale generated/bulls/NN-name.png -> public/bulls/NN.webp (<=256px). Idempotent. */
export async function optimizeBulls() {
  mkdirSync(OUT, { recursive: true });
  const pngs = readdirSync(SRC).filter((f) => /^\d{2}-.*\.png$/.test(f)).sort();
  if (pngs.length !== 25) {
    throw new Error(`expected 25 source bull PNGs in ${SRC}, found ${pngs.length}`);
  }
  await Promise.all(pngs.map(async (file) => {
    const nn = file.slice(0, 2); // "01".."25"
    await sharp(join(SRC, file))
      .resize(MAX, MAX, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: 82 })
      .toFile(join(OUT, `${nn}.webp`));
  }));
  return pngs.length;
}

// Run as a CLI when invoked directly (npm predev/prebuild).
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  optimizeBulls()
    .then((n) => console.log(`optimized ${n} bull tiles -> public/bulls`))
    .catch((e) => { console.error(e); process.exit(1); });
}
