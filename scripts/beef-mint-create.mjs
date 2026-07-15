// Ops tool: create the MAINNET $BEEF mint (classic SPL, 6 decimals) + metadata +
// vault token account + treasury ATA, then hand the mint authority to the
// program's vault_authority PDA. One-shot, run BEFORE _beef-launch / init_beef.
//
// ORDERING NOTE (deviation from plan Task 8, deliberate): Metaplex createV1
// requires the MINT AUTHORITY to sign, and the script cannot sign as the PDA.
// So metadata is created while the payer still holds the mint authority, and
// the authority handoff to vault_authority is the FINAL step:
//   (a) create mint — payer = temp mint authority, freeze authority = null
//       FROM CREATION (no setAuthority-to-null step exists or is needed)
//   (b) Metaplex createV1 metadata (payer signs as mint authority)
//   (c) vault token account (owner = vault_authority PDA) + treasury ATA
//   (d) setAuthority(mint, MintTokens -> vault_authority PDA)  <- point of no return
// After (d) the payer has ZERO power over the mint: no freeze authority ever
// existed, and the mint authority is the program PDA forever (D1).
//
// Usage:
//   RPC_URL=<mainnet rpc> PAYER_WALLET=<keypair path> TREASURY_WALLET=<pubkey> \
//   BEEF_NAME=<name> BEEF_SYMBOL=<symbol> BEEF_META_URI=<uri> \
//   node scripts/beef-mint-create.mjs [--dry-run] [--mint-keypair <path>] [--vault-keypair <path>]
//
// --dry-run          print derived addresses + planned steps, send NOTHING.
// --mint-keypair     vanity keypair for the mint address (solana-keygen grind
//                    --starts-with BEEF:1). Throwaway generated if omitted.
// --vault-keypair    vanity keypair for the vault token account address. As in
//                    beef-init.mjs, the keypair has ZERO power after creation
//                    (token accounts obey the stored owner = vault_authority PDA).
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  createMint, createAccount, createAssociatedTokenAccountIdempotent,
  getAssociatedTokenAddressSync, setAuthority, AuthorityType, getMint,
} from "@solana/spl-token";
import { readFileSync } from "node:fs";
import { vaultAuthPda } from "@ansem/sdk";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { createSignerFromKeypair, keypairIdentity, percentAmount } from "@metaplex-foundation/umi";
import { fromWeb3JsKeypair, fromWeb3JsPublicKey, toWeb3JsPublicKey } from "@metaplex-foundation/umi-web3js-adapters";
import { createV1, findMetadataPda, mplTokenMetadata, TokenStandard } from "@metaplex-foundation/mpl-token-metadata";

const req = (k) => {
  const v = process.env[k];
  if (!v) { console.error(`missing env ${k}`); process.exit(1); }
  return v;
};
const kpOf = (p) => Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(p, "utf8"))));
const arg = (name) => { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : undefined; };
const DRY_RUN = process.argv.includes("--dry-run");
// Local validators (solana-test-validator) have no Metaplex Token Metadata program, so the
// createV1 step below would fail there. --skip-metadata forces the skip; otherwise we probe
// for the program account and auto-skip when it is absent (e.g. a bare local validator).
const SKIP_METADATA = process.argv.includes("--skip-metadata");
const MPL_TOKEN_METADATA_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

const RPC = process.env.RPC_URL || process.env.RPC || "https://api.mainnet-beta.solana.com";
const payer = kpOf(req("PAYER_WALLET"));
const treasuryWallet = new PublicKey(req("TREASURY_WALLET"));
const BEEF_NAME = req("BEEF_NAME");
const BEEF_SYMBOL = req("BEEF_SYMBOL");
const BEEF_META_URI = req("BEEF_META_URI");
const DECIMALS = 6;

const mintKp = arg("--mint-keypair") ? kpOf(arg("--mint-keypair")) : Keypair.generate();
const vaultKp = arg("--vault-keypair") ? kpOf(arg("--vault-keypair")) : Keypair.generate();

const conn = new Connection(RPC, "confirmed");
const vaultAuthority = vaultAuthPda();
const treasuryAta = getAssociatedTokenAddressSync(mintKp.publicKey, treasuryWallet); // classic SPL mint

// Metadata PDA derivation needs no network: ["metadata", mpl program, mint].
const umi = createUmi(RPC).use(mplTokenMetadata());
umi.use(keypairIdentity(fromWeb3JsKeypair(payer)));
const metadataPda = findMetadataPda(umi, { mint: fromWeb3JsPublicKey(mintKp.publicKey) })[0];

