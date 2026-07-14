import { readFileSync } from "node:fs";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  DEFAULT_ER_ENDPOINT, DEFAULT_ER_WS_ENDPOINT, DEFAULT_ER_VALIDATOR, VRF_BASE_QUEUE,
} from "@ansem/sdk";

export interface KeeperConfig {
  rpcUrl: string;
  wsUrl: string;
  erEndpoint: string;
  erWsEndpoint: string;
  validator: PublicKey;
  vrfQueue: PublicKey;
  adminKeypair: Keypair;
  roundDurationSecs: number;
  graceSecs: number;
  pollMs: number;
  httpPort: number;
  /** KEEPER_DIRECT_MODE=1: rounds stay on L1 for stake_direct (never delegated). */
  directMode: boolean;
  // ---- Mainnet real-payout layer (plan 2026-07-14, Task 7) ----
  /** "mock" mints synthetic ANSEM (devnet); "real" buys ANSEM on Jupiter + execute_swap_real. */
  swapMode: "mock" | "real";
  /** Jupiter swap API host (free lite tier by default). */
  jupBaseUrl: string;
  /** Slippage tolerance for Jupiter quotes/swaps, in basis points. */
  slippageBps: number;
  /** Buyback fires only once the treasury holds more than this many SOL. */
  buybackMinSol: number;
  /** SOL left behind in the treasury PDA each buyback (keeps it rent-alive + float). */
  treasuryKeepSol: number;
  /** Alert floor: warn when the keeper ANSEM inventory drops below this (base units). 0 disables. */
  inventoryMinAnsem: number;
}

const req = (env: NodeJS.ProcessEnv, key: string): string => {
  const v = env[key];
  if (!v) throw new Error(`missing required env var: ${key}`);
  return v;
};
const num = (env: NodeJS.ProcessEnv, key: string, dflt: number): number => {
  const v = env[key];
  return v === undefined ? dflt : Number(v);
};
const str = (env: NodeJS.ProcessEnv, key: string, dflt: string): string => {
  const v = env[key];
  return v === undefined || v === "" ? dflt : v;
};

export function loadKeeperConfig(
  env: NodeJS.ProcessEnv,
  loadKeypair: (path: string) => Keypair,
): KeeperConfig {
  return {
    rpcUrl: req(env, "ANCHOR_PROVIDER_URL"),
    wsUrl: env.WS_ENDPOINT || req(env, "ANCHOR_PROVIDER_URL").replace(/^http/, "ws"),
    erEndpoint: env.EPHEMERAL_PROVIDER_ENDPOINT || DEFAULT_ER_ENDPOINT,
    erWsEndpoint: env.EPHEMERAL_WS_ENDPOINT || DEFAULT_ER_WS_ENDPOINT,
    validator: new PublicKey(env.VALIDATOR || DEFAULT_ER_VALIDATOR),
    vrfQueue: new PublicKey(env.VRF_BASE_QUEUE || VRF_BASE_QUEUE),
    adminKeypair: loadKeypair(req(env, "DEVNET_WALLET")),
    roundDurationSecs: num(env, "KEEPER_ROUND_SECS", 60),
    graceSecs: num(env, "KEEPER_GRACE_SECS", 180),
    pollMs: num(env, "KEEPER_POLL_MS", 4000),
    httpPort: num(env, "KEEPER_HTTP_PORT", 8787),
    directMode: env.KEEPER_DIRECT_MODE === "1",
    swapMode: env.SWAP_MODE === "real" ? "real" : "mock",
    jupBaseUrl: str(env, "JUP_BASE_URL", "https://lite-api.jup.ag/swap/v1"),
    slippageBps: num(env, "SLIPPAGE_BPS", 100),
    buybackMinSol: num(env, "BUYBACK_MIN_SOL", 0.05),
    treasuryKeepSol: num(env, "TREASURY_KEEP_SOL", 0.01),
    inventoryMinAnsem: num(env, "INVENTORY_MIN", 0),
  };
}

/** Real keypair loader (fs) — used by main.ts, never by unit tests. */
export function fsLoadKeypair(path: string): Keypair {
  const raw = JSON.parse(readFileSync(path, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}
