// Ops tool: create the BEEF vault token account + init_beef on the live cluster.
//
//   RPC=<url> node scripts/beef-init.mjs [--vault-keypair <path>] [--beef-mint <CA>] [--fill <uiAmount>]
//
// - --vault-keypair: keypair whose PUBKEY becomes the vault address. Grind a
//   vanity one first:  solana-keygen grind --starts-with BEEF:1
//   (ops cosmetics only — the program pins whatever pubkey is used at init).
//   Omit to use a throwaway keypair (fine for devnet rehearsals).
// - --beef-mint: existing mint CA (MAINNET: the pump.fun $BEEF CA, provided at
//   launch). Omit on devnet to create a fresh 6dp mock mint.
// - --fill: devnet-only convenience — mint <uiAmount> BEEF into the vault
//   (mock mint only; a real CA can't be minted, fill it by transfer instead).
//
// Admin keypair defaults to ~/.config/solana/ansem-devnet.json; override with
// ADMIN_KEYPAIR=<path> (e.g. ~/.config/solana/id.json for a localnet rehearsal
// where id.json is the Config admin). It MUST equal the on-chain Config.admin.
//
// After creation the vault keypair has ZERO power (SPL token accounts obey the
// stored owner = vault_authority PDA, not the address's key) — discard it.
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { Wallet } from "@coral-xyz/anchor";
import { createMint, createAccount, mintTo, getAccount } from "@solana/spl-token";
import { readFileSync } from "node:fs";
import {
  createProgram, configPda, beefConfigPda, vaultAuthPda, initBeefIx, fetchBeefConfig, BN,
  DEFAULT_BEEF_DIVISOR, DEFAULT_BEEF_TICK_BPS, DEFAULT_BEEF_BONUS_CAP_BPS,
  DEFAULT_BEEF_ACTIVITY_WINDOW_SECS, DEFAULT_BEEF_SECS_PER_TICK,
} from "@ansem/sdk";

const arg = (name) => { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : undefined; };
const RPC = process.env.RPC || "https://api.devnet.solana.com";
const conn = new Connection(RPC, "confirmed");
const ADMIN_KP = process.env.ADMIN_KEYPAIR || `${process.env.HOME}/.config/solana/ansem-devnet.json`;
const admin = Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(ADMIN_KP, "utf8"))));
const program = createProgram(conn, new Wallet(admin));

const vaultKp = arg("--vault-keypair")
  ? Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(arg("--vault-keypair"), "utf8"))))
  : Keypair.generate();

let beefMint = arg("--beef-mint") ? new PublicKey(arg("--beef-mint")) : null;
if (!beefMint) {
  beefMint = await createMint(conn, admin, admin.publicKey, null, 6);
  console.log("created MOCK beef mint:", beefMint.toBase58());
}

const vault = await createAccount(conn, admin, beefMint, vaultAuthPda(), vaultKp);
console.log("vault token account:", vault.toBase58(), "(owner = vault_authority PDA — keypair now powerless)");

const fill = arg("--fill");
if (fill) {
  await mintTo(conn, admin, beefMint, vault, admin, BigInt(Math.round(Number(fill) * 1e6)));
  console.log(`filled vault with ${fill} mock BEEF`);
}

await initBeefIx(
  program, admin.publicKey, beefMint, vault,
  new BN(DEFAULT_BEEF_DIVISOR), DEFAULT_BEEF_TICK_BPS, DEFAULT_BEEF_BONUS_CAP_BPS,
  new BN(DEFAULT_BEEF_ACTIVITY_WINDOW_SECS), new BN(DEFAULT_BEEF_SECS_PER_TICK),
).rpc({ commitment: "confirmed" });

const bc = await fetchBeefConfig(program, beefConfigPda());
const v = await getAccount(conn, vault);
console.log("BEEF INITIALIZED:", JSON.stringify({
  mint: bc.beefMint.toBase58(), vault: bc.beefVault.toBase58(),
  divisor: bc.divisor.toString(), vaultBalance: v.amount.toString(), totalOwed: bc.totalOwed.toString(),
}, null, 2));
