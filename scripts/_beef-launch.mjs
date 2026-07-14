// Ops tool: one-shot MAINNET $BEEF launch parameters (idempotent, re-runnable).
// Signed by the KEEPER key (config.admin) — the same hot key _mainnet-init handed
// admin to. Every call here is admin-gated; the deploy/upgrade wallet is NOT used.
//
// ┌──────────────────────────────────────────────────────────────────────────┐
// │ ORDERING — READ BEFORE LAUNCH DAY:                                         │
// │   SWAPS FAIL until init_jackpot_config lands. execute_swap_{mock,real}     │
// │   reads the JackpotConfig PDA in settlement; the account does not exist    │
// │   until step 2 below. Therefore the program UPGRADE and THIS SCRIPT must   │
// │   run in ONE SITTING — never leave the upgraded program live without the   │
// │   JackpotConfig PDA, or the game halts on the next round's swap.           │
// │   Run order on launch day (plan 2026-07-14, Task 9):                       │
// │     solana program deploy (upgrade) → beef-mint-create.mjs → THIS SCRIPT   │
// └──────────────────────────────────────────────────────────────────────────┘
//
// Steps (each idempotent — probes on-chain state, then acts or SKIPs):
//   1. init_beef(210_000_000, 1_000_000_000, 21_000_000_000_000, 2000, 3,
//                30_000, 86_400, 60)              — skip if BeefConfig exists
//   2. init_jackpot_config()                      — skip if JackpotConfig exists
//   3. set_jackpot_params(25, 100)                — skip if already 25/100
//   4. set_fee_bps(500)                           — skip if already 500 (5%)
//   5. set_round_duration(60)                     — skip if already 60
// Note: init_jackpot_config seeds the PDA with the (25, 100) launch defaults, so
// step 3 legitimately SKIPs on a fresh launch — it exists as the tuning re-run guard.
// Prints the final Config + BeefConfig + JackpotConfig states.
//
// Usage:
//   RPC=<mainnet rpc> KEEPER_WALLET=<keypair path> \
//   BEEF_MINT=<mint pubkey> BEEF_VAULT=<vault token acct pubkey> \
//   BEEF_TREASURY_ATA=<treasury ATA pubkey>   # OR: TREASURY_WALLET=<owner pubkey> \
//   node scripts/_beef-launch.mjs
//
// BEEF_MINT / BEEF_VAULT / (BEEF_TREASURY_ATA | TREASURY_WALLET) all come straight
// from scripts/beef-mint-create.mjs's "CREATED ADDRESSES" output (beefMint,
// vaultTokenAccount, treasuryAta / treasuryWallet). When only TREASURY_WALLET is
// given, the treasury ATA is derived exactly as mint-create derived it
// (getAssociatedTokenAddressSync(beefMint, treasuryWallet), classic SPL).
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { Wallet } from "@coral-xyz/anchor";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { readFileSync } from "node:fs";
import {
  createProgram, BN,
  configPda, beefConfigPda, jackpotConfigPda,
  fetchConfig, fetchBeefConfig, fetchJackpotConfig,
  initBeefIx, initJackpotConfigIx, setJackpotParamsIx, setFeeBpsIx, setRoundDurationIx,
} from "@ansem/sdk";

const req = (k) => {
  const v = process.env[k];
  if (!v) { console.error(`missing env ${k}`); process.exit(1); }
  return v;
};
const kpOf = (p) => Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(p, "utf8"))));
const jstr = (o) => JSON.stringify(o, (k, v) => (typeof v === "bigint" ? v.toString() : v));

const conn = new Connection(req("RPC"), "confirmed");
const keeper = kpOf(req("KEEPER_WALLET"));
const beefMint = new PublicKey(req("BEEF_MINT"));
const beefVault = new PublicKey(req("BEEF_VAULT"));
// Treasury ATA: explicit BEEF_TREASURY_ATA wins; else derive from TREASURY_WALLET
// exactly as beef-mint-create.mjs did (classic SPL, on-curve owner).
const beefTreasury = process.env.BEEF_TREASURY_ATA
  ? new PublicKey(process.env.BEEF_TREASURY_ATA)
  : getAssociatedTokenAddressSync(beefMint, new PublicKey(req("TREASURY_WALLET")));

const asKeeper = createProgram(conn, new Wallet(keeper));

// Frozen launch parameters (spec 2026-07-14-beef-on-ansem-design D1/D4/D5/D6).
const P = {
  maxRoundMint: new BN("210000000"),        // 210 BEEF/round nominal (@6dp)
  satLamports: new BN("1000000000"),        // half-max at a 1 SOL pot
  hardCap: new BN("21000000000000"),        // 21,000,000 BEEF supply cap
  treasuryBps: 2000,                        // 20% continuous treasury cut (init-PINNED)
  tickBps: 3,                               // +0.03% hold-to-grow per tick
  bonusCapBps: 30000,                       // +300% -> 4x payout cap
  activityWindowSecs: new BN("86400"),      // daily-streak activity gate
  secsPerTick: new BN("60"),                // one tick per round-length
  jackpotTriggerOdds: 25,                   // 1-in-25 winner rounds fire the jackpot
  jackpotCapMult: 100,                      // bite <= 100x winning-square value
  feeBps: 500,                              // 5% pot fee
  roundDurationSecs: 60,                    // 60s rounds
};

