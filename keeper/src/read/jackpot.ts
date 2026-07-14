import { Program } from "@coral-xyz/anchor";
import { AnsemMiner, jackpotConfigPda, fetchJackpotConfig } from "@ansem/sdk";

// Canonical PDA derivation now lives in the SDK (packages/sdk/src/pdas.ts). Re-export it so
// the keeper/app share one source of truth — the raw duplicate derivation + hand-decode that
// this module carried pre-upgrade (the old TODO(sdk)) is gone.
export { jackpotConfigPda } from "@ansem/sdk";

/** Jackpot params surfaced in the snapshot; null when the on-chain PDA is absent. */
export interface JackpotParams {
  jackpotTriggerOdds: number | null;
  jackpotCapMult: number | null;
}

const EMPTY: JackpotParams = { jackpotTriggerOdds: null, jackpotCapMult: null };

/**
 * Cached, null-safe reader of the on-chain jackpot params via the SDK's typed
 * `fetchJackpotConfig`. Against the CURRENT program the PDA does not exist -> the fetch
 * rejects -> both fields null; against the upgraded program it decodes the real values.
 * Never throws. Caches for `ttlMs` so the per-tick snapshot build doesn't hammer RPC
 * (the params change only on an admin ix).
 */
export function makeJackpotReader(
  program: Program<AnsemMiner>,
  ttlMs = 60_000,
  now: () => number = () => Date.now(),
): () => Promise<JackpotParams> {
  const pda = jackpotConfigPda();
  let cached: JackpotParams = EMPTY;
  let at = -Infinity;
  return async () => {
    if (now() - at < ttlMs) return cached;
    at = now();
    try {
      const st = await fetchJackpotConfig(program, pda);
      cached = { jackpotTriggerOdds: st.triggerOdds, jackpotCapMult: st.capMult };
    } catch {
      cached = EMPTY; // PDA absent (pre-upgrade program) or transient RPC error — stay null-safe
    }
    return cached;
  };
}
