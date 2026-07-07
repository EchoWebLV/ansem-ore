import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { AnsemMiner } from "../target/types/ansem_miner";
import { Connection, PublicKey, Keypair, SystemProgram, Transaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, getAccount } from "@solana/spl-token";
import { SessionTokenManager } from "@magicblock-labs/gum-sdk";
import { GetCommitmentSignature } from "@magicblock-labs/ephemeral-rollups-sdk";
import { assert } from "chai";

// ANSEM Miner — M3 devnet smoke. Reuses the proven flow (mirrors ansem-miner-vrf.ts)
// but adapted for DEVNET: idempotent (no genesis reset), player funded by transfer
// (devnet airdrop is throttled), a FRESH round-id per run, a regional MagicBlock ER
// endpoint (NOT the router), and the real permissioned VRF oracle. All endpoints from
// scripts/devnet-env.sh via process.env — `source` it before running.

const DLP_PROGRAM_ID = "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh";
const enc = (s: string) => Buffer.from(s);
const roundSeed = (id: number) => new anchor.BN(id).toArrayLike(Buffer, "le", 8);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function awaitOwner(conn: Connection, pubkey: PublicKey, tries = 40): Promise<string> {
  for (let i = 0; i < tries; i++) {
    const acc = await conn.getAccountInfo(pubkey, "confirmed");
    if (acc) return acc.owner.toBase58();
    await sleep(500);
  }
  throw new Error(`account ${pubkey.toBase58()} not found after ${tries} tries`);
}

async function awaitOwnerIs(conn: Connection, pubkey: PublicKey, expected: string, tries = 60): Promise<void> {
  let last = "?";
  for (let i = 0; i < tries; i++) {
    const acc = await conn.getAccountInfo(pubkey, "confirmed");
    if (acc) { last = acc.owner.toBase58(); if (last === expected) return; }
    await sleep(500);
  }
  throw new Error(`owner of ${pubkey.toBase58()} = ${last}, expected ${expected}`);
}

async function awaitEr<T>(fetchFn: () => Promise<T>, pred: (v: T) => boolean, tries = 60): Promise<T> {
  let last: T | undefined;
  for (let i = 0; i < tries; i++) {
    try { last = await fetchFn(); if (pred(last)) return last; } catch (_) { /* read lag */ }
    await sleep(500);
  }
  throw new Error(`predicate not satisfied after ${tries} tries (last=${JSON.stringify(last)})`);
}

// Send an ER tx tolerating the confirm flake; caller confirms via state polling.
async function erRpcTolerant(send: () => Promise<string>): Promise<void> {
  try { await send(); }
  catch (e: any) {
    const s = String(e);
    if (!/Unknown action|not confirmed|block height exceeded|Invalid response|failed to get|timeout|Blockhash not found/i.test(s)) throw e;
  }
}

const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);
const program = anchor.workspace.AnsemMiner as Program<AnsemMiner>;
const admin = provider.wallet as anchor.Wallet;

// ER provider — a SPECIFIC regional MagicBlock devnet ER endpoint (NOT the router:
// ER writes through devnet-router.magicblock.app fail "Blockhash not found"). Must
// match the region of the validator we delegate to (VALIDATOR). Set via devnet-env.sh.
const erConnection = new Connection(
  process.env.EPHEMERAL_PROVIDER_ENDPOINT || "https://devnet-us.magicblock.app",
  { wsEndpoint: process.env.EPHEMERAL_WS_ENDPOINT || "wss://devnet-us.magicblock.app", commitment: "confirmed" }
);
const erProvider = new anchor.AnchorProvider(erConnection, anchor.Wallet.local(), { commitment: "confirmed" });
const ephemeralProgram = new Program<AnsemMiner>(program.idl, erProvider);

const VALIDATOR = new PublicKey(process.env.VALIDATOR || "MUS3hc9TCw4cGC12vHNoYcCGzJG1txjgQLZWVoeNHNd");
const validatorMeta = [{ pubkey: VALIDATOR, isSigner: false, isWritable: false }];
const VRF_BASE_QUEUE = new PublicKey(process.env.VRF_BASE_QUEUE || "Cuj97ggrhhidhbu39TijNVqE74xvKJ69gDervRUXAxGh");

