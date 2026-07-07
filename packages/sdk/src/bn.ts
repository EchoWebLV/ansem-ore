import * as anchor from "@coral-xyz/anchor";

/**
 * `@coral-xyz/anchor` is CJS. Under **Node ESM** (the keeper's real runtime), the
 * cjs-module-lexer does NOT surface `BN` as a named export, so `anchor.BN` is
 * `undefined` and only `anchor.default.BN` is the constructor. Under **esbuild/vite**
 * (vitest, Next) the reverse holds — `anchor.BN` works, `anchor.default` may not.
 * `new anchor.BN(...)` therefore silently works in tests but throws
 * "anchor.BN is not a constructor" in a plain Node process.
 *
 * Resolve whichever the runtime exposes so `new BN()` works everywhere, and stay
 * identity-equal to anchor's OWN BN (anchor's Borsh coder relies on `BN.isBN` /
 * the bn.js interface). Import this `BN` instead of touching `anchor.BN` directly.
 */
const mod = anchor as unknown as {
  BN?: typeof anchor.BN;
  default?: { BN: typeof anchor.BN };
};
export const BN = mod.BN ?? mod.default!.BN;
export type BN = anchor.BN;
