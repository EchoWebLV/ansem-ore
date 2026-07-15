import type { Connection, PublicKey } from "@solana/web3.js";

// BEEF-facing client helpers (spec 2026-07-14-beef-on-ansem-design). The chip
// shows REAL on-chain quantities only (D12): the pending figure is computed with
// the program's exact integer math so a claim can never deliver LESS than shown.

/**
 * Parity with `programs/ansem-miner/src/math.rs::beef_payout`:
 *
 *   payout = floor(unclaimed * (10_000 + bonus_bps) / 10_000)
 *
 * u128 there, arbitrary-precision BigInt here — same floor, same result. This is
 * the amount `claim_beef` transfers for the CURRENTLY-STORED miner state, so it is
 * a guaranteed floor on what a claim delivers: on-chain, `claim_beef` first accrues
 * any pending hold-to-grow ticks (bonus only ever GROWS) and the roll that precedes
 * it only ADDS to `unclaimed` (its dilution conserves the unclaimed*bonus product).
 * Both can only raise the realized payout above this number — never below it (D12).
 */
export function beefPayout(unclaimed: bigint, bonusBps: number): bigint {
  if (unclaimed <= 0n) return 0n;
  return (unclaimed * (10_000n + BigInt(bonusBps))) / 10_000n;
}

/** True iff `pubkey` currently exists on-chain. A read failure reads as false — the
 *  invariant-safe direction: a BEEF roll is only ever bundled when its BeefRound is
 *  provably present, so a probe blip degrades to a plain (BEEF never blocks the game)
 *  claim/stake rather than a bundle that would abort on a missing account. */
export async function accountExists(connection: Connection, pubkey: PublicKey): Promise<boolean> {
  return connection
    .getAccountInfo(pubkey, "confirmed")
    .then((info) => info !== null)
    .catch(() => false);
}