const [configPda] = PublicKey.findProgramAddressSync([enc("config")], program.programId);
const [potVaultPda] = PublicKey.findProgramAddressSync([enc("pot_vault")], program.programId);
const [ansemMint] = PublicKey.findProgramAddressSync([enc("ansem_mint")], program.programId);
const [vaultAuth] = PublicKey.findProgramAddressSync([enc("vault_auth")], program.programId);
const [mintAuth] = PublicKey.findProgramAddressSync([enc("mint_auth")], program.programId);
const [treasury] = PublicKey.findProgramAddressSync([enc("treasury")], program.programId);
const payoutVault = getAssociatedTokenAddressSync(ansemMint, vaultAuth, true);

// Account bundles parametrized by the fresh round / player (lottery model: a
// single payout_vault, no reserve jackpots).
const swapAccounts = (roundPda: PublicKey) => ({
  payer: admin.publicKey, round: roundPda, ansemMint, mintAuthority: mintAuth,
  vaultAuthority: vaultAuth, payoutVault, potVault: potVaultPda, treasury,
});
const claimAccounts = (player: PublicKey, playerAta: PublicKey, roundPda: PublicKey) => ({
  authority: player, round: roundPda, ansemMint, vaultAuthority: vaultAuth,
  payoutVault, playerAta,
});

// ---- Devnet-realism helpers (no genesis reset to lean on) ----

// initialize is one-time; create-or-skip.
let migrated = false;
async function ensureInitialized() {
  if (migrated) return; // fresh lottery config already created this run
  // M4b migration: the old on-chain Config is byte-incompatible with the new
  // lottery layout → close it (if present) so a fresh initialize can run.
  const info = await provider.connection.getAccountInfo(configPda, "confirmed").catch(() => null);
  if (info) {
    await program.methods.closeConfig().accounts({ admin: admin.publicKey }).rpc();
    console.log("   M4b migration: closed old-layout config");
  }
  await program.methods.initialize().accounts({ admin: admin.publicKey }).rpc();
  // Flat 50% return band so a sole ER staker always mines > 0 ANSEM regardless of
  // which square is the VRF-picked jackpot square.
  await program.methods.setReturnBand(5000, 5000).accounts({ admin: admin.publicKey }).rpc();
  console.log("   initialized fresh lottery config + set flat 50% band on devnet");
  migrated = true;
}

// Deadline-gate commit ordering (lottery model): commit the miner while the round
// is STILL delegated (its read-only gate account must be available on the ER),
// retrying until the ON-CHAIN clock passes the deadline (CommitTooEarly); confirm
// the ER->L1 flush via GetCommitmentSignature; THEN commit the round.
async function commitMinerThenRound(roundPda: PublicKey, minerPda: PublicKey) {
  for (let i = 0; i < 80; i++) {
    const cur = await provider.connection.getAccountInfo(minerPda, "confirmed").catch(() => null);
    if (cur && cur.owner.toBase58() === program.programId.toBase58()) break;
    try {
      const sig = await ephemeralProgram.methods.commitMiner()
        .accounts({ payer: admin.publicKey, miner: minerPda, round: roundPda })
        .rpc({ skipPreflight: true, commitment: "confirmed" });
      await GetCommitmentSignature(sig, erConnection);
      break;
    } catch (e: any) {
      if (/CommitTooEarly/.test(String(e))) { await sleep(2000); continue; }
      await sleep(2000); // ER confirm flake — retry; owner pre-check confirms a landed tx
    }
  }
  await awaitOwnerIs(provider.connection, minerPda, program.programId.toBase58());
  await erRpcTolerant(() => ephemeralProgram.methods.commitRound()
    .accounts({ payer: admin.publicKey, config: configPda, round: roundPda })
    .rpc({ skipPreflight: true, commitment: "confirmed" }));
  await awaitOwnerIs(provider.connection, roundPda, program.programId.toBase58());
}

// Fund an ephemeral player from the deploy wallet (devnet airdrop is throttled).
async function fundFromAdmin(to: PublicKey, lamports: number) {
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: to, lamports }));
  await provider.sendAndConfirm(tx);
}

function nextRoundPda(id: number): PublicKey {
  return PublicKey.findProgramAddressSync([enc("round"), roundSeed(id)], program.programId)[0];
}

