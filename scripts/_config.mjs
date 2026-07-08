// Ops tool: probe the live devnet Config; with --launch-defaults, reset the fields
// the test suites override (return band -> (0,5000), round duration -> 60s).
// Usage: RPC=<url> node scripts/_config.mjs [--launch-defaults]
import { Connection, Keypair } from "@solana/web3.js";
import { Wallet } from "@coral-xyz/anchor";
import { readFileSync } from "node:fs";
import { createProgram, configPda, fetchConfig, BN } from "@ansem/sdk";

const RPC = process.env.RPC || "https://api.devnet.solana.com";
const conn = new Connection(RPC, "confirmed");
const kp = Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(`${process.env.HOME}/.config/solana/ansem-devnet.json`, "utf8"))));
const program = createProgram(conn, new Wallet(kp));

const show = async (label) => {
  const c = await fetchConfig(program, configPda());
  console.log(label, JSON.stringify(c, (k, v) => (typeof v === "bigint" ? v.toString() : v)));
  return c;
};

await show("CONFIG:");
if (process.argv.includes("--launch-defaults")) {
  console.log("setting launch defaults: return band (0, 5000), round duration 60s ...");
  await program.methods.setReturnBand(0, 5000)
    .accountsPartial({ admin: kp.publicKey, config: configPda() }).rpc({ commitment: "confirmed" });
  await program.methods.setRoundDuration(new BN(60))
    .accountsPartial({ admin: kp.publicKey, config: configPda() }).rpc({ commitment: "confirmed" });
  await show("AFTER:");
}
