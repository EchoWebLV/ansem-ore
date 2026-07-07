import { Connection } from "@solana/web3.js";
import { Program, Wallet } from "@coral-xyz/anchor";
import { AnsemMiner, createProgram, createErProgram } from "@ansem/sdk";
import type { KeeperConfig } from "./env.js";

export interface Chain {
  conn: Connection;
  erConn: Connection;
  wallet: Wallet;
  program: Program<AnsemMiner>;
  erProgram: Program<AnsemMiner>;
}

export function buildChain(cfg: KeeperConfig): Chain {
  const conn = new Connection(cfg.rpcUrl, { wsEndpoint: cfg.wsUrl, commitment: "confirmed" });
  const erConn = new Connection(cfg.erEndpoint, { wsEndpoint: cfg.erWsEndpoint, commitment: "confirmed" });
  const wallet = new Wallet(cfg.adminKeypair);
  return {
    conn, erConn, wallet,
    program: createProgram(conn, wallet),
    erProgram: createErProgram(erConn, wallet),
  };
}
