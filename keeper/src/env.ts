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
  };
}

/** Real keypair loader (fs) — used by main.ts, never by unit tests. */
export function fsLoadKeypair(path: string): Keypair {
  const raw = JSON.parse(readFileSync(path, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}
