"use client";
import { useEffect, useRef, useState } from "react";
import type { Program } from "@coral-xyz/anchor";
import { fetchBeefConfig, beefConfigPda, type BeefConfigState, type AnsemMiner } from "@ansem/sdk";

export interface UseBeefConfigOpts {
  /** Re-probe cadence while BEEF is still uninitialized (default 45s). Polling stops once found. */
  pollMs?: number;
  /** Injectable probe (tests). Resolves the BeefConfig, or null when uninitialized/unreadable. */
  probe?: () => Promise<BeefConfigState | null>;
}

/**
 * The single authoritative BEEF gate. Returns the on-chain BeefConfig, or null while
 * BEEF is NOT initialized (today's mainnet) or no wallet program is available.
 *
 * WHY the account probe (not snapshot.beefPerRound): the `rollBeef` instruction the
 * whole BEEF UI bundles REQUIRES BeefConfig to exist on-chain, so its presence is
 * exactly the condition under which a BEEF bundle is safe — probing it directly is
 * ground truth. The keeper's `beefPerRound` is a downstream hint that only appears
 * after the first stamp and would leave the gate wrong during the init→first-stamp
 * window. Once resolved the config is permanent (BeefConfig is never closed), so
 * polling stops and the value is cached for the session.
 */
export function useBeefConfig(l1: Program<AnsemMiner> | undefined, opts: UseBeefConfigOpts = {}): BeefConfigState | null {
  const { pollMs = 45_000, probe } = opts;
  const [config, setConfig] = useState<BeefConfigState | null>(null);
  const found = useRef(false);

  useEffect(() => {
    if (found.current) return;          // permanent once found — no further reads
    if (!l1 && !probe) return;          // disconnected: nothing to probe (keep last value)
    let live = true;
    let id: ReturnType<typeof setInterval> | null = null;
    // Fully guarded: catch a synchronous derivation throw as well as a fetch rejection,
    // so a probe blip (or a test env without curve crypto) never escapes as an unhandled
    // rejection — it simply reads as "BEEF not live yet".
    const read = probe ?? (async (): Promise<BeefConfigState | null> => {
      try { return await fetchBeefConfig(l1!, beefConfigPda()); }
      catch { return null; }
    });
    const tick = async () => {
      const c = await read().catch(() => null);
      if (!live) return;
      if (c) {
        found.current = true;
        setConfig(c);
        if (id) { clearInterval(id); id = null; }
      }
    };
    void tick();
    id = setInterval(() => { void tick(); }, pollMs);
    return () => { live = false; if (id) clearInterval(id); };
  }, [l1, probe, pollMs]);

  return config;
}