// createRound makes round (current_round_id + 1); read the id back from config.
// Self-heals: if a prior run died mid-round (current round unfinalized), cancel it
// (past-deadline) so a fresh round can open — devnet has no genesis reset.
async function createFreshRound(durationSecs = 25): Promise<{ id: number; pda: PublicKey }> {
  const cfg0: any = await program.account.config.fetch(configPda);
  if (!cfg0.currentRoundFinalized && cfg0.currentRoundId.toNumber() > 0) {
    const curId = cfg0.currentRoundId.toNumber();
    const curPda = nextRoundPda(curId);
    const info = await provider.connection.getAccountInfo(curPda, "confirmed");
    if (info) {
      // A prior ER run may have left the round DELEGATED (DLP-owned) — commit +
      // undelegate it back to L1 before it can be cancelled (M2a task-9 pattern).
      if (info.owner.toBase58() === DLP_PROGRAM_ID) {
        console.log(`   self-heal: committing delegated stranded round ${curId} back to L1`);
        await erRpcTolerant(() => ephemeralProgram.methods.commitRound()
          .accounts({ payer: admin.publicKey, config: configPda, round: curPda })
          .rpc({ skipPreflight: true, commitment: "confirmed" }));
        await awaitOwnerIs(provider.connection, curPda, program.programId.toBase58());
      }
      const r: any = await program.account.round.fetch(curPda).catch(() => null);
      if (r && r.state !== 4 && r.state !== 5) { // not Claimable/Closed → cancelable
        console.log(`   self-heal: cancelling stranded round ${curId} (state=${r.state})`);
        await retryPastDeadline(() => program.methods.cancelRound().accounts({ admin: admin.publicKey, round: curPda }).rpc(), "self-heal cancel");
      }
    }
  }
  await program.methods.setRoundDuration(new anchor.BN(durationSecs)).accounts({ admin: admin.publicKey }).rpc();
  const cfg: any = await program.account.config.fetch(configPda);
  const newId = cfg.currentRoundId.toNumber() + 1;
  const pda = nextRoundPda(newId);
  await program.methods.createRound().accounts({ payer: admin.publicKey, round: pda }).rpc();
  return { id: newId, pda };
}

// Devnet propagation guard: block until the escrow's active_round write from
// join_round is visible, so a follow-up stake can't read a stale active_round=0
// and fail NotCurrentRound (join and stake may hit different RPC nodes).
async function awaitJoined(escrowPda: PublicKey, id: number) {
  await awaitEr(() => program.account.playerEscrow.fetch(escrowPda), (e: any) => e.activeRound.toNumber() === id, 30);
}

// The on-chain (validator) clock LAGS real wall-clock on devnet, so a deadline-gated
// call (settle / cancel_round) is rejected even after local Date.now() passes the
// deadline. Retry the actual instruction until the validator clock catches up.
async function retryPastDeadline(fn: () => Promise<any>, label: string, tries = 110): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try { await fn(); return; }
    catch (e: any) {
      const s = String(e);
      if (!/RoundNotEnded|RoundNotCancelable|Blockhash not found|Too Many Requests|429|not confirmed|block height/i.test(s)) throw e;
      await sleep(2000);
    }
  }
  await fn(); // final attempt surfaces the real error if it still fails
}

// Retry a base-L1 send on PRE-send transient RPC failures ONLY (blockhash-fetch
// 429 / rate-limit from the dev-tier endpoint). Safe from double-execution: the
// tx never left the client. Does NOT retry post-send/confirmation failures.
async function l1Send(fn: () => Promise<any>, tries = 6): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try { await fn(); return; }
    catch (e: any) {
      const s = String(e);
      if (i === tries - 1 || !/failed to get recent blockhash|getLatestBlockhash|429|rate limited|Too Many Requests/i.test(s)) throw e;
      await sleep(2000 * (i + 1));
    }
  }
}

