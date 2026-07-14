// Ops tool: seed the launch jackpot via STAKE-AND-ROLL (spec D7) — zero new
// program code. Loop rounds staking SEED_LAMPORTS_PER_ROUND on ONE square and
// let the misses roll into config.rolloverJackpot until it reaches the target.
//
// Why ~96% expected transfer: 24 of 25 rounds our square misses — under the
// live WTA band (0,0) nobody owns the jackpot square, so the stake's swapped
// ANSEM rolls into the jackpot; ~1 in 25 the jackpot lands on our square and
// we win our own stake back. (The protocol fee — 1% today, 5% at launch — is
// skimmed before the swap, so net transfer is ~96% of post-fee proceeds.)
//
// rolloverJackpot is denominated in ANSEM BASE UNITS (6 decimals), NOT lamports
// (jackpot is ANSEM, verified in finalize_swap_accounting). TARGET_ANSEM_BASE_UNITS
// must be sized off a live ANSEM/SOL quote at seed time (~2 SOL worth, D7).
//
// Round cadence is 300s today and becomes 60s at launch — this script POLLS
// round state via the SDK (fetchRound) and never assumes a duration.
//
// Usage:
//   RPC_URL=<mainnet rpc> SEEDER_WALLET=<keypair path> \
//   SEED_LAMPORTS_PER_ROUND=<lamports> TARGET_ANSEM_BASE_UNITS=<base units> \
//   MAX_ROUNDS=<hard stop> [SEED_SQUARE=0] \
//   node scripts/seed-jackpot-roll.mjs [--live]
//
// DRY-RUN IS THE DEFAULT: fetches the live config (read-only) and prints what
// it would do. Real mode requires the explicit --live flag AND all env present.
import { Connection, Keypair } from "@solana/web3.js";
import { Wallet } from "@coral-xyz/anchor";
import { readFileSync } from "node:fs";
import {
  createProgram, configPda, roundPda, fetchConfig, fetchRound,
  stakeDirectIx, rollBeefIx, beefRoundPda, RoundState, GRID_SIZE, BN,
} from "@ansem/sdk";
import { rollStampedRound } from "./_seed-beef-roll.mjs";

const req = (k) => {
  const v = process.env[k];
  if (!v) { console.error(`missing env ${k}`); process.exit(1); }
  return v;
};
const kpOf = (p) => Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(p, "utf8"))));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const human = (baseUnits) => (Number(baseUnits) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 2 });
const LIVE = process.argv.includes("--live");

const RPC = process.env.RPC_URL || process.env.RPC || "https://api.mainnet-beta.solana.com";
const perRound = BigInt(req("SEED_LAMPORTS_PER_ROUND"));
const target = BigInt(req("TARGET_ANSEM_BASE_UNITS"));
const maxRounds = Number(req("MAX_ROUNDS"));
const square = Number(process.env.SEED_SQUARE ?? "0");
if (!(square >= 0 && square < GRID_SIZE)) { console.error(`SEED_SQUARE must be 0..${GRID_SIZE - 1}`); process.exit(1); }
if (!(maxRounds > 0)) { console.error("MAX_ROUNDS must be > 0"); process.exit(1); }

// Wallet: required in --live (it signs stakes). In dry-run a throwaway keypair
// satisfies the SDK's provider — nothing is ever signed or sent.
const seeder = LIVE ? kpOf(req("SEEDER_WALLET"))
  : (process.env.SEEDER_WALLET ? kpOf(process.env.SEEDER_WALLET) : Keypair.generate());

const conn = new Connection(RPC, "confirmed");
const program = createProgram(conn, new Wallet(seeder));

const c0 = await fetchConfig(program, configPda());
console.log("SEED PLAN:", JSON.stringify({
  mode: LIVE ? "LIVE" : "DRY-RUN",
  rpc: RPC,
  seeder: LIVE || process.env.SEEDER_WALLET ? seeder.publicKey.toBase58() : "(throwaway — dry-run only)",
  square,
  perRoundLamports: perRound.toString(),
  perRoundSol: Number(perRound) / 1e9,
  maxRounds,
  currentRoundId: c0.currentRoundId,
  roundDurationSecs: c0.roundDurationSecs,
  rolloverJackpot: { raw: c0.rolloverJackpot.toString(), ansem: human(c0.rolloverJackpot) },
  target: { raw: target.toString(), ansem: human(target) },
  stakeBounds: { minStake: c0.minStake.toString(), maxStakePerRound: c0.maxStakePerRound.toString() },
}, null, 2));

