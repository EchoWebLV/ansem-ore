// Ops tool: one-shot MAINNET initialize + launch params (idempotent, re-runnable).
// The DEPLOY wallet (upgrade authority) signs initialize_real once; every later
// param call is signed by the KEEPER key (config.admin) — proving the key split.
// Launch policy (plan 2026-07-14): WTA band (0,0), 5-min rounds, 24h claim window,
// min_swap_rate = floor from a live Jupiter quote, caps 0.01 / 1 SOL.
// Usage:
//   RPC=<mainnet rpc> DEPLOY_WALLET=<path> KEEPER_WALLET=<path> \
//   ANSEM_MINT=<ca> MIN_SWAP_RATE=<ANSEM base units per 1 SOL> \
//   node scripts/_mainnet-init.mjs
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { Wallet } from "@coral-xyz/anchor";
import { readFileSync } from "node:fs";
import { createProgram, configPda, fetchConfig, BN } from "@ansem/sdk";

const req = (k) => {
  const v = process.env[k];
  if (!v) { console.error(`missing env ${k}`); process.exit(1); }
  return v;
};
const kpOf = (p) => Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(p, "utf8"))));

const conn = new Connection(req("RPC"), "confirmed");
const deployer = kpOf(req("DEPLOY_WALLET"));
const keeper = kpOf(req("KEEPER_WALLET"));
const ansemMint = new PublicKey(req("ANSEM_MINT"));
const minSwapRate = new BN(req("MIN_SWAP_RATE"));

const asDeployer = createProgram(conn, new Wallet(deployer));
const asKeeper = createProgram(conn, new Wallet(keeper));

const BPF_LOADER_UPGRADEABLE = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const [programData] = PublicKey.findProgramAddressSync(
  [asDeployer.programId.toBytes()],
  BPF_LOADER_UPGRADEABLE,
);

const show = async (label) => {
  const c = await fetchConfig(asKeeper, configPda());
  console.log(label, JSON.stringify(c, (k, v) => (typeof v === "bigint" ? v.toString() : v)));
  return c;
};

const existing = await conn.getAccountInfo(configPda());
if (!existing) {
  console.log("initialize_real:", {
    deployer: deployer.publicKey.toBase58(),
    keeperAdmin: keeper.publicKey.toBase58(),
    ansemMint: ansemMint.toBase58(),
  });
  const sig = await asDeployer.methods
    .initializeReal(keeper.publicKey)
    .accountsPartial({
      admin: deployer.publicKey,
      ansemMint,
      program: asDeployer.programId,
      programData,
    })
    .rpc({ commitment: "confirmed" });
  console.log("initialize_real sig:", sig);
} else {
  console.log("config exists — skipping initialize_real");
}

// Launch params — keeper-signed (config.admin). Values per the launch decisions.
const params = [
  ["setReturnBand", [0, 0]],
  ["setRoundDuration", [new BN(300)]],
  ["setClaimWindow", [new BN(86400)]],
  ["setMinSwapRate", [minSwapRate]],
  ["setStakeLimits", [new BN(10_000_000), new BN(1_000_000_000)]],
];
for (const [method, args] of params) {
  const sig = await asKeeper.methods[method](...args)
    .accountsPartial({ admin: keeper.publicKey, config: configPda() })
    .rpc({ commitment: "confirmed" });
  console.log(method, args.map(String).join(", "), "->", sig);
}

await show("FINAL CONFIG:");
