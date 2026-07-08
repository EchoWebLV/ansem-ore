"use client";
import { useEffect, useState, useCallback } from "react";
import { PublicKey } from "@solana/web3.js";
import type { Program } from "@coral-xyz/anchor";
import {
  fetchEscrow, fetchMiner, fetchConfig, escrowPda, minerPda, configPda,
  type EscrowState, type MinerState, type ConfigState, type AnsemMiner,
} from "@ansem/sdk";

interface Fetchers {
  escrow: () => Promise<EscrowState | null>;
  miner: () => Promise<MinerState | null>;
  config: () => Promise<ConfigState>;
}
export interface PlayerStateArgs {
  program: Program<AnsemMiner>; wallet: PublicKey; pollMs?: number; fetchers?: Fetchers;
}
export interface PlayerState {
  escrow: EscrowState | null; miner: MinerState | null; config: ConfigState | null;
  /** True once BOTH escrow and miner have resolved at least once (null counts). Consumers that
   *  gate an irreversible action on player state (e.g. the Enter-forfeiture check) MUST wait for
   *  this — before it, escrow/miner are null and collapse to defaults that read as "fresh player,
   *  nothing to forfeit", which would enable a forfeiting Enter during the load window. */
  loaded: boolean;
  refresh: () => void;
}

export function usePlayerState({ program, wallet, pollMs = 6000, fetchers }: PlayerStateArgs): PlayerState {
  const [escrow, setEscrow] = useState<EscrowState | null>(null);
  const [miner, setMiner] = useState<MinerState | null>(null);
  const [config, setConfig] = useState<ConfigState | null>(null);
  const [loaded, setLoaded] = useState(false);

  const walletKey = wallet.toBase58();
  const refresh = useCallback(() => {
    const f: Fetchers = fetchers ?? {
      escrow: () => fetchEscrow(program, escrowPda(wallet)),
      miner: () => fetchMiner(program, minerPda(wallet)),
      config: () => fetchConfig(program, configPda()),
    };
    // A resolved read (even null = no account) counts as loaded; a rejected read does NOT, so a
    // persistent fetch failure keeps `loaded` false and the Enter gate fail-safe (blocked).
    const e = f.escrow().then((v) => { setEscrow(v); return true; }, () => false);
    const m = f.miner().then((v) => { setMiner(v); return true; }, () => false);
    Promise.all([e, m]).then(([eo, mo]) => { if (eo && mo) setLoaded(true); });
    f.config().then(setConfig).catch(() => {});
  }, [program, walletKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // A wallet switch re-enters the load window — reset on walletKey ONLY (not on every refresh
  // identity change) so an unstable `program` prop can't keep resetting `loaded` to false.
  useEffect(() => { setLoaded(false); }, [walletKey]);

  useEffect(() => {
    refresh();
    if (!pollMs) return;
    const id = setInterval(refresh, pollMs);
    return () => clearInterval(id);
  }, [refresh, pollMs]);

  return { escrow, miner, config, loaded, refresh };
}
