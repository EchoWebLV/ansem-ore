import { PublicKey } from "@solana/web3.js";
import type { BeefConfigState } from "@ansem/sdk";
import type { Logger } from "./logger.js";

/**
 * Injected surface for the minted-BEEF stamp crank (plan 2026-07-14 Task 6 Step 2), so the
 * probe/cache/send/capture sequence is unit-testable without a chain. The live wiring lives
 * in service.ts; every primitive here is chain I/O the tests stub.
 */
export interface BeefStampDeps {
  /** Null-safe BeefConfig read: the pinned mint/vault/treasury, or null when BeefConfig is
   *  uninitialized (mainnet today) OR the read fails. MUST NOT throw. */
  probeConfig: () => Promise<BeefConfigState | null>;
  /** The BEEF mint's OWNING token program (classic SPL vs Token-2022) — read from the mint
   *  account on-chain, never env. Called once per (re)probe against the resolved mint. */
  detectTokenProgram: (beefMint: PublicKey) => Promise<PublicKey>;
  /** Send stamp_beef for `roundId` against the pinned accounts. Throws on any on-chain reject. */
  sendStamp: (roundId: number, cfg: BeefConfigState, tokenProgram: PublicKey) => Promise<void>;
  /** Read the just-stamped round's FROZEN players' emission (BeefRound.emission, base units). */
  readEmission: (roundId: number) => Promise<bigint>;
  /** Push the captured emission to the snapshot holder (service.ts lastBeefEmission). */
  pushEmission: (emission: bigint) => void;
  log: Logger;
}

interface BeefCache { cfg: BeefConfigState; tokenProgram: PublicKey; }

export interface BeefStamper {
  /** Boot-time probe: warms the cache + logs enabled/dormant. Optional — stamp() lazily
   *  probes too, so a keeper that boots BEFORE BEEF launches still picks it up later. */
  init: () => Promise<void>;
  /** Best-effort per-round stamp. Resolves (no-op) when BEEF is uninitialized; THROWS on a
   *  real stamp send-failure so finalizeSettled swallows+logs it (BEEF never blocks the game). */
  stamp: (roundId: number) => Promise<void>;
  /** Observability/tests: true once a BeefConfig has been cached. */
  enabled: () => boolean;
}

/**
 * The minted-BEEF stamp crank. Holds a lazily-populated cache of the pinned BEEF accounts
 * (mint / vault / treasury from BeefConfig + the mint's owning token program):
 *
 *  - probe ONCE at boot (init). On mainnet TODAY BeefConfig does not exist, so the cache
 *    stays empty and the crank is dormant — no stamp tx is ever sent, the game runs exactly
 *    as before BEEF launched.
 *  - stamp() re-probes whenever the cache is empty, so an init_beef that lands MID-FLIGHT is
 *    picked up on the next finalize with NO keeper restart (this is why the disabled path
 *    still costs one cheap read per finalize — a required trade for hot BEEF enablement).
 *  - a stamp SEND-failure invalidates the cache (re-probe next finalize) — recovers from a
 *    transient RPC error and picks up a post-init config/address change without a restart.
 *
 * INVARIANT: BEEF never blocks the game. A send-failure throws (finalizeSettled swallows it);
 * every other path resolves. The emission CAPTURE (for snapshot.beefPerRound) is best-effort:
 * a read hiccup after a landed stamp is logged, not thrown, and keeps the prior snapshot value.
 */
export function makeBeefStamper(deps: BeefStampDeps): BeefStamper {
  let cache: BeefCache | null = null;

  // Resolve the pinned accounts + owning token program and cache them. Returns false
  // (dormant) when BeefConfig is absent. Never throws — probeConfig is null-safe.
  const probe = async (): Promise<boolean> => {
    const cfg = await deps.probeConfig();
    if (!cfg) { cache = null; return false; }
    const tokenProgram = await deps.detectTokenProgram(new PublicKey(cfg.beefMint));
    cache = { cfg, tokenProgram };
    return true;
  };

  return {
    async init() {
      if (await probe()) {
        deps.log.info("BEEF stamp crank enabled", {
          mint: cache!.cfg.beefMint, vault: cache!.cfg.beefVault,
          treasury: cache!.cfg.beefTreasury, tokenProgram: cache!.tokenProgram.toBase58(),
        });
      } else {
        deps.log.info("BEEF not initialized — stamp crank dormant (re-probes each finalize)");
      }
    },

    async stamp(roundId) {
      // Lazy (re)probe on an empty cache: this is how a keeper that booted before BEEF picks
      // up a mid-flight init_beef. A miss leaves BEEF dormant -> skip silently (no tx, no throw).
      if (!cache && !(await probe())) return;
      const { cfg, tokenProgram } = cache!;
      try {
        await deps.sendStamp(roundId, cfg, tokenProgram);
      } catch (e) {
        cache = null; // invalidate -> re-probe next finalize (transient recovery / config change)
        throw e;      // finalizeSettled swallows+logs — BEEF never blocks the game (invariant)
      }
      // Stamp landed. Capture the frozen players' emission for snapshot.beefPerRound. A read
      // hiccup here is non-fatal (the stamp already succeeded): log and keep the prior value.
      try {
        const emission = await deps.readEmission(roundId);
        deps.pushEmission(emission);
        deps.log.info("beef emission stamped", { roundId, emission: emission.toString() });
      } catch (e) {
        deps.log.warn("beef stamped but emission read failed (snapshot keeps prior value)", {
          roundId, err: String(e),
        });
      }
    },

    enabled: () => cache !== null,
  };
}
