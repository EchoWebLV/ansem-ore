import { Connection, PublicKey } from "@solana/web3.js";
import { PROGRAM_ID } from "@ansem/sdk";

/** Jackpot params surfaced in the snapshot; null when the on-chain PDA is absent. */
export interface JackpotParams {
  jackpotTriggerOdds: number | null;
  jackpotCapMult: number | null;
}

const EMPTY: JackpotParams = { jackpotTriggerOdds: null, jackpotCapMult: null };

// JackpotConfig PDA seed (program constant JACKPOT_CONFIG_SEED, spec 2026-07-14 D6).
const JACKPOT_CONFIG_SEED = Buffer.from("jackpot_config");

/** Derive the JackpotConfig PDA. */
export function jackpotConfigPda(): PublicKey {
  return PublicKey.findProgramAddressSync([JACKPOT_CONFIG_SEED], PROGRAM_ID)[0];
}

/**
 * Raw-decode a JackpotConfig account buffer: 8-byte anchor discriminator, then
 * `trigger_odds: u16` (LE) at offset 8 and `cap_mult: u16` (LE) at offset 10
 * (layout per plan Task 3 state/jackpot.rs). Returns nulls if the buffer is too short.
 *
 * TODO(sdk): drop this once packages/sdk exposes `jackpotConfigPda()` +
 * `fetchJackpotConfig()` (plan Task 5) — the keeper decodes here because the SDK/IDL
 * do not carry the JackpotConfig account until the program upgrade lands.
 */
export function decodeJackpotParams(data: Uint8Array | null | undefined): JackpotParams {
  if (!data || data.length < 12) return EMPTY;
  const buf = Buffer.from(data);
  return { jackpotTriggerOdds: buf.readUInt16LE(8), jackpotCapMult: buf.readUInt16LE(10) };
}

/**
 * Cached, null-safe reader of the on-chain jackpot params. Against the CURRENT program the
 * PDA does not exist -> getAccountInfo null -> both fields null; against the upgraded program
 * it decodes the real values. Never throws. Caches for `ttlMs` so the per-tick snapshot build
 * doesn't hammer RPC (the params change only on an admin ix).
 */
export function makeJackpotReader(
  conn: Connection,
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
      const info = await conn.getAccountInfo(pda, "confirmed");
      cached = decodeJackpotParams(info?.data);
    } catch {
      cached = EMPTY; // transient RPC error — stay null-safe, retry next TTL window
    }
    return cached;
  };
}
