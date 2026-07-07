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
  escrow: EscrowState | null; miner: MinerState | null; config: ConfigState | null; refresh: () => void;
}

export function usePlayerState({ program, wallet, pollMs = 6000, fetchers }: PlayerStateArgs): PlayerState {
  const [escrow, setEscrow] = useState<EscrowState | null>(null);
  const [miner, setMiner] = useState<MinerState | null>(null);
  const [config, setConfig] = useState<ConfigState | null>(null);

  const walletKey = wallet.toBase58();
  const refresh = useCallback(() => {
    const f: Fetchers = fetchers ?? {
      escrow: () => fetchEscrow(program, escrowPda(wallet)),
      miner: () => fetchMiner(program, minerPda(wallet)),
      config: () => fetchConfig(program, configPda()),
    };
    f.escrow().then(setEscrow).catch(() => {});
    f.miner().then(setMiner).catch(() => {});
    f.config().then(setConfig).catch(() => {});
  }, [program, walletKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    refresh();
    if (!pollMs) return;
    const id = setInterval(refresh, pollMs);
    return () => clearInterval(id);
  }, [refresh, pollMs]);

  return { escrow, miner, config, refresh };
}
