import * as anchor from "@coral-xyz/anchor";
import { Program, AnchorProvider, Wallet } from "@coral-xyz/anchor";
import { Connection } from "@solana/web3.js";
import { AnsemMiner } from "./idl/ansem_miner.js";
import idlJson from "./idl/ansem_miner.json" assert { type: "json" };

/** L1 program bound to a connection + wallet. */
export function createProgram(connection: Connection, wallet: Wallet): Program<AnsemMiner> {
  const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });
  return new Program<AnsemMiner>(idlJson as anchor.Idl as AnsemMiner, provider);
}

/** ER program: same IDL, an ER connection/provider. Pass the same wallet used on L1. */
export function createErProgram(erConnection: Connection, wallet: Wallet): Program<AnsemMiner> {
  const erProvider = new AnchorProvider(erConnection, wallet, { commitment: "confirmed" });
  return new Program<AnsemMiner>(idlJson as anchor.Idl as AnsemMiner, erProvider);
}
