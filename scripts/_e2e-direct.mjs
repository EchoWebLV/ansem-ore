// Ops proof (direct-stake engine): fund -> ONE tx staking TWO squares straight
// from the wallet -> live keeper settles (L1 round, never delegated) -> claim ->
// assert ANSEM landed + miner zeroed (idempotent). The whole player journey is
// two wallet signatures: stake, claim.
// Usage: RPC=<l1 rpc> node scripts/_e2e-direct.mjs
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { Wallet } from "@coral-xyz/anchor";
import { readFileSync } from "node:fs";
import {
  createProgram, configPda, minerPda, fetchConfig, fetchMiner, RoundState,
  stakeDirectIx, claimDirectIx, l1Send, sleep, BN,
} from "@ansem/sdk";

const RPC = process.env.RPC || "https://api.devnet.solana.com";
const KEEPER_HTTP = process.env.KEEPER_HTTP || "http://127.0.0.1:8787";
const step = (m, x = "") => console.log(`[e2e-direct] ${m}`, x);

const conn = new Connection(RPC, "confirmed");
const admin = Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(`${process.env.HOME}/.config/solana/ansem-devnet.json`, "utf8"))));
const adminProgram = createProgram(conn, new Wallet(admin));
const snapshot = async () => (await fetch(`${KEEPER_HTTP}/snapshot`)).json();

// 1. Fresh player, funded 0.1 SOL.
const player = Keypair.generate();
step("player", player.publicKey.toBase58());
await l1Send(() => adminProgram.provider.sendAndConfirm(
  new Transaction().add(SystemProgram.transfer({
    fromPubkey: admin.publicKey, toPubkey: player.publicKey, lamports: 0.1 * LAMPORTS_PER_SOL,
  }))));
const l1 = createProgram(conn, new Wallet(player));

// 2. Wait for an OPEN round with >=25s runway (keeper snapshot, like the app).
let roundId = 0;
for (let i = 0; i < 60; i++) {
  const s = await snapshot().catch(() => null);
  const now = Math.floor(Date.now() / 1000);
  if (s && s.state === RoundState.Open && s.deadlineTs - now >= 25) { roundId = s.roundId; break; }
  await sleep(2000);
}
if (!roundId) throw new Error("no OPEN round with runway from the keeper");
step("locked onto direct round", roundId);

// 3. ONE transaction, TWO squares, SOL straight from the wallet (the single approval).
const STAKE = new BN(0.01 * LAMPORTS_PER_SOL);
const ix1 = await stakeDirectIx(l1, player.publicKey, roundId, 4, STAKE).instruction();
const ix2 = await stakeDirectIx(l1, player.publicKey, roundId, 17, STAKE).instruction();
const walletBefore = await conn.getBalance(player.publicKey);
await l1Send(() => l1.provider.sendAndConfirm(new Transaction().add(ix1, ix2)));
const walletAfter = await conn.getBalance(player.publicKey);
step("ONE-TX stake landed on squares 4+17", { walletDeltaSol: (walletBefore - walletAfter) / 1e9 });

const m = await fetchMiner(l1, minerPda(player.publicKey));
if (m?.roundId !== roundId || m.blockStake[4] !== 10_000_000n || m.blockStake[17] !== 10_000_000n)
  throw new Error("miner does not reflect the direct stakes");

// 4. The live keeper settles + swaps (round never delegated).
let done = false;
for (let i = 0; i < 90; i++) {
  const s = await snapshot().catch(() => null);
  if (s && (s.roundId > roundId || (s.roundId === roundId && s.state === RoundState.Claimable))) { done = true; break; }
  await sleep(3000);
}
if (!done) throw new Error("keeper never finalized the direct round");
step("keeper settled + swapped the direct round");

// 5. Claim (second and final wallet signature).
await l1Send(() => claimDirectIx(l1, player.publicKey, roundId).signers([player]).rpc());
const cfg = await fetchConfig(adminProgram, configPda());
const atas = await conn.getParsedTokenAccountsByOwner(player.publicKey, { mint: new PublicKey(cfg.ansemMint) });
const ansem = atas.value.reduce((n, a) => n + Number(a.account.data.parsed.info.tokenAmount.amount), 0);
const mAfter = await fetchMiner(l1, minerPda(player.publicKey));
const zeroed = mAfter.blockStake.every((b) => b === 0n);
step("claimed", { ansemBaseUnits: ansem, minerZeroed: zeroed });
if (!zeroed) throw new Error("miner not zeroed after claim");
if (ansem <= 0) throw new Error("claim minted 0 ANSEM (double-zero draw — rerun)");
console.log(`\nE2E DIRECT PROOF: PASS — round ${roundId}: ONE-TX 2-square wallet stake -> VRF settle -> claim minted ${(ansem / 1e6).toFixed(2)} ANSEM (2 signatures total)`);
