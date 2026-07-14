import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { AnsemMiner } from "../target/types/ansem_miner";
import { Connection, PublicKey, Keypair, SystemProgram } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, getAccount, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { SessionTokenManager } from "@magicblock-labs/gum-sdk";
import { GetCommitmentSignature } from "@magicblock-labs/ephemeral-rollups-sdk";
import { assert } from "chai";

// ANSEM Miner — M2c session-keys suite. SELF-CONTAINED (own rounds, fresh player).
//
// Proves gasless, popup-free ER staking: a browser mints ONE SessionTokenV2 on L1
// (one wallet popup, via the gum program KeyspM2ss… bundled by mb-test-validator),
// then signs a burst of ER `stake` calls with an ephemeral session key — the player
// wallet never signs a stake. A leaked session key is contained: it can only place
// stakes inside the already-fenced round budget and can NEVER move value OUT
// (deposit/withdraw/claim stay wallet-only).
//
// Test 1 exercises the real deployment path (session-signed stake IN the ER, then
// commit → settle → reconcile → swap → claim). Test 2 is the security matrix: the
// `stake` gate is layer-agnostic, so it runs ON L1 (round undelegated, open) to
// assert the auth boundary without any ER-clone flakiness.

const DLP_PROGRAM_ID = "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh";
const enc = (s: string) => Buffer.from(s);
const roundSeed = (id: number) => new anchor.BN(id).toArrayLike(Buffer, "le", 8);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const nowSec = () => Math.floor(Date.now() / 1000);
const RANDOMNESS = Array(32).fill(7); // admin-settle randomness (M2c isolates the session boundary, not VRF)

async function awaitOwner(conn: Connection, pubkey: PublicKey, tries = 25): Promise<string> {
  for (let i = 0; i < tries; i++) {
    const acc = await conn.getAccountInfo(pubkey, "confirmed");
    if (acc) return acc.owner.toBase58();
    await sleep(300);
  }
  throw new Error(`account ${pubkey.toBase58()} not found after ${tries} tries`);
}

async function awaitOwnerIs(conn: Connection, pubkey: PublicKey, expected: string, tries = 40): Promise<void> {
  let last = "?";
  for (let i = 0; i < tries; i++) {
    const acc = await conn.getAccountInfo(pubkey, "confirmed");
    if (acc) { last = acc.owner.toBase58(); if (last === expected) return; }
    await sleep(400);
  }
  throw new Error(`owner of ${pubkey.toBase58()} = ${last}, expected ${expected}`);
}

