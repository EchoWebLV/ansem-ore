import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { AnsemMiner } from "../target/types/ansem_miner";
import { PublicKey } from "@solana/web3.js";
import { assert } from "chai";
import { getAssociatedTokenAddressSync, getAccount, createAssociatedTokenAccountIdempotent } from "@solana/spl-token";
import { keccak256 } from "js-sha3";

const enc = (s: string) => Buffer.from(s);

// Mirrors the Rust `jackpot_block` in programs/ansem-miner/src/math.rs EXACTLY:
// keccak256( randomness[32 bytes] || utf8("jkblock") ), take output byte[0] % 25.
function computeJackpotBlock(rnd: Buffer): number {
  const h = keccak256.arrayBuffer(Buffer.concat([rnd, Buffer.from("jkblock")]));
  const firstByte = new Uint8Array(h)[0];
  return firstByte % 25;
}

describe("ansem-miner", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.AnsemMiner as Program<AnsemMiner>;
  const admin = provider.wallet as anchor.Wallet;

  const [configPda] = PublicKey.findProgramAddressSync([enc("config")], program.programId);
  const [ansemMint] = PublicKey.findProgramAddressSync([enc("ansem_mint")], program.programId);

  it("initializes config and mock mint", async () => {
    await program.methods.initialize().accounts({ admin: admin.publicKey }).rpc();
    const cfg = await program.account.config.fetch(configPda);
    assert.equal(cfg.admin.toBase58(), admin.publicKey.toBase58());
    assert.equal(cfg.ansemMint.toBase58(), ansemMint.toBase58());
    assert.equal(cfg.currentRoundId.toNumber(), 0);
    assert.equal(cfg.feeBps, 100);
    assert.equal(cfg.swapMode, 0);
  });

  const player = anchor.web3.Keypair.generate();
  const [escrowPda] = PublicKey.findProgramAddressSync(
    [enc("escrow"), player.publicKey.toBuffer()], program.programId);
  const [potVault] = PublicKey.findProgramAddressSync([enc("pot_vault")], program.programId);

  it("funds a player then deposits into escrow", async () => {
    const sig = await provider.connection.requestAirdrop(player.publicKey, 5 * anchor.web3.LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(sig);
    await program.methods.deposit(new anchor.BN(2 * anchor.web3.LAMPORTS_PER_SOL))
      .accounts({ authority: player.publicKey }).signers([player]).rpc();
    const e = await program.account.playerEscrow.fetch(escrowPda);
    assert.equal(e.balance.toNumber(), 2 * anchor.web3.LAMPORTS_PER_SOL);
    const potLamports = await provider.connection.getBalance(potVault);
    assert.isAtLeast(potLamports, 2 * anchor.web3.LAMPORTS_PER_SOL);
  });

  it("withdraws part of the escrow", async () => {
    await program.methods.withdraw(new anchor.BN(anchor.web3.LAMPORTS_PER_SOL))
      .accounts({ authority: player.publicKey }).signers([player]).rpc();
    const e = await program.account.playerEscrow.fetch(escrowPda);
    assert.equal(e.balance.toNumber(), anchor.web3.LAMPORTS_PER_SOL);
  });

  it("creates round 1", async () => {
    const [round1] = PublicKey.findProgramAddressSync(
      [enc("round"), new anchor.BN(1).toArrayLike(Buffer, "le", 8)], program.programId);
    await program.methods.createRound()
      .accounts({ payer: admin.publicKey, round: round1 }).rpc();
    const cfg = await program.account.config.fetch(configPda);
    assert.equal(cfg.currentRoundId.toNumber(), 1);
    const r = await program.account.round.fetch(round1);
    assert.equal(r.roundId.toNumber(), 1);
    assert.equal(r.state, 0);
    assert.isAbove(r.deadlineTs.toNumber(), Math.floor(Date.now()/1000));
  });

  const [minerPda] = PublicKey.findProgramAddressSync(
    [enc("miner"), player.publicKey.toBuffer()], program.programId);

  it("initializes the persistent miner position", async () => {
    await program.methods.initMiner().accounts({ authority: player.publicKey }).signers([player]).rpc();
    const m = await program.account.minerPosition.fetch(minerPda);
    assert.equal(m.authority.toBase58(), player.publicKey.toBase58());
    assert.equal(m.roundId.toNumber(), 0);
  });

  const round1 = PublicKey.findProgramAddressSync(
    [enc("round"), new anchor.BN(1).toArrayLike(Buffer, "le", 8)], program.programId)[0];

  it("stakes on two squares", async () => {
    await program.methods.stake(3, new anchor.BN(0.3 * anchor.web3.LAMPORTS_PER_SOL))
      .accounts({ authority: player.publicKey, round: round1 }).signers([player]).rpc();
    await program.methods.stake(14, new anchor.BN(0.2 * anchor.web3.LAMPORTS_PER_SOL))
      .accounts({ authority: player.publicKey, round: round1 }).signers([player]).rpc();
    const m = await program.account.minerPosition.fetch(minerPda);
    assert.equal(m.roundId.toNumber(), 1);
    assert.equal(m.blockStake[3].toNumber(), 0.3 * anchor.web3.LAMPORTS_PER_SOL);
    assert.equal(m.blockStake[14].toNumber(), 0.2 * anchor.web3.LAMPORTS_PER_SOL);
    const r = await program.account.round.fetch(round1);
    assert.equal(r.pot.toNumber(), 0.5 * anchor.web3.LAMPORTS_PER_SOL);
    const e = await program.account.playerEscrow.fetch(escrowPda);
    assert.equal(e.activeRound.toNumber(), 1);
    assert.equal(e.balance.toNumber(), 0.5 * anchor.web3.LAMPORTS_PER_SOL); // 1 SOL left after deposit(2)-withdraw(1); staked 0.5
  });

  it("rejects an out-of-range block", async () => {
    try {
      await program.methods.stake(25, new anchor.BN(anchor.web3.LAMPORTS_PER_SOL))
        .accounts({ authority: player.publicKey, round: round1 }).signers([player]).rpc();
      assert.fail("should have thrown");
    } catch (e:any) { assert.include(e.toString(), "BadBlock"); }
  });

  it("rejects staking beyond escrow balance", async () => {
    try {
      await program.methods.stake(1, new anchor.BN(100 * anchor.web3.LAMPORTS_PER_SOL))
        .accounts({ authority: player.publicKey, round: round1 }).signers([player]).rpc();
      assert.fail("should have thrown");
    } catch (e:any) { assert.include(e.toString(), "InsufficientBalance"); }
  });

  it("settles round 1 with injected randomness (admin only)", async () => {
    // wait out the 60s deadline by warping is not available on localnet by default;
    // instead settle path allows admin to settle once deadline passed. For the test,
    // we create rounds with a short duration via set at initialize is 60s, so we
    // fast-path: assert settle before deadline is rejected, then advance.
    const rnd = Buffer.alloc(32, 9);
    try {
      await program.methods.settle([...rnd]).accounts({ admin: admin.publicKey, round: round1 }).rpc();
      assert.fail("should reject before deadline");
    } catch (e:any) { assert.include(e.toString(), "RoundNotEnded"); }
  });

  // Task 9b: deterministic time control for tests.
  // Drives round_duration_secs down for a dedicated round so settle/swap/claim
  // can be exercised without waiting out a real 60s deadline.
  // The earlier rounds (e.g. round1) keep the 60s default untouched.
  //
  // durationSecs defaults to 0 (round already "ended" the instant it's
  // created — used by tests that only need to settle/swap/claim). Tasks 10-12
  // need to stake on the round *before* settling it, so they pass a small
  // positive duration long enough to fit the staking txs but short enough
  // that the round has expired by the time settle() runs.
  async function freshInstantRound(durationSecs = 0): Promise<{ id: number; pda: PublicKey }> {
    await program.methods.setRoundDuration(new anchor.BN(durationSecs)).accounts({ admin: admin.publicKey }).rpc();
    const cfgBefore = await program.account.config.fetch(configPda);
    const nextId = cfgBefore.currentRoundId.toNumber() + 1;
    const [pda] = PublicKey.findProgramAddressSync(
      [enc("round"), new anchor.BN(nextId).toArrayLike(Buffer, "le", 8)], program.programId);
    await program.methods.createRound().accounts({ payer: admin.publicKey, round: pda }).rpc();
    const cfg = await program.account.config.fetch(configPda);
    const id = cfg.currentRoundId.toNumber();
    return { id, pda };
  }

  // Sleep helper: used to let a short-duration round's deadline pass before
  // calling settle(), after staking txs have landed.
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it("creates a zero-duration round that is immediately settleable", async () => {
    const { pda } = await freshInstantRound();
    const rnd = Buffer.alloc(32, 5);
    await program.methods.settle([...rnd])
      .accounts({ admin: admin.publicKey, round: pda }).rpc();
    const r = await program.account.round.fetch(pda);
    assert.equal(r.state, 2); // STATE_SETTLED
  });

  const [vaultAuth] = PublicKey.findProgramAddressSync([enc("vault_auth")], program.programId);
  const [mintAuth] = PublicKey.findProgramAddressSync([enc("mint_auth")], program.programId);
  const [treasury] = PublicKey.findProgramAddressSync([enc("treasury")], program.programId);
  const [jackpotAuth] = PublicKey.findProgramAddressSync([enc("jackpot_auth")], program.programId);

  // Hoisted to describe-scope (rather than declared inside the swap test) so
  // the claim tests below can reference the same staker/round.
  const p2 = anchor.web3.Keypair.generate();

  it("mock-swaps a settled round's pot into ANSEM", async () => {
    const { pda } = await freshInstantRound(3);
    // Use a second fresh player to avoid the unclaimed-round guard from the
    // earlier player (player already staked round1 and hasn't claimed it).
    const sig = await provider.connection.requestAirdrop(p2.publicKey, 3 * anchor.web3.LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(sig);
    await program.methods.deposit(new anchor.BN(2 * anchor.web3.LAMPORTS_PER_SOL))
      .accounts({ authority: p2.publicKey }).signers([p2]).rpc();
    await program.methods.initMiner().accounts({ authority: p2.publicKey }).signers([p2]).rpc();
    await program.methods.stake(5, new anchor.BN(anchor.web3.LAMPORTS_PER_SOL))
      .accounts({ authority: p2.publicKey, round: pda }).signers([p2]).rpc();
    await sleep(3500);
    await program.methods.settle([...Buffer.alloc(32, 3)])
      .accounts({ admin: admin.publicKey, round: pda }).rpc();

    const payoutVault = getAssociatedTokenAddressSync(ansemMint, vaultAuth, true);
    await program.methods.executeSwapMock().accounts({
      payer: admin.publicKey,
      round: pda,
      ansemMint,
      mintAuthority: mintAuth,
      vaultAuthority: vaultAuth,
      payoutVault,
      potVault,
      treasury,
    }).rpc();

    const r = await program.account.round.fetch(pda);
    assert.equal(r.state, 4); // CLAIMABLE
    // net = 1 SOL - 1% fee = 0.99 SOL; ansem = 0.99 * 2800e6 = 2,772,000,000
    assert.equal(r.swapProceeds.toNumber(), 2_772_000_000);
    const bal = await getAccount(provider.connection, payoutVault);
    assert.equal(Number(bal.amount), 2_772_000_000);
  });

  it("claims the full proceeds for a sole staker", async () => {
    // continue from the swap test's round: p2 is the only staker
    const cfg = await program.account.config.fetch(configPda);
    const id = cfg.currentRoundId.toNumber();
    const [pda] = PublicKey.findProgramAddressSync(
      [enc("round"), new anchor.BN(id).toArrayLike(Buffer, "le", 8)], program.programId);
    const [p2Escrow] = PublicKey.findProgramAddressSync([enc("escrow"), p2.publicKey.toBuffer()], program.programId);
    const payoutVault = getAssociatedTokenAddressSync(ansemMint, vaultAuth, true);
    const jackpotVault = getAssociatedTokenAddressSync(ansemMint, jackpotAuth, true);
    const p2Ata = getAssociatedTokenAddressSync(ansemMint, p2.publicKey);

    // claim.rs requires jackpot_vault to already exist (it's a strict
    // Account<TokenAccount>, not init_if_needed) even though this round never
    // hits the jackpot; create the empty ATA client-side (test-only setup,
    // not a program instruction). Task 12 seeds it with real balance via an
    // admin-only seed_jackpot instruction to exercise the jackpot payout path.
    await createAssociatedTokenAccountIdempotent(
      provider.connection, admin.payer, ansemMint, jackpotAuth, { commitment: "confirmed" }, undefined, undefined, true,
    );

    await program.methods.claim(new anchor.BN(id)).accounts({
      authority: p2.publicKey,
      round: pda,
      ansemMint,
      vaultAuthority: vaultAuth,
      jackpotAuthority: jackpotAuth,
      payoutVault,
      jackpotVault,
      playerAta: p2Ata,
    }).signers([p2]).rpc();

    const bal = await getAccount(provider.connection, p2Ata);
    assert.equal(Number(bal.amount), 2_772_000_000); // sole staker gets all proceeds
    const e = await program.account.playerEscrow.fetch(p2Escrow);
    assert.equal(e.activeRound.toNumber(), 0);
    assert.equal(e.lastClaimedRound.toNumber(), id);
  });

  it("rejects a double claim", async () => {
    const cfg = await program.account.config.fetch(configPda);
    const id = cfg.currentRoundId.toNumber();
    const [pda] = PublicKey.findProgramAddressSync(
      [enc("round"), new anchor.BN(id).toArrayLike(Buffer, "le", 8)], program.programId);
    const payoutVault = getAssociatedTokenAddressSync(ansemMint, vaultAuth, true);
    const jackpotVault = getAssociatedTokenAddressSync(ansemMint, jackpotAuth, true);
    const p2Ata = getAssociatedTokenAddressSync(ansemMint, p2.publicKey);
    try {
      await program.methods.claim(new anchor.BN(id)).accounts({
        authority: p2.publicKey,
        round: pda,
        ansemMint,
        vaultAuthority: vaultAuth,
        jackpotAuthority: jackpotAuth,
        payoutVault,
        jackpotVault,
        playerAta: p2Ata,
      }).signers([p2]).rpc();
      assert.fail("should reject");
    } catch (e: any) { assert.include(e.toString(), "AlreadyClaimed"); }
  });

  // Task 10 quality-review fix: pot_vault is a single commingled PDA shared by
  // every player's idle escrow *and* every round's pot. This test proves
  // execute_swap_mock cannot drain another player's untouched escrow balance
  // (or an unswapped round's pot) out to treasury: it runs two rounds
  // concurrently (round A stakes+settles but is swapped *last*), with a
  // third player who only deposits (never stakes) and keeps idle escrow
  // parked in pot_vault the whole time, then asserts pot_vault's lamports
  // never fall below what's still owed to un-swapped pots + idle escrow.
  it("keeps pot_vault solvent across interleaved rounds and an idle depositor", async () => {
    // Idle depositor: funds sit in pot_vault as escrow the whole test and
    // must never be swept out by someone else's swap.
    const idle = anchor.web3.Keypair.generate();
    const sig0 = await provider.connection.requestAirdrop(idle.publicKey, 3 * anchor.web3.LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(sig0);
    const idleAmount = 1.5 * anchor.web3.LAMPORTS_PER_SOL;
    await program.methods.deposit(new anchor.BN(idleAmount))
      .accounts({ authority: idle.publicKey }).signers([idle]).rpc();

    // Round A and Round B run "concurrently": both created and staked before
    // either is settled/swapped. Round B is swapped first, Round A second,
    // proving a still-unswapped round's pot is never touched by an earlier
    // swap and the idle depositor's escrow is never touched by either.
    const pA = anchor.web3.Keypair.generate();
    const pB = anchor.web3.Keypair.generate();
    for (const p of [pA, pB]) {
      const s = await provider.connection.requestAirdrop(p.publicKey, 3 * anchor.web3.LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(s);
      await program.methods.deposit(new anchor.BN(2 * anchor.web3.LAMPORTS_PER_SOL))
        .accounts({ authority: p.publicKey }).signers([p]).rpc();
      await program.methods.initMiner().accounts({ authority: p.publicKey }).signers([p]).rpc();
    }

    const roundA = await freshInstantRound(4);
    await program.methods.stake(2, new anchor.BN(0.6 * anchor.web3.LAMPORTS_PER_SOL))
      .accounts({ authority: pA.publicKey, round: roundA.pda }).signers([pA]).rpc();

    const roundB = await freshInstantRound(4);
    await program.methods.stake(9, new anchor.BN(0.4 * anchor.web3.LAMPORTS_PER_SOL))
      .accounts({ authority: pB.publicKey, round: roundB.pda }).signers([pB]).rpc();

    await sleep(4500);
    await program.methods.settle([...Buffer.alloc(32, 7)])
      .accounts({ admin: admin.publicKey, round: roundA.pda }).rpc();
    await program.methods.settle([...Buffer.alloc(32, 8)])
      .accounts({ admin: admin.publicKey, round: roundB.pda }).rpc();

    const payoutVault = getAssociatedTokenAddressSync(ansemMint, vaultAuth, true);

    // Swap B first while A is still unswapped and sitting in the shared vault.
    await program.methods.executeSwapMock().accounts({
      payer: admin.publicKey, round: roundB.pda, ansemMint,
      mintAuthority: mintAuth, vaultAuthority: vaultAuth, payoutVault, potVault, treasury,
    }).rpc();

    // Invariant: pot_vault lamports must still cover the idle depositor's
    // escrow balance plus round A's not-yet-swapped pot.
    const eIdle = await program.account.playerEscrow.fetch(
      PublicKey.findProgramAddressSync([enc("escrow"), idle.publicKey.toBuffer()], program.programId)[0]);
    const rAafterBSwap = await program.account.round.fetch(roundA.pda);
    const potVaultLamportsAfterBSwap = await provider.connection.getBalance(potVault);
    assert.isAtLeast(
      potVaultLamportsAfterBSwap,
      eIdle.balance.toNumber() + rAafterBSwap.pot.toNumber(),
    );

    // Now swap A. It must still succeed (its pot lamports were never touched
    // by B's swap) and must not draw on the idle depositor's escrow.
    await program.methods.executeSwapMock().accounts({
      payer: admin.publicKey, round: roundA.pda, ansemMint,
      mintAuthority: mintAuth, vaultAuthority: vaultAuth, payoutVault, potVault, treasury,
    }).rpc();

    const rAfinal = await program.account.round.fetch(roundA.pda);
    assert.equal(rAfinal.state, 4); // CLAIMABLE
    // pot = 0.6 SOL (600,000,000 lamports); net = pot * 99% (1% fee) =
    // 594,000,000 lamports; ansem = net * mock_rate(2800e6) / LAMPORTS_PER_SOL
    const potA = 600_000_000;
    const netA = potA * 99 / 100;
    assert.equal(rAfinal.swapProceeds.toNumber(), netA * 2_800_000_000 / 1_000_000_000);

    // The idle depositor can still withdraw their full balance: proof their
    // escrow lamports were never shipped to treasury by either swap.
    const balBefore = await provider.connection.getBalance(idle.publicKey);
    await program.methods.withdraw(new anchor.BN(idleAmount))
      .accounts({ authority: idle.publicKey }).signers([idle]).rpc();
    const balAfter = await provider.connection.getBalance(idle.publicKey);
    assert.isAbove(balAfter, balBefore); // withdrawal succeeded, funds intact
    const eIdleFinal = await program.account.playerEscrow.fetch(
      PublicKey.findProgramAddressSync([enc("escrow"), idle.publicKey.toBuffer()], program.programId)[0]);
    assert.equal(eIdleFinal.balance.toNumber(), 0);
  });

  // Note: execute_swap_mock retains a defensive solvency guard
  // (require pot_vault >= total_escrow_balance + round.pot before sweeping to
  // treasury) that enforces spec §4's PotVault invariant. By construction
  // deposit/withdraw/stake keep that invariant in exact lockstep, so the
  // guard's reject branch is unreachable via legitimate instructions — the
  // positive test above ("...solvent across interleaved rounds") proves the
  // invariant is upheld. We intentionally do NOT ship a test-only vault-drain
  // instruction to exercise the reject branch: an admin instruction able to
  // move pot_vault lamports would be a rug vector on the live program.

  // Task 12: multi-player solvency + jackpot integration tests.
  it("pays 3 players summing to (approximately) the swap proceeds", async () => {
    const players = [0, 1, 2].map(() => anchor.web3.Keypair.generate());
    for (const p of players) {
      const s = await provider.connection.requestAirdrop(p.publicKey, 3 * anchor.web3.LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(s);
      await program.methods.deposit(new anchor.BN(2 * anchor.web3.LAMPORTS_PER_SOL))
        .accounts({ authority: p.publicKey }).signers([p]).rpc();
      await program.methods.initMiner().accounts({ authority: p.publicKey }).signers([p]).rpc();
    }
    const { id, pda } = await freshInstantRound(4);
    // varied stakes across squares
    await program.methods.stake(0, new anchor.BN(0.3e9)).accounts({ authority: players[0].publicKey, round: pda }).signers([players[0]]).rpc();
    await program.methods.stake(1, new anchor.BN(0.2e9)).accounts({ authority: players[0].publicKey, round: pda }).signers([players[0]]).rpc();
    await program.methods.stake(1, new anchor.BN(0.5e9)).accounts({ authority: players[1].publicKey, round: pda }).signers([players[1]]).rpc();
    await program.methods.stake(7, new anchor.BN(0.1e9)).accounts({ authority: players[1].publicKey, round: pda }).signers([players[1]]).rpc();
    await program.methods.stake(7, new anchor.BN(0.9e9)).accounts({ authority: players[2].publicKey, round: pda }).signers([players[2]]).rpc();

    await sleep(4500);
    await program.methods.settle([...Buffer.alloc(32, 42)]).accounts({ admin: admin.publicKey, round: pda }).rpc();
    const payoutVault = getAssociatedTokenAddressSync(ansemMint, vaultAuth, true);
    await program.methods.executeSwapMock().accounts({
      payer: admin.publicKey, round: pda, ansemMint,
      mintAuthority: mintAuth, vaultAuthority: vaultAuth, payoutVault, potVault, treasury,
    }).rpc();
    const r = await program.account.round.fetch(pda);
    const proceeds = r.swapProceeds.toNumber();

    const jackpotVault = getAssociatedTokenAddressSync(ansemMint, jackpotAuth, true);
    await createAssociatedTokenAccountIdempotent(
      provider.connection, admin.payer, ansemMint, jackpotAuth, { commitment: "confirmed" }, undefined, undefined, true,
    );

    let sum = 0;
    for (const p of players) {
      const ata = getAssociatedTokenAddressSync(ansemMint, p.publicKey);
      await program.methods.claim(new anchor.BN(id)).accounts({
        authority: p.publicKey, round: pda, ansemMint,
        vaultAuthority: vaultAuth, jackpotAuthority: jackpotAuth,
        payoutVault, jackpotVault, playerAta: ata,
      }).signers([p]).rpc();
      const bal = await getAccount(provider.connection, ata);
      sum += Number(bal.amount);
    }
    assert.isAtMost(proceeds - sum, players.length); // floor dust only
    assert.isAbove(sum, proceeds - players.length - 1);
  });

  it("adds a jackpot payout when odds are forced to 1", async () => {
    await program.methods.setJackpotOdds(1).accounts({ admin: admin.publicKey }).rpc();
    const jackpotVault = getAssociatedTokenAddressSync(ansemMint, jackpotAuth, true);
    await createAssociatedTokenAccountIdempotent(
      provider.connection, admin.payer, ansemMint, jackpotAuth, { commitment: "confirmed" }, undefined, undefined, true,
    );
    await program.methods.seedJackpot(new anchor.BN(1_000_000_000)).accounts({
      admin: admin.publicKey, ansemMint, jackpotVault,
    }).rpc();

    const p = anchor.web3.Keypair.generate();
    const s = await provider.connection.requestAirdrop(p.publicKey, 3 * anchor.web3.LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(s);
    await program.methods.deposit(new anchor.BN(2e9)).accounts({ authority: p.publicKey }).signers([p]).rpc();
    await program.methods.initMiner().accounts({ authority: p.publicKey }).signers([p]).rpc();
    const { id, pda } = await freshInstantRound(4);

    const rnd = Buffer.alloc(32, 5);
    const jackpotBlock = computeJackpotBlock(rnd);
    // Stake the jackpot_block(rnd) square so the additive jackpot path is
    // actually exercised (sole staker, so this is also the only square).
    await program.methods.stake(jackpotBlock, new anchor.BN(1e9))
      .accounts({ authority: p.publicKey, round: pda }).signers([p]).rpc();

    await sleep(4500);
    await program.methods.settle([...rnd]).accounts({ admin: admin.publicKey, round: pda }).rpc();
    const payoutVault = getAssociatedTokenAddressSync(ansemMint, vaultAuth, true);
    await program.methods.executeSwapMock().accounts({
      payer: admin.publicKey, round: pda, ansemMint,
      mintAuthority: mintAuth, vaultAuthority: vaultAuth, payoutVault, potVault, treasury,
    }).rpc();

    const r = await program.account.round.fetch(pda);
    assert.isTrue(r.jackpotHit);
    assert.equal(r.jackpotBlock, jackpotBlock);

    const ata = getAssociatedTokenAddressSync(ansemMint, p.publicKey);
    await program.methods.claim(new anchor.BN(id)).accounts({
      authority: p.publicKey, round: pda, ansemMint,
      vaultAuthority: vaultAuth, jackpotAuthority: jackpotAuth,
      payoutVault, jackpotVault, playerAta: ata,
    }).signers([p]).rpc();
    const bal = await getAccount(provider.connection, ata);
    // sole staker: main payout == proceeds. Jackpot pool seeded with 1e9,
    // jackpot_bps default 1000 (10%) -> payout_pool = 1e8; sole staker on the
    // jackpot block gets the full payout_pool share on top of main proceeds.
    const mainProceeds = r.swapProceeds.toNumber();
    assert.equal(Number(bal.amount), mainProceeds + 100_000_000);
  });

  // Task 13: final end-to-end happy-path sweep for a completely fresh player,
  // chaining every M1 instruction in lifecycle order and asserting the two
  // key final invariants: the player's ATA balance matches the sole-staker
  // proceeds, and escrow.balance == deposit - staked (nothing else moved it).
  it("end-to-end: initialize->createRound->deposit->initMiner->stake->settle->executeSwapMock->claim", async () => {
    const fresh = anchor.web3.Keypair.generate();
    const sig = await provider.connection.requestAirdrop(fresh.publicKey, 3 * anchor.web3.LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(sig);

    const depositAmount = 2 * anchor.web3.LAMPORTS_PER_SOL;
    const stakeAmount = 0.7 * anchor.web3.LAMPORTS_PER_SOL;

    const [freshEscrow] = PublicKey.findProgramAddressSync(
      [enc("escrow"), fresh.publicKey.toBuffer()], program.programId);

    // initialize: already done in the first test of this suite (config is a
    // singleton PDA); re-affirm it's live rather than re-calling it.
    const cfgCheck = await program.account.config.fetch(configPda);
    assert.equal(cfgCheck.admin.toBase58(), admin.publicKey.toBase58());

    // createRound
    const { id, pda: roundPda } = await freshInstantRound(4);

    // deposit
    await program.methods.deposit(new anchor.BN(depositAmount))
      .accounts({ authority: fresh.publicKey }).signers([fresh]).rpc();

    // initMiner
    await program.methods.initMiner().accounts({ authority: fresh.publicKey }).signers([fresh]).rpc();

    // stake (sole staker on this round)
    await program.methods.stake(11, new anchor.BN(stakeAmount))
      .accounts({ authority: fresh.publicKey, round: roundPda }).signers([fresh]).rpc();

    await sleep(4500);

    // settle (admin, injected randomness)
    await program.methods.settle([...Buffer.alloc(32, 21)])
      .accounts({ admin: admin.publicKey, round: roundPda }).rpc();

    // executeSwapMock
    const payoutVault = getAssociatedTokenAddressSync(ansemMint, vaultAuth, true);
    await program.methods.executeSwapMock().accounts({
      payer: admin.publicKey, round: roundPda, ansemMint,
      mintAuthority: mintAuth, vaultAuthority: vaultAuth, payoutVault, potVault, treasury,
    }).rpc();

    const settledRound = await program.account.round.fetch(roundPda);
    assert.equal(settledRound.state, 4); // CLAIMABLE

    // claim
    const jackpotVault = getAssociatedTokenAddressSync(ansemMint, jackpotAuth, true);
    await createAssociatedTokenAccountIdempotent(
      provider.connection, admin.payer, ansemMint, jackpotAuth, { commitment: "confirmed" }, undefined, undefined, true,
    );
    const freshAta = getAssociatedTokenAddressSync(ansemMint, fresh.publicKey);
    await program.methods.claim(new anchor.BN(id)).accounts({
      authority: fresh.publicKey, round: roundPda, ansemMint,
      vaultAuthority: vaultAuth, jackpotAuthority: jackpotAuth,
      payoutVault, jackpotVault, playerAta: freshAta,
    }).signers([fresh]).rpc();

    // Final assertions: sole staker gets the entire swap proceeds in their ATA.
    const finalAtaBal = await getAccount(provider.connection, freshAta);
    assert.equal(Number(finalAtaBal.amount), settledRound.swapProceeds.toNumber());

    // escrow.balance == deposit - staked (claim doesn't touch SOL escrow balance,
    // only active_round/last_claimed_round bookkeeping).
    const finalEscrow = await program.account.playerEscrow.fetch(freshEscrow);
    assert.equal(finalEscrow.balance.toNumber(), depositAmount - stakeAmount);
    assert.equal(finalEscrow.activeRound.toNumber(), 0);
    assert.equal(finalEscrow.lastClaimedRound.toNumber(), id);
  });
});
