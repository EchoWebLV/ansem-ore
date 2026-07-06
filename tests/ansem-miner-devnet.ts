import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { AnsemMiner } from "../target/types/ansem_miner";
import { Connection, PublicKey, Keypair, SystemProgram, Transaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, getAccount } from "@solana/spl-token";
import { SessionTokenManager } from "@magicblock-labs/gum-sdk";
import { assert } from "chai";

// ANSEM Miner — M3 devnet smoke. Reuses the proven flow (mirrors ansem-miner-vrf.ts)
// but adapted for DEVNET: idempotent (no genesis reset), player funded by transfer
// (devnet airdrop is throttled), a FRESH round-id per run, the hosted MagicBlock ER
// router, and the real permissioned VRF oracle. All endpoints come from
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

// ER provider — the hosted MagicBlock devnet router (auto-routes per-tx by delegation).
const erConnection = new Connection(
  process.env.EPHEMERAL_PROVIDER_ENDPOINT || "https://devnet-router.magicblock.app",
  { wsEndpoint: process.env.EPHEMERAL_WS_ENDPOINT || "wss://devnet-router.magicblock.app", commitment: "confirmed" }
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
const [smallJackpotAuth] = PublicKey.findProgramAddressSync([enc("jackpot_sm_auth")], program.programId);
const [bigJackpotAuth] = PublicKey.findProgramAddressSync([enc("jackpot_big_auth")], program.programId);
const payoutVault = getAssociatedTokenAddressSync(ansemMint, vaultAuth, true);
const smallJackpotVault = getAssociatedTokenAddressSync(ansemMint, smallJackpotAuth, true);
const bigJackpotVault = getAssociatedTokenAddressSync(ansemMint, bigJackpotAuth, true);

// Account bundles parametrized by the fresh round / player (devnet uses fresh ids).
const swapAccounts = (roundPda: PublicKey) => ({
  payer: admin.publicKey, round: roundPda, ansemMint, mintAuthority: mintAuth,
  vaultAuthority: vaultAuth, payoutVault, smallJackpotAuthority: smallJackpotAuth,
  smallJackpotVault, bigJackpotAuthority: bigJackpotAuth, bigJackpotVault,
  potVault: potVaultPda, treasury,
});
const claimAccounts = (player: PublicKey, playerAta: PublicKey, roundPda: PublicKey) => ({
  authority: player, round: roundPda, ansemMint, vaultAuthority: vaultAuth,
  smallJackpotAuthority: smallJackpotAuth, bigJackpotAuthority: bigJackpotAuth,
  payoutVault, smallJackpotVault, bigJackpotVault, playerAta,
});

// ---- Devnet-realism helpers (no genesis reset to lean on) ----

// initialize is one-time; create-or-skip.
async function ensureInitialized() {
  const cfg = await program.account.config.fetch(configPda).catch(() => null);
  if (cfg) { console.log(`   config exists (current_round_id=${cfg.currentRoundId}) — skip initialize`); return; }
  await program.methods.initialize().accounts({ admin: admin.publicKey }).rpc();
  console.log("   initialized config + mint + vaults on devnet");
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
    const curPda = nextRoundPda(cfg0.currentRoundId.toNumber());
    const r: any = await program.account.round.fetch(curPda).catch(() => null);
    if (r && r.state !== 4 && r.state !== 5) { // not Claimable/Closed → cancelable
      console.log(`   self-heal: cancelling stranded round ${cfg0.currentRoundId} (state=${r.state})`);
      await retryPastDeadline(() => program.methods.cancelRound().accounts({ admin: admin.publicKey, round: curPda }).rpc(), "self-heal cancel");
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
async function retryPastDeadline(fn: () => Promise<any>, label: string, tries = 45): Promise<void> {
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
    await fundFromAdmin(player.publicKey, 0.8 * anchor.web3.LAMPORTS_PER_SOL);
    await program.methods.deposit(new anchor.BN(0.5 * anchor.web3.LAMPORTS_PER_SOL))
      .accounts({ authority: player.publicKey }).signers([player]).rpc();

    const { id, pda: roundPda } = await createFreshRound();
    console.log(`   created round ${id}`);
    await program.methods.initMiner().accounts({ authority: player.publicKey }).signers([player]).rpc()
      .catch((e: any) => { if (!/already in use/.test(String(e))) throw e; });

    await program.methods.joinRound(new anchor.BN(id))
      .accounts({ authority: player.publicKey, config: configPda, escrow: escrowPda }).signers([player]).rpc();
    await awaitJoined(escrowPda, id);
    await program.methods.stake(0, new anchor.BN(0.3 * anchor.web3.LAMPORTS_PER_SOL))
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
    await fundFromAdmin(player.publicKey, 0.8 * anchor.web3.LAMPORTS_PER_SOL);
    await program.methods.deposit(new anchor.BN(0.5 * anchor.web3.LAMPORTS_PER_SOL))
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
      program.methods.stake(0, new anchor.BN(0.25 * anchor.web3.LAMPORTS_PER_SOL))
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
    await program.methods.refund(new anchor.BN(id)).accounts({ authority: player.publicKey, round: roundPda }).signers([player]).rpc();
  });
});
