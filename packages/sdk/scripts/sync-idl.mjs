// packages/sdk/scripts/sync-idl.mjs
import { copyFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const outDir = resolve(here, "../src/idl");
mkdirSync(outDir, { recursive: true });

const pairs = [
  [resolve(repoRoot, "target/idl/ansem_miner.json"), resolve(outDir, "ansem_miner.json")],
  [resolve(repoRoot, "target/types/ansem_miner.ts"), resolve(outDir, "ansem_miner.ts")],
];
for (const [src, dst] of pairs) {
  if (!existsSync(src)) {
    console.error(`sync-idl: missing ${src} — run \`anchor build\` at the repo root first.`);
    process.exit(1);
  }
  copyFileSync(src, dst);
  console.log(`sync-idl: ${src} -> ${dst}`);
}
