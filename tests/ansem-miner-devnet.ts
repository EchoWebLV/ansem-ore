import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { AnsemMiner } from "../target/types/ansem_miner";
import { Connection, PublicKey, Keypair, SystemProgram, Transaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, getAccount } from "@solana/spl-token";
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
async function createFreshRound(durationSecs = 25): Promise<{ id: number; pda: PublicKey }> {
  await program.methods.setRoundDuration(new anchor.BN(durationSecs)).accounts({ admin: admin.publicKey }).rpc();
  const cfg = await program.account.config.fetch(configPda);
  const newId = cfg.currentRoundId.toNumber() + 1;
  const pda = nextRoundPda(newId);
  await program.methods.createRound().accounts({ payer: admin.publicKey, round: pda }).rpc();
  return { id: newId, pda };
}

describe("ansem-miner (M3 devnet)", () => {
  it("phase 1: L1 flow — init(idempotent) -> round -> deposit -> stake(wallet) -> settle -> swap -> claim", async function () {
    this.timeout(240000);
    const player = Keypair.generate();
    const [escrowPda] = PublicKey.findProgramAddressSync([enc("escrow"), player.publicKey.toBuffer()], program.programId);
    const [minerPda] = PublicKey.findProgramAddressSync([enc("miner"), player.publicKey.toBuffer()], program.programId);
    const playerAta = getAssociatedTokenAddressSync(ansemMint, player.publicKey);

    await ensureInitialized();
    await fundFromAdmin(player.publicKey, 3 * anchor.web3.LAMPORTS_PER_SOL);
    await program.methods.deposit(new anchor.BN(anchor.web3.LAMPORTS_PER_SOL))
      .accounts({ authority: player.publicKey }).signers([player]).rpc();

    const { id, pda: roundPda } = await createFreshRound();
    console.log(`   created round ${id}`);
    await program.methods.initMiner().accounts({ authority: player.publicKey }).signers([player]).rpc()
      .catch((e: any) => { if (!/already in use/.test(String(e))) throw e; });

    await program.methods.joinRound(new anchor.BN(id))
      .accounts({ authority: player.publicKey, config: configPda, escrow: escrowPda }).signers([player]).rpc();
    await program.methods.stake(0, new anchor.BN(0.5 * anchor.web3.LAMPORTS_PER_SOL))
      .accounts({ authority: player.publicKey, config: configPda, round: roundPda, miner: minerPda, escrow: escrowPda, sessionToken: null })
      .signers([player]).rpc();

    // Wait out the deadline, then admin-settle (M1 fallback — no VRF in phase 1),
    // reconcile, swap, claim. settle takes ONLY randomness (round_id is from seeds).
    await awaitEr(() => program.account.round.fetch(roundPda), (r: any) => Date.now() / 1000 >= r.deadlineTs.toNumber(), 80);
    await program.methods.settle(Array(32).fill(7))
      .accounts({ admin: admin.publicKey, round: roundPda, config: configPda }).rpc();
    await program.methods.reconcileMiner(new anchor.BN(id))
      .accounts({ config: configPda, escrow: escrowPda, miner: minerPda }).rpc();
    await program.methods.executeSwapMock().accounts(swapAccounts(roundPda)).rpc();
    assert.equal((await program.account.round.fetch(roundPda)).state, 4, "round CLAIMABLE");
    await program.methods.claim(new anchor.BN(id))
      .accounts(claimAccounts(player.publicKey, playerAta, roundPda)).signers([player]).rpc();

    const ata = await getAccount(provider.connection, playerAta);
    assert.isAbove(Number(ata.amount), 0, "player mined ANSEM on devnet L1");
    console.log(`   ✓ mined ${ata.amount} ANSEM base units on devnet`);
  });
});
