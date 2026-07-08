// TEMP (delete after use): probe config/current-round on devnet; with --set, finalize the
// round cursor so the keeper opens the next fresh round (skips the poisoned round).
import { Connection, Keypair } from "@solana/web3.js";
import { Wallet } from "@coral-xyz/anchor";
import { readFileSync } from "node:fs";
import { createProgram, configPda, roundPda, fetchConfig, fetchRound, BN } from "@ansem/sdk";

const RPC = process.env.RPC || "https://api.devnet.solana.com";
const conn = new Connection(RPC, "confirmed");
const kp = Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(`${process.env.HOME}/.config/solana/ansem-devnet.json`, "utf8"))));
const program = createProgram(conn, new Wallet(kp));

const cfg = await fetchConfig(program, configPda());
console.log("admin:", cfg.admin, "| wallet:", kp.publicKey.toBase58(), "| admin==wallet:", cfg.admin === kp.publicKey.toBase58());
console.log("current_round_id:", cfg.currentRoundId, "| finalized:", cfg.currentRoundFinalized);

const rpda = roundPda(cfg.currentRoundId);
const info = await conn.getAccountInfo(rpda);
console.log("current round PDA owner:", info?.owner.toBase58() ?? "(none)");
try {
  const r = await fetchRound(program, rpda);
  console.log("round state:", r.state, "| pot:", r.pot.toString(), "| deadline:", r.deadlineTs, "| now:", Math.floor(Date.now() / 1000));
} catch {
  console.log("round unreadable as an L1 Round (likely DLP-delegated)");
}

if (process.argv.includes("--set")) {
  const newId = cfg.currentRoundId;
  console.log(`\nset_round_cursor(${newId}) -> finalized=true so the keeper opens ${newId + 1} fresh ...`);
  const sig = await program.methods.setRoundCursor(new BN(newId)).accountsPartial({ admin: kp.publicKey, config: configPda() }).rpc({ commitment: "confirmed" });
  console.log("sig:", sig);
  const c2 = await fetchConfig(program, configPda());
  console.log("AFTER: current_round_id:", c2.currentRoundId, "| finalized:", c2.currentRoundFinalized);
}