const plan = {
  rpc: RPC,
  payer: payer.publicKey.toBase58(),
  beefMint: mintKp.publicKey.toBase58(),
  decimals: DECIMALS,
  name: BEEF_NAME, symbol: BEEF_SYMBOL, uri: BEEF_META_URI,
  metadataPda: toWeb3JsPublicKey(metadataPda).toBase58(),
  vaultAuthorityPda: vaultAuthority.toBase58(),
  vaultTokenAccount: vaultKp.publicKey.toBase58(),
  treasuryWallet: treasuryWallet.toBase58(),
  treasuryAta: treasuryAta.toBase58(),
  steps: [
    "(a) create mint: payer = TEMP mint authority, freeze authority = NULL from creation",
    "(b) Metaplex createV1 metadata (payer signs as mint authority; update authority = payer)",
    "(c) create vault token account (owner = vault_authority PDA) + treasury ATA",
    "(d) setAuthority(mint, MintTokens -> vault_authority PDA) — FINAL, irreversible",
  ],
};
console.log("PLAN:", JSON.stringify(plan, null, 2));

if (DRY_RUN) {
  console.log("--dry-run: nothing sent. Re-run without --dry-run to execute.");
  process.exit(0);
}

// (a)+(b) Mint AND metadata in ONE atomic Metaplex createV1 tx — the canonical fungible
// flow: the mint keypair signs, Metaplex initializes the mint (6 decimals) and writes the
// metadata together. No existence race between separate create-mint and metadata txs
// (the split flow failed live 2026-07-14: Metaplex error 0x86 "Mint needs to be signer").
// Fallback (local validators without Metaplex): the old plain createMint, no metadata.
if (SKIP_METADATA || !(await conn.getAccountInfo(MPL_TOKEN_METADATA_ID))) {
  await createMint(conn, payer, payer.publicKey, null, DECIMALS, mintKp);
  console.warn("(a) mint created (metadata SKIPPED — no Metaplex on this cluster):", mintKp.publicKey.toBase58());
} else {
  await createV1(umi, {
    mint: createSignerFromKeypair(umi, fromWeb3JsKeypair(mintKp)), // mint signs; createV1 initializes it
    authority: umi.identity, // mint authority = payer (temp, handed to PDA in (d))
    name: BEEF_NAME,
    symbol: BEEF_SYMBOL,
    uri: BEEF_META_URI,
    sellerFeeBasisPoints: percentAmount(0),
    decimals: DECIMALS,
    tokenStandard: TokenStandard.Fungible,
    isMutable: true, // update authority (payer) can fix logo/URI later; supply stays PDA-gated
  }).sendAndConfirm(umi);
  console.log("(a+b) mint + metadata created atomically:", mintKp.publicKey.toBase58(), "metadata:", toWeb3JsPublicKey(metadataPda).toBase58());
}
// createV1 may set a freeze authority (payer) on the mint it initializes — D1 requires NONE.
// Null it here if present, BEFORE the mint-authority handoff makes changes impossible.
{
  const m = await getMint(conn, mintKp.publicKey);
  if (m.freezeAuthority) {
    await setAuthority(conn, payer, mintKp.publicKey, payer, AuthorityType.FreezeAccount, null);
    console.log("(b2) freeze authority nulled (createV1 had set it to the payer)");
  }
}

// (c) Vault token account (owner = vault_authority PDA) + treasury ATA.
const vault = await createAccount(conn, payer, mintKp.publicKey, vaultAuthority, vaultKp);
console.log("(c) vault token account:", vault.toBase58(), "(owner = vault_authority PDA — vault keypair now powerless)");
await createAssociatedTokenAccountIdempotent(conn, payer, mintKp.publicKey, treasuryWallet);
console.log("(c) treasury ATA:", treasuryAta.toBase58(), "(owner =", treasuryWallet.toBase58() + ")");

// (d) FINAL: hand the mint authority to the program PDA. Point of no return.
await setAuthority(conn, payer, mintKp.publicKey, payer, AuthorityType.MintTokens, vaultAuthority);

// Prove the handoff from chain state, not from assumption.
const mintState = await getMint(conn, mintKp.publicKey);
const mintAuth = mintState.mintAuthority?.toBase58() ?? "null";
const freezeAuth = mintState.freezeAuthority?.toBase58() ?? "null";
if (mintAuth !== vaultAuthority.toBase58() || freezeAuth !== "null") {
  console.error("HANDOFF VERIFICATION FAILED:", { mintAuth, freezeAuth });
  process.exit(1);
}
console.log("=".repeat(72));
console.log("(d) AUTHORITY HANDOFF COMPLETE — verified on chain:");
console.log("    mint authority  :", mintAuth, "(vault_authority PDA)");
console.log("    freeze authority:", freezeAuth);
console.log("    The payer wallet now has ZERO power over the BEEF mint.");
console.log("=".repeat(72));

console.log("CREATED ADDRESSES:", JSON.stringify({
  beefMint: mintKp.publicKey.toBase58(),
  metadata: toWeb3JsPublicKey(metadataPda).toBase58(),
  vaultTokenAccount: vault.toBase58(),
  vaultAuthorityPda: vaultAuthority.toBase58(),
  treasuryAta: treasuryAta.toBase58(),
  treasuryWallet: treasuryWallet.toBase58(),
  supply: mintState.supply.toString(),
}, null, 2));
