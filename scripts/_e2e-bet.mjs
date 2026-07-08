// Ops proof: a scripted player runs the FULL bet loop against the LIVE keeper —
// fund -> deposit -> one-popup entry batch -> gasless session stake x2 squares ->
// keeper settles+swaps -> claim -> assert ANSEM received + escrow unlocked.
// Uses the same SDK builders the app's write path uses.
// Usage: RPC=<l1 rpc> node scripts/_e2e-bet.mjs
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { Wallet } from "@coral-xyz/anchor";
import { readFileSync } from "node:fs";
import {
  createProgram, createErProgram, configPda, roundPda, minerPda, escrowPda,
  fetchConfig, fetchEscrow, RoundState, DLP_PROGRAM_ID,
  depositIx, claimIx, buildEntryInstructions, awaitOwnerIs, awaitEr, l1Send, sleep,
  DEFAULT_ER_ENDPOINT, DEFAULT_ER_WS_ENDPOINT, DEFAULT_ER_VALIDATOR, BN,
} from "@ansem/sdk";

const RPC = process.env.RPC || "https://api.devnet.solana.com";
const KEEPER_HTTP = process.env.KEEPER_HTTP || "http://127.0.0.1:8787";
const step = (m, x = "") => console.log(`[e2e-bet] ${m}`, x);

const conn = new Connection(RPC, "confirmed");
const admin = Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(`${process.env.HOME}/.config/solana/ansem-devnet.json`, "utf8"))));
const adminProgram = createProgram(conn, new Wallet(admin));

const snapshot = async () => (await fetch(`${KEEPER_HTTP}/snapshot`)).json();

// 1. Fresh player, funded by admin (0.1 SOL — covers deposit + fees).
const player = Keypair.generate();
step("player", player.publicKey.toBase58());
await l1Send(() => adminProgram.provider.sendAndConfirm(
  new Transaction().add(SystemProgram.transfer({
    fromPubkey: admin.publicKey, toPubkey: player.publicKey, lamports: 0.1 * LAMPORTS_PER_SOL,
  }))));
const pWallet = new Wallet(player);
const l1 = createProgram(conn, pWallet);

// 2. Deposit 0.05 SOL into escrow (wallet-signed, like the app's ESCROW panel).
await l1Send(() => depositIx(l1, player.publicKey, new BN(0.05 * LAMPORTS_PER_SOL)).signers([player]).rpc());
step("deposited 0.05 SOL");

// 3. Wait for an OPEN round with >=30s runway (reading the keeper snapshot, like the app).
let roundId = 0;
for (let i = 0; i < 60; i++) {
  const s = await snapshot().catch(() => null);
  const now = Math.floor(Date.now() / 1000);
  if (s && s.state === RoundState.Open && s.deadlineTs - now >= 30) { roundId = s.roundId; break; }
  await sleep(2000);
}
if (!roundId) throw new Error("no OPEN round with runway from the keeper");
step("locked onto round", roundId);
await awaitOwnerIs(conn, roundPda(roundId), DLP_PROGRAM_ID.toBase58());

// 4. ONE-POPUP entry batch (init_miner + createSessionV2 + join_round + delegate_miner),
//    exactly the app's enterRound path (SDK buildEntryInstructions).
const entry = await buildEntryInstructions(
  l1, conn, pWallet, roundId, new PublicKey(DEFAULT_ER_VALIDATOR),
  Math.floor(Date.now() / 1000) + 3600, { includeInitMiner: true },
);
const tx = new Transaction().add(...entry.instructions);
tx.feePayer = player.publicKey;
tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
tx.partialSign(entry.sessionSigner);
tx.partialSign(player);
await l1Send(() => conn.sendRawTransaction(tx.serialize(), { skipPreflight: true }));
const esc = await awaitEr(() => fetchEscrow(l1, escrowPda(player.publicKey)), (e) => e?.activeRound === roundId, 30, 1000);
if (esc?.activeRound !== roundId) throw new Error("entry did not land (activeRound mismatch)");
await awaitOwnerIs(conn, minerPda(player.publicKey), DLP_PROGRAM_ID.toBase58());
step("ONE-POPUP entry landed (joined + delegated + session minted)");

// 5. GASLESS stake on TWO squares — signed ONLY by the session key on the ER
//    (the wallet never signs; multi-square like the app's new stake rail).
const erConn = new Connection(DEFAULT_ER_ENDPOINT, { wsEndpoint: DEFAULT_ER_WS_ENDPOINT, commitment: "confirmed" });
const er = createErProgram(erConn, new Wallet(entry.sessionSigner));
const STAKE = new BN(0.01 * LAMPORTS_PER_SOL);
for (const sq of [3, 11]) {
  for (let i = 0; i < 8; i++) {
    try {
      await er.methods.stake(sq, STAKE).accounts({
        authority: entry.sessionSigner.publicKey, config: configPda(), round: roundPda(roundId),
        miner: minerPda(player.publicKey), escrow: escrowPda(player.publicKey), sessionToken: entry.tokenPda,
      }).signers([entry.sessionSigner]).rpc({ skipPreflight: true, commitment: "confirmed" });
      break;
    } catch (e) { if (i === 7) throw e; await sleep(2000); }
  }
  step(`gasless stake landed on square ${sq} (0.01 SOL, session-signed)`);
}

// 6. Wait for the LIVE keeper to settle + swap this round (state -> CLAIMABLE).
let claimable = false;
for (let i = 0; i < 90; i++) {
  const s = await snapshot().catch(() => null);
  if (s && s.roundId === roundId && s.state === RoundState.Claimable) { claimable = true; break; }
  if (s && s.roundId > roundId) { claimable = true; break; } // keeper already moved on — round finalized
  await sleep(3000);
}
if (!claimable) throw new Error("keeper never brought the round to CLAIMABLE");
step("keeper settled + swapped the round");

// 7. CLAIM (wallet-signed, like the app's Claim button) + assert the payout.
await l1Send(() => claimIx(l1, player.publicKey, roundId).signers([player]).rpc());
const cfg = await fetchConfig(adminProgram, configPda());
const atas = await conn.getParsedTokenAccountsByOwner(player.publicKey, { mint: new PublicKey(cfg.ansemMint) });
const ansem = atas.value.reduce((n, a) => n + Number(a.account.data.parsed.info.tokenAmount.amount), 0);
const escAfter = await fetchEscrow(l1, escrowPda(player.publicKey));
step("claimed", { ansemBaseUnits: ansem, lastClaimedRound: escAfter?.lastClaimedRound, activeRound: escAfter?.activeRound });

if (escAfter?.lastClaimedRound !== roundId) throw new Error("claim did not reconcile lastClaimedRound");
if (ansem <= 0) throw new Error("claim minted 0 ANSEM (astronomically unlikely double-zero draw — rerun)");
console.log(`\nE2E BET PROOF: PASS — round ${roundId}: deposit -> one-popup entry -> 2x gasless stakes -> VRF settle -> claim minted ${(ansem / 1e6).toFixed(2)} ANSEM`);