async function awaitEr<T>(fetchFn: () => Promise<T>, pred: (v: T) => boolean, tries = 30): Promise<T> {
  let last: T | undefined;
  for (let i = 0; i < tries; i++) {
    try { last = await fetchFn(); if (pred(last)) return last; } catch (_) { /* read lag */ }
    await sleep(400);
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

// Assert a promise rejects; return the stringified error for optional inspection.
async function expectThrows(p: Promise<any>, label: string): Promise<string> {
  try { await p; }
  catch (e: any) { return String(e); }
  throw new Error(`expected "${label}" to fail, but it succeeded`);
}

const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);
const program = anchor.workspace.AnsemMiner as Program<AnsemMiner>;
const admin = provider.wallet as anchor.Wallet;

const erConnection = new Connection(
  process.env.EPHEMERAL_PROVIDER_ENDPOINT || "http://127.0.0.1:7799",
  { wsEndpoint: process.env.EPHEMERAL_WS_ENDPOINT || "ws://127.0.0.1:7800", commitment: "confirmed" }
);
const erProvider = new anchor.AnchorProvider(erConnection, anchor.Wallet.local(), { commitment: "confirmed" });
const ephemeralProgram = new Program<AnsemMiner>(program.idl, erProvider);

const VALIDATOR = new PublicKey(process.env.VALIDATOR || "mAGicPQYBMvcYveUZA5F5UNNwyHvfYh5xkLS2Fr1mev");
const validatorMeta = [{ pubkey: VALIDATOR, isSigner: false, isWritable: false }];

const [configPda] = PublicKey.findProgramAddressSync([enc("config")], program.programId);
const player = Keypair.generate();
const [escrowPda] = PublicKey.findProgramAddressSync([enc("escrow"), player.publicKey.toBuffer()], program.programId);
const [minerPda] = PublicKey.findProgramAddressSync([enc("miner"), player.publicKey.toBuffer()], program.programId);
const [potVaultPda] = PublicKey.findProgramAddressSync([enc("pot_vault")], program.programId);
const [ansemMint] = PublicKey.findProgramAddressSync([enc("ansem_mint")], program.programId);
const [vaultAuth] = PublicKey.findProgramAddressSync([enc("vault_auth")], program.programId);
const [mintAuth] = PublicKey.findProgramAddressSync([enc("mint_auth")], program.programId);
const [treasury] = PublicKey.findProgramAddressSync([enc("treasury")], program.programId);
const [smallJackpotAuth] = PublicKey.findProgramAddressSync([enc("jackpot_sm_auth")], program.programId);
const [bigJackpotAuth] = PublicKey.findProgramAddressSync([enc("jackpot_big_auth")], program.programId);
const payoutVault = getAssociatedTokenAddressSync(ansemMint, vaultAuth, true);
const playerAta = getAssociatedTokenAddressSync(ansemMint, player.publicKey);

// tokenProgram is no longer auto-resolvable (Interface token layer, commit 1ab3f46).
const swapAccounts = (roundPda: PublicKey) => ({
  payer: admin.publicKey, round: roundPda, ansemMint, mintAuthority: mintAuth,
  vaultAuthority: vaultAuth, payoutVault, potVault: potVaultPda, treasury, tokenProgram: TOKEN_PROGRAM_ID,
});
const claimAccounts = (roundPda: PublicKey) => ({
  authority: player.publicKey, round: roundPda, ansemMint, vaultAuthority: vaultAuth,
  payoutVault, playerAta, tokenProgram: TOKEN_PROGRAM_ID,
});

// Gum session-token manager, wallet = the PLAYER (fee_payer + authority of the
// session it creates). createSessionV2 args: (top_up, valid_until, lamports).
const gum = new SessionTokenManager(new anchor.Wallet(player), provider.connection).program;
const sessionTokenPda = (sessionSigner: PublicKey, target: PublicKey) =>
  PublicKey.findProgramAddressSync(
    [enc("session_token_v2"), target.toBuffer(), sessionSigner.toBuffer(), player.publicKey.toBuffer()],
    gum.programId
  )[0];

// Mint a SessionTokenV2 on L1 (one wallet popup in production). top_up=false: the
// ephemeral key stays at 0 lamports — it's never the fee payer (a funded relayer/
// validator pays on the ER; the base validator's local wallet pays on L1). Its
// only power is to SIGN `stake` on the player's behalf.
async function createSession(sessionSigner: Keypair, target: PublicKey, validUntil: number): Promise<PublicKey> {
  const tokenPda = sessionTokenPda(sessionSigner.publicKey, target);
  await gum.methods.createSessionV2(false, new anchor.BN(validUntil), null)
    .accounts({
      sessionToken: tokenPda,
      sessionSigner: sessionSigner.publicKey,
      feePayer: player.publicKey,
      authority: player.publicKey,
      targetProgram: target,
    })
    .signers([sessionSigner])
    .rpc();
  return tokenPda;
}

describe("ansem-miner (M2c session keys)", () => {
  before("L1 prelude: initialize, fund player, deposit, init miner", async () => {
    await program.methods.initialize().accounts({ admin: admin.publicKey, tokenProgram: TOKEN_PROGRAM_ID }).rpc();
    // Fixture (BEEF/jackpot upgrade): execute_swap_mock now reads the JackpotConfig
    // PDA (spec D6). Seed it once so the swap resolves it — defaults (1-in-25/100x)
    // run at rollover 0 in this suite, so the bite is 0 and payouts are unchanged.
    await program.methods.initJackpotConfig().accounts({ admin: admin.publicKey }).rpc();
    // Lottery model: flat 50% return band so the sole staker always gets > 0.
    await program.methods.setReturnBand(5000, 5000).accounts({ admin: admin.publicKey }).rpc();
    const sig = await provider.connection.requestAirdrop(player.publicKey, 5 * anchor.web3.LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(sig, "confirmed");
    await program.methods.deposit(new anchor.BN(2 * anchor.web3.LAMPORTS_PER_SOL))
      .accounts({ authority: player.publicKey }).signers([player]).rpc();
    await program.methods.initMiner().accounts({ authority: player.publicKey }).signers([player]).rpc();
  });

  it("mines ANSEM from an ER stake signed ONLY by an ephemeral session key (no wallet popup)", async function () {
    this.timeout(180000);
    const ROUND_ID = 1;
    const STAKE_BLOCK = 0;
    const STAKE_AMT = new anchor.BN(0.5 * anchor.web3.LAMPORTS_PER_SOL);
    const [roundPda] = PublicKey.findProgramAddressSync([enc("round"), roundSeed(ROUND_ID)], program.programId);

    await program.methods.setRoundDuration(new anchor.BN(30)).accounts({ admin: admin.publicKey }).rpc();
    await program.methods.createRound().accounts({ payer: admin.publicKey, round: roundPda }).rpc();

    // The one wallet popup: mint the session token on L1 (15-min expiry).
    const sessionKp = Keypair.generate();
    const tokenPda = await createSession(sessionKp, program.programId, nowSec() + 900);

    // Delegate round + miner into the ER.
    await program.methods.delegateRound(new anchor.BN(ROUND_ID))
      .accounts({ payer: admin.publicKey, round: roundPda })
      .remainingAccounts(validatorMeta).rpc({ skipPreflight: true, commitment: "confirmed" });
    assert.equal(await awaitOwner(provider.connection, roundPda), DLP_PROGRAM_ID);
    await program.methods.delegateMiner()
      .accounts({ payer: player.publicKey, miner: minerPda })
      .remainingAccounts(validatorMeta).signers([player])
      .rpc({ skipPreflight: true, commitment: "confirmed" });
    assert.equal(await awaitOwner(provider.connection, minerPda), DLP_PROGRAM_ID);

    await program.methods.joinRound(new anchor.BN(ROUND_ID))
      .accounts({ authority: player.publicKey, config: configPda, escrow: escrowPda })
      .signers([player]).rpc();

    // Stake in the ER — signed by the SESSION KEY (authority = sessionKp), the
    // player wallet never signs. Idempotent retry for cold-clone lag (session
    // token + config + escrow all clone on first ER read).
    for (let i = 0; i < 6; i++) {
      const m: any = await ephemeralProgram.account.minerPosition.fetch(minerPda).catch(() => null);
      if (m && m.blockStake[STAKE_BLOCK].toString() === STAKE_AMT.toString()) break;
      await erRpcTolerant(() => ephemeralProgram.methods.stake(STAKE_BLOCK, STAKE_AMT)
        .accounts({
          authority: sessionKp.publicKey, config: configPda, round: roundPda,
          miner: minerPda, escrow: escrowPda, sessionToken: tokenPda,
        })
        .signers([sessionKp]).rpc({ skipPreflight: true, commitment: "confirmed" }));
      await sleep(2000);
    }
    const staked: any = await awaitEr(
      () => ephemeralProgram.account.minerPosition.fetch(minerPda),
      (m: any) => m.blockStake[STAKE_BLOCK].toString() === STAKE_AMT.toString(), 10
    );
    assert.equal(staked.blockStake[STAKE_BLOCK].toString(), STAKE_AMT.toString(),
      "session-key-signed stake landed in the ER");

    // Deadline-gate ordering: commit the miner while the round is STILL delegated
    // (so its read-only gate account is available on the ER), retrying until the
    // ON-CHAIN clock passes the deadline (CommitTooEarly). Polls the validator clock
    // via the program gate — NOT wall-clock — so it's robust to mb-test-validator
    // clock drift. Confirm the ER->L1 commit via GetCommitmentSignature; on a
    // confirm-layer flake, retry (the owner pre-check catches a tx that did land).
    for (let i = 0; i < 60; i++) {
      const cur = await provider.connection.getAccountInfo(minerPda, "confirmed").catch(() => null);
      if (cur && cur.owner.toBase58() === program.programId.toBase58()) break; // already undelegated
      try {
        const sig = await ephemeralProgram.methods.commitMiner()
          .accounts({ payer: admin.publicKey, miner: minerPda, round: roundPda })
          .rpc({ skipPreflight: true, commitment: "confirmed" });
        await GetCommitmentSignature(sig, erConnection);
        break;
      } catch (e: any) {
        if (/CommitTooEarly/.test(String(e))) { await sleep(1500); continue; }
        await sleep(1500); // ER confirm flake — retry; owner pre-check confirms a landed tx
      }
    }
    await awaitOwnerIs(provider.connection, minerPda, program.programId.toBase58());
    await erRpcTolerant(() => ephemeralProgram.methods.commitRound()
      .accounts({ payer: admin.publicKey, config: configPda, round: roundPda })
      .rpc({ skipPreflight: true, commitment: "confirmed" }));
    await awaitOwnerIs(provider.connection, roundPda, program.programId.toBase58());

    assert.equal((await program.account.round.fetch(roundPda)).pot.toString(), STAKE_AMT.toString(),
      "session-staked pot committed to L1");

    // Settle (admin), reconcile, swap, claim.
    await program.methods.settle(RANDOMNESS).accounts({ admin: admin.publicKey, config: configPda, round: roundPda }).rpc();
    await program.methods.reconcileMiner(new anchor.BN(ROUND_ID))
      .accounts({ config: configPda, escrow: escrowPda, miner: minerPda })
      .rpc({ skipPreflight: true, commitment: "confirmed" });
    await program.methods.executeSwapMock().accounts(swapAccounts(roundPda)).rpc();
    assert.equal((await program.account.round.fetch(roundPda)).state, 4, "round CLAIMABLE");
    await program.methods.claim(new anchor.BN(ROUND_ID)).accounts(claimAccounts(roundPda)).signers([player]).rpc();
    const ata = await getAccount(provider.connection, playerAta);
    assert.isAbove(Number(ata.amount), 0, "player mined ANSEM via a session-key-signed stake");
  });

  it("enforces the session boundary: valid/wallet pass; expired/foreign/withdraw fail", async function () {
    this.timeout(90000);
    // Security matrix on L1 (round undelegated + open) — the `stake` gate is
    // layer-agnostic, so this proves the auth boundary with zero ER-clone noise.
    const ROUND2 = 2;
    const BLK = 0;
    const AMT = new anchor.BN(0.1 * anchor.web3.LAMPORTS_PER_SOL);
    const [round2Pda] = PublicKey.findProgramAddressSync([enc("round"), roundSeed(ROUND2)], program.programId);

    // Long window so every L1 stake attempt is comfortably before the deadline.
    await program.methods.setRoundDuration(new anchor.BN(300)).accounts({ admin: admin.publicKey }).rpc();
    await program.methods.createRound().accounts({ payer: admin.publicKey, round: round2Pda }).rpc();
    await program.methods.joinRound(new anchor.BN(ROUND2))
      .accounts({ authority: player.publicKey, config: configPda, escrow: escrowPda })
      .signers([player]).rpc();

    const stakeL1 = (authority: Keypair, sessionToken: PublicKey | null) =>
      program.methods.stake(BLK, AMT)
        .accounts({
          authority: authority.publicKey, config: configPda, round: round2Pda,
          miner: minerPda, escrow: escrowPda, sessionToken,
        })
        .signers([authority]).rpc();

    const readBlk = async () =>
      (await program.account.minerPosition.fetch(minerPda)).blockStake[BLK] as anchor.BN;

    // (1) Wallet-signed stake still passes (the session_auth_or fallback). This is
    // the miner's FIRST stake in round 2, so the handler resets it to this round
    // (block_stake := 0) then adds AMT → the absolute value is exactly AMT.
    await stakeL1(player, null);
    assert.equal((await readBlk()).toString(), AMT.toString(), "wallet-signed stake passes");

    // (2) A VALID session token authorizes a stake (session key signs, not wallet).
    const good = Keypair.generate();
    const goodTok = await createSession(good, program.programId, nowSec() + 900);
    const before2 = await readBlk();
    await stakeL1(good, goodTok);
    assert.equal((await readBlk()).sub(before2).toString(), AMT.toString(), "valid-session stake passes");

    // (3) EXPIRED token → rejected (create allows a past valid_until; the gate checks now < valid_until).
    const expiredKp = Keypair.generate();
    const expiredTok = await createSession(expiredKp, program.programId, nowSec() - 60);
    const before3 = await readBlk();
    await expectThrows(stakeL1(expiredKp, expiredTok), "expired-token stake");
    assert.equal((await readBlk()).toString(), before3.toString(), "expired-token stake wrote nothing");

    // (4) FOREIGN-program token (target = System program) → rejected. Its PDA binds
    // a different target_program, so our program's expected PDA mismatches → InvalidToken.
    const foreignKp = Keypair.generate();
    const foreignTok = await createSession(foreignKp, SystemProgram.programId, nowSec() + 900);
    const before4 = await readBlk();
    await expectThrows(stakeL1(foreignKp, foreignTok), "foreign-program-token stake");
    assert.equal((await readBlk()).toString(), before4.toString(), "foreign-token stake wrote nothing");

    // (5) CONTAINMENT: a session key can NEVER move value out — withdraw is wallet-only.
    const escBefore = await program.account.playerEscrow.fetch(escrowPda);
    await expectThrows(
      program.methods.withdraw(new anchor.BN(1))
        .accounts({ authority: good.publicKey, config: configPda, escrow: escrowPda }).signers([good]).rpc(),
      "session-key withdraw"
    );
    const escAfter = await program.account.playerEscrow.fetch(escrowPda);
    assert.equal(escAfter.balance.toString(), escBefore.balance.toString(), "session key could not withdraw escrow SOL");

    // (6) RECONCILE-DRAIN GUARD: an ATTACKER wallet-signing into the VICTIM's miner
    // with NO token is rejected by the session_auth_or fallback (require
    // miner.authority == authority). Without this, writing a victim's block_stake
    // would drain the victim's escrow at reconcile (the debit reads the committed
    // miner snapshot). attacker is a non-fee-payer signer, so needs no lamports.
    const attacker = Keypair.generate();
    const before6 = await readBlk();
    await expectThrows(stakeL1(attacker, null), "attacker wallet-signed stake into victim miner");
    assert.equal((await readBlk()).toString(), before6.toString(), "attacker could not inflate victim's stake (no token)");

    // (7) TOKEN IS SIGNER-BOUND: an attacker who steals the victim's VALID token but
    // signs with their own key is rejected — is_valid recomputes the PDA with
    // session_signer = attacker, which mismatches the token (minted for `good`).
    const before7 = await readBlk();
    await expectThrows(stakeL1(attacker, goodTok), "stolen token used by wrong signer");
    assert.equal((await readBlk()).toString(), before7.toString(), "a leaked token can't be used by a different signer");
  });
});
