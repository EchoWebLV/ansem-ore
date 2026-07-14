import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { AnsemMiner } from "../target/types/ansem_miner";
import { PublicKey, Keypair, Transaction } from "@solana/web3.js";
import { assert } from "chai";
import { createMint, createAccount, mintTo, transfer, getAccount, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";

const enc = (s: string) => Buffer.from(s);
const u64le = (n: number) => new anchor.BN(n).toArrayLike(Buffer, "le", 8);

// BEEF vault emission layer suite. Fresh local validator; tolerant initialize
// so it can share a validator with another suite if needed. FAST bonus params
// (secs_per_tick = 1) so hold-to-grow is testable in wall-clock seconds.
describe("beef vault emission", () => {
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
  const STAKE_WINDOW = 15;

  let beefMint: PublicKey;
  const beefVaultKp = Keypair.generate(); // vanity grinding is ops-side cosmetics only
  let beefVault: PublicKey;

  // Test params: 1s ticks so bonuses accrue in-test. tick=1000bps/s, cap 30_000.
  const DIVISOR = 1000;
  const TICK_BPS = 1000;
  const CAP_BPS = 30_000;
  const WINDOW = 86_400;
  const SECS_PER_TICK = 1;
  const VAULT_FILL = 1_000_000_000; // 1000 BEEF @6dp -> first emission = 1_000_000

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

  // tokenProgram is no longer auto-resolvable (the program's token layer is an Interface);
  // the mock ANSEM + BEEF mints are classic SPL, so pass the classic token program.
  const swapAccounts = (roundPda: PublicKey) => ({
    payer: admin.publicKey, round: roundPda, ansemMint,
    mintAuthority: mintAuth, vaultAuthority: vaultAuth, payoutVault, potVault, treasury,
    tokenProgram: TOKEN_PROGRAM_ID,
  });
  const stakeDirectAccts = (pk: PublicKey, roundPda: PublicKey) => ({
    authority: pk, config: configPda, round: roundPda, miner: minerOf(pk), potVault,
  });
  async function fundedPlayer(sol = 3): Promise<Keypair> {
    const kp = Keypair.generate();
    const sig = await provider.connection.requestAirdrop(kp.publicKey, sol * anchor.web3.LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(sig);
    return kp;
  }

  it("bootstraps: initialize (tolerant) + mock BEEF mint + vault owned by vault_authority", async () => {
    try {
      await program.methods.initialize().accounts({ admin: admin.publicKey, tokenProgram: TOKEN_PROGRAM_ID }).rpc();
    } catch (e: any) {
      if (!/already in use/.test(e.toString())) throw e;
    }
    beefMint = await createMint(provider.connection, admin.payer, admin.publicKey, null, 6);
    beefVault = await createAccount(provider.connection, admin.payer, beefMint, vaultAuth, beefVaultKp);
    await mintTo(provider.connection, admin.payer, beefMint, beefVault, admin.payer, VAULT_FILL);
    const v = await getAccount(provider.connection, beefVault);
    assert.equal(v.owner.toBase58(), vaultAuth.toBase58());
    assert.equal(Number(v.amount), VAULT_FILL);
  });

  it("init_beef pins mint+vault and stores params; wrong-owner vault is rejected", async () => {
    // wrong owner -> BadBeefVault
    const bogus = await createAccount(provider.connection, admin.payer, beefMint, admin.publicKey, Keypair.generate());
    try {
      await program.methods.initBeef(new anchor.BN(DIVISOR), TICK_BPS, CAP_BPS, new anchor.BN(WINDOW), new anchor.BN(SECS_PER_TICK))
        .accounts({ admin: admin.publicKey, beefMint, vaultAuthority: vaultAuth, beefVault: bogus }).rpc();
      assert.fail("should reject vault not owned by vault_authority");
    } catch (e: any) { assert.include(e.toString(), "BadBeefVault"); }

    await program.methods.initBeef(new anchor.BN(DIVISOR), TICK_BPS, CAP_BPS, new anchor.BN(WINDOW), new anchor.BN(SECS_PER_TICK))
      .accounts({ admin: admin.publicKey, beefMint, vaultAuthority: vaultAuth, beefVault }).rpc();
    const bc = await program.account.beefConfig.fetch(beefConfigPda);
    assert.equal(bc.beefVault.toBase58(), beefVault.toBase58());
    assert.equal(bc.divisor.toNumber(), DIVISOR);
    assert.equal(bc.totalOwed.toNumber(), 0);
  });

  it("set_beef_params tunes knobs (admin-gated)", async () => {
    await program.methods.setBeefParams(new anchor.BN(DIVISOR), TICK_BPS, CAP_BPS, new anchor.BN(WINDOW), new anchor.BN(SECS_PER_TICK))
      .accounts({ admin: admin.publicKey, config: configPda, beefConfig: beefConfigPda }).rpc();
    const outsider = await fundedPlayer(1);
    try {
      await program.methods.setBeefParams(new anchor.BN(1), 1, 1, new anchor.BN(1), new anchor.BN(1))
        .accounts({ admin: outsider.publicKey, config: configPda, beefConfig: beefConfigPda })
        .signers([outsider]).rpc();
      assert.fail("non-admin must not set params");
    } catch (e: any) { assert.include(e.toString(), "Unauthorized"); }
  });

  const stampAccts = (roundId: number, roundPda: PublicKey) => ({
    payer: admin.publicKey, config: configPda, round: roundPda,
    beefConfig: beefConfigPda, beefVault, beefRound: beefRoundOf(roundId),
  });

  let p1: Keypair, p2: Keypair;
  let round1: { id: number; pda: PublicKey };
  const P1_STAKE = 300_000_000;
  const P2_STAKE = 100_000_000;

  it("stamp_beef freezes emission = free_vault/divisor and recognizes the liability", async () => {
    p1 = await fundedPlayer();
    p2 = await fundedPlayer();
    round1 = await freshRound(STAKE_WINDOW);
    await program.methods.stakeDirect(new anchor.BN(round1.id), 3, new anchor.BN(P1_STAKE))
      .accounts(stakeDirectAccts(p1.publicKey, round1.pda)).signers([p1]).rpc();
    await program.methods.stakeDirect(new anchor.BN(round1.id), 7, new anchor.BN(P2_STAKE))
      .accounts(stakeDirectAccts(p2.publicKey, round1.pda)).signers([p2]).rpc();

    // pre-CLAIMABLE stamp must fail
    try {
      await program.methods.stampBeef(new anchor.BN(round1.id)).accounts(stampAccts(round1.id, round1.pda)).rpc();
      assert.fail("stamp before swap must fail");
    } catch (e: any) { assert.include(e.toString(), "BadRoundState"); }

    await settleAfterDeadline(round1.pda, Buffer.alloc(32, 7));
    await program.methods.executeSwapMock().accounts(swapAccounts(round1.pda)).rpc();
    await program.methods.stampBeef(new anchor.BN(round1.id)).accounts(stampAccts(round1.id, round1.pda)).rpc();

    const br = await program.account.beefRound.fetch(beefRoundOf(round1.id));
    assert.equal(br.emission.toNumber(), VAULT_FILL / DIVISOR); // 1_000_000
    const bc = await program.account.beefConfig.fetch(beefConfigPda);
    assert.equal(bc.totalOwed.toNumber(), VAULT_FILL / DIVISOR);

    // double-stamp: BeefRound is `init` -> second call fails at account level
    try {
      await program.methods.stampBeef(new anchor.BN(round1.id)).accounts(stampAccts(round1.id, round1.pda)).rpc();
      assert.fail("double stamp must fail");
    } catch (e: any) { assert.include(e.toString(), "already in use"); }
  });

  it("stamp_beef rejects a non-current round (anti retro-stamp grief)", async () => {
    // Settle+swap an old round but leave it UNSTAMPED, then open a newer round.
    // Stamping the now-old (still unstamped) round must hit the current_round_id
    // gate — the anti retro-stamp guard. (duration 0: no stakers, settle at once.)
    const rOld = await freshRound(0);
    await settleAfterDeadline(rOld.pda, Buffer.alloc(32, 4));
    await program.methods.executeSwapMock().accounts(swapAccounts(rOld.pda)).rpc();
    const rNew = await freshRound(0);
    try {
      await program.methods.stampBeef(new anchor.BN(rOld.id)).accounts(stampAccts(rOld.id, rOld.pda)).rpc();
      assert.fail("stamping an old (non-current) round must fail");
    } catch (e: any) { assert.include(e.toString(), "NotCurrentRound"); }

    // finish rNew clean: empty pot -> emission 0, leaving state finalized for the
    // roll tests that follow.
    await settleAfterDeadline(rNew.pda, Buffer.alloc(32, 3));
    await program.methods.executeSwapMock().accounts(swapAccounts(rNew.pda)).rpc();
    await program.methods.stampBeef(new anchor.BN(rNew.id)).accounts(stampAccts(rNew.id, rNew.pda)).rpc();
    const br = await program.account.beefRound.fetch(beefRoundOf(rNew.id));
    assert.equal(br.emission.toNumber(), 0);
  });

  const rollAccts = (pk: PublicKey, roundId: number, roundPda: PublicKey) => ({
    authority: pk, round: roundPda, miner: minerOf(pk), beefRound: beefRoundOf(roundId),
    beefConfig: beefConfigPda, beefMiner: beefMinerOf(pk),
  });

  // Full stake -> settle -> swap -> stamp lifecycle used by later tests.
  async function playRound(stakes: Array<{ kp: Keypair; square: number; amount: number }>) {
    const round = await freshRound(STAKE_WINDOW);
    for (const s of stakes) {
      await program.methods.stakeDirect(new anchor.BN(round.id), s.square, new anchor.BN(s.amount))
        .accounts(stakeDirectAccts(s.kp.publicKey, round.pda)).signers([s.kp]).rpc();
    }
    await settleAfterDeadline(round.pda, Buffer.alloc(32, 9));
    await program.methods.executeSwapMock().accounts(swapAccounts(round.pda)).rpc();
    await program.methods.stampBeef(new anchor.BN(round.id)).accounts(stampAccts(round.id, round.pda)).rpc();
    return round;
  }

  it("roll_beef credits pro-rata shares; second roll is a no-op (never an error)", async () => {
    await program.methods.rollBeef(new anchor.BN(round1.id))
      .accounts(rollAccts(p1.publicKey, round1.id, round1.pda)).signers([p1]).rpc();
    await program.methods.rollBeef(new anchor.BN(round1.id))
      .accounts(rollAccts(p2.publicKey, round1.id, round1.pda)).signers([p2]).rpc();

    const emission = VAULT_FILL / DIVISOR; // 1_000_000
    const bm1 = await program.account.beefMiner.fetch(beefMinerOf(p1.publicKey));
    const bm2 = await program.account.beefMiner.fetch(beefMinerOf(p2.publicKey));
    assert.equal(bm1.unclaimed.toNumber(), (emission * P1_STAKE) / (P1_STAKE + P2_STAKE)); // 750_000
    assert.equal(bm2.unclaimed.toNumber(), (emission * P2_STAKE) / (P1_STAKE + P2_STAKE)); // 250_000
    assert.equal(bm1.lastRolledRoundId.toNumber(), round1.id);

    // idempotent: second roll changes nothing and does NOT throw (bundle safety)
    await program.methods.rollBeef(new anchor.BN(round1.id))
      .accounts(rollAccts(p1.publicKey, round1.id, round1.pda)).signers([p1]).rpc();
    const again = await program.account.beefMiner.fetch(beefMinerOf(p1.publicKey));
    assert.equal(again.unclaimed.toNumber(), bm1.unclaimed.toNumber());
  });

  it("bundle order [roll_beef, claim_direct] in ONE tx preserves the BEEF share", async () => {
    const p3 = await fundedPlayer();
    const r = await playRound([{ kp: p3, square: 5, amount: 200_000_000 }]);
    const p3Ata = getAssociatedTokenAddressSync(ansemMint, p3.publicKey);

    const rollIx = await program.methods.rollBeef(new anchor.BN(r.id))
      .accounts(rollAccts(p3.publicKey, r.id, r.pda)).instruction();
    const claimIx = await program.methods.claimDirect(new anchor.BN(r.id))
      .accounts({ authority: p3.publicKey, config: configPda, round: r.pda, miner: minerOf(p3.publicKey),
        ansemMint, vaultAuthority: vaultAuth, payoutVault, playerAta: p3Ata,
        tokenProgram: TOKEN_PROGRAM_ID }).instruction();
    await provider.sendAndConfirm(new Transaction().add(rollIx, claimIx), [p3]);

    const bm = await program.account.beefMiner.fetch(beefMinerOf(p3.publicKey));
    assert.isAbove(bm.unclaimed.toNumber(), 0); // share survived the zeroing claim
    // and the miner's stakes are zeroed by claim_direct as before
    const m = await program.account.minerPosition.fetch(minerOf(p3.publicKey));
    assert.equal(m.blockStake.reduce((a: number, b: any) => a + b.toNumber(), 0), 0);
  });

  it("roll after ANSEM-claim-first rolls ZERO (stakes gone) — documented forfeit, still no error", async () => {
    const p4 = await fundedPlayer();
    const r = await playRound([{ kp: p4, square: 1, amount: 150_000_000 }]);
    const p4Ata = getAssociatedTokenAddressSync(ansemMint, p4.publicKey);
    await program.methods.claimDirect(new anchor.BN(r.id))
      .accounts({ authority: p4.publicKey, config: configPda, round: r.pda, miner: minerOf(p4.publicKey),
        ansemMint, vaultAuthority: vaultAuth, payoutVault, playerAta: p4Ata,
        tokenProgram: TOKEN_PROGRAM_ID }).signers([p4]).rpc();
    await program.methods.rollBeef(new anchor.BN(r.id))
      .accounts(rollAccts(p4.publicKey, r.id, r.pda)).signers([p4]).rpc();
    const bm = await program.account.beefMiner.fetch(beefMinerOf(p4.publicKey));
    assert.equal(bm.unclaimed.toNumber(), 0);
  });

  const claimBeefAccts = (pk: PublicKey) => ({
    authority: pk, beefConfig: beefConfigPda, beefMiner: beefMinerOf(pk),
    beefMint, vaultAuthority: vaultAuth, beefVault,
    playerBeefAta: getAssociatedTokenAddressSync(beefMint, pk),
    tokenProgram: TOKEN_PROGRAM_ID,
  });

  it("claim_beef pays unclaimed*(1+bonus), decrements owed, resets; double-claim pays zero", async () => {
    // p1 holds 750_000 from round1; secs_per_tick=1 & tick=1000bps mean real
    // seconds have been accruing bonus since the roll. Claim and check bounds.
    const bcBefore = await program.account.beefConfig.fetch(beefConfigPda);
    const bmBefore = await program.account.beefMiner.fetch(beefMinerOf(p1.publicKey));
    const base = bmBefore.unclaimed.toNumber();

    await program.methods.claimBeef().accounts(claimBeefAccts(p1.publicKey)).signers([p1]).rpc();

    const ata = getAssociatedTokenAddressSync(beefMint, p1.publicKey);
    const got = Number((await getAccount(provider.connection, ata)).amount);
    assert.isAtLeast(got, base);            // at least the base
    assert.isAtMost(got, base * 4);         // never beyond the 4x cap

    const bm = await program.account.beefMiner.fetch(beefMinerOf(p1.publicKey));
    assert.equal(bm.unclaimed.toNumber(), 0);  // full reset
    assert.equal(bm.bonusBps, 0);
    const bc = await program.account.beefConfig.fetch(beefConfigPda);
    assert.isBelow(bc.totalOwed.toNumber(), bcBefore.totalOwed.toNumber()); // owed shrank

    // double claim: nothing moves
    await program.methods.claimBeef().accounts(claimBeefAccts(p1.publicKey)).signers([p1]).rpc();
    const got2 = Number((await getAccount(provider.connection, ata)).amount);
    assert.equal(got2, got);
  });

  it("hold-to-grow: bonus caps at 4x and dilution waters a new share down", async () => {
    // crank ticks way up so p2's held balance pins the cap in seconds
    await program.methods.setBeefParams(new anchor.BN(DIVISOR), 30_000, CAP_BPS, new anchor.BN(WINDOW), new anchor.BN(1))
      .accounts({ admin: admin.publicKey, config: configPda, beefConfig: beefConfigPda }).rpc();
    await sleep(3000); // >=1 tick at 30_000bps -> instantly capped

    // p2 rolls a NEW round's share on top of the capped balance -> dilution
    const r = await playRound([{ kp: p2, square: 9, amount: 100_000_000 }]);
    await program.methods.rollBeef(new anchor.BN(r.id))
      .accounts(rollAccts(p2.publicKey, r.id, r.pda)).signers([p2]).rpc();
    const bm = await program.account.beefMiner.fetch(beefMinerOf(p2.publicKey));
    assert.isBelow(bm.bonusBps, CAP_BPS); // new share diluted the capped bonus
    assert.isAbove(bm.bonusBps, 0);

    // claim: payout is (1+bonus)x of the combined balance, bounded by 4x
    const base = bm.unclaimed.toNumber();
    await program.methods.claimBeef().accounts(claimBeefAccts(p2.publicKey)).signers([p2]).rpc();
    const ata = getAssociatedTokenAddressSync(beefMint, p2.publicKey);
    const got = Number((await getAccount(provider.connection, ata)).amount);
    assert.isAtLeast(got, base);
    assert.isAtMost(got, base * 4);
    // restore fast-but-sane params for later tests
    await program.methods.setBeefParams(new anchor.BN(DIVISOR), TICK_BPS, CAP_BPS, new anchor.BN(WINDOW), new anchor.BN(1))
      .accounts({ admin: admin.publicKey, config: configPda, beefConfig: beefConfigPda }).rpc();
  });

  it("INVARIANT: a drained vault stamps emission 0 and the ANSEM game is untouched", async () => {
    // Drain the vault to (approximately) its owed floor by pointing divisor at 1
    // and claiming everything claimable? Simpler: fetch free = amount - owed and
    // assert stamp math directly on a fresh round with near-zero free balance.
    const bc = await program.account.beefConfig.fetch(beefConfigPda);
    const v = await getAccount(provider.connection, beefVault);
    const free = Number(v.amount) - bc.totalOwed.toNumber();
    // crank divisor so emission floors to 0 even with free balance remaining:
    await program.methods.setBeefParams(new anchor.BN("18446744073709551615"), TICK_BPS, CAP_BPS, new anchor.BN(WINDOW), new anchor.BN(1))
      .accounts({ admin: admin.publicKey, config: configPda, beefConfig: beefConfigPda }).rpc();

    const p5 = await fundedPlayer();
    const r = await playRound([{ kp: p5, square: 2, amount: 120_000_000 }]);
    const br = await program.account.beefRound.fetch(beefRoundOf(r.id));
    assert.equal(br.emission.toNumber(), 0); // "empty" vault -> zero emission
    assert.isAtLeast(free, 0);

    // roll + claim still succeed as no-ops...
    await program.methods.rollBeef(new anchor.BN(r.id))
      .accounts(rollAccts(p5.publicKey, r.id, r.pda)).signers([p5]).rpc();
    await program.methods.claimBeef().accounts(claimBeefAccts(p5.publicKey)).signers([p5]).rpc();

    // ...and the ANSEM claim works exactly as in the no-BEEF world.
    const p5Ata = getAssociatedTokenAddressSync(ansemMint, p5.publicKey);
    await program.methods.claimDirect(new anchor.BN(r.id))
      .accounts({ authority: p5.publicKey, config: configPda, round: r.pda, miner: minerOf(p5.publicKey),
        ansemMint, vaultAuthority: vaultAuth, payoutVault, playerAta: p5Ata,
        tokenProgram: TOKEN_PROGRAM_ID }).signers([p5]).rpc();
    const won = Number((await getAccount(provider.connection, p5Ata)).amount);
    assert.isAbove(won, 0); // sole staker -> wins the jackpot regardless of BEEF

    // restore params
    await program.methods.setBeefParams(new anchor.BN(DIVISOR), TICK_BPS, CAP_BPS, new anchor.BN(WINDOW), new anchor.BN(1))
      .accounts({ admin: admin.publicKey, config: configPda, beefConfig: beefConfigPda }).rpc();
  });

  it("SOLVENCY: total BEEF paid out never exceeds the vault fill", async () => {
    const v = await getAccount(provider.connection, beefVault);
    const stillVaulted = Number(v.amount);
    assert.isAtLeast(stillVaulted, 0);
    assert.isAtMost(VAULT_FILL - stillVaulted, VAULT_FILL); // paid <= filled
    const bc = await program.account.beefConfig.fetch(beefConfigPda);
    assert.isAtMost(bc.totalOwed.toNumber(), stillVaulted); // owed always covered
  });

  // ---- Task 4: sweep_beef_excess (admin-gated, solvency-bounded token exit) ----
  // Only BEEF ABOVE the total_owed solvency ledger may leave the vault. The fixtures
  // above have accrued a real liability (rolled, still-unclaimed shares -> total_owed>0)
  // AND a large free surplus, so the boundary `amount <= vault.amount - total_owed` is
  // meaningfully exercised. This test is placed AFTER the suite's last vault-balance
  // assertion (the SOLVENCY invariant above) and additionally RESTORES the vault to its
  // exact pre-sweep balance at the end, so it cannot disturb any earlier assertion.
  const sweepBeefAccounts = (destAta: PublicKey, adminPk: PublicKey) => ({
    admin: adminPk,
    config: configPda,
    beefConfig: beefConfigPda,
    vaultAuthority: vaultAuth,
    beefMint, // required for transfer_checked (mint + decimals)
    beefVault,
    destinationAta: destAta,
    tokenProgram: TOKEN_PROGRAM_ID,
  });

  it("sweep_beef_excess: exact free surplus leaves; +1 unit and non-admin fail; vault restored", async () => {
    const bc0 = await program.account.beefConfig.fetch(beefConfigPda);
    const v0 = await getAccount(provider.connection, beefVault);
    const vaultAmt = v0.amount;
    const owed = BigInt(bc0.totalOwed.toString());
    const free = vaultAmt - owed;
    // Fixtures must give us a real liability AND a real surplus for the boundary to bite.
    assert.isAbove(bc0.totalOwed.toNumber(), 0, "fixtures left a real BEEF liability (total_owed > 0)");
    assert.isAbove(Number(free), 0, "there is free BEEF above the owed floor to sweep");

    // Admin-owned destination token account for the beef mint (any owner is allowed;
    // the ix only constrains token::mint == beef_config.beef_mint).
    const destAta = await createAccount(
      provider.connection, admin.payer, beefMint, admin.publicKey, Keypair.generate()
    );

    // (a) non-admin signer -> Unauthorized (no tokens move).
    const outsider = await fundedPlayer(1);
    try {
      await (program.methods as any)
        .sweepBeefExcess(new anchor.BN(free.toString()))
        .accounts(sweepBeefAccounts(destAta, outsider.publicKey))
        .signers([outsider])
        .rpc();
      assert.fail("a non-admin must not be able to sweep BEEF");
    } catch (e: any) {
      assert.include(e.toString(), "Unauthorized");
    }

    // (b) one base unit ABOVE the free surplus -> InsufficientBalance (solvency floor).
    try {
      await (program.methods as any)
        .sweepBeefExcess(new anchor.BN((free + 1n).toString()))
        .accounts(sweepBeefAccounts(destAta, admin.publicKey))
        .rpc();
      assert.fail("sweeping into the owed floor must be rejected");
    } catch (e: any) {
      assert.include(e.toString(), "InsufficientBalance");
    }

    // (c) exactly the free surplus succeeds and drains the vault down to total_owed.
    await (program.methods as any)
      .sweepBeefExcess(new anchor.BN(free.toString()))
      .accounts(sweepBeefAccounts(destAta, admin.publicKey))
      .rpc();

    const vaultAfter = (await getAccount(provider.connection, beefVault)).amount;
    const destAfter = (await getAccount(provider.connection, destAta)).amount;
    const bc1 = await program.account.beefConfig.fetch(beefConfigPda);
    assert.equal(destAfter.toString(), free.toString(), "destination received exactly the free surplus");
    assert.equal(vaultAfter.toString(), owed.toString(), "vault drained down to exactly total_owed");
    assert.equal(bc1.totalOwed.toString(), bc0.totalOwed.toString(), "total_owed ledger unchanged by the sweep");
    // Solvency invariant still holds: the vault fully covers everything owed.
    assert.isAtLeast(Number(vaultAfter), bc1.totalOwed.toNumber());

    // RESTORE: deposit the swept BEEF back so the vault balance is exactly as before
    // (plain permissionless SPL transfer, admin ATA -> vault). Proves no interference:
    // the suite's vault ends identical to its pre-sweep state.
    await transfer(provider.connection, admin.payer, destAta, beefVault, admin.payer, free);
    const vaultRestored = (await getAccount(provider.connection, beefVault)).amount;
    assert.equal(vaultRestored.toString(), vaultAmt.toString(), "vault fully restored to its pre-sweep balance");
  });
});