if (perRound < c0.minStake || perRound > c0.maxStakePerRound) {
  console.error(`SEED_LAMPORTS_PER_ROUND out of config bounds [${c0.minStake}, ${c0.maxStakePerRound}]`);
  process.exit(1);
}
if (c0.rolloverJackpot >= target) {
  console.log("rolloverJackpot already >= target — nothing to do.");
  process.exit(0);
}
if (!LIVE) {
  console.log("DRY-RUN (default): nothing sent. Re-run with --live to stake for real.");
  process.exit(0);
}

// ---- LIVE MODE ----
let roundsStaked = 0;
let totalStaked = 0n;
const POLL_MS = 3000;
const SETTLE_TIMEOUT_MS = 15 * 60 * 1000; // per-round safety valve, poll-based (no duration assumption)
const ROLL_ATTEMPTS = Math.ceil(SETTLE_TIMEOUT_MS / POLL_MS);

while (true) {
  const c = await fetchConfig(program, configPda());
  if (c.rolloverJackpot >= target) {
    console.log(`TARGET REACHED: rolloverJackpot ${c.rolloverJackpot} (${human(c.rolloverJackpot)} ANSEM) >= ${target}`);
    break;
  }
  if (roundsStaked >= maxRounds) {
    console.log(`MAX_ROUNDS (${maxRounds}) hit — stopping short of target. rolloverJackpot: ${c.rolloverJackpot} (${human(c.rolloverJackpot)} ANSEM)`);
    break;
  }

  // Stake only into a round that is Open with a comfortable margin before the
  // deadline; otherwise wait for the keeper to open the next one.
  const rid = c.currentRoundId;
  const r = await fetchRound(program, roundPda(rid)).catch(() => null);
  const now = Math.floor(Date.now() / 1000);
  if (!r || r.state !== RoundState.Open || now >= r.deadlineTs - 5) {
    await sleep(POLL_MS);
    continue;
  }

  const sig = await stakeDirectIx(program, seeder.publicKey, rid, square, new BN(perRound.toString()))
    .rpc({ commitment: "confirmed" });
  roundsStaked += 1;
  totalStaked += perRound;
  console.log(`round ${rid}: staked ${perRound} lamports on square ${square} (${roundsStaked}/${maxRounds}) sig ${sig}`);

  // Poll until the round leaves the pre-settlement states (swap accounting —
  // which moves the rollover — completes by Claimable; Closed covers cancels).
  const start = Date.now();
  for (;;) {
    const rr = await fetchRound(program, roundPda(rid)).catch(() => null);
    if (rr && (rr.state >= RoundState.Claimable || rr.state === RoundState.Closed)) break;
    if (Date.now() - start > SETTLE_TIMEOUT_MS) {
      console.log(`round ${rid}: still not claimable after ${SETTLE_TIMEOUT_MS / 1000}s — re-checking config and continuing`);
      break;
    }
    await sleep(POLL_MS);
  }

  const rollSig = await rollStampedRound({
    roundId: rid,
    readBeefRound: (roundId) => program.account.beefRound.fetch(beefRoundPda(roundId)),
    sendRoll: (roundId) => rollBeefIx(program, seeder.publicKey, roundId)
      .rpc({ commitment: "confirmed" }),
    sleep,
    attempts: ROLL_ATTEMPTS,
    delayMs: POLL_MS,
  });
  console.log(`round ${rid}: rolled stamped BEEF for seeder sig ${rollSig}`);

  const cAfter = await fetchConfig(program, configPda());
  console.log(`round ${rid} settled | staked total ${totalStaked} lamports (${Number(totalStaked) / 1e9} SOL) | rolloverJackpot ${cAfter.rolloverJackpot} raw = ${human(cAfter.rolloverJackpot)} ANSEM (target ${human(target)})`);
}

console.log("DONE:", JSON.stringify({ roundsStaked, totalStakedLamports: totalStaked.toString() }));
