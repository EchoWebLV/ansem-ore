import { Connection, PublicKey } from "@solana/web3.js";
import { GetCommitmentSignature } from "@magicblock-labs/ephemeral-rollups-sdk";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const ER_FLAKE = /Unknown action|not confirmed|block height exceeded|Invalid response|failed to get|timeout|Blockhash not found/i;
const DEADLINE = /RoundNotEnded|RoundNotCancelable|Blockhash not found|Too Many Requests|429|not confirmed|block height/i;
const RATE = /failed to get recent blockhash|getLatestBlockhash|429|rate limited|Too Many Requests/i;

/** Swallow the ER confirm-flake regex; rethrow anything else. Wrap every ER write. */
export async function erRpcTolerant(send: () => Promise<unknown>): Promise<void> {
  try { await send(); }
  catch (e) { if (!ER_FLAKE.test(String(e))) throw e; }
}

/** The on-chain clock lags wall-clock; retry a deadline-gated call until it lands. */
export async function retryPastDeadline(fn: () => Promise<unknown>, label: string, tries = 110, intervalMs = 2000): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try { await fn(); return; }
    catch (e) { if (!DEADLINE.test(String(e))) throw e; await sleep(intervalMs); }
  }
  await fn(); // final attempt surfaces the real error
}

/** Retry an L1 send on PRE-send transient RPC failures only (safe: tx never left the client). */
export async function l1Send(fn: () => Promise<unknown>, tries = 6, baseMs = 2000): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try { await fn(); return; }
    catch (e) { if (i === tries - 1 || !RATE.test(String(e))) throw e; await sleep(baseMs * (i + 1)); }
  }
}

export async function awaitOwnerIs(conn: Connection, pubkey: PublicKey, expected: string, tries = 60, intervalMs = 500): Promise<void> {
  let last = "?";
  for (let i = 0; i < tries; i++) {
    const acc = await conn.getAccountInfo(pubkey, "confirmed");
    if (acc) { last = acc.owner.toBase58(); if (last === expected) return; }
    await sleep(intervalMs);
  }
  throw new Error(`owner of ${pubkey.toBase58()} = ${last}, expected ${expected}`);
}

export async function awaitEr<T>(fetchFn: () => Promise<T>, pred: (v: T) => boolean, tries = 60, intervalMs = 500): Promise<T> {
  let last: T | undefined;
  for (let i = 0; i < tries; i++) {
    try { last = await fetchFn(); if (pred(last)) return last; } catch { /* read lag */ }
    await sleep(intervalMs);
  }
  throw new Error(`predicate not satisfied after ${tries} tries (last=${JSON.stringify(last)})`);
}

/** Flush an ER commit signature to L1 (wraps GetCommitmentSignature). */
export const flushCommit = (sig: string, erConnection: Connection) => GetCommitmentSignature(sig, erConnection);