console.log("$BEEF LAUNCH:", jstr({
  rpc: conn.rpcEndpoint,
  keeperAdmin: keeper.publicKey.toBase58(),
  beefMint: beefMint.toBase58(),
  beefVault: beefVault.toBase58(),
  beefTreasury: beefTreasury.toBase58(),
  params: {
    ...P,
    maxRoundMint: P.maxRoundMint.toString(), satLamports: P.satLamports.toString(),
    hardCap: P.hardCap.toString(), activityWindowSecs: P.activityWindowSecs.toString(),
    secsPerTick: P.secsPerTick.toString(),
  },
}));

const rpc = { commitment: "confirmed" };

// ── Step 1: init_beef (skip if BeefConfig exists) ──────────────────────────
if (!(await conn.getAccountInfo(beefConfigPda()))) {
  const sig = await initBeefIx(
    asKeeper, keeper.publicKey, beefMint, beefVault, beefTreasury,
    P.maxRoundMint, P.satLamports, P.hardCap, P.treasuryBps,
    P.tickBps, P.bonusCapBps, P.activityWindowSecs, P.secsPerTick,
  ).rpc(rpc);
  console.log(`1. init_beef DONE (maxRoundMint=${P.maxRoundMint}, sat=${P.satLamports}, ` +
    `hardCap=${P.hardCap}, treasuryBps=${P.treasuryBps}, tickBps=${P.tickBps}, ` +
    `bonusCapBps=${P.bonusCapBps}, window=${P.activityWindowSecs}, secsPerTick=${P.secsPerTick}) ->`, sig);
} else {
  const bc = await fetchBeefConfig(asKeeper, beefConfigPda());
  console.log("1. init_beef SKIPPED — BeefConfig exists:", jstr(bc));
  if (bc.beefMint !== beefMint.toBase58())
    console.warn(`   WARN pinned beefMint ${bc.beefMint} != env BEEF_MINT ${beefMint.toBase58()}`);
  if (bc.beefVault !== beefVault.toBase58())
    console.warn(`   WARN pinned beefVault ${bc.beefVault} != env BEEF_VAULT ${beefVault.toBase58()}`);
  if (bc.beefTreasury !== beefTreasury.toBase58())
    console.warn(`   WARN pinned beefTreasury ${bc.beefTreasury} != resolved treasury ATA ${beefTreasury.toBase58()}`);
}

// ── Step 2: init_jackpot_config (skip if JackpotConfig exists) ─────────────
if (!(await conn.getAccountInfo(jackpotConfigPda()))) {
  const sig = await initJackpotConfigIx(asKeeper, keeper.publicKey).rpc(rpc);
  console.log("2. init_jackpot_config DONE (seeds PDA with launch defaults) ->", sig);
} else {
  console.log("2. init_jackpot_config SKIPPED — JackpotConfig exists:",
    jstr(await fetchJackpotConfig(asKeeper, jackpotConfigPda())));
}

// ── Step 3: set_jackpot_params(25, 100) (skip if already equal) ────────────
{
  const jc = await fetchJackpotConfig(asKeeper, jackpotConfigPda());
  if (jc.triggerOdds === P.jackpotTriggerOdds && jc.capMult === P.jackpotCapMult) {
    console.log(`3. set_jackpot_params SKIPPED — already triggerOdds=${jc.triggerOdds}, capMult=${jc.capMult}`);
  } else {
    const sig = await setJackpotParamsIx(asKeeper, keeper.publicKey, P.jackpotTriggerOdds, P.jackpotCapMult).rpc(rpc);
    console.log(`3. set_jackpot_params DONE (triggerOdds ${jc.triggerOdds}->${P.jackpotTriggerOdds}, ` +
      `capMult ${jc.capMult}->${P.jackpotCapMult}) ->`, sig);
  }
}

// ── Step 4: set_fee_bps(500) (skip if already 500) ─────────────────────────
{
  const c = await fetchConfig(asKeeper, configPda());
  if (c.feeBps === P.feeBps) {
    console.log(`4. set_fee_bps SKIPPED — already ${c.feeBps} bps`);
  } else {
    const sig = await setFeeBpsIx(asKeeper, keeper.publicKey, P.feeBps).rpc(rpc);
    console.log(`4. set_fee_bps DONE (${c.feeBps}->${P.feeBps} bps) ->`, sig);
  }
}

// ── Step 5: set_round_duration(60) (skip if already 60) ────────────────────
{
  const c = await fetchConfig(asKeeper, configPda());
  if (c.roundDurationSecs === P.roundDurationSecs) {
    console.log(`5. set_round_duration SKIPPED — already ${c.roundDurationSecs}s`);
  } else {
    const sig = await setRoundDurationIx(asKeeper, keeper.publicKey, P.roundDurationSecs).rpc(rpc);
    console.log(`5. set_round_duration DONE (${c.roundDurationSecs}->${P.roundDurationSecs}s) ->`, sig);
  }
}

// ── Final state ────────────────────────────────────────────────────────────
console.log("=".repeat(72));
console.log("FINAL Config       :", jstr(await fetchConfig(asKeeper, configPda())));
console.log("FINAL BeefConfig   :", jstr(await fetchBeefConfig(asKeeper, beefConfigPda())));
console.log("FINAL JackpotConfig:", jstr(await fetchJackpotConfig(asKeeper, jackpotConfigPda())));
console.log("=".repeat(72));
console.log("$BEEF launch parameters applied. Swaps now settle against JackpotConfig.");
