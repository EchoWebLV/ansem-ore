import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { AnsemMiner } from "../target/types/ansem_miner";
import { PublicKey, Keypair } from "@solana/web3.js";
import { assert, expect } from "chai";
import {
  createMint,
  mintTo,
  getMint,
  getAccount,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import { keccak256 } from "js-sha3";

const enc = (s: string) => Buffer.from(s);

// Mirror the on-chain payout math (programs/ansem-miner/src/math.rs) so the test can
// independently recompute a real round's frozen non-jackpot entitlement and force a
// known jackpot square from the injected settle randomness. js-sha3 keccak256 ==
// Solana's hashv (keccak-256); byte packing matches multiplier_bps / jackpot_block.
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

// The upgradeable BPF loader that owns program accounts on a real cluster (and on a
// plainly-deployed localnet program). ProgramData PDA = [programId] under this loader.
const BPF_LOADER_UPGRADEABLE = new PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111"
);

// Mainnet-path suite: real-mode initialization (`initialize_real`). Unlike the mock
// `initialize`, this path is gated to the program's UPGRADE AUTHORITY (kills init-
// squatting) and records an EXTERNAL, pre-existing ANSEM mint (no PDA mint minted).
// The upgrade-authority signer is NOT necessarily the admin: `keeper_admin` (a hot
// key) becomes `config.admin`, so the cold deploy wallet can never crank admin ixs.
//
// REQUIRES the program to be deployed with the UPGRADEABLE loader (so a ProgramData
// account exists and its upgrade authority == the provider wallet). A genesis
// `--bpf-program` preload has NO ProgramData and will fail this suite. Deploy recipe:
//   solana-test-validator  (plain, fresh test-ledger)
//   solana airdrop <provider wallet>
//   solana program deploy target/deploy/ansem_miner.so \
//     --program-id target/deploy/ansem_miner-keypair.json -u localhost
describe("mainnet-path: initialize_real (upgrade-authority gated, external ANSEM mint)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.AnsemMiner as Program<AnsemMiner>;
  // provider wallet == the program's upgrade authority (upgradeable deploy).
  const deployer = provider.wallet as anchor.Wallet;

  const [configPda] = PublicKey.findProgramAddressSync([enc("config")], program.programId);
  const [mintAuth] = PublicKey.findProgramAddressSync([enc("mint_auth")], program.programId);
  const [vaultAuth] = PublicKey.findProgramAddressSync([enc("vault_auth")], program.programId);
  const [potVault] = PublicKey.findProgramAddressSync([enc("pot_vault")], program.programId);
  const [treasury] = PublicKey.findProgramAddressSync([enc("treasury")], program.programId);
  const [programData] = PublicKey.findProgramAddressSync(
    [program.programId.toBuffer()],
    BPF_LOADER_UPGRADEABLE
  );

  // The Railway hot key: passed as `keeper_admin`, becomes config.admin. Distinct
  // from the deploy wallet so we can prove signer != admin.
  const keeperAdmin = Keypair.generate();
  // A wallet that is neither the upgrade authority nor the admin.
  const stranger = Keypair.generate();
  let ansemMint: PublicKey;

  const initRealAccounts = (adminPk: PublicKey) => ({
    admin: adminPk,
    config: configPda,
    ansemMint,
    mintAuthority: mintAuth,
    vaultAuthority: vaultAuth,
    potVault,
    treasury,
    program: program.programId,
    programData,
    systemProgram: anchor.web3.SystemProgram.programId,
  });

  const airdrop = async (pk: PublicKey, sol: number) => {
    const sig = await provider.connection.requestAirdrop(
      pk,
      sol * anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(sig);
  };

  before(async () => {
    await airdrop(keeperAdmin.publicKey, 2);
    await airdrop(stranger.publicKey, 2);
    // A pre-existing TOKEN-2022 mint (6 decimals) stands in for the real $ANSEM mint,
    // which is a Token-2022 mint on mainnet (owner TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb).
    // The program holds NO authority over it; it is passed in as an external account, and
    // every token op below runs against TOKEN_2022_PROGRAM_ID so the suite proves the EXACT
    // real-ANSEM shape end-to-end (init -> stake -> settle -> swap_real -> claim -> sweeps -> close).
    ansemMint = await createMint(
      provider.connection,
      deployer.payer,
      deployer.publicKey,
      null,
      6,
      undefined,
      undefined,
      TOKEN_2022_PROGRAM_ID
    );
  });

  // Negative FIRST: while Config does not yet exist, a non-upgrade-authority signer
  // must be rejected. (Running this before the successful init proves the failure is
  // the upgrade-authority constraint, not an "already in use" Config collision.)
  it("rent reserve fixture: rejects init by a non-upgrade-authority signer (Unauthorized)", async () => {
    try {
      await (program.methods as any)
        .initializeReal(keeperAdmin.publicKey)
        .accountsPartial(initRealAccounts(stranger.publicKey))
        .signers([stranger])
        .rpc();
      assert.fail("initialize_real must reject a non-upgrade-authority signer");
    } catch (e: any) {
      assert.include(e.toString(), "Unauthorized");
    }
  });

  it("rent reserve fixture: initialize_real: external mint, JUPITER mode, admin = keeper_admin (not the signer)", async () => {
    await (program.methods as any)
      .initializeReal(keeperAdmin.publicKey)
      .accountsPartial(initRealAccounts(deployer.publicKey))
      .rpc();

    const cfg: any = await program.account.config.fetch(configPda);
    assert.equal(cfg.swapMode, 1, "swap_mode == SWAP_MODE_JUPITER");
    assert.equal(
      cfg.ansemMint.toBase58(),
      ansemMint.toBase58(),
      "records the external ANSEM mint"
    );
    assert.equal(cfg.mockRate.toString(), "0", "no mock rate in real mode");
    // The signer was the deploy wallet, but admin is the passed keeper key.
    assert.equal(
      cfg.admin.toBase58(),
      keeperAdmin.publicKey.toBase58(),
      "config.admin == keeper_admin arg (signer is only the upgrade authority)"
    );
    // Sanity: Task-1 fields carry the same defaults the mock initialize sets.
    assert.equal(cfg.ansemObligations.toString(), "0");
    assert.equal(cfg.rolloverJackpot.toString(), "0");
    assert.equal(cfg.minSwapRate.toString(), "0");
    assert.isTrue(cfg.currentRoundFinalized);

    // Fixture (BEEF/jackpot upgrade): execute_swap_real now reads the JackpotConfig
    // PDA (spec D6) — seed it once here, gated by the real-mode admin (keeper_admin).
    // Defaults (1-in-25 / 100x) are transparent to this suite's assertions: every
    // real-swap round below starts from rollover 0, so the bite is 0 and the
    // "rollover consumed by the winner" identity is unchanged.
    await (program.methods as any)
      .initJackpotConfig()
      .accounts({ admin: keeperAdmin.publicKey })
      .signers([keeperAdmin])
      .rpc();
  });

  it("rent reserve fixture: admin-gated ix signed by the DEPLOY wallet now FAILS Unauthorized", async () => {
    try {
      await program.methods
        .setRoundDuration(new anchor.BN(42))
        .accounts({ admin: deployer.publicKey })
        .rpc();
      assert.fail("deploy wallet must not be able to crank admin ixs");
    } catch (e: any) {
      assert.include(e.toString(), "Unauthorized");
    }
  });

  it("rent reserve fixture: the SAME admin-gated ix signed by keeper_admin SUCCEEDS", async () => {
    await program.methods
      .setRoundDuration(new anchor.BN(42))
      .accounts({ admin: keeperAdmin.publicKey })
      .signers([keeperAdmin])
      .rpc();
    const cfg: any = await program.account.config.fetch(configPda);
    assert.equal(cfg.roundDurationSecs.toString(), "42");
  });

  // ---- Task 3: execute_swap_real (keeper-inventory payout) ----
  // The real payout path. Unlike execute_swap_mock (mints from a PDA mint at a fixed
  // rate), execute_swap_real PULLS an exact, keeper-quoted `ansem_out` of a PRE-EXISTING
  // external mint out of the keeper's own ATA (simulated Jupiter buy) into payout_vault —
  // no mint authority, no minting. The SOL pot moves pot_vault -> treasury exactly as in
  // mock, and the shared finalize_swap_accounting freezes the same jackpot/rollover/
  // entitlement/obligations state. These tests run on the real-mode Config from above.
  // Lazily derived: ansemMint is only assigned in the before() hook, so compute the
  // payout ATA inside the first swap test rather than eagerly in the describe body.
  let payoutVault: PublicKey;
  const minerOf = (pk: PublicKey) =>
    PublicKey.findProgramAddressSync([enc("miner"), pk.toBuffer()], program.programId)[0];
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // Fixed settle randomness -> a known jackpot square, so we can guarantee a winner.
  const RND = Buffer.alloc(32, 9);
  const jsq = jackpotBlock([...RND], "jackpot");
  const loserSquare = (jsq + 1) % 25;
  const WINNER_STAKE = 200_000_000; // 0.2 SOL on the jackpot square
  const LOSER_STAKE = 100_000_000; // 0.1 SOL on a non-jackpot square
  const KEEPER_INVENTORY = 10_000_000_000; // 10k ANSEM (6dp) minted to the keeper ATA
  const ANSEM_OUT = new anchor.BN(800_000_000); // arbitrary market-ish proceeds (800 ANSEM)

  const winner = Keypair.generate();
  const loser = Keypair.generate();
  let keeperAta: PublicKey;
  let roundId: number;
  let roundPda: PublicKey;

  const settleRealAccounts = (rPda: PublicKey) => ({
    admin: keeperAdmin.publicKey,
    round: rPda,
  });
  const swapRealAccounts = (rPda: PublicKey, payerPk: PublicKey, srcAta: PublicKey) => ({
    payer: payerPk,
    config: configPda,
    round: rPda,
    ansemMint,
    vaultAuthority: vaultAuth,
    payoutVault,
    sourceAta: srcAta,
    potVault,
    treasury,
    // token_program is no longer auto-resolvable (Interface has two ids) — pass Token-2022.
    tokenProgram: TOKEN_2022_PROGRAM_ID,
  });
  const stakeRealAccounts = (pk: PublicKey, rPda: PublicKey) => ({
    authority: pk,
    config: configPda,
    round: rPda,
    miner: minerOf(pk),
    potVault,
  });
  const claimRealAccounts = (pk: PublicKey, rPda: PublicKey, ata: PublicKey) => ({
    authority: pk,
    config: configPda,
    round: rPda,
    miner: minerOf(pk),
    ansemMint,
    vaultAuthority: vaultAuth,
    payoutVault,
    playerAta: ata,
    tokenProgram: TOKEN_2022_PROGRAM_ID,
  });

  const balOf = async (ata: PublicKey): Promise<bigint> => {
    try {
      return (await getAccount(provider.connection, ata, undefined, TOKEN_2022_PROGRAM_ID)).amount;
    } catch {
      return 0n; // ATA not created yet
    }
  };

  it("rent reserve fixture: real round: fund keeper inventory, two wallets stake, settle to a known jackpot", async () => {
    payoutVault = getAssociatedTokenAddressSync(ansemMint, vaultAuth, true, TOKEN_2022_PROGRAM_ID);
    await airdrop(winner.publicKey, 3);
    await airdrop(loser.publicKey, 3);

    // Simulated Jupiter buy: mint EXTERNAL supply into the keeper's own Token-2022 ATA. The
    // program never has this mint's authority — swap must pull from here, not mint.
    const keeperAtaAcc = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      deployer.payer,
      ansemMint!,
      keeperAdmin.publicKey,
      undefined,
      undefined,
      undefined,
      TOKEN_2022_PROGRAM_ID
    );
    keeperAta = keeperAtaAcc.address;
    await mintTo(
      provider.connection,
      deployer.payer,
      ansemMint!,
      keeperAta,
      deployer.publicKey, // deployer is the external mint's authority (createMint above)
      KEEPER_INVENTORY,
      undefined,
      undefined,
      TOKEN_2022_PROGRAM_ID
    );
    assert.equal((await balOf(keeperAta)).toString(), KEEPER_INVENTORY.toString());

    // Short round so we can settle without a long sleep, but long enough to stake.
    await program.methods
      .setRoundDuration(new anchor.BN(6))
      .accounts({ admin: keeperAdmin.publicKey })
      .signers([keeperAdmin])
      .rpc();

    const cfg: any = await program.account.config.fetch(configPda);
    roundId = cfg.currentRoundId.toNumber() + 1;
    [roundPda] = PublicKey.findProgramAddressSync(
      [enc("round"), new anchor.BN(roundId).toArrayLike(Buffer, "le", 8)],
      program.programId
    );
    await program.methods
      .createRound()
      .accounts({ payer: keeperAdmin.publicKey, round: roundPda })
      .signers([keeperAdmin])
      .rpc();

    // winner stakes the jackpot square; loser stakes a different square.
    await program.methods
      .stakeDirect(new anchor.BN(roundId), jsq, new anchor.BN(WINNER_STAKE))
      .accounts(stakeRealAccounts(winner.publicKey, roundPda))
      .signers([winner])
      .rpc();
    await program.methods
      .stakeDirect(new anchor.BN(roundId), loserSquare, new anchor.BN(LOSER_STAKE))
      .accounts(stakeRealAccounts(loser.publicKey, roundPda))
      .signers([loser])
      .rpc();

    const r0: any = await program.account.round.fetch(roundPda);
    assert.equal(r0.pot.toNumber(), WINNER_STAKE + LOSER_STAKE);

    // settle after the deadline (admin = keeper), injecting our fixed randomness.
    for (let i = 0; i < 40; i++) {
      try {
        await program.methods
          .settle([...RND])
          .accounts(settleRealAccounts(roundPda))
          .signers([keeperAdmin])
          .rpc();
        break;
      } catch (e: any) {
        if (!e.toString().includes("RoundNotEnded")) throw e;
        await sleep(1000);
      }
    }
    const r1: any = await program.account.round.fetch(roundPda);
    assert.equal(r1.state, 2, "STATE_SETTLED");
    assert.equal(r1.jackpotSquare, jsq, "jackpot square == our forced keccak draw");
  });

  it("rent reserve fixture: execute_swap_real rejects a non-admin payer (Unauthorized)", async () => {
    // stranger is neither the deploy wallet nor config.admin: the payer==admin
    // constraint on `config` fails before any funds move (round stays SETTLED).
    try {
      await (program.methods as any)
        .executeSwapReal(ANSEM_OUT)
        .accounts(swapRealAccounts(roundPda, stranger.publicKey, keeperAta))
        .signers([stranger])
        .rpc();
      assert.fail("non-admin payer must be rejected");
    } catch (e: any) {
      assert.include(e.toString(), "Unauthorized");
    }
    const r: any = await program.account.round.fetch(roundPda);
    assert.equal(r.state, 2, "round still SETTLED after the failed swap");
  });

  it("rent reserve fixture: execute_swap_real enforces the min_swap_rate floor (SwapRateTooLow)", async () => {
    // Set an absurd floor: ansem_out >= net * rate / LAMPORTS_PER_SOL is unmeetable.
    await (program.methods as any)
      .setMinSwapRate(new anchor.BN("1000000000000"))
      .accounts({ admin: keeperAdmin.publicKey })
      .signers([keeperAdmin])
      .rpc();
    try {
      await (program.methods as any)
        .executeSwapReal(ANSEM_OUT)
        .accounts(swapRealAccounts(roundPda, keeperAdmin.publicKey, keeperAta))
        .signers([keeperAdmin])
        .rpc();
      assert.fail("swap below the rate floor must be rejected");
    } catch (e: any) {
      assert.include(e.toString(), "SwapRateTooLow");
    }
    // Reset so the happy-path swap below is unconstrained.
    await (program.methods as any)
      .setMinSwapRate(new anchor.BN(0))
      .accounts({ admin: keeperAdmin.publicKey })
      .signers([keeperAdmin])
      .rpc();
    const r: any = await program.account.round.fetch(roundPda);
    assert.equal(r.state, 2, "round still SETTLED (rate-floor reverted the tx)");
  });

  it("rent reserve fixture: execute_swap_real fails when the source ATA holds less than ansem_out (SPL transfer)", async () => {
    // Ask to pay out MORE than the keeper minted -> the in-ix SPL transfer fails and
    // the whole tx reverts (the pot->treasury leg that ran first is rolled back too).
    const tooMuch = new anchor.BN((KEEPER_INVENTORY + 1).toString());
    let threw = false;
    try {
      await (program.methods as any)
        .executeSwapReal(tooMuch)
        .accounts(swapRealAccounts(roundPda, keeperAdmin.publicKey, keeperAta))
        .signers([keeperAdmin])
        .rpc();
    } catch {
      threw = true;
    }
    assert.isTrue(threw, "over-drawing the keeper inventory must fail");
    const r: any = await program.account.round.fetch(roundPda);
    assert.equal(r.state, 2, "round still SETTLED (SPL transfer failure reverted)");
  });

  it("rent reserve: execute_swap_real keeps the pot vault alive while moving the exact pot", async () => {
    const cfg0: any = await program.account.config.fetch(configPda);
    const r0: any = await program.account.round.fetch(roundPda);
    const pot = BigInt(r0.pot.toString());

    const potVaultBefore = await provider.connection.getBalance(potVault);
    const treasuryBefore = await provider.connection.getBalance(treasury);
    const sourceBefore = await balOf(keeperAta);
    const payoutBefore = await balOf(payoutVault);
    const supplyBefore = (await getMint(provider.connection, ansemMint!, undefined, TOKEN_2022_PROGRAM_ID)).supply;
    assert.equal(cfg0.ansemObligations.toString(), "0", "no obligations before the first swap");
    assert.equal(cfg0.rolloverJackpot.toString(), "0", "no rollover before the first swap");
    assert.equal(potVaultBefore, Number(pot), "the pot vault has no residual balance");

    await provider.sendAndConfirm(
      new anchor.web3.Transaction().add(
        anchor.web3.SystemProgram.transfer({
          fromPubkey: deployer.publicKey,
          toPubkey: potVault,
          lamports: 1_000,
        })
      )
    );
    expect(await provider.connection.getBalance(potVault)).to.equal(Number(pot) + 1_000);

    await (program.methods as any)
      .executeSwapReal(ANSEM_OUT)
      .accounts(swapRealAccounts(roundPda, keeperAdmin.publicKey, keeperAta))
      .signers([keeperAdmin])
      .rpc();

    // SOL pot moved out exactly, while the pot_vault remains rent-exempt.
    const postSwapPotVaultLamports = await provider.connection.getBalance(potVault);
    const postSwapTreasuryLamports = await provider.connection.getBalance(treasury);
    expect(postSwapPotVaultLamports).to.be.gte(
      await provider.connection.getMinimumBalanceForRentExemption(0)
    );
    expect(postSwapTreasuryLamports - treasuryBefore).to.equal(Number(pot));

    // ANSEM proceeds came FROM the keeper ATA (no minting): source -ansem_out,
    // payout +ansem_out, and the mint's total supply is UNCHANGED.
    const sourceAfter = await balOf(keeperAta);
    const payoutAfter = await balOf(payoutVault);
    const supplyAfter = (await getMint(provider.connection, ansemMint!, undefined, TOKEN_2022_PROGRAM_ID)).supply;
    const out = BigInt(ANSEM_OUT.toString());
    assert.equal((sourceBefore - sourceAfter).toString(), out.toString(), "ansem_out debited from keeper ATA");
    assert.equal((payoutAfter - payoutBefore).toString(), out.toString(), "ansem_out credited to payout_vault");
    assert.equal(supplyAfter.toString(), supplyBefore.toString(), "no tokens minted (supply unchanged)");

    // Round + config accounting (shared finalize_swap_accounting).
    const r: any = await program.account.round.fetch(roundPda);
    const cfg: any = await program.account.config.fetch(configPda);
    assert.equal(r.state, 4, "STATE_CLAIMABLE");
    assert.equal(r.swapProceeds.toString(), ANSEM_OUT.toString(), "swap_proceeds == ansem_out");
    assert.equal(
      cfg.ansemObligations.toString(),
      ANSEM_OUT.toString(),
      "obligations grew by exactly ansem_out"
    );
    // entitlement_total == nj_total + jackpot_pool (recomputed via the keccak mirror,
    // exactly as direct-stake.ts proves for the mock path).
    const rnd = Array.from(r.randomness as number[]).map(Number);
    assert.equal(jackpotBlock(rnd, "jackpot"), r.jackpotSquare, "mirror jackpot square matches chain");
    const blockSol = (r.blockSol as anchor.BN[]).map((b) => BigInt(b.toString()));
    const njTotal = nonjackpotPayout(
      returnWeight(blockSol, rnd, r.jackpotSquare, cfg.multMinBps, cfg.multMaxBps),
      pot,
      out
    );
    assert.equal(
      r.entitlementTotal.toString(),
      (njTotal + BigInt(r.jackpotPool.toString())).toString(),
      "entitlement_total == nj_total + jackpot_pool"
    );
    // Winner present + zero starting rollover => the whole proceeds are entitled and
    // the rollover is consumed (jackpot-branch identity).
    assert.equal(r.entitlementTotal.toString(), ANSEM_OUT.toString(), "all proceeds entitled");
    assert.equal(cfg.rolloverJackpot.toString(), "0", "rollover consumed by the winner");
  });

  it("winner claim_direct receives REAL ANSEM and obligations decrement by the paid amount", async () => {
    const winnerAta = getAssociatedTokenAddressSync(ansemMint!, winner.publicKey, false, TOKEN_2022_PROGRAM_ID);
    const cfg0: any = await program.account.config.fetch(configPda);
    const r0: any = await program.account.round.fetch(roundPda);

    await program.methods
      .claimDirect(new anchor.BN(roundId))
      .accounts(claimRealAccounts(winner.publicKey, roundPda, winnerAta))
      .signers([winner])
      .rpc();

    const paid = await balOf(winnerAta);
    assert.isAbove(Number(paid), 0, "winner received real ANSEM from the keeper-funded vault");
    const cfg1: any = await program.account.config.fetch(configPda);
    const r1: any = await program.account.round.fetch(roundPda);
    // obligations shrank by exactly what was paid; the round recorded it.
    assert.equal(cfg0.ansemObligations.sub(cfg1.ansemObligations).toString(), paid.toString());
    assert.equal(r1.claimedProceeds.sub(r0.claimedProceeds).toString(), paid.toString());
    // solvency: never pay more than the frozen entitlement.
    assert.isAtMost(Number(r1.claimedProceeds), Number(r1.entitlementTotal));
  });

  // ---- Task 4: sweep_treasury (admin-gated SOL exit, rent-floored) ----
  // The real swap above moved the whole SOL pot pot_vault -> treasury. sweep_treasury
  // lets config.admin move lamports OUT to ANY destination it names, but must always
  // leave >= the rent-exemption minimum for a 0-data account, so the treasury PDA can
  // never be closed out from under the program. Runs on the post-swap treasury.
  const sweepTreasuryAccounts = (destPk: PublicKey, adminPk: PublicKey) => ({
    admin: adminPk,
    config: configPda,
    treasury,
    destination: destPk,
  });

  it("sweep_treasury rejects a non-admin signer (Unauthorized)", async () => {
    const dest = Keypair.generate().publicKey;
    const treasuryBefore = BigInt(await provider.connection.getBalance(treasury));
    try {
      await (program.methods as any)
        .sweepTreasury(new anchor.BN(1))
        .accounts(sweepTreasuryAccounts(dest, stranger.publicKey))
        .signers([stranger])
        .rpc();
      assert.fail("a non-admin must not be able to sweep the treasury");
    } catch (e: any) {
      assert.include(e.toString(), "Unauthorized");
    }
    const treasuryAfter = BigInt(await provider.connection.getBalance(treasury));
    assert.equal(
      treasuryAfter.toString(),
      treasuryBefore.toString(),
      "treasury untouched by the rejected sweep"
    );
  });

  it("sweep_treasury refuses to dip below the rent-exemption floor (InsufficientBalance)", async () => {
    const dest = Keypair.generate().publicKey;
    const rentMin = BigInt(await provider.connection.getMinimumBalanceForRentExemption(0));
    const treasuryBal = BigInt(await provider.connection.getBalance(treasury));
    // One lamport MORE than the sweepable surplus (balance - rent_min) must be refused.
    const over = (treasuryBal - rentMin + 1n).toString();
    try {
      await (program.methods as any)
        .sweepTreasury(new anchor.BN(over))
        .accounts(sweepTreasuryAccounts(dest, keeperAdmin.publicKey))
        .signers([keeperAdmin])
        .rpc();
      assert.fail("over-sweeping past the rent floor must be rejected");
    } catch (e: any) {
      assert.include(e.toString(), "InsufficientBalance");
    }
    const treasuryAfter = BigInt(await provider.connection.getBalance(treasury));
    assert.isAtLeast(
      Number(treasuryAfter),
      Number(rentMin),
      "treasury still holds at least the rent floor after the rejected over-sweep"
    );
  });

  it("sweep_treasury moves the surplus to the named destination and leaves exactly the rent floor", async () => {
    const dest = Keypair.generate().publicKey;
    const rentMin = BigInt(await provider.connection.getMinimumBalanceForRentExemption(0));
    const treasuryBefore = BigInt(await provider.connection.getBalance(treasury));
    const amount = treasuryBefore - rentMin; // sweep the entire surplus down to the floor
    assert.isAbove(Number(amount), 0, "the post-swap pot is a real surplus to sweep");
    const destBefore = BigInt(await provider.connection.getBalance(dest)); // fresh account: 0

    await (program.methods as any)
      .sweepTreasury(new anchor.BN(amount.toString()))
      .accounts(sweepTreasuryAccounts(dest, keeperAdmin.publicKey))
      .signers([keeperAdmin])
      .rpc();

    const destAfter = BigInt(await provider.connection.getBalance(dest));
    const treasuryAfter = BigInt(await provider.connection.getBalance(treasury));
    assert.equal(
      (destAfter - destBefore).toString(),
      amount.toString(),
      "destination received the full swept surplus"
    );
    assert.isAtLeast(
      Number(treasuryAfter),
      Number(rentMin),
      "treasury kept at least the rent-exemption floor"
    );
    assert.equal(
      treasuryAfter.toString(),
      rentMin.toString(),
      "treasury left at exactly the rent floor (boundary is inclusive)"
    );
  });

  // ---- Task 5: close_round janitor + set_claim_window ----
  // Permissionless round reaper. A CLAIMABLE round closes only AFTER deadline +
  // claim_window_secs (rent -> config.admin; the unclaimed remainder is forfeited
  // into rollover_jackpot; obligations untouched — a pure earmark move). An EMPTY
  // cancelled round (pot == 0) reaps instantly; a non-empty cancelled round refuses
  // (refund_direct must stay alive). Any other state refuses. The claim window is
  // read LIVE from config at close time, so these tests flex set_claim_window
  // between a large value (gate blocks) and a small one (gate opens) to prove the
  // window deterministically instead of racing the wall clock.
  const closeRoundAccounts = (rPda: PublicKey, callerPk: PublicKey) => ({
    caller: callerPk,
    config: configPda,
    round: rPda,
    adminDest: keeperAdmin.publicKey,
  });
  const setClaimWindow = async (secs: number) =>
    (program.methods as any)
      .setClaimWindow(new anchor.BN(secs))
      .accounts({ admin: keeperAdmin.publicKey })
      .signers([keeperAdmin])
      .rpc();
  const createFreshRound = async (): Promise<{ id: number; pda: PublicKey }> => {
    const cfg: any = await program.account.config.fetch(configPda);
    const id = cfg.currentRoundId.toNumber() + 1;
    const [pda] = PublicKey.findProgramAddressSync(
      [enc("round"), new anchor.BN(id).toArrayLike(Buffer, "le", 8)],
      program.programId
    );
    await program.methods
      .createRound()
      .accounts({ payer: keeperAdmin.publicKey, round: pda })
      .signers([keeperAdmin])
      .rpc();
    return { id, pda };
  };
  const settleWithRetry = async (pda: PublicKey) => {
    for (let i = 0; i < 40; i++) {
      try {
        await program.methods
          .settle([...RND])
          .accounts(settleRealAccounts(pda))
          .signers([keeperAdmin])
          .rpc();
        return;
      } catch (e: any) {
        if (!e.toString().includes("RoundNotEnded")) throw e;
        await sleep(1000);
      }
    }
    throw new Error("settle never succeeded (deadline never passed?)");
  };
  const cancelWithRetry = async (pda: PublicKey) => {
    for (let i = 0; i < 40; i++) {
      try {
        await program.methods
          .cancelRound()
          .accountsPartial({ admin: keeperAdmin.publicKey, round: pda })
          .signers([keeperAdmin])
          .rpc();
        return;
      } catch (e: any) {
        if (!e.toString().includes("RoundNotCancelable")) throw e;
        await sleep(1000);
      }
    }
    throw new Error("cancel never succeeded (deadline never passed?)");
  };

  // Fresh wallets per janitor round → isolated miner PDAs, no cross-test coupling.
  const jWinner = Keypair.generate();
  const jLoser = Keypair.generate();
  const eWinner = Keypair.generate();
  const eLoser = Keypair.generate();
  const fStaker = Keypair.generate();
  const randomCaller = Keypair.generate(); // permissionless closer: not admin, not fee payer
  let jRoundId: number;
  let jRoundPda: PublicKey;

  it("set_claim_window rejects a negative window (BadBeefParams)", async () => {
    try {
      await (program.methods as any)
        .setClaimWindow(new anchor.BN(-1))
        .accounts({ admin: keeperAdmin.publicKey })
        .signers([keeperAdmin])
        .rpc();
      assert.fail("a negative claim window must be rejected");
    } catch (e: any) {
      assert.include(e.toString(), "BadBeefParams");
    }
  });

  it("close_round: an OPEN round is not closeable (RoundNotCloseable); then stake + settle", async () => {
    // Short round + short window so the whole lifecycle runs with real (tiny) sleeps.
    await program.methods
      .setRoundDuration(new anchor.BN(3))
      .accounts({ admin: keeperAdmin.publicKey })
      .signers([keeperAdmin])
      .rpc();
    await setClaimWindow(3);
    await airdrop(jWinner.publicKey, 3);
    await airdrop(jLoser.publicKey, 3);

    const created = await createFreshRound();
    jRoundId = created.id;
    jRoundPda = created.pda;

    // (c) An OPEN round has neither a claim window nor a cancel behind it.
    try {
      await (program.methods as any)
        .closeRound()
        .accountsPartial(closeRoundAccounts(jRoundPda, stranger.publicKey))
        .signers([stranger])
        .rpc();
      assert.fail("close_round must refuse an OPEN round");
    } catch (e: any) {
      assert.include(e.toString(), "RoundNotCloseable");
    }
    const rOpen: any = await program.account.round.fetch(jRoundPda);
    assert.equal(rOpen.state, 0, "round survived the rejected close (still OPEN)");

    await program.methods
      .stakeDirect(new anchor.BN(jRoundId), jsq, new anchor.BN(WINNER_STAKE))
      .accounts(stakeRealAccounts(jWinner.publicKey, jRoundPda))
      .signers([jWinner])
      .rpc();
    await program.methods
      .stakeDirect(new anchor.BN(jRoundId), loserSquare, new anchor.BN(LOSER_STAKE))
      .accounts(stakeRealAccounts(jLoser.publicKey, jRoundPda))
      .signers([jLoser])
      .rpc();

    await settleWithRetry(jRoundPda);
    const rS: any = await program.account.round.fetch(jRoundPda);
    assert.equal(rS.state, 2, "STATE_SETTLED");
    assert.equal(rS.jackpotSquare, jsq, "forced jackpot square == our keccak draw");
  });

  it("close_round: swap the round to CLAIMABLE, winner claims PART (loser's share left unclaimed)", async () => {
    await (program.methods as any)
      .executeSwapReal(ANSEM_OUT)
      .accounts(swapRealAccounts(jRoundPda, keeperAdmin.publicKey, keeperAta))
      .signers([keeperAdmin])
      .rpc();
    const r1: any = await program.account.round.fetch(jRoundPda);
    assert.equal(r1.state, 4, "STATE_CLAIMABLE");

    // Winner (sole jackpot-square staker) claims their full jackpot share; the loser
    // deliberately does NOT claim, so entitlement_total - claimed_proceeds > 0.
    const jWinnerAta = getAssociatedTokenAddressSync(ansemMint!, jWinner.publicKey, false, TOKEN_2022_PROGRAM_ID);
    await program.methods
      .claimDirect(new anchor.BN(jRoundId))
      .accounts(claimRealAccounts(jWinner.publicKey, jRoundPda, jWinnerAta))
      .signers([jWinner])
      .rpc();
    const paid = await balOf(jWinnerAta);
    const r2: any = await program.account.round.fetch(jRoundPda);
    assert.isAbove(Number(paid), 0, "winner received real ANSEM");
    assert.equal(r2.claimedProceeds.toString(), paid.toString(), "claimed_proceeds == winner payout");
    assert.isBelow(
      Number(r2.claimedProceeds),
      Number(r2.entitlementTotal),
      "part-claim: some entitlement remains to be forfeited"
    );
  });

  it("close_round: a CLAIMABLE round inside its claim window refuses (ClaimWindowOpen)", async () => {
    // Widen the window far past wall-clock so the gate blocks deterministically.
    await setClaimWindow(3600);
    try {
      await (program.methods as any)
        .closeRound()
        .accountsPartial(closeRoundAccounts(jRoundPda, randomCaller.publicKey))
        .signers([randomCaller])
        .rpc();
      assert.fail("close_round must refuse while the claim window is open");
    } catch (e: any) {
      assert.include(e.toString(), "ClaimWindowOpen");
    }
    const r: any = await program.account.round.fetch(jRoundPda);
    assert.equal(r.state, 4, "round still CLAIMABLE after the rejected close");
  });

  it("close_round: past the window, a RANDOM wallet reaps it — rent -> admin, forfeit -> rollover, obligations unchanged", async () => {
    // Shrink the window back so it has genuinely elapsed (round settled >= deadline ago).
    await setClaimWindow(3);

    const rPre: any = await program.account.round.fetch(jRoundPda);
    const entitlement = BigInt(rPre.entitlementTotal.toString());
    const claimed = BigInt(rPre.claimedProceeds.toString());
    const forfeited = entitlement - claimed;
    const cfgPre: any = await program.account.config.fetch(configPda);
    const rolloverBefore = BigInt(cfgPre.rolloverJackpot.toString());
    const obligationsBefore = BigInt(cfgPre.ansemObligations.toString());
    const keeperBefore = BigInt(await provider.connection.getBalance(keeperAdmin.publicKey));
    const roundRent = BigInt(await provider.connection.getBalance(jRoundPda));

    // Close as soon as the on-chain window truly elapses (robust to validator clock
    // drift): retry only on ClaimWindowOpen, surface anything else.
    let closed = false;
    for (let i = 0; i < 30; i++) {
      try {
        await (program.methods as any)
          .closeRound()
          .accountsPartial(closeRoundAccounts(jRoundPda, randomCaller.publicKey))
          .signers([randomCaller])
          .rpc();
        closed = true;
        break;
      } catch (e: any) {
        if (!e.toString().includes("ClaimWindowOpen")) throw e;
        await sleep(1000);
      }
    }
    assert.isTrue(closed, "close_round eventually succeeded once the window elapsed");

    // Round account reaped.
    let gone = false;
    try {
      await program.account.round.fetch(jRoundPda);
    } catch {
      gone = true;
    }
    assert.isTrue(gone, "Round account is GONE (rent reclaimed)");

    const cfgPost: any = await program.account.config.fetch(configPda);
    const rolloverAfter = BigInt(cfgPost.rolloverJackpot.toString());
    const obligationsAfter = BigInt(cfgPost.ansemObligations.toString());
    const keeperAfter = BigInt(await provider.connection.getBalance(keeperAdmin.publicKey));

    assert.isAbove(Number(forfeited), 0, "the loser's unclaimed share was really forfeited");
    assert.equal(
      (keeperAfter - keeperBefore).toString(),
      roundRent.toString(),
      "config.admin lamports grew by exactly the round's rent"
    );
    assert.equal(
      (rolloverAfter - rolloverBefore).toString(),
      forfeited.toString(),
      "rollover_jackpot grew by exactly (entitlement_total - claimed_proceeds)"
    );
    assert.equal(
      obligationsAfter.toString(),
      obligationsBefore.toString(),
      "ansem_obligations UNCHANGED by close_round"
    );

    // A claim against the reaped round now fails (account gone).
    const jLoserAta = getAssociatedTokenAddressSync(ansemMint!, jLoser.publicKey, false, TOKEN_2022_PROGRAM_ID);
    let claimThrew = false;
    try {
      await program.methods
        .claimDirect(new anchor.BN(jRoundId))
        .accounts(claimRealAccounts(jLoser.publicKey, jRoundPda, jLoserAta))
        .signers([jLoser])
        .rpc();
    } catch {
      claimThrew = true;
    }
    assert.isTrue(claimThrew, "claim_direct against a reaped round fails (account gone)");
  });

  it("close_round: an EMPTY cancelled round (pot == 0) reaps instantly (no window wait)", async () => {
    const { pda } = await createFreshRound();
    // No stakes -> pot stays 0. Wait past the (3s) deadline so cancel is allowed.
    await cancelWithRetry(pda);
    const rC: any = await program.account.round.fetch(pda);
    assert.equal(rC.state, 5, "STATE_CLOSED");
    assert.equal(rC.pot.toString(), "0", "empty round");

    const keeperBefore = BigInt(await provider.connection.getBalance(keeperAdmin.publicKey));
    const rent = BigInt(await provider.connection.getBalance(pda));
    // No claim-window wait: the CLOSED+empty branch has no time gate.
    await (program.methods as any)
      .closeRound()
      .accountsPartial(closeRoundAccounts(pda, randomCaller.publicKey))
      .signers([randomCaller])
      .rpc();
    let gone = false;
    try {
      await program.account.round.fetch(pda);
    } catch {
      gone = true;
    }
    assert.isTrue(gone, "empty cancelled round reaped");
    const keeperAfter = BigInt(await provider.connection.getBalance(keeperAdmin.publicKey));
    assert.equal((keeperAfter - keeperBefore).toString(), rent.toString(), "rent -> config.admin");
  });

  it("close_round: a NON-EMPTY cancelled round refuses (RoundNotCloseable) and refund_direct still works", async () => {
    await airdrop(fStaker.publicKey, 3);
    const { id, pda } = await createFreshRound();
    await program.methods
      .stakeDirect(new anchor.BN(id), jsq, new anchor.BN(WINNER_STAKE))
      .accounts(stakeRealAccounts(fStaker.publicKey, pda))
      .signers([fStaker])
      .rpc();
    await cancelWithRetry(pda);
    const rC: any = await program.account.round.fetch(pda);
    assert.equal(rC.state, 5, "STATE_CLOSED");
    assert.isAbove(Number(rC.pot), 0, "non-empty cancelled round");

    // close_round must refuse — the refund path must stay alive.
    try {
      await (program.methods as any)
        .closeRound()
        .accountsPartial(closeRoundAccounts(pda, randomCaller.publicKey))
        .signers([randomCaller])
        .rpc();
      assert.fail("close_round must refuse a non-empty cancelled round");
    } catch (e: any) {
      assert.include(e.toString(), "RoundNotCloseable");
    }

    // The account survives AND refund_direct still returns the staker's SOL.
    const staked = BigInt(WINNER_STAKE);
    const balBefore = BigInt(await provider.connection.getBalance(fStaker.publicKey));
    await program.methods
      .refundDirect(new anchor.BN(id))
      .accounts({
        authority: fStaker.publicKey,
        config: configPda,
        round: pda,
        miner: minerOf(fStaker.publicKey),
        potVault,
      })
      .signers([fStaker])
      .rpc();
    const balAfter = BigInt(await provider.connection.getBalance(fStaker.publicKey));
    assert.equal(
      (balAfter - balBefore).toString(),
      staked.toString(),
      "refund_direct returned the full stake from the surviving round"
    );
  });

  it("close_round: after reaping, the NEXT round is fully creatable and playable (lifecycle survives)", async () => {
    await airdrop(eWinner.publicKey, 3);
    await airdrop(eLoser.publicKey, 3);
    const { id, pda } = await createFreshRound();
    await program.methods
      .stakeDirect(new anchor.BN(id), jsq, new anchor.BN(WINNER_STAKE))
      .accounts(stakeRealAccounts(eWinner.publicKey, pda))
      .signers([eWinner])
      .rpc();
    await program.methods
      .stakeDirect(new anchor.BN(id), loserSquare, new anchor.BN(LOSER_STAKE))
      .accounts(stakeRealAccounts(eLoser.publicKey, pda))
      .signers([eLoser])
      .rpc();
    await settleWithRetry(pda);
    await (program.methods as any)
      .executeSwapReal(ANSEM_OUT)
      .accounts(swapRealAccounts(pda, keeperAdmin.publicKey, keeperAta))
      .signers([keeperAdmin])
      .rpc();
    const r: any = await program.account.round.fetch(pda);
    assert.equal(r.state, 4, "STATE_CLAIMABLE — a full round played after prior closes");

    // And a winner can still claim real ANSEM on this post-close round.
    const eWinnerAta = getAssociatedTokenAddressSync(ansemMint!, eWinner.publicKey, false, TOKEN_2022_PROGRAM_ID);
    await program.methods
      .claimDirect(new anchor.BN(id))
      .accounts(claimRealAccounts(eWinner.publicKey, pda, eWinnerAta))
      .signers([eWinner])
      .rpc();
    assert.isAbove(Number(await balOf(eWinnerAta)), 0, "winner claimed on the post-close round");
  });

  // ---- Task (mainnet-phase0): set_stake_limits (launch cap tuner) ----
  // min_stake / max_stake_per_round are otherwise frozen at initialize (0.01 / 100
  // SOL defaults). Launch policy caps max at 1 SOL and must be retunable WITHOUT a
  // program upgrade — this admin ix (SetParams-gated on config.admin) is that knob.
  // Proven on the real-mode config above: keeper_admin succeeds, the new cap actually
  // bites a subsequent stake_direct, a stranger is rejected, and min > max is refused.
  const LAUNCH_MIN = new anchor.BN(10_000_000); // 0.01 SOL
  const LAUNCH_MAX = new anchor.BN(1_000_000_000); // 1 SOL
  const slStaker = Keypair.generate();

  it("set_stake_limits: keeper_admin sets min 0.01 / max 1 SOL — config reflects it", async () => {
    await (program.methods as any)
      .setStakeLimits(LAUNCH_MIN, LAUNCH_MAX)
      .accounts({ admin: keeperAdmin.publicKey })
      .signers([keeperAdmin])
      .rpc();
    const cfg: any = await program.account.config.fetch(configPda);
    assert.equal(cfg.minStake.toString(), LAUNCH_MIN.toString(), "min_stake updated");
    assert.equal(
      cfg.maxStakePerRound.toString(),
      LAUNCH_MAX.toString(),
      "max_stake_per_round capped at 1 SOL"
    );
  });

  it("set_stake_limits: a stake above the new 1 SOL cap fails StakeTooLarge", async () => {
    await airdrop(slStaker.publicKey, 3);
    // Comfortable deadline so the failure is unambiguously the cap, not RoundEnded.
    await program.methods
      .setRoundDuration(new anchor.BN(30))
      .accounts({ admin: keeperAdmin.publicKey })
      .signers([keeperAdmin])
      .rpc();
    const { id, pda } = await createFreshRound();
    const over = new anchor.BN(1_500_000_000); // 1.5 SOL > the 1 SOL cap set above
    try {
      await program.methods
        .stakeDirect(new anchor.BN(id), jsq, over)
        .accounts(stakeRealAccounts(slStaker.publicKey, pda))
        .signers([slStaker])
        .rpc();
      assert.fail("a stake above max_stake_per_round must be rejected");
    } catch (e: any) {
      assert.include(e.toString(), "StakeTooLarge");
    }
  });

  it("set_stake_limits rejects a non-admin signer (Unauthorized)", async () => {
    try {
      await (program.methods as any)
        .setStakeLimits(LAUNCH_MIN, LAUNCH_MAX)
        .accounts({ admin: stranger.publicKey })
        .signers([stranger])
        .rpc();
      assert.fail("a non-admin must not set stake limits");
    } catch (e: any) {
      assert.include(e.toString(), "Unauthorized");
    }
  });

  it("set_stake_limits rejects min > max (BadStakeBounds)", async () => {
    try {
      await (program.methods as any)
        .setStakeLimits(new anchor.BN(2_000_000_000), new anchor.BN(1_000_000_000))
        .accounts({ admin: keeperAdmin.publicKey })
        .signers([keeperAdmin])
        .rpc();
      assert.fail("min > max must be rejected");
    } catch (e: any) {
      assert.include(e.toString(), "BadStakeBounds");
    }
  });
});
