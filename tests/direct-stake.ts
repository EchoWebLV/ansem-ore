import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { AnsemMiner } from "../target/types/ansem_miner";
import { PublicKey, Transaction } from "@solana/web3.js";
import { assert } from "chai";
import { getAssociatedTokenAddressSync, getAccount, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { keccak256 } from "js-sha3";

const enc = (s: string) => Buffer.from(s);

// Mirror the on-chain payout math (programs/ansem-miner/src/math.rs) so the test
// can independently recompute a round's frozen non-jackpot entitlement. js-sha3
// keccak256 == Solana's hashv (keccak-256); byte packing matches multiplier_bps.
const multiplierBps = (rnd: number[], square: number, minBps: number, maxBps: number): bigint => {
  const h = keccak256.array([...rnd, square & 0xff]);
  const x = h[0] | (h[1] << 8);
  return BigInt(minBps + (x % ((maxBps - minBps) + 1)));
};
const returnWeight = (blockSol: bigint[], rnd: number[], jsq: number, minBps: number, maxBps: number): bigint => {
  let w = 0n;
  for (let s = 0; s < 25; s++) if (s !== jsq) w += blockSol[s] * multiplierBps(rnd, s, minBps, maxBps);
  return w;
};
const nonjackpotPayout = (weight: bigint, pot: bigint, proceeds: bigint): bigint =>
  pot === 0n ? 0n : (proceeds * weight) / (pot * 10_000n);
const jackpotBlock = (rnd: number[], domain: string): number =>
  keccak256.array([...rnd, ...Buffer.from(domain)])[0] % 25;

// Direct-stake engine suite (ORE model): SOL moves wallet->pot INSIDE the stake
// tx; no escrow/session/delegation. Pull-claims; idempotency via block_stake
// zeroing. Runs against a fresh local validator (self-initializes).
describe("direct-stake engine", () => {
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
  const payoutVault = getAssociatedTokenAddressSync(ansemMint, vaultAuth, true);
  const minerOf = (pk: PublicKey) =>
    PublicKey.findProgramAddressSync([enc("miner"), pk.toBuffer()], program.programId)[0];

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const STAKE_WINDOW = 15;

  async function freshRound(durationSecs = 0): Promise<{ id: number; pda: PublicKey }> {
    await program.methods.setRoundDuration(new anchor.BN(durationSecs)).accounts({ admin: admin.publicKey }).rpc();
    const before = await program.account.config.fetch(configPda);
    const nextId = before.currentRoundId.toNumber() + 1;
    const [pda] = PublicKey.findProgramAddressSync(
      [enc("round"), new anchor.BN(nextId).toArrayLike(Buffer, "le", 8)], program.programId);
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

  async function cancelAfterDeadline(roundPda: PublicKey) {
    for (let i = 0; i < 40; i++) {
      try {
        await program.methods.cancelRound().accounts({ admin: admin.publicKey, round: roundPda }).rpc();
        return;
      } catch (e: any) {
        // Pre-deadline cancel throws RoundNotCancelable (recovery.rs), not RoundNotEnded.
        if (!/RoundNotEnded|RoundNotCancelable/.test(e.toString())) throw e;
        await sleep(1000);
      }
    }
    throw new Error("round never became cancelable");
  }

  // tokenProgram is no longer auto-resolvable (the program's token layer is an Interface);
  // the mock mint is classic SPL, so pass the classic token program explicitly.
  const swapAccounts = (roundPda: PublicKey) => ({
    payer: admin.publicKey, round: roundPda, ansemMint,
    mintAuthority: mintAuth, vaultAuthority: vaultAuth, payoutVault,
    potVault, treasury, tokenProgram: TOKEN_PROGRAM_ID,
  });
  const stakeDirectAccts = (pk: PublicKey, roundPda: PublicKey) => ({
    authority: pk, config: configPda, round: roundPda, miner: minerOf(pk), potVault,
  });
  const claimDirectAccts = (pk: PublicKey, roundPda: PublicKey, ata: PublicKey) => ({
    authority: pk, config: configPda, round: roundPda, miner: minerOf(pk),
    ansemMint, vaultAuthority: vaultAuth, payoutVault, playerAta: ata, tokenProgram: TOKEN_PROGRAM_ID,
  });

  async function fundedPlayer(sol = 3): Promise<anchor.web3.Keypair> {
    const kp = anchor.web3.Keypair.generate();
    const sig = await provider.connection.requestAirdrop(kp.publicKey, sol * anchor.web3.LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(sig);
    return kp;
  }

  it("initializes", async () => {
    await program.methods.initialize().accounts({ admin: admin.publicKey, tokenProgram: TOKEN_PROGRAM_ID }).rpc();
    const cfg = await program.account.config.fetch(configPda);
    assert.isTrue(cfg.currentRoundFinalized);
  });

  const p1 = anchor.web3.Keypair.generate();
  const p2 = anchor.web3.Keypair.generate();
  let round: { id: number; pda: PublicKey };
  let p1Ata: PublicKey, p2Ata: PublicKey;
  const P1_TOTAL = 300_000_000; // 0.2 + 0.1 across two squares
  const P2_TOTAL = 100_000_000;

  it("stake_direct: ONE tx, two squares, SOL moves wallet->pot inside it (no escrow anywhere)", async () => {
    const s1 = await provider.connection.requestAirdrop(p1.publicKey, 3 * anchor.web3.LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(s1);
    const s2 = await provider.connection.requestAirdrop(p2.publicKey, 3 * anchor.web3.LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(s2);

    round = await freshRound(STAKE_WINDOW);
    const potBefore = await provider.connection.getBalance(potVault);
    const walletBefore = await provider.connection.getBalance(p1.publicKey);

    // p1: TWO squares in ONE transaction — the "one approval" UX, on-chain.
    const ix1 = await program.methods.stakeDirect(new anchor.BN(round.id), 3, new anchor.BN(200_000_000))
      .accounts(stakeDirectAccts(p1.publicKey, round.pda)).instruction();
    const ix2 = await program.methods.stakeDirect(new anchor.BN(round.id), 11, new anchor.BN(100_000_000))
      .accounts(stakeDirectAccts(p1.publicKey, round.pda)).instruction();
    await provider.sendAndConfirm(new Transaction().add(ix1, ix2), [p1]);

    // p2: single square, same square 3 (tests pro-rata + jackpot splitting later).
    await program.methods.stakeDirect(new anchor.BN(round.id), 3, new anchor.BN(P2_TOTAL))
      .accounts(stakeDirectAccts(p2.publicKey, round.pda)).signers([p2]).rpc();

    const r = await program.account.round.fetch(round.pda);
    assert.equal(r.pot.toNumber(), P1_TOTAL + P2_TOTAL);
    assert.equal(r.blockSol[3].toNumber(), 300_000_000);
    assert.equal(r.blockSol[11].toNumber(), 100_000_000);

    const m1 = await program.account.minerPosition.fetch(minerOf(p1.publicKey));
    assert.equal(m1.roundId.toNumber(), round.id);
    assert.equal(m1.blockStake[3].toNumber(), 200_000_000);
    assert.equal(m1.blockStake[11].toNumber(), 100_000_000);

    // The lamports physically moved wallet -> pot vault in the stake txs.
    const potAfter = await provider.connection.getBalance(potVault);
    assert.equal(potAfter - potBefore, P1_TOTAL + P2_TOTAL);
    const walletAfter = await provider.connection.getBalance(p1.publicKey);
    // p1 paid stakes + fees + one-time miner PDA rent; bound the delta sanely.
    assert.isAtLeast(walletBefore - walletAfter, P1_TOTAL);
    assert.isBelow(walletBefore - walletAfter, P1_TOTAL + 5_000_000);

    // NO escrow account was created for either player.
    const [e1] = PublicKey.findProgramAddressSync([enc("escrow"), p1.publicKey.toBuffer()], program.programId);
    assert.isNull(await provider.connection.getAccountInfo(e1));
  });

  it("guards: below min, bad block, ended round", async () => {
    try {
      await program.methods.stakeDirect(new anchor.BN(round.id), 0, new anchor.BN(1_000))
        .accounts(stakeDirectAccts(p2.publicKey, round.pda)).signers([p2]).rpc();
      assert.fail("should reject below min_stake");
    } catch (e: any) { assert.include(e.toString(), "StakeTooSmall"); }
    try {
      await program.methods.stakeDirect(new anchor.BN(round.id), 25, new anchor.BN(P2_TOTAL))
        .accounts(stakeDirectAccts(p2.publicKey, round.pda)).signers([p2]).rpc();
      assert.fail("should reject block 25");
    } catch (e: any) { assert.include(e.toString(), "BadBlock"); }
  });

  it("keeper flow unchanged: settle + swap the direct round", async () => {
    await settleAfterDeadline(round.pda, Buffer.alloc(32, 7));
    await program.methods.executeSwapMock().accounts(swapAccounts(round.pda)).rpc();
    const r = await program.account.round.fetch(round.pda);
    assert.equal(r.state, 4); // CLAIMABLE
    // pot 0.4 SOL, 1% fee -> proceeds = 0.396 SOL * 2800 ANSEM/SOL (6dp)
    assert.equal(r.swapProceeds.toNumber(), 396_000_000 * 2.8);
  });

  it("swap tracks obligations + freezes entitlement_total (nj_total + jackpot_pool)", async () => {
    const cfg: any = await program.account.config.fetch(configPda);
    const r: any = await program.account.round.fetch(round.pda);
    // First swap (rollover started at 0): every base unit just minted is now owed.
    assert.equal(cfg.ansemObligations.toString(), r.swapProceeds.toString());
    // Recompute nj_total exactly as the program does; the jackpot square derived
    // from our keccak mirror must equal the on-chain one (guards the TS math).
    const rnd = Array.from(r.randomness as number[]).map(Number);
    const jsq = jackpotBlock(rnd, "jackpot");
    assert.equal(jsq, r.jackpotSquare);
    const blockSol = (r.blockSol as anchor.BN[]).map((b) => BigInt(b.toString()));
    const w = returnWeight(blockSol, rnd, jsq, cfg.multMinBps, cfg.multMaxBps);
    const expectedNjTotal = nonjackpotPayout(w, BigInt(r.pot.toString()), BigInt(r.swapProceeds.toString()));
    assert.equal(
      r.entitlementTotal.toString(),
      (expectedNjTotal + BigInt(r.jackpotPool.toString())).toString()
    );
  });

  it("stake_direct on an ENDED round is rejected", async () => {
    try {
      await program.methods.stakeDirect(new anchor.BN(round.id), 0, new anchor.BN(P2_TOTAL))
        .accounts(stakeDirectAccts(p2.publicKey, round.pda)).signers([p2]).rpc();
      assert.fail("should reject on non-open round");
    } catch (e: any) { assert.include(e.toString(), "RoundNotOpen"); }
  });

  it("claim_direct pays both stakers; solvency holds; double-claim pays ZERO", async () => {
    p1Ata = getAssociatedTokenAddressSync(ansemMint, p1.publicKey);
    p2Ata = getAssociatedTokenAddressSync(ansemMint, p2.publicKey);

    // Each claim must move exactly `paid` from the config obligations ledger into
    // this round's claimed_proceeds (ATAs start empty, so paid == the new balance).
    const cfg0: any = await program.account.config.fetch(configPda);
    const r0: any = await program.account.round.fetch(round.pda);

    await program.methods.claimDirect(new anchor.BN(round.id))
      .accounts(claimDirectAccts(p1.publicKey, round.pda, p1Ata)).signers([p1]).rpc();
    const paid1 = (await getAccount(provider.connection, p1Ata)).amount;
    const cfg1: any = await program.account.config.fetch(configPda);
    const r1: any = await program.account.round.fetch(round.pda);
    assert.equal(r1.claimedProceeds.sub(r0.claimedProceeds).toString(), paid1.toString());
    assert.equal(cfg0.ansemObligations.sub(cfg1.ansemObligations).toString(), paid1.toString());

    await program.methods.claimDirect(new anchor.BN(round.id))
      .accounts(claimDirectAccts(p2.publicKey, round.pda, p2Ata)).signers([p2]).rpc();
    const paid2 = (await getAccount(provider.connection, p2Ata)).amount;
    const cfg2: any = await program.account.config.fetch(configPda);
    const r2c: any = await program.account.round.fetch(round.pda);
    assert.equal(r2c.claimedProceeds.sub(r1.claimedProceeds).toString(), paid2.toString());
    assert.equal(cfg1.ansemObligations.sub(cfg2.ansemObligations).toString(), paid2.toString());

    const r = r2c;
    const b1 = Number(paid1);
    const b2 = Number(paid2);
    assert.isAbove(b1 + b2, 0);
    assert.isAtMost(b1 + b2, r.swapProceeds.toNumber()); // solvency: never over-pay

    // Miner stakes zeroed -> a second claim computes weight 0 and pays 0.
    const m1 = await program.account.minerPosition.fetch(minerOf(p1.publicKey));
    assert.equal(m1.blockStake.reduce((a: number, b: any) => a + b.toNumber(), 0), 0);
    await program.methods.claimDirect(new anchor.BN(round.id))
      .accounts(claimDirectAccts(p1.publicKey, round.pda, p1Ata)).signers([p1]).rpc();
    const b1Again = Number((await getAccount(provider.connection, p1Ata)).amount);
    assert.equal(b1Again, b1);
  });

  it("refund_direct returns exact stakes on a cancelled round; second refund moves nothing", async () => {
    const p3 = await fundedPlayer();
    const r2 = await freshRound(8);
    const STAKE = 150_000_000;
    await program.methods.stakeDirect(new anchor.BN(r2.id), 5, new anchor.BN(STAKE))
      .accounts(stakeDirectAccts(p3.publicKey, r2.pda)).signers([p3]).rpc();

    await cancelAfterDeadline(r2.pda);

    const before = await provider.connection.getBalance(p3.publicKey);
    await program.methods.refundDirect(new anchor.BN(r2.id))
      .accounts(stakeDirectAccts(p3.publicKey, r2.pda)).signers([p3]).rpc();
    const after = await provider.connection.getBalance(p3.publicKey);
    // Refund minus this tx's fee — allow small fee slack.
    assert.isAtLeast(after - before, STAKE - 100_000);

    const again = await provider.connection.getBalance(p3.publicKey);
    await program.methods.refundDirect(new anchor.BN(r2.id))
      .accounts(stakeDirectAccts(p3.publicKey, r2.pda)).signers([p3]).rpc();
    const after2 = await provider.connection.getBalance(p3.publicKey);
    assert.isAtMost(again - after2, 100_000); // only the fee, no funds moved
  });
});
