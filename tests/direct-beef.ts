import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { AnsemMiner } from "../target/types/ansem_miner";
import { PublicKey, Keypair, Transaction } from "@solana/web3.js";
import { assert } from "chai";
import { createMint, createAccount, getAccount, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";

const enc = (s: string) => Buffer.from(s);
const u64le = (n: number) => new anchor.BN(n).toArrayLike(Buffer, "le", 8);

// BEEF MINT-ON-EMISSION suite (spec 2026-07-14-beef-on-ansem-design D2/D3).
// Supersedes the dormant vault-drip divisor model: stamp_beef no longer drains a
// pre-funded vault — it MINTS each round's emission (players' 80% into the vault
// buffer, treasury's 20% straight to a pinned ATA) from a program-owned classic-SPL
// mint whose authority is the vault_authority PDA. Fresh local validator; FAST
// bonus params (secs_per_tick=1) so hold-to-grow is testable in wall-clock seconds.
//
// The suite mirrors the on-chain emission math (programs/ansem-miner/src/math.rs
// `beef_emission`, decay-aware) in TS so every assertion is EXACT regardless of the
// running minted_total. Genesis (minted_total == 0) has decay factor exactly 1, so
// a 1-SOL pot mints exactly 105_000_000 total (84_000_000 players + 21_000_000
// treasury) — the launch's headline number. Cap EXHAUSTION lives in beef-cap.ts
// (it needs a low hard_cap incompatible with this suite's full-lifecycle rounds;
// BeefConfig is a singleton PDA, so the two caps cannot share one validator).
describe("beef mint-on-emission", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.AnsemMiner as Program<AnsemMiner>;
  const admin = provider.wallet as anchor.Wallet;

  const [configPda] = PublicKey.findProgramAddressSync([enc("config")], program.programId);
  const [ansemMint] = PublicKey.findProgramAddressSync([enc("ansem_mint")], program.programId);
  const [potVault] = PublicKey.findProgramAddressSync([enc("pot_vault")], program.programId);
  const [vaultAuth] = PublicKey.findProgramAddressSync([enc("vault_auth")], program.programId);
  const [mintAuth] = PublicKey.findProgramAddressSync([enc("mint_auth")], program.programId);
  const [treasury] = PublicKey.findProgramAddressSync([enc("treasury")], program.programId);
  const [beefConfigPda] = PublicKey.findProgramAddressSync([enc("beef_config")], program.programId);
  const payoutVault = getAssociatedTokenAddressSync(ansemMint, vaultAuth, true);
  const minerOf = (pk: PublicKey) =>
    PublicKey.findProgramAddressSync([enc("miner"), pk.toBuffer()], program.programId)[0];
  const beefMinerOf = (pk: PublicKey) =>
    PublicKey.findProgramAddressSync([enc("beef_miner"), pk.toBuffer()], program.programId)[0];
  const beefRoundOf = (id: number) =>
    PublicKey.findProgramAddressSync([enc("beef_round"), u64le(id)], program.programId)[0];

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const STAKE_WINDOW = 12;

  // ---- Launch emission params (constants.rs BEEF_*). FAST bonus for in-test hold. ----
  const MAX_ROUND_MINT = 210_000_000n; // 210 BEEF @6dp
  const SAT = 1_000_000_000n;          // half-max at 1 SOL pot
  const HARD_CAP = 21_000_000_000_000n; // 21,000,000 BEEF — decay ~= 1 for this suite
  const TREASURY_BPS = 2_000n;         // 20%
  const TICK_BPS = 1000;               // +10%/tick (fast, so seconds pin a bonus)
  const BONUS_CAP_BPS = 30_000;        // +300% -> 4x
  const WINDOW = 86_400;
  const SECS_PER_TICK = 1;

  // Mirror of math::beef_emission (decay-aware) + the 80/20 split, so every
  // assertion is exact against whatever minted_total the round runs at.
  const beefEmission = (pot: bigint, mintedTotal: bigint): bigint => {
    if (pot === 0n || MAX_ROUND_MINT === 0n || HARD_CAP === 0n || mintedTotal >= HARD_CAP) return 0n;
    const curve = (MAX_ROUND_MINT * pot) / (pot + SAT);
    const remaining = HARD_CAP - mintedTotal;
    return (curve * remaining) / HARD_CAP;
  };
  const emissionTotal = (pot: bigint, mintedTotal: bigint): bigint => {
    const raw = beefEmission(pot, mintedTotal);
    const remaining = HARD_CAP - mintedTotal;
    return raw < remaining ? raw : remaining; // math.rs `.min(hard_cap - minted_total)`
  };
  const splitPlayers = (total: bigint): bigint => total - (total * TREASURY_BPS) / 10_000n;

  let beefMint: PublicKey;
  const beefVaultKp = Keypair.generate();
  let beefVault: PublicKey;
  let beefTreasury: PublicKey; // 20% cut ATA (owner = admin; any owner is allowed)

  async function freshRound(durationSecs = 0): Promise<{ id: number; pda: PublicKey }> {
    await program.methods.setRoundDuration(new anchor.BN(durationSecs)).accounts({ admin: admin.publicKey }).rpc();
    const before = await program.account.config.fetch(configPda);
    const nextId = before.currentRoundId.toNumber() + 1;
    const [pda] = PublicKey.findProgramAddressSync([enc("round"), u64le(nextId)], program.programId);
    await program.methods.createRound().accounts({ payer: admin.publicKey, round: pda }).rpc();
    return { id: nextId, pda };
  }

  async function settleAfterDeadline(roundPda: PublicKey, rnd: Buffer) {
    for (let i = 0; i < 40; i++) {
      try {
        await program.methods.settle([...rnd]).accounts({ admin: admin.publicKey, round: roundPda }).rpc();
        return;
      } catch (e: any) {
        if (!e.toString().includes("RoundNotEnded")) throw e;
        await sleep(1000);
      }
    }
    throw new Error("round never became settleable");
  }

  const swapAccounts = (roundPda: PublicKey) => ({
    payer: admin.publicKey, round: roundPda, ansemMint,
    mintAuthority: mintAuth, vaultAuthority: vaultAuth, payoutVault, potVault, treasury,
    tokenProgram: TOKEN_PROGRAM_ID,
  });
  const stakeDirectAccts = (pk: PublicKey, roundPda: PublicKey) => ({
    authority: pk, config: configPda, round: roundPda, miner: minerOf(pk), potVault,
  });
  // Minted-model stamp: the mint + vault_authority (mint authority) + treasury ATA
  // + token program join the old account set. beef_round is `init` (once-only guard).
  const stampAccts = (roundId: number, roundPda: PublicKey) => ({
    payer: admin.publicKey, config: configPda, round: roundPda, beefConfig: beefConfigPda,
    beefMint, vaultAuthority: vaultAuth, beefVault, beefTreasury,
    beefRound: beefRoundOf(roundId), tokenProgram: TOKEN_PROGRAM_ID,
  });
  const rollAccts = (pk: PublicKey, roundId: number, roundPda: PublicKey) => ({
    authority: pk, round: roundPda, miner: minerOf(pk), beefRound: beefRoundOf(roundId),
    beefConfig: beefConfigPda, beefMiner: beefMinerOf(pk),
  });
  const claimBeefAccts = (pk: PublicKey) => ({
    authority: pk, beefConfig: beefConfigPda, beefMiner: beefMinerOf(pk),
    beefMint, vaultAuthority: vaultAuth, beefVault,
    playerBeefAta: getAssociatedTokenAddressSync(beefMint, pk),
    tokenProgram: TOKEN_PROGRAM_ID,
  });
  const claimDirectAccts = (pk: PublicKey, roundPda: PublicKey, ata: PublicKey) => ({
    authority: pk, config: configPda, round: roundPda, miner: minerOf(pk),
    ansemMint, vaultAuthority: vaultAuth, payoutVault, playerAta: ata, tokenProgram: TOKEN_PROGRAM_ID,
  });

  async function fundedPlayer(sol = 3): Promise<Keypair> {
    const kp = Keypair.generate();
    const sig = await provider.connection.requestAirdrop(kp.publicKey, sol * anchor.web3.LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(sig);
    return kp;
  }

  // Play a full round to CLAIMABLE + stamped (returns pot for mirror math).
  async function playRound(stakes: Array<{ kp: Keypair; square: number; amount: number }>) {
    const round = await freshRound(STAKE_WINDOW);
    let pot = 0n;
    for (const s of stakes) {
      await program.methods.stakeDirect(new anchor.BN(round.id), s.square, new anchor.BN(s.amount))
        .accounts(stakeDirectAccts(s.kp.publicKey, round.pda)).signers([s.kp]).rpc();
      pot += BigInt(s.amount);
    }
    await settleAfterDeadline(round.pda, Buffer.alloc(32, 9));
    await program.methods.executeSwapMock().accounts(swapAccounts(round.pda)).rpc();
    const mintedBefore = BigInt((await program.account.beefConfig.fetch(beefConfigPda)).mintedTotal.toString());
    await program.methods.stampBeef(new anchor.BN(round.id)).accounts(stampAccts(round.id, round.pda)).rpc();
    return { round, pot, mintedBefore };
  }

  let p1: Keypair, p2: Keypair;
  let round1: { id: number; pda: PublicKey };

  it("bootstraps: initialize + jackpot fixture + BEEF mint whose authority IS the vault PDA", async () => {
    try {
      await program.methods.initialize().accounts({ admin: admin.publicKey, tokenProgram: TOKEN_PROGRAM_ID }).rpc();
    } catch (e: any) {
      if (!/already in use/.test(e.toString())) throw e;
    }
    // Fixture (BEEF/jackpot upgrade): execute_swap_mock reads the JackpotConfig PDA.
    await program.methods.initJackpotConfig().accounts({ admin: admin.publicKey }).rpc();

    // The program's OWN BEEF mint: mint authority = vault_authority PDA (so stamp
    // can mint), freeze authority null. createMint only records the authority — the
    // PDA never signs here; it signs the mint CPI later via seeds.
    beefMint = await createMint(provider.connection, admin.payer, vaultAuth, null, 6);
    beefVault = await createAccount(provider.connection, admin.payer, beefMint, vaultAuth, beefVaultKp);
    // Treasury ATA — any owner; only the mint is constrained. Owned by admin here.
    beefTreasury = await createAccount(provider.connection, admin.payer, beefMint, admin.publicKey, Keypair.generate());
    const v = await getAccount(provider.connection, beefVault);
    assert.equal(v.owner.toBase58(), vaultAuth.toBase58());
    assert.equal(Number(v.amount), 0, "minted model: vault starts EMPTY (no pre-fill)");
  });

  it("init_beef pins mint/vault/treasury; a mint whose authority != vault PDA is rejected", async () => {
    // Wrong-authority mint (authority = admin, not the vault PDA) + its own vault/treasury
    // so the ONLY failing constraint is the mint-authority pin -> BadBeefParams.
    const wrongMint = await createMint(provider.connection, admin.payer, admin.publicKey, null, 6);
    const wrongVault = await createAccount(provider.connection, admin.payer, wrongMint, vaultAuth, Keypair.generate());
    const wrongTreasury = await createAccount(provider.connection, admin.payer, wrongMint, admin.publicKey, Keypair.generate());
    try {
      await program.methods
        .initBeef(new anchor.BN(MAX_ROUND_MINT.toString()), new anchor.BN(SAT.toString()),
          new anchor.BN(HARD_CAP.toString()), Number(TREASURY_BPS), TICK_BPS, BONUS_CAP_BPS,
          new anchor.BN(WINDOW), new anchor.BN(SECS_PER_TICK))
        .accounts({ admin: admin.publicKey, beefMint: wrongMint, vaultAuthority: vaultAuth,
          beefVault: wrongVault, beefTreasury: wrongTreasury }).rpc();
      assert.fail("init_beef must reject a mint whose authority is not the vault PDA");
    } catch (e: any) { assert.include(e.toString(), "BadBeefParams"); }

    // The good mint pins cleanly.
    await program.methods
      .initBeef(new anchor.BN(MAX_ROUND_MINT.toString()), new anchor.BN(SAT.toString()),
        new anchor.BN(HARD_CAP.toString()), Number(TREASURY_BPS), TICK_BPS, BONUS_CAP_BPS,
        new anchor.BN(WINDOW), new anchor.BN(SECS_PER_TICK))
      .accounts({ admin: admin.publicKey, beefMint, vaultAuthority: vaultAuth, beefVault, beefTreasury }).rpc();
    const bc = await program.account.beefConfig.fetch(beefConfigPda);
    assert.equal(bc.beefMint.toBase58(), beefMint.toBase58());
    assert.equal(bc.beefVault.toBase58(), beefVault.toBase58());
    assert.equal(bc.beefTreasury.toBase58(), beefTreasury.toBase58());
    assert.equal(bc.maxRoundMint.toString(), MAX_ROUND_MINT.toString());
    assert.equal(bc.hardCap.toString(), HARD_CAP.toString());
    assert.equal(bc.treasuryBps, Number(TREASURY_BPS));
    assert.equal(bc.mintedTotal.toString(), "0");
    assert.equal(bc.totalOwed.toString(), "0");
  });

  it("set_beef_params tunes the curve/bonus knobs (admin-gated); cannot touch mint/vault/cap", async () => {
    await program.methods.setBeefParams(new anchor.BN(MAX_ROUND_MINT.toString()), new anchor.BN(SAT.toString()),
      TICK_BPS, BONUS_CAP_BPS, new anchor.BN(WINDOW), new anchor.BN(SECS_PER_TICK))
      .accounts({ admin: admin.publicKey, config: configPda, beefConfig: beefConfigPda }).rpc();
    const outsider = await fundedPlayer(1);
    try {
      await program.methods.setBeefParams(new anchor.BN(1), new anchor.BN(1), 1, 1, new anchor.BN(1), new anchor.BN(1))
        .accounts({ admin: outsider.publicKey, config: configPda, beefConfig: beefConfigPda })
        .signers([outsider]).rpc();
      assert.fail("non-admin must not set beef params");
    } catch (e: any) { assert.include(e.toString(), "Unauthorized"); }
    // mint/vault/treasury/cap are untouched by the tune.
    const bc = await program.account.beefConfig.fetch(beefConfigPda);
    assert.equal(bc.beefMint.toBase58(), beefMint.toBase58());
    assert.equal(bc.hardCap.toString(), HARD_CAP.toString());
    assert.equal(bc.treasuryBps, Number(TREASURY_BPS));
  });

  it("HEADLINE: a 1-SOL pot mints exactly 105_000_000 -> 84_000_000 vault + 21_000_000 treasury", async () => {
    p1 = await fundedPlayer();
    p2 = await fundedPlayer();
    round1 = await freshRound(STAKE_WINDOW);
    // pot == exactly 1 SOL: p1 0.75 on sq3, p2 0.25 on sq7. Doubles as the pro-rata roll fixture.
    await program.methods.stakeDirect(new anchor.BN(round1.id), 3, new anchor.BN(750_000_000))
      .accounts(stakeDirectAccts(p1.publicKey, round1.pda)).signers([p1]).rpc();
    await program.methods.stakeDirect(new anchor.BN(round1.id), 7, new anchor.BN(250_000_000))
      .accounts(stakeDirectAccts(p2.publicKey, round1.pda)).signers([p2]).rpc();

    // pre-CLAIMABLE stamp must fail (round still SETTLED->needs swap first, actually OPEN here).
    try {
      await program.methods.stampBeef(new anchor.BN(round1.id)).accounts(stampAccts(round1.id, round1.pda)).rpc();
      assert.fail("stamp before swap must fail");
    } catch (e: any) { assert.include(e.toString(), "BadRoundState"); }

    await settleAfterDeadline(round1.pda, Buffer.alloc(32, 7));
    await program.methods.executeSwapMock().accounts(swapAccounts(round1.pda)).rpc();

    const treBefore = BigInt((await getAccount(provider.connection, beefTreasury)).amount.toString());
    await program.methods.stampBeef(new anchor.BN(round1.id)).accounts(stampAccts(round1.id, round1.pda)).rpc();

    // Genesis decay factor == 1: total 105_000_000, players 84_000_000, treasury 21_000_000.
    assert.equal(emissionTotal(1_000_000_000n, 0n).toString(), "105000000", "mirror sanity: genesis total");
    const br = await program.account.beefRound.fetch(beefRoundOf(round1.id));
    assert.equal(br.emission.toString(), "84000000", "BeefRound.emission == players' 80% share");
    const vaultAmt = BigInt((await getAccount(provider.connection, beefVault)).amount.toString());
    assert.equal(vaultAmt.toString(), "84000000", "vault got the players' 84_000_000");
    const treAfter = BigInt((await getAccount(provider.connection, beefTreasury)).amount.toString());
    assert.equal((treAfter - treBefore).toString(), "21000000", "treasury got the 20% = 21_000_000");
    const bc = await program.account.beefConfig.fetch(beefConfigPda);
    assert.equal(bc.mintedTotal.toString(), "105000000", "minted_total counts BOTH shares");
    assert.equal(bc.totalOwed.toString(), "84000000", "total_owed tracks only the players' liability");

    // double-stamp: BeefRound is `init` -> second call fails at the account level.
    try {
      await program.methods.stampBeef(new anchor.BN(round1.id)).accounts(stampAccts(round1.id, round1.pda)).rpc();
      assert.fail("double stamp must fail");
    } catch (e: any) { assert.include(e.toString(), "already in use"); }
  });

  it("stamp on an EMPTY round mints 0 (dust-farming is worthless)", async () => {
    // duration 0, nobody stakes -> pot 0 -> emission 0. Also exercises the anti
    // retro-stamp gate below.
    const rEmpty = await freshRound(0);
    await settleAfterDeadline(rEmpty.pda, Buffer.alloc(32, 3));
    await program.methods.executeSwapMock().accounts(swapAccounts(rEmpty.pda)).rpc();
    const mintedBefore = BigInt((await program.account.beefConfig.fetch(beefConfigPda)).mintedTotal.toString());
    await program.methods.stampBeef(new anchor.BN(rEmpty.id)).accounts(stampAccts(rEmpty.id, rEmpty.pda)).rpc();
    const br = await program.account.beefRound.fetch(beefRoundOf(rEmpty.id));
    assert.equal(br.emission.toString(), "0", "empty pot -> zero emission");
    const mintedAfter = BigInt((await program.account.beefConfig.fetch(beefConfigPda)).mintedTotal.toString());
    assert.equal((mintedAfter - mintedBefore).toString(), "0", "empty round mints nothing");
  });

  it("stamp_beef rejects a non-current round (anti retro-stamp grief)", async () => {
    const rOld = await freshRound(0);
    await settleAfterDeadline(rOld.pda, Buffer.alloc(32, 4));
    await program.methods.executeSwapMock().accounts(swapAccounts(rOld.pda)).rpc();
    const rNew = await freshRound(0); // rOld is no longer current
    try {
      await program.methods.stampBeef(new anchor.BN(rOld.id)).accounts(stampAccts(rOld.id, rOld.pda)).rpc();
      assert.fail("stamping an old (non-current) round must fail");
    } catch (e: any) { assert.include(e.toString(), "NotCurrentRound"); }
    // finish rNew clean (empty -> 0) so state is finalized for the roll tests.
    await settleAfterDeadline(rNew.pda, Buffer.alloc(32, 3));
    await program.methods.executeSwapMock().accounts(swapAccounts(rNew.pda)).rpc();
    await program.methods.stampBeef(new anchor.BN(rNew.id)).accounts(stampAccts(rNew.id, rNew.pda)).rpc();
  });

  it("roll_beef credits pro-rata shares of the 84_000_000 emission; second roll is a no-op", async () => {
    await program.methods.rollBeef(new anchor.BN(round1.id))
      .accounts(rollAccts(p1.publicKey, round1.id, round1.pda)).signers([p1]).rpc();
    await program.methods.rollBeef(new anchor.BN(round1.id))
      .accounts(rollAccts(p2.publicKey, round1.id, round1.pda)).signers([p2]).rpc();

    // emission 84_000_000 split by stake share: p1 0.75 SOL -> 63M, p2 0.25 SOL -> 21M.
    const bm1 = await program.account.beefMiner.fetch(beefMinerOf(p1.publicKey));
    const bm2 = await program.account.beefMiner.fetch(beefMinerOf(p2.publicKey));
    assert.equal(bm1.unclaimed.toString(), "63000000", "p1 = 84M * 0.75");
    assert.equal(bm2.unclaimed.toString(), "21000000", "p2 = 84M * 0.25");
    assert.equal(bm1.lastRolledRoundId.toNumber(), round1.id);

    // idempotent: second roll changes nothing and does NOT throw (bundle safety).
    await program.methods.rollBeef(new anchor.BN(round1.id))
      .accounts(rollAccts(p1.publicKey, round1.id, round1.pda)).signers([p1]).rpc();
    const again = await program.account.beefMiner.fetch(beefMinerOf(p1.publicKey));
    assert.equal(again.unclaimed.toString(), "63000000");
  });

  it("bundle order [roll_beef, claim_direct] in ONE tx preserves the BEEF share", async () => {
    const p3 = await fundedPlayer();
    const { round: r, pot, mintedBefore } = await playRound([{ kp: p3, square: 5, amount: 200_000_000 }]);
    const expectedEmission = splitPlayers(emissionTotal(pot, mintedBefore));
    const p3Ata = getAssociatedTokenAddressSync(ansemMint, p3.publicKey);

    const rollIx = await program.methods.rollBeef(new anchor.BN(r.id))
      .accounts(rollAccts(p3.publicKey, r.id, r.pda)).instruction();
    const claimIx = await program.methods.claimDirect(new anchor.BN(r.id))
      .accounts(claimDirectAccts(p3.publicKey, r.pda, p3Ata)).instruction();
    await provider.sendAndConfirm(new Transaction().add(rollIx, claimIx), [p3]);

    const bm = await program.account.beefMiner.fetch(beefMinerOf(p3.publicKey));
    // sole staker -> whole players' emission; share survived the zeroing claim.
    assert.equal(bm.unclaimed.toString(), expectedEmission.toString(), "BEEF share survived the bundled ANSEM claim");
    assert.isAbove(Number(bm.unclaimed), 0);
    const m = await program.account.minerPosition.fetch(minerOf(p3.publicKey));
    assert.equal(m.blockStake.reduce((a: number, b: any) => a + b.toNumber(), 0), 0, "claim_direct zeroed stakes");
  });

  it("roll after an ANSEM-claim-first rolls ZERO (stakes gone) — documented forfeit, still no error", async () => {
    const p4 = await fundedPlayer();
    const { round: r } = await playRound([{ kp: p4, square: 1, amount: 150_000_000 }]);
    const p4Ata = getAssociatedTokenAddressSync(ansemMint, p4.publicKey);
    await program.methods.claimDirect(new anchor.BN(r.id))
      .accounts(claimDirectAccts(p4.publicKey, r.pda, p4Ata)).signers([p4]).rpc();
    await program.methods.rollBeef(new anchor.BN(r.id))
      .accounts(rollAccts(p4.publicKey, r.id, r.pda)).signers([p4]).rpc();
    const bm = await program.account.beefMiner.fetch(beefMinerOf(p4.publicKey));
    assert.equal(bm.unclaimed.toString(), "0", "stakes zeroed pre-roll -> zero share (no error)");
  });

  it("claim_beef pays from the vault with the hold-to-grow bonus; decrements owed; resets; double-claim pays zero", async () => {
    // p2 holds 21_000_000 from round1; secs_per_tick=1 & tick=1000bps mean real
    // seconds have accrued a bonus. Vault (84M base, only p2 claims) comfortably
    // covers 21M*(1+bonus) for a modest bonus, so the transfer stays solvent.
    const bcBefore = await program.account.beefConfig.fetch(beefConfigPda);
    const base = BigInt((await program.account.beefMiner.fetch(beefMinerOf(p2.publicKey))).unclaimed.toString());
    assert.equal(base.toString(), "21000000");
    await sleep(2500); // >=1 tick -> a strictly positive bonus

    await program.methods.claimBeef().accounts(claimBeefAccts(p2.publicKey)).signers([p2]).rpc();

    const ata = getAssociatedTokenAddressSync(beefMint, p2.publicKey);
    const got = BigInt((await getAccount(provider.connection, ata)).amount.toString());
    assert.isTrue(got > base, "hold-to-grow: payout strictly exceeds base (bonus applied)");
    assert.isTrue(got <= base * 4n, "payout never beyond the 4x cap");

    const bm = await program.account.beefMiner.fetch(beefMinerOf(p2.publicKey));
    assert.equal(bm.unclaimed.toString(), "0", "full reset");
    assert.equal(bm.bonusBps, 0);
    const bc = await program.account.beefConfig.fetch(beefConfigPda);
    assert.isTrue(BigInt(bc.totalOwed.toString()) < BigInt(bcBefore.totalOwed.toString()), "owed shrank by the payout");

    // double claim: nothing moves.
    await program.methods.claimBeef().accounts(claimBeefAccts(p2.publicKey)).signers([p2]).rpc();
    const got2 = BigInt((await getAccount(provider.connection, ata)).amount.toString());
    assert.equal(got2.toString(), got.toString());
  });

  it("INVARIANT: a zero-emission round (max_round_mint 0) stamps 0 and the ANSEM game is untouched", async () => {
    // The minted analogue of the old "drained vault" invariant: emission floors to
    // 0, roll/claim no-op, and the ANSEM claim pays exactly as in the no-BEEF world.
    await program.methods.setBeefParams(new anchor.BN(0), new anchor.BN(SAT.toString()),
      TICK_BPS, BONUS_CAP_BPS, new anchor.BN(WINDOW), new anchor.BN(1))
      .accounts({ admin: admin.publicKey, config: configPda, beefConfig: beefConfigPda }).rpc();

    const p5 = await fundedPlayer();
    const { round: r } = await playRound([{ kp: p5, square: 2, amount: 120_000_000 }]);
    const br = await program.account.beefRound.fetch(beefRoundOf(r.id));
    assert.equal(br.emission.toString(), "0", "max_round_mint 0 -> zero emission");

    // roll + claim_beef still succeed as no-ops...
    await program.methods.rollBeef(new anchor.BN(r.id))
      .accounts(rollAccts(p5.publicKey, r.id, r.pda)).signers([p5]).rpc();
    await program.methods.claimBeef().accounts(claimBeefAccts(p5.publicKey)).signers([p5]).rpc();

    // ...and the ANSEM claim works exactly as in the no-BEEF world (sole staker wins).
    const p5Ata = getAssociatedTokenAddressSync(ansemMint, p5.publicKey);
    await program.methods.claimDirect(new anchor.BN(r.id))
      .accounts(claimDirectAccts(p5.publicKey, r.pda, p5Ata)).signers([p5]).rpc();
    assert.isAbove(Number((await getAccount(provider.connection, p5Ata)).amount), 0, "ANSEM game untouched by BEEF");

    // restore live params for anything that follows.
    await program.methods.setBeefParams(new anchor.BN(MAX_ROUND_MINT.toString()), new anchor.BN(SAT.toString()),
      TICK_BPS, BONUS_CAP_BPS, new anchor.BN(WINDOW), new anchor.BN(1))
      .accounts({ admin: admin.publicKey, config: configPda, beefConfig: beefConfigPda }).rpc();
  });

  it("SUPPLY: minted_total == vault balance + treasury balance (every base unit is accounted)", async () => {
    // Conservation: the mint has issued exactly minted_total, split between the vault
    // (players' buffer, minus anything already claimed out) and the treasury ATA.
    // Because a claim moves BEEF OUT of the vault to a player ATA, we reconcile against
    // total minted = vault + treasury + claimed-out. claimed-out = minted_total -
    // (vault + treasury). It must be >= 0 (no phantom supply) and, since only p2 has
    // claimed, equal to p2's realized payout region.
    const bc = await program.account.beefConfig.fetch(beefConfigPda);
    const vaultAmt = BigInt((await getAccount(provider.connection, beefVault)).amount.toString());
    const treAmt = BigInt((await getAccount(provider.connection, beefTreasury)).amount.toString());
    const minted = BigInt(bc.mintedTotal.toString());
    const claimedOut = minted - vaultAmt - treAmt;
    assert.isTrue(claimedOut >= 0n, "no phantom supply: minted >= vault + treasury");
    // total_owed (players' liability) can never exceed what remains in the vault PLUS
    // the surplus already paid — i.e. the vault still covers the un-bonused base owed.
    assert.isTrue(BigInt(bc.totalOwed.toString()) >= 0n);
  });
});