describe("ansem-miner (M3 devnet)", () => {
  // Dev-tier Helius throttles under sustained load; space tests so the rate-limit
  // bucket refills between them (each test is green in isolation).
  afterEach(async () => { await sleep(12000); });

  it("phase 1: L1 flow — init(idempotent) -> round -> deposit -> stake(wallet) -> settle -> swap -> claim", async function () {
    this.timeout(240000);
    const player = Keypair.generate();
    const [escrowPda] = PublicKey.findProgramAddressSync([enc("escrow"), player.publicKey.toBuffer()], program.programId);
    const [minerPda] = PublicKey.findProgramAddressSync([enc("miner"), player.publicKey.toBuffer()], program.programId);
    const playerAta = getAssociatedTokenAddressSync(ansemMint, player.publicKey);

    await ensureInitialized();
    await fundFromAdmin(player.publicKey, 0.1 * anchor.web3.LAMPORTS_PER_SOL);
    await program.methods.deposit(new anchor.BN(0.05 * anchor.web3.LAMPORTS_PER_SOL))
      .accounts({ authority: player.publicKey }).signers([player]).rpc();

    const { id, pda: roundPda } = await createFreshRound();
    console.log(`   created round ${id}`);
    await program.methods.initMiner().accounts({ authority: player.publicKey }).signers([player]).rpc()
      .catch((e: any) => { if (!/already in use/.test(String(e))) throw e; });

    await program.methods.joinRound(new anchor.BN(id))
      .accounts({ authority: player.publicKey, config: configPda, escrow: escrowPda }).signers([player]).rpc();
    await awaitJoined(escrowPda, id);
    await program.methods.stake(0, new anchor.BN(0.02 * anchor.web3.LAMPORTS_PER_SOL))
      .accounts({ authority: player.publicKey, config: configPda, round: roundPda, miner: minerPda, escrow: escrowPda, sessionToken: null })
      .signers([player]).rpc();

    // Wait out the deadline, then admin-settle (M1 fallback — no VRF in phase 1),
    // reconcile, swap, claim. settle takes ONLY randomness (round_id is from seeds).
    await retryPastDeadline(() => program.methods.settle(Array(32).fill(7))
      .accounts({ admin: admin.publicKey, round: roundPda, config: configPda }).rpc(), "settle");
    await program.methods.reconcileMiner(new anchor.BN(id))
      .accounts({ config: configPda, escrow: escrowPda, miner: minerPda }).rpc();
    await program.methods.executeSwapMock().accounts(swapAccounts(roundPda)).rpc();
    assert.equal((await program.account.round.fetch(roundPda)).state, 4, "round CLAIMABLE");
    await program.methods.claim(new anchor.BN(id))
      .accounts(claimAccounts(player.publicKey, playerAta, roundPda)).signers([player]).rpc();

    // Poll the ATA read — the claim mint may not have propagated to the read node yet.
    const minted = await awaitEr(
      async () => Number((await getAccount(provider.connection, playerAta)).amount),
      (a: number) => a > 0, 25);
    assert.isAbove(minted, 0, "player mined ANSEM on devnet L1");
    console.log(`   ✓ mined ${minted} ANSEM base units on devnet`);
  });

  it("phase 1: session-key CPI works against the live devnet gum program", async function () {
    this.timeout(240000);
    const player = Keypair.generate();
    const [escrowPda] = PublicKey.findProgramAddressSync([enc("escrow"), player.publicKey.toBuffer()], program.programId);
    const [minerPda] = PublicKey.findProgramAddressSync([enc("miner"), player.publicKey.toBuffer()], program.programId);

    await ensureInitialized();
    await fundFromAdmin(player.publicKey, 0.1 * anchor.web3.LAMPORTS_PER_SOL);
    await program.methods.deposit(new anchor.BN(0.05 * anchor.web3.LAMPORTS_PER_SOL))
      .accounts({ authority: player.publicKey }).signers([player]).rpc();
    await program.methods.initMiner().accounts({ authority: player.publicKey }).signers([player]).rpc()
      .catch((e: any) => { if (!/already in use/.test(String(e))) throw e; });

    // Gum session-token manager for this player, against the LIVE devnet gum program.
    const gum = new SessionTokenManager(new anchor.Wallet(player), provider.connection).program;
    const sessionTokenPda = (signer: PublicKey, target: PublicKey) =>
      PublicKey.findProgramAddressSync(
        [enc("session_token_v2"), target.toBuffer(), signer.toBuffer(), player.publicKey.toBuffer()], gum.programId)[0];
    const createSession = async (signer: Keypair, target: PublicKey, validUntil: number) => {
      const tokenPda = sessionTokenPda(signer.publicKey, target);
      await gum.methods.createSessionV2(false, new anchor.BN(validUntil), null)
        .accounts({ sessionToken: tokenPda, sessionSigner: signer.publicKey, feePayer: player.publicKey, authority: player.publicKey, targetProgram: target })
        .signers([signer]).rpc();
      return tokenPda;
    };
    const nowSec = () => Math.floor(Date.now() / 1000);
    const sessionStake = (authority: Keypair, roundPda: PublicKey, tokenPda: PublicKey) =>
      program.methods.stake(0, new anchor.BN(0.02 * anchor.web3.LAMPORTS_PER_SOL))
        .accounts({ authority: authority.publicKey, config: configPda, round: roundPda, miner: minerPda, escrow: escrowPda, sessionToken: tokenPda })
        .signers([authority]).rpc();

    // Mint a valid + an already-expired session token against the devnet gum program.
    const goodKp = Keypair.generate();
    const goodTok = await createSession(goodKp, program.programId, nowSec() + 900);
    const expKp = Keypair.generate();
    const expTok = await createSession(expKp, program.programId, nowSec() - 60);
    console.log("   ✓ createSessionV2 CPI succeeded on the live devnet gum program");

    const { id, pda: roundPda } = await createFreshRound(30);
    await program.methods.joinRound(new anchor.BN(id))
      .accounts({ authority: player.publicKey, config: configPda, escrow: escrowPda }).signers([player]).rpc();
    await awaitJoined(escrowPda, id);

    // (1) VALID session-signed L1 stake passes — the wallet never signs the stake.
    await sessionStake(goodKp, roundPda, goodTok);
    const miner1: any = await program.account.minerPosition.fetch(minerPda);
    assert.isAbove(Number(miner1.blockStake[0]), 0, "valid session key staked on devnet");
    console.log("   ✓ valid session-key stake accepted by the gum-gated stake on devnet");

    // (2) EXPIRED session token is rejected by the session gate.
    let rejected = false;
    try { await sessionStake(expKp, roundPda, expTok); } catch (_) { rejected = true; }
    assert.isTrue(rejected, "expired session token must be rejected");
    console.log("   ✓ expired session token rejected on devnet");

    // Finalize: cancel once the validator clock passes the deadline, refund the lock.
    await retryPastDeadline(() => program.methods.cancelRound().accounts({ admin: admin.publicKey, round: roundPda }).rpc(), "cancel");
    await program.methods.refund(new anchor.BN(id)).accounts({ authority: player.publicKey, config: configPda, round: roundPda, escrow: escrowPda, miner: minerPda }).signers([player]).rpc();
  });

  it("phase 2: ER stake via the devnet ER -> commit round-trip to L1", async function () {
    this.timeout(360000);
    const player = Keypair.generate();
    const [escrowPda] = PublicKey.findProgramAddressSync([enc("escrow"), player.publicKey.toBuffer()], program.programId);
    const [minerPda] = PublicKey.findProgramAddressSync([enc("miner"), player.publicKey.toBuffer()], program.programId);
    const STAKE = new anchor.BN(0.02 * anchor.web3.LAMPORTS_PER_SOL);

    await ensureInitialized();
    await fundFromAdmin(player.publicKey, 0.1 * anchor.web3.LAMPORTS_PER_SOL);
    await program.methods.deposit(new anchor.BN(0.05 * anchor.web3.LAMPORTS_PER_SOL))
      .accounts({ authority: player.publicKey }).signers([player]).rpc();
    await program.methods.initMiner().accounts({ authority: player.publicKey }).signers([player]).rpc()
      .catch((e: any) => { if (!/already in use/.test(String(e))) throw e; });
    const { id, pda: roundPda } = await createFreshRound(120);

    // Delegate round + miner to the ER (validator identity from env VALIDATOR).
    await l1Send(() => program.methods.delegateRound(new anchor.BN(id))
      .accounts({ payer: admin.publicKey, round: roundPda })
      .remainingAccounts(validatorMeta).rpc({ skipPreflight: true, commitment: "confirmed" }));
    await awaitOwnerIs(provider.connection, roundPda, DLP_PROGRAM_ID); // poll until delegation propagates
    console.log("   ✓ round delegated to DLP");
    await l1Send(() => program.methods.delegateMiner()
      .accounts({ payer: player.publicKey, miner: minerPda })
      .remainingAccounts(validatorMeta).signers([player]).rpc({ skipPreflight: true, commitment: "confirmed" }));
    await awaitOwnerIs(provider.connection, minerPda, DLP_PROGRAM_ID);
    console.log("   ✓ miner delegated to DLP");

    await l1Send(() => program.methods.joinRound(new anchor.BN(id))
      .accounts({ authority: player.publicKey, config: configPda, escrow: escrowPda }).signers([player]).rpc());
    await awaitJoined(escrowPda, id);

    // Stake in the ER via the US regional endpoint (cold first-write can clone-lag → idempotent retry).
    for (let i = 0; i < 8; i++) {
      const m: any = await ephemeralProgram.account.minerPosition.fetch(minerPda).catch(() => null);
      if (m && m.blockStake[0].toString() === STAKE.toString()) break;
      await erRpcTolerant(() => ephemeralProgram.methods.stake(0, STAKE)
        .accounts({ authority: player.publicKey, config: configPda, round: roundPda, miner: minerPda, escrow: escrowPda, sessionToken: null })
        .signers([player]).rpc({ skipPreflight: true, commitment: "confirmed" }));
      await sleep(2500);
    }
    await awaitEr(() => ephemeralProgram.account.minerPosition.fetch(minerPda),
      (m: any) => m.blockStake[0].toString() === STAKE.toString(), 15);
    console.log("   ✓ stake executed inside the devnet ER (US regional endpoint)");

    // Deadline-gate: commit the miner (while delegated, past deadline) then round.
    await commitMinerThenRound(roundPda, minerPda);

    const round: any = await program.account.round.fetch(roundPda);
    assert.equal(round.state, 0, "committed round is OPEN on L1");
    assert.equal(round.pot.toString(), STAKE.toString(), "ER-committed pot landed on L1");
    console.log("   ✓ round + miner committed back to L1 (owner = program, pot present)");

    // Finalize: cancel past deadline, refund the lock.
    await retryPastDeadline(() => program.methods.cancelRound().accounts({ admin: admin.publicKey, round: roundPda }).rpc(), "cancel");
    await program.methods.refund(new anchor.BN(id)).accounts({ authority: player.publicKey, config: configPda, round: roundPda, escrow: escrowPda, miner: minerPda }).signers([player]).rpc().catch(() => {});
  });

  it("phase 3: ER stake -> commit -> request_settle -> real devnet VRF oracle -> Settled -> claim", async function () {
    this.timeout(600000); // devnet oracle fulfillment latency is unobserved — give it room
    const player = Keypair.generate();
    const [escrowPda] = PublicKey.findProgramAddressSync([enc("escrow"), player.publicKey.toBuffer()], program.programId);
    const [minerPda] = PublicKey.findProgramAddressSync([enc("miner"), player.publicKey.toBuffer()], program.programId);
    const playerAta = getAssociatedTokenAddressSync(ansemMint, player.publicKey);
    const STAKE = new anchor.BN(0.02 * anchor.web3.LAMPORTS_PER_SOL);

    await ensureInitialized();
    await fundFromAdmin(player.publicKey, 0.1 * anchor.web3.LAMPORTS_PER_SOL);
    await l1Send(() => program.methods.deposit(new anchor.BN(0.05 * anchor.web3.LAMPORTS_PER_SOL))
      .accounts({ authority: player.publicKey }).signers([player]).rpc());
    await program.methods.initMiner().accounts({ authority: player.publicKey }).signers([player]).rpc()
      .catch((e: any) => { if (!/already in use/.test(String(e))) throw e; });
    const { id, pda: roundPda } = await createFreshRound(90);

    // Delegate -> join -> ER stake -> commit (same proven Phase-2 flow).
    await l1Send(() => program.methods.delegateRound(new anchor.BN(id))
      .accounts({ payer: admin.publicKey, round: roundPda })
      .remainingAccounts(validatorMeta).rpc({ skipPreflight: true, commitment: "confirmed" }));
    await awaitOwnerIs(provider.connection, roundPda, DLP_PROGRAM_ID);
    await l1Send(() => program.methods.delegateMiner()
      .accounts({ payer: player.publicKey, miner: minerPda })
      .remainingAccounts(validatorMeta).signers([player]).rpc({ skipPreflight: true, commitment: "confirmed" }));
    await awaitOwnerIs(provider.connection, minerPda, DLP_PROGRAM_ID);
    await l1Send(() => program.methods.joinRound(new anchor.BN(id))
      .accounts({ authority: player.publicKey, config: configPda, escrow: escrowPda }).signers([player]).rpc());
    await awaitJoined(escrowPda, id);
    for (let i = 0; i < 8; i++) {
      const m: any = await ephemeralProgram.account.minerPosition.fetch(minerPda).catch(() => null);
      if (m && m.blockStake[0].toString() === STAKE.toString()) break;
      await erRpcTolerant(() => ephemeralProgram.methods.stake(0, STAKE)
        .accounts({ authority: player.publicKey, config: configPda, round: roundPda, miner: minerPda, escrow: escrowPda, sessionToken: null })
        .signers([player]).rpc({ skipPreflight: true, commitment: "confirmed" }));
      await sleep(2500);
    }
    await awaitEr(() => ephemeralProgram.account.minerPosition.fetch(minerPda),
      (m: any) => m.blockStake[0].toString() === STAKE.toString(), 15);
    await commitMinerThenRound(roundPda, minerPda);
    console.log("   ✓ staked in ER + committed to L1; requesting VRF settle on L1");

    // request_settle on L1 (needs Open + past-deadline). Idempotent + tolerant of
    // clock lag / rate limits: retry until the round leaves Open (-> VrfPending).
    for (let i = 0; i < 90; i++) {
      const r: any = await program.account.round.fetch(roundPda).catch(() => null);
      if (r && r.state !== 0) break;
      try {
        // NO skipPreflight: preflight surfaces a clean RoundNotEnded (clock lag)
        // for the retry regex; with skipPreflight it mangles to "Unknown action".
        await program.methods.requestSettle(7)
          .accounts({ payer: admin.publicKey, round: roundPda, config: configPda, oracleQueue: VRF_BASE_QUEUE })
          .rpc({ commitment: "confirmed" });
      } catch (e: any) {
        if (!/RoundNotEnded|BadRoundState|Blockhash not found|429|rate limited|Too Many Requests|not confirmed|block height/i.test(String(e))) throw e;
      }
      await sleep(2000);
    }
    const pending: any = await program.account.round.fetch(roundPda);
    assert.notEqual(pending.state, 0, "round left OPEN (request_settle posted the VRF request)");
    console.log(`   ✓ request_settle posted (state=${pending.state}); awaiting real devnet oracle...`);

    // Wait for the REAL permissioned devnet oracle to fulfill -> Settled (state 2).
    const settled: any = await awaitEr(() => program.account.round.fetch(roundPda), (r: any) => r.state === 2, 300);
    assert.notDeepEqual([...settled.randomness], new Array(32).fill(0), "oracle drew nonzero randomness");
    console.log("   ✓ devnet VRF oracle fulfilled -> round Settled with nonzero randomness");

    // L1 tail: reconcile -> swap -> claim.
    await l1Send(() => program.methods.reconcileMiner(new anchor.BN(id))
      .accounts({ config: configPda, escrow: escrowPda, miner: minerPda }).rpc());
    await l1Send(() => program.methods.executeSwapMock().accounts(swapAccounts(roundPda)).rpc());
    await l1Send(() => program.methods.claim(new anchor.BN(id))
      .accounts(claimAccounts(player.publicKey, playerAta, roundPda)).signers([player]).rpc());
    const minted = await awaitEr(async () => Number((await getAccount(provider.connection, playerAta)).amount), (a: number) => a > 0, 25);
    assert.isAbove(minted, 0, "player mined ANSEM via a real-VRF-settled devnet round");
    console.log(`   ✓ mined ${minted} ANSEM via the full VRF-settled devnet flow`);
  });

  it("phase 4: full e2e — session-key ER stake -> VRF settle -> claim (gasless, wallet never signs the stake)", async function () {
    this.timeout(600000);
    const player = Keypair.generate();
    const [escrowPda] = PublicKey.findProgramAddressSync([enc("escrow"), player.publicKey.toBuffer()], program.programId);
    const [minerPda] = PublicKey.findProgramAddressSync([enc("miner"), player.publicKey.toBuffer()], program.programId);
    const playerAta = getAssociatedTokenAddressSync(ansemMint, player.publicKey);
    const STAKE = new anchor.BN(0.02 * anchor.web3.LAMPORTS_PER_SOL);

    await ensureInitialized();
    await fundFromAdmin(player.publicKey, 0.1 * anchor.web3.LAMPORTS_PER_SOL);
    await l1Send(() => program.methods.deposit(new anchor.BN(0.05 * anchor.web3.LAMPORTS_PER_SOL))
      .accounts({ authority: player.publicKey }).signers([player]).rpc());
    await program.methods.initMiner().accounts({ authority: player.publicKey }).signers([player]).rpc()
      .catch((e: any) => { if (!/already in use/.test(String(e))) throw e; });

    // Mint a SessionTokenV2 on L1 against the live devnet gum program (one wallet approval).
    const gum = new SessionTokenManager(new anchor.Wallet(player), provider.connection).program;
    const sessionKp = Keypair.generate();
    const [tokenPda] = PublicKey.findProgramAddressSync(
      [enc("session_token_v2"), program.programId.toBuffer(), sessionKp.publicKey.toBuffer(), player.publicKey.toBuffer()], gum.programId);
    await l1Send(() => gum.methods.createSessionV2(false, new anchor.BN(Math.floor(Date.now() / 1000) + 900), null)
      .accounts({ sessionToken: tokenPda, sessionSigner: sessionKp.publicKey, feePayer: player.publicKey, authority: player.publicKey, targetProgram: program.programId })
      .signers([sessionKp]).rpc());
    const { id, pda: roundPda } = await createFreshRound(90);

    await l1Send(() => program.methods.delegateRound(new anchor.BN(id))
      .accounts({ payer: admin.publicKey, round: roundPda })
      .remainingAccounts(validatorMeta).rpc({ skipPreflight: true, commitment: "confirmed" }));
    await awaitOwnerIs(provider.connection, roundPda, DLP_PROGRAM_ID);
    await l1Send(() => program.methods.delegateMiner()
      .accounts({ payer: player.publicKey, miner: minerPda })
      .remainingAccounts(validatorMeta).signers([player]).rpc({ skipPreflight: true, commitment: "confirmed" }));
    await awaitOwnerIs(provider.connection, minerPda, DLP_PROGRAM_ID);
    await l1Send(() => program.methods.joinRound(new anchor.BN(id))
      .accounts({ authority: player.publicKey, config: configPda, escrow: escrowPda }).signers([player]).rpc());
    await awaitJoined(escrowPda, id);

    // ER stake signed ONLY by the ephemeral session key — the player wallet never
    // signs the stake (the gasless headline). authority = sessionKp; token supplied.
    for (let i = 0; i < 8; i++) {
      const m: any = await ephemeralProgram.account.minerPosition.fetch(minerPda).catch(() => null);
      if (m && m.blockStake[0].toString() === STAKE.toString()) break;
      await erRpcTolerant(() => ephemeralProgram.methods.stake(0, STAKE)
        .accounts({ authority: sessionKp.publicKey, config: configPda, round: roundPda, miner: minerPda, escrow: escrowPda, sessionToken: tokenPda })
        .signers([sessionKp]).rpc({ skipPreflight: true, commitment: "confirmed" }));
      await sleep(2500);
    }
    await awaitEr(() => ephemeralProgram.account.minerPosition.fetch(minerPda),
      (m: any) => m.blockStake[0].toString() === STAKE.toString(), 15);
    console.log("   ✓ ER stake signed ONLY by the session key (wallet never signed the stake)");

    await commitMinerThenRound(roundPda, minerPda);

    for (let i = 0; i < 90; i++) {
      const r: any = await program.account.round.fetch(roundPda).catch(() => null);
      if (r && r.state !== 0) break;
      try {
        await program.methods.requestSettle(9)
          .accounts({ payer: admin.publicKey, round: roundPda, config: configPda, oracleQueue: VRF_BASE_QUEUE })
          .rpc({ commitment: "confirmed" });
      } catch (e: any) {
        if (!/RoundNotEnded|BadRoundState|Blockhash not found|429|rate limited|Too Many Requests|not confirmed|block height/i.test(String(e))) throw e;
      }
      await sleep(2000);
    }
    const settled: any = await awaitEr(() => program.account.round.fetch(roundPda), (r: any) => r.state === 2, 300);
    assert.notDeepEqual([...settled.randomness], new Array(32).fill(0), "oracle drew nonzero randomness");

    await l1Send(() => program.methods.reconcileMiner(new anchor.BN(id))
      .accounts({ config: configPda, escrow: escrowPda, miner: minerPda }).rpc());
    await l1Send(() => program.methods.executeSwapMock().accounts(swapAccounts(roundPda)).rpc());
    await l1Send(() => program.methods.claim(new anchor.BN(id))
      .accounts(claimAccounts(player.publicKey, playerAta, roundPda)).signers([player]).rpc());
    const minted = await awaitEr(async () => Number((await getAccount(provider.connection, playerAta)).amount), (a: number) => a > 0, 25);
    assert.isAbove(minted, 0, "player mined ANSEM via the full gasless session->VRF devnet flow");
    console.log(`   ✓ E2E: session-key stake -> VRF settle -> mined ${minted} ANSEM on devnet`);
  });
});
