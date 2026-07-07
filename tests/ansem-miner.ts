import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { AnsemMiner } from "../target/types/ansem_miner";
import { PublicKey } from "@solana/web3.js";
import { assert } from "chai";
import { getAssociatedTokenAddressSync, getAccount } from "@solana/spl-token";
import { keccak256 } from "js-sha3";

const enc = (s: string) => Buffer.from(s);

// Mirrors the Rust `jackpot_block` in programs/ansem-miner/src/math.rs EXACTLY:
// keccak256( randomness[32 bytes] || utf8(domain) ), take output byte[0] % 25.
// Lottery model uses the single domain "jackpot" (the one winning square/round).
function computeJackpotBlock(rnd: Buffer, domain: string): number {
  const h = keccak256.arrayBuffer(Buffer.concat([rnd, Buffer.from(domain)]));
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

  // M2c: `stake` gained a Session gate; its `miner`/`escrow` are now seeded on
  // `miner.authority` (self-referential) so anchor can no longer auto-derive them
  // client-side, and the optional `sessionToken` must be passed explicitly. These
  // are all wallet-signed (no session), so sessionToken is null and the
  // session_auth_or fallback (miner.authority == authority) authorizes them.
  const minerOf = (pk: PublicKey) =>
    PublicKey.findProgramAddressSync([enc("miner"), pk.toBuffer()], program.programId)[0];
  const escrowOf = (pk: PublicKey) =>
    PublicKey.findProgramAddressSync([enc("escrow"), pk.toBuffer()], program.programId)[0];
  const stakeAccts = (pk: PublicKey, roundPda: PublicKey) => ({
    authority: pk, config: configPda, round: roundPda,
    miner: minerOf(pk), escrow: escrowOf(pk), sessionToken: null,
  });

  // Round window for staking tests. Must comfortably outlast each round's full
  // pre-swap tx sequence (join_round + all stake() calls, up to ~8 txs for the
  // multi-player test) even on a loaded machine — otherwise staking races the
  // deadline and fails RoundEnded. settleAfterDeadline then polls out the rest
  // of the window, so a generous value only adds a bounded settle wait.
  const STAKE_WINDOW = 15;

  it("initializes config and mock mint", async () => {
    await program.methods.initialize().accounts({ admin: admin.publicKey }).rpc();
    const cfg = await program.account.config.fetch(configPda);
    assert.equal(cfg.admin.toBase58(), admin.publicKey.toBase58());
    assert.equal(cfg.ansemMint.toBase58(), ansemMint.toBase58());
    assert.equal(cfg.currentRoundId.toNumber(), 0);
    assert.equal(cfg.feeBps, 100);
    assert.equal(cfg.swapMode, 0);
    // No round yet => finalized true, so the first create_round is allowed.
    assert.isTrue(cfg.currentRoundFinalized);
    // Lottery model: per-square return band defaults to 0-50%; the jackpot
    // rollover starts empty. The reserve jackpot vaults are gone — the jackpot is
    // funded from each round's own proceeds.
    assert.equal(cfg.multMinBps, 0);
    assert.equal(cfg.multMaxBps, 5000);
    assert.equal(cfg.rolloverJackpot.toNumber(), 0);
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
    // Give round 1 a bounded (15s) duration instead of the 60s default so the
    // "abandoned round" escape-hatch test below can wait out its deadline and
    // cancel it. The negative tests between here and there run in a few seconds,
    // well inside the 15s window (deadline still future for the settle-reject).
    await program.methods.setRoundDuration(new anchor.BN(15)).accounts({ admin: admin.publicKey }).rpc();
    const [round1] = PublicKey.findProgramAddressSync(
      [enc("round"), new anchor.BN(1).toArrayLike(Buffer, "le", 8)], program.programId);
    await program.methods.createRound()
      .accounts({ payer: admin.publicKey, round: round1 }).rpc();
    const cfg = await program.account.config.fetch(configPda);
    assert.equal(cfg.currentRoundId.toNumber(), 1);
    // Opening a round clears the finalized gate until it reaches a terminal state.
    assert.isFalse(cfg.currentRoundFinalized);
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
    // join_round sets the withdraw-lock (no debit); stake no longer touches escrow.
    await joinOnce(1, player);
    await program.methods.stake(3, new anchor.BN(0.3 * anchor.web3.LAMPORTS_PER_SOL))
      .accounts(stakeAccts(player.publicKey, round1)).signers([player]).rpc();
    await program.methods.stake(14, new anchor.BN(0.2 * anchor.web3.LAMPORTS_PER_SOL))
      .accounts(stakeAccts(player.publicKey, round1)).signers([player]).rpc();
    const m = await program.account.minerPosition.fetch(minerPda);
    assert.equal(m.roundId.toNumber(), 1);
    assert.equal(m.blockStake[3].toNumber(), 0.3 * anchor.web3.LAMPORTS_PER_SOL);
    assert.equal(m.blockStake[14].toNumber(), 0.2 * anchor.web3.LAMPORTS_PER_SOL);
    const r = await program.account.round.fetch(round1);
    assert.equal(r.pot.toNumber(), 0.5 * anchor.web3.LAMPORTS_PER_SOL);
    const e = await program.account.playerEscrow.fetch(escrowPda);
    assert.equal(e.activeRound.toNumber(), 1); // locked by join_round
    // Escrow is NOT debited at stake time under reconcile-at-commit: balance
    // stays 1 SOL (deposit 2 - withdraw 1); the 0.5 staked is debited only at
    // reconcile_miner, which this abandoned round never reaches (it's cancelled).
    assert.equal(e.balance.toNumber(), anchor.web3.LAMPORTS_PER_SOL);
  });

  it("rejects an out-of-range block", async () => {
    try {
      await program.methods.stake(25, new anchor.BN(anchor.web3.LAMPORTS_PER_SOL))
        .accounts(stakeAccts(player.publicKey, round1)).signers([player]).rpc();
      assert.fail("should have thrown");
    } catch (e:any) { assert.include(e.toString(), "BadBlock"); }
  });

  it("rejects staking beyond escrow balance", async () => {
    try {
      // prior staked 0.5 + 2 SOL = 2.5 > balance 1.0 (but < 100 SOL cap, so this
      // trips the soft budget check, not StakeTooLarge).
      await program.methods.stake(1, new anchor.BN(2 * anchor.web3.LAMPORTS_PER_SOL))
        .accounts(stakeAccts(player.publicKey, round1)).signers([player]).rpc();
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

  // Settle a round once its (short) deadline has passed. Polls the on-chain
  // deadline check, so it's robust against validator-clock lag vs wall-clock
  // (a fixed sleep can undershoot the validator's unix_timestamp). Staking txs
  // are already confirmed before this is called, so only the deadline is awaited.
  async function settleAfterDeadline(roundPda: PublicKey, rnd: Buffer) {
    for (let i = 0; i < 30; i++) {
      try {
        await program.methods.settle([...rnd])
          .accounts({ admin: admin.publicKey, round: roundPda }).rpc();
        return;
      } catch (e: any) {
        if (!e.toString().includes("RoundNotEnded")) throw e;
        await sleep(1000);
      }
    }
    throw new Error("round never became settleable after polling");
  }

  // M2a escrow lifecycle helpers. Under reconcile-at-commit, a round's L1
  // escrow flow is: join_round (lock, NO debit) -> stake(s) -> reconcile_miner
  // (debit from the committed block_stake, release the lock). In production the
  // stake(s) run on the ER and reconcile runs on L1 after commit; on base we
  // call them directly so these game-logic tests exercise the *real* accounting
  // (stake no longer debits escrow itself). Call joinOnce once per player/round
  // before their first stake, and reconcile once per player before the swap.
  async function joinOnce(roundId: number, p: anchor.web3.Keypair) {
    const [esc] = PublicKey.findProgramAddressSync(
      [enc("escrow"), p.publicKey.toBuffer()], program.programId);
    await program.methods.joinRound(new anchor.BN(roundId))
      .accounts({ authority: p.publicKey, config: configPda, escrow: esc })
      .signers([p]).rpc();
  }
  async function reconcile(p: anchor.web3.Keypair) {
    const [esc] = PublicKey.findProgramAddressSync(
      [enc("escrow"), p.publicKey.toBuffer()], program.programId);
    const [mnr] = PublicKey.findProgramAddressSync(
      [enc("miner"), p.publicKey.toBuffer()], program.programId);
    const roundId = (await program.account.playerEscrow.fetch(esc)).activeRound.toNumber();
    await program.methods.reconcileMiner(new anchor.BN(roundId))
      .accounts({ config: configPda, escrow: esc, miner: mnr }).rpc();
  }

  it("cancels an abandoned round 1 and refunds the staker (escape hatch)", async () => {
    // round 1 (15s duration) was staked by `player` and never settled — the
    // classic wedge. Wait out its deadline, then admin cancels it (Open + past
    // deadline -> Closed), which re-arms the create_round gate, and `player`
    // permissionlessly refunds their staked SOL back into escrow. Pure
    // accounting: no lamports leave the commingled pot_vault.
    // Wait out round 1's deadline, then cancel. The validator's on-chain clock
    // can lag wall-clock, so poll-retry the cancel against the actual on-chain
    // deadline check rather than trusting a wall-clock sleep.
    let canceled = false;
    for (let i = 0; i < 30 && !canceled; i++) {
      await sleep(1500);
      try {
        await program.methods.cancelRound()
          .accounts({ admin: admin.publicKey, round: round1 }).rpc();
        canceled = true;
      } catch (e: any) {
        if (!e.toString().includes("RoundNotCancelable")) throw e;
      }
    }
    assert.isTrue(canceled, "round 1 should become cancelable after its deadline");
    const rClosed = await program.account.round.fetch(round1);
    assert.equal(rClosed.state, 5); // STATE_CLOSED
    assert.isTrue((await program.account.config.fetch(configPda)).currentRoundFinalized);

    // player joined + staked 0.5 SOL on round 1 (0.3 + 0.2). This abandoned round
    // was never RECONCILED, so refund takes the "joined, not reconciled" branch
    // (§3C): it only RELEASES the withdraw-lock with no credit (nothing was
    // debited). The reconciled-then-cancelled credit-back branch has its own test.
    const eBefore = await program.account.playerEscrow.fetch(escrowPda);
    assert.equal(eBefore.activeRound.toNumber(), 1);
    assert.equal(eBefore.balance.toNumber(), anchor.web3.LAMPORTS_PER_SOL); // never debited
    const teBefore = (await program.account.config.fetch(configPda)).totalEscrowBalance.toNumber();
    await program.methods.refund(new anchor.BN(1))
      .accounts(stakeAccts(player.publicKey, round1)).signers([player]).rpc();
    const eAfter = await program.account.playerEscrow.fetch(escrowPda);
    assert.equal(eAfter.balance.toNumber(), anchor.web3.LAMPORTS_PER_SOL); // unchanged (no credit)
    assert.equal(eAfter.activeRound.toNumber(), 0); // lock released
    assert.equal(eAfter.lastClaimedRound.toNumber(), 0); // §3C: refund no longer writes last_claimed_round
    const teAfter = (await program.account.config.fetch(configPda)).totalEscrowBalance.toNumber();
    assert.equal(teAfter - teBefore, 0); // refund moves no escrow accounting

    // double refund is rejected (nothing left to refund)
    try {
      await program.methods.refund(new anchor.BN(1))
        .accounts(stakeAccts(player.publicKey, round1)).signers([player]).rpc();
      assert.fail("should reject double refund");
    } catch (e: any) { assert.include(e.toString(), "NothingToRefund"); }
  });

  it("creates a zero-duration round that is immediately settleable", async () => {
    const { pda } = await freshInstantRound();
    const rnd = Buffer.alloc(32, 5);
    await program.methods.settle([...rnd])
      .accounts({ admin: admin.publicKey, round: pda }).rpc();
    const r = await program.account.round.fetch(pda);
    assert.equal(r.state, 2); // STATE_SETTLED

    // Finalize this settle-only round (no stakers) so the create_round gate is
    // re-armed for the next round.
    await program.methods.cancelRound().accounts({ admin: admin.publicKey, round: pda }).rpc();
    assert.equal((await program.account.round.fetch(pda)).state, 5); // STATE_CLOSED
  });

  const [vaultAuth] = PublicKey.findProgramAddressSync([enc("vault_auth")], program.programId);
  const [mintAuth] = PublicKey.findProgramAddressSync([enc("mint_auth")], program.programId);
  const [treasury] = PublicKey.findProgramAddressSync([enc("treasury")], program.programId);
  const payoutVault = getAssociatedTokenAddressSync(ansemMint, vaultAuth, true);
  // The one VRF-picked jackpot square for a given settle randomness.
  const jackpotSquareOf = (rnd: Buffer) => computeJackpotBlock(rnd, "jackpot");

  // Account-set helpers (lottery model: a single payout_vault, no reserve jackpots).
  const swapAccounts = (roundPda: PublicKey) => ({
    payer: admin.publicKey, round: roundPda, ansemMint,
    mintAuthority: mintAuth, vaultAuthority: vaultAuth, payoutVault,
    potVault, treasury,
  });
  const claimAccounts = (roundPda: PublicKey, authority: PublicKey, playerAta: PublicKey) => ({
    authority, round: roundPda, ansemMint, vaultAuthority: vaultAuth,
    payoutVault, playerAta,
  });

  // Hoisted to describe-scope (rather than declared inside the swap test) so
  // the claim tests below can reference the same staker/round.
  const p2 = anchor.web3.Keypair.generate();

  it("mock-swaps a settled round's pot into ANSEM", async () => {
    const { id, pda } = await freshInstantRound(STAKE_WINDOW);
    // Use a second fresh player to avoid the unclaimed-round guard from the
    // earlier player (player already staked round1 and hasn't claimed it).
    const sig = await provider.connection.requestAirdrop(p2.publicKey, 3 * anchor.web3.LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(sig);
    await program.methods.deposit(new anchor.BN(2 * anchor.web3.LAMPORTS_PER_SOL))
      .accounts({ authority: p2.publicKey }).signers([p2]).rpc();
    await program.methods.initMiner().accounts({ authority: p2.publicKey }).signers([p2]).rpc();
    await joinOnce(id, p2);
    // Stake the jackpot square (derived from the settle randomness) so this sole
    // staker wins the whole pool == full proceeds (and the rollover stays 0).
    const jsq = jackpotSquareOf(Buffer.alloc(32, 3));
    await program.methods.stake(jsq, new anchor.BN(anchor.web3.LAMPORTS_PER_SOL))
      .accounts(stakeAccts(p2.publicKey, pda)).signers([p2]).rpc();
    // reconcile debits escrow from block_stake — required or the swap is Insolvent.
    await reconcile(p2);
    await settleAfterDeadline(pda, Buffer.alloc(32, 3));

    await program.methods.executeSwapMock().accounts(swapAccounts(pda)).rpc();

    const r = await program.account.round.fetch(pda);
    assert.equal(r.state, 4); // CLAIMABLE
    assert.equal(r.jackpotSquare, jsq); // VRF-picked square == the one we staked
    // net = 1 SOL - 1% fee = 0.99 SOL; ansem = 0.99 * 2800e6 = 2,772,000,000
    assert.equal(r.swapProceeds.toNumber(), 2_772_000_000);
    // Sole staker on the jackpot square => the pool == the full proceeds.
    assert.equal(r.jackpotPool.toNumber(), 2_772_000_000);
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
    const p2Ata = getAssociatedTokenAddressSync(ansemMint, p2.publicKey);

    await program.methods.claim(new anchor.BN(id))
      .accounts(claimAccounts(pda, p2.publicKey, p2Ata)).signers([p2]).rpc();

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
    const p2Ata = getAssociatedTokenAddressSync(ansemMint, p2.publicKey);
    try {
      await program.methods.claim(new anchor.BN(id))
        .accounts(claimAccounts(pda, p2.publicKey, p2Ata)).signers([p2]).rpc();
      assert.fail("should reject");
    } catch (e: any) { assert.include(e.toString(), "AlreadyClaimed"); }
  });

  // Solvency: pot_vault is a single commingled PDA shared by every player's
  // idle escrow *and* the (now serialized) round's pot. The create_round gate
  // enforces one active round at a time, so this proves the remaining
  // commingling risk is contained — an idle depositor's parked escrow is never
  // swept out to treasury by another player's swap. (Concurrent rounds, which
  // the earlier version of this test exercised, are now forbidden by the
  // lifecycle gate; per-round vaults for overlapping rounds are deferred to M2.)
  it("keeps pot_vault solvent: a swap never sweeps idle-depositor escrow", async () => {
    // Idle depositor: funds sit in pot_vault as escrow the whole test and must
    // never be swept out by someone else's swap.
    const idle = anchor.web3.Keypair.generate();
    const sig0 = await provider.connection.requestAirdrop(idle.publicKey, 3 * anchor.web3.LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(sig0);
    const idleAmount = 1.5 * anchor.web3.LAMPORTS_PER_SOL;
    await program.methods.deposit(new anchor.BN(idleAmount))
      .accounts({ authority: idle.publicKey }).signers([idle]).rpc();

    const pA = anchor.web3.Keypair.generate();
    const s = await provider.connection.requestAirdrop(pA.publicKey, 3 * anchor.web3.LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(s);
    await program.methods.deposit(new anchor.BN(2 * anchor.web3.LAMPORTS_PER_SOL))
      .accounts({ authority: pA.publicKey }).signers([pA]).rpc();
    await program.methods.initMiner().accounts({ authority: pA.publicKey }).signers([pA]).rpc();

    const roundA = await freshInstantRound(STAKE_WINDOW);
    await joinOnce(roundA.id, pA);
    // Stake the jackpot square so the pool is won this round and the global
    // rollover stays 0 for the tests that follow.
    const jsqA = jackpotSquareOf(Buffer.alloc(32, 7));
    await program.methods.stake(jsqA, new anchor.BN(0.6 * anchor.web3.LAMPORTS_PER_SOL))
      .accounts(stakeAccts(pA.publicKey, roundA.pda)).signers([pA]).rpc();
    await reconcile(pA);

    await settleAfterDeadline(roundA.pda, Buffer.alloc(32, 7));

    await program.methods.executeSwapMock().accounts(swapAccounts(roundA.pda)).rpc();

    const rAfinal = await program.account.round.fetch(roundA.pda);
    assert.equal(rAfinal.state, 4); // CLAIMABLE
    // pot = 0.6 SOL; net = pot * 99% (1% fee); ansem = net * mock_rate / 1 SOL
    const potA = 600_000_000;
    const netA = potA * 99 / 100;
    assert.equal(rAfinal.swapProceeds.toNumber(), netA * 2_800_000_000 / 1_000_000_000);

    // Invariant: after the swap, pot_vault still fully covers the idle
    // depositor's escrow — their parked SOL was never touched.
    const eIdle = await program.account.playerEscrow.fetch(
      PublicKey.findProgramAddressSync([enc("escrow"), idle.publicKey.toBuffer()], program.programId)[0]);
    const potVaultLamports = await provider.connection.getBalance(potVault);
    assert.isAtLeast(potVaultLamports, eIdle.balance.toNumber());

    // And they can withdraw their full balance: proof the escrow lamports were
    // never shipped to treasury by the swap.
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
    const { id, pda } = await freshInstantRound(STAKE_WINDOW);
    for (const p of players) await joinOnce(id, p);
    // varied stakes across squares; ensure SOMEONE stakes the jackpot square so
    // the whole pool is won and the payouts sum to the full proceeds.
    const jsq = jackpotSquareOf(Buffer.alloc(32, 42));
    await program.methods.stake(0, new anchor.BN(0.3e9)).accounts(stakeAccts(players[0].publicKey, pda)).signers([players[0]]).rpc();
    await program.methods.stake(1, new anchor.BN(0.2e9)).accounts(stakeAccts(players[0].publicKey, pda)).signers([players[0]]).rpc();
    await program.methods.stake(1, new anchor.BN(0.5e9)).accounts(stakeAccts(players[1].publicKey, pda)).signers([players[1]]).rpc();
    await program.methods.stake(7, new anchor.BN(0.1e9)).accounts(stakeAccts(players[1].publicKey, pda)).signers([players[1]]).rpc();
    await program.methods.stake(7, new anchor.BN(0.9e9)).accounts(stakeAccts(players[2].publicKey, pda)).signers([players[2]]).rpc();
    await program.methods.stake(jsq, new anchor.BN(0.4e9)).accounts(stakeAccts(players[2].publicKey, pda)).signers([players[2]]).rpc();
    for (const p of players) await reconcile(p);

    await settleAfterDeadline(pda, Buffer.alloc(32, 42));
    await program.methods.executeSwapMock().accounts(swapAccounts(pda)).rpc();
    const r = await program.account.round.fetch(pda);
    const proceeds = r.swapProceeds.toNumber();

    // Lottery model: with the jackpot square staked, Σ(returns + jackpot share)
    // equals the full proceeds, modulo per-player floor dust (one floor for the
    // returns portion + one for the jackpot share, per claimer).
    let sum = 0;
    for (const p of players) {
      const ata = getAssociatedTokenAddressSync(ansemMint, p.publicKey);
      await program.methods.claim(new anchor.BN(id))
        .accounts(claimAccounts(pda, p.publicKey, ata)).signers([p]).rpc();
      const bal = await getAccount(provider.connection, ata);
      sum += Number(bal.amount);
    }
    assert.isAtMost(proceeds - sum, 2 * players.length + 2);
    assert.isAbove(sum, proceeds - 2 * players.length - 2);
  });

  it("§lottery: set_return_band(0,0) sends the whole pot to the jackpot square", async () => {
    // Max-variance mode: non-jackpot squares return 0, so the jackpot-square
    // staker takes the entire proceeds and everyone else gets nothing.
    await program.methods.setReturnBand(0, 0).accounts({ admin: admin.publicKey }).rpc();

    const [pWin, pLose] = [anchor.web3.Keypair.generate(), anchor.web3.Keypair.generate()];
    for (const p of [pWin, pLose]) {
      const s = await provider.connection.requestAirdrop(p.publicKey, 3 * anchor.web3.LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(s);
      await program.methods.deposit(new anchor.BN(2e9)).accounts({ authority: p.publicKey }).signers([p]).rpc();
      await program.methods.initMiner().accounts({ authority: p.publicKey }).signers([p]).rpc();
    }
    const { id, pda } = await freshInstantRound(STAKE_WINDOW);
    const rnd = Buffer.alloc(32, 5);
    const jsq = jackpotSquareOf(rnd);
    const other = (jsq + 1) % 25;
    await joinOnce(id, pWin);
    await joinOnce(id, pLose);
    await program.methods.stake(jsq, new anchor.BN(1e9)).accounts(stakeAccts(pWin.publicKey, pda)).signers([pWin]).rpc();
    await program.methods.stake(other, new anchor.BN(1e9)).accounts(stakeAccts(pLose.publicKey, pda)).signers([pLose]).rpc();
    await reconcile(pWin);
    await reconcile(pLose);

    await settleAfterDeadline(pda, rnd);
    await program.methods.executeSwapMock().accounts(swapAccounts(pda)).rpc();

    const r = await program.account.round.fetch(pda);
    assert.equal(r.jackpotSquare, jsq);
    const proceeds = r.swapProceeds.toNumber();
    assert.equal(r.jackpotPool.toNumber(), proceeds, "0-band => pool == full proceeds");

    const winAta = getAssociatedTokenAddressSync(ansemMint, pWin.publicKey);
    const loseAta = getAssociatedTokenAddressSync(ansemMint, pLose.publicKey);
    await program.methods.claim(new anchor.BN(id)).accounts(claimAccounts(pda, pWin.publicKey, winAta)).signers([pWin]).rpc();
    await program.methods.claim(new anchor.BN(id)).accounts(claimAccounts(pda, pLose.publicKey, loseAta)).signers([pLose]).rpc();
    assert.equal(Number((await getAccount(provider.connection, winAta)).amount), proceeds, "jackpot staker takes all");
    assert.equal(Number((await getAccount(provider.connection, loseAta)).amount), 0, "non-jackpot staker gets nothing at 0-band");

    // Restore the default 0-50% band for the tests that follow.
    await program.methods.setReturnBand(0, 5000).accounts({ admin: admin.publicKey }).rpc();
  });

  it("§lottery: equal jackpot-square stakers split the pool equally, order-independent", async () => {
    // Two equal stakers on the jackpot square must get EQUAL shares regardless of
    // who claims first — the pool is frozen at swap (the audit's order-dependence
    // fix, preserved). Use (0,0) so the pool == full proceeds for a clean split.
    await program.methods.setReturnBand(0, 0).accounts({ admin: admin.publicKey }).rpc();
    const [pa, pb] = [anchor.web3.Keypair.generate(), anchor.web3.Keypair.generate()];
    for (const p of [pa, pb]) {
      const s = await provider.connection.requestAirdrop(p.publicKey, 3 * anchor.web3.LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(s);
      await program.methods.deposit(new anchor.BN(2e9)).accounts({ authority: p.publicKey }).signers([p]).rpc();
      await program.methods.initMiner().accounts({ authority: p.publicKey }).signers([p]).rpc();
    }
    const { id, pda } = await freshInstantRound(STAKE_WINDOW);
    const rnd = Buffer.alloc(32, 5);
    const jsq = jackpotSquareOf(rnd);
    await joinOnce(id, pa);
    await joinOnce(id, pb);
    await program.methods.stake(jsq, new anchor.BN(1e9)).accounts(stakeAccts(pa.publicKey, pda)).signers([pa]).rpc();
    await program.methods.stake(jsq, new anchor.BN(1e9)).accounts(stakeAccts(pb.publicKey, pda)).signers([pb]).rpc();
    await reconcile(pa);
    await reconcile(pb);

    await settleAfterDeadline(pda, rnd);
    await program.methods.executeSwapMock().accounts(swapAccounts(pda)).rpc();
    const r = await program.account.round.fetch(pda);
    const expectedEach = Math.floor(r.jackpotPool.toNumber() / 2);

    // pb claims FIRST, pa SECOND — order must not matter.
    const pbAta = getAssociatedTokenAddressSync(ansemMint, pb.publicKey);
    const paAta = getAssociatedTokenAddressSync(ansemMint, pa.publicKey);
    await program.methods.claim(new anchor.BN(id)).accounts(claimAccounts(pda, pb.publicKey, pbAta)).signers([pb]).rpc();
    await program.methods.claim(new anchor.BN(id)).accounts(claimAccounts(pda, pa.publicKey, paAta)).signers([pa]).rpc();
    const balB = Number((await getAccount(provider.connection, pbAta)).amount);
    const balA = Number((await getAccount(provider.connection, paAta)).amount);
    assert.equal(balA, balB, "equal stakers get equal payouts regardless of claim order");
    assert.equal(balA, expectedEach);

    await program.methods.setReturnBand(0, 5000).accounts({ admin: admin.publicKey }).rpc();
  });

  it("§lottery: an unstaked jackpot square rolls its pool into the next round", async () => {
    // Round A: nobody stakes the jackpot square => the whole leftover rolls over.
    const cfg0 = await program.account.config.fetch(configPda);
    assert.equal(cfg0.rolloverJackpot.toNumber(), 0, "precondition: rollover starts empty");

    const pA = anchor.web3.Keypair.generate();
    let s = await provider.connection.requestAirdrop(pA.publicKey, 3 * anchor.web3.LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(s);
    await program.methods.deposit(new anchor.BN(2e9)).accounts({ authority: pA.publicKey }).signers([pA]).rpc();
    await program.methods.initMiner().accounts({ authority: pA.publicKey }).signers([pA]).rpc();
    const roundA = await freshInstantRound(STAKE_WINDOW);
    const rndA = Buffer.alloc(32, 9);
    const jsqA = jackpotSquareOf(rndA);
    const nonJsqA = (jsqA + 1) % 25;
    await joinOnce(roundA.id, pA);
    await program.methods.stake(nonJsqA, new anchor.BN(1e9)).accounts(stakeAccts(pA.publicKey, roundA.pda)).signers([pA]).rpc();
    await reconcile(pA);
    await settleAfterDeadline(roundA.pda, rndA);
    await program.methods.executeSwapMock().accounts(swapAccounts(roundA.pda)).rpc();
    const rA = await program.account.round.fetch(roundA.pda);
    assert.equal(rA.jackpotPool.toNumber(), 0, "no jackpot staker => no pool this round");
    const carried = (await program.account.config.fetch(configPda)).rolloverJackpot.toNumber();
    assert.isAbove(carried, 0, "leftover must roll over");
    const paAta = getAssociatedTokenAddressSync(ansemMint, pA.publicKey);
    await program.methods.claim(new anchor.BN(roundA.id)).accounts(claimAccounts(roundA.pda, pA.publicKey, paAta)).signers([pA]).rpc();

    // Round B: a staker on the jackpot square collects this round's leftover PLUS
    // the carried rollover; the rollover then resets to 0.
    const pB = anchor.web3.Keypair.generate();
    s = await provider.connection.requestAirdrop(pB.publicKey, 3 * anchor.web3.LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(s);
    await program.methods.deposit(new anchor.BN(2e9)).accounts({ authority: pB.publicKey }).signers([pB]).rpc();
    await program.methods.initMiner().accounts({ authority: pB.publicKey }).signers([pB]).rpc();
    const roundB = await freshInstantRound(STAKE_WINDOW);
    const rndB = Buffer.alloc(32, 11);
    const jsqB = jackpotSquareOf(rndB);
    await joinOnce(roundB.id, pB);
    await program.methods.stake(jsqB, new anchor.BN(1e9)).accounts(stakeAccts(pB.publicKey, roundB.pda)).signers([pB]).rpc();
    await reconcile(pB);
    await settleAfterDeadline(roundB.pda, rndB);
    await program.methods.executeSwapMock().accounts(swapAccounts(roundB.pda)).rpc();
    const rB = await program.account.round.fetch(roundB.pda);
    assert.equal(rB.jackpotPool.toNumber(), rB.swapProceeds.toNumber() + carried, "carried rollover folded into pool");
    assert.equal((await program.account.config.fetch(configPda)).rolloverJackpot.toNumber(), 0, "rollover consumed by the winner");
    const pbAta = getAssociatedTokenAddressSync(ansemMint, pB.publicKey);
    await program.methods.claim(new anchor.BN(roundB.id)).accounts(claimAccounts(roundB.pda, pB.publicKey, pbAta)).signers([pB]).rpc();
    assert.equal(Number((await getAccount(provider.connection, pbAta)).amount), rB.swapProceeds.toNumber() + carried, "winner collects proceeds + rollover");
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
    const { id, pda: roundPda } = await freshInstantRound(STAKE_WINDOW);

    // deposit
    await program.methods.deposit(new anchor.BN(depositAmount))
      .accounts({ authority: fresh.publicKey }).signers([fresh]).rpc();

    // initMiner
    await program.methods.initMiner().accounts({ authority: fresh.publicKey }).signers([fresh]).rpc();

    // join_round (lock) -> stake (sole staker on the jackpot square, so they win
    // the whole pool == full proceeds) -> reconcile_miner (debit)
    await joinOnce(id, fresh);
    const e2eJsq = jackpotSquareOf(Buffer.alloc(32, 21));
    await program.methods.stake(e2eJsq, new anchor.BN(stakeAmount))
      .accounts(stakeAccts(fresh.publicKey, roundPda)).signers([fresh]).rpc();
    await reconcile(fresh);

    // settle (admin, injected randomness) — poll past the deadline
    await settleAfterDeadline(roundPda, Buffer.alloc(32, 21));

    // executeSwapMock
    await program.methods.executeSwapMock().accounts(swapAccounts(roundPda)).rpc();

    const settledRound = await program.account.round.fetch(roundPda);
    assert.equal(settledRound.state, 4); // CLAIMABLE

    // claim
    const freshAta = getAssociatedTokenAddressSync(ansemMint, fresh.publicKey);
    await program.methods.claim(new anchor.BN(id))
      .accounts(claimAccounts(roundPda, fresh.publicKey, freshAta)).signers([fresh]).rpc();

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

  // ---------------------------------------------------------------------------
  // M4a §3 program-hardening regressions (added at end so round-id sequencing of
  // the tests above is undisturbed). 3A (commit_miner) is covered by the ER suite.
  // ---------------------------------------------------------------------------

  it("§3B: delegate_round rejects a non-admin caller (keeper-gate holds)", async () => {
    const attacker = anchor.web3.Keypair.generate();
    const air = await provider.connection.requestAirdrop(attacker.publicKey, anchor.web3.LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(air);
    // A 0-duration round is OPEN (settle hasn't run) but immediately past deadline.
    const { id, pda } = await freshInstantRound(0);
    try {
      await program.methods.delegateRound(new anchor.BN(id))
        .accounts({ payer: attacker.publicKey, config: configPda, round: pda })
        .signers([attacker]).rpc();
      assert.fail("non-admin delegate_round must be rejected");
    } catch (e: any) { assert.include(e.toString(), "Unauthorized"); }
    // Finalize this OPEN round so the create_round gate re-arms (poll for clock lag).
    let closed = false;
    for (let i = 0; i < 20 && !closed; i++) {
      try {
        await program.methods.cancelRound().accounts({ admin: admin.publicKey, round: pda }).rpc();
        closed = true;
      } catch (e: any) { if (!e.toString().includes("RoundNotCancelable")) throw e; await sleep(1000); }
    }
    assert.isTrue(closed, "round should finalize");
    assert.equal((await program.account.round.fetch(pda)).state, 5); // STATE_CLOSED
  });

  it("§3B: delegate_round rejects a stale (non-current / non-OPEN) round", async () => {
    // round 1 was closed by the escape-hatch test above -> stale + finalized. The
    // admin gate passes but the defense-in-depth state/round-id check trips.
    const [stalePda] = PublicKey.findProgramAddressSync(
      [enc("round"), new anchor.BN(1).toArrayLike(Buffer, "le", 8)], program.programId);
    try {
      await program.methods.delegateRound(new anchor.BN(1))
        .accounts({ payer: admin.publicKey, config: configPda, round: stalePda }).rpc();
      assert.fail("delegating a stale round must be rejected");
    } catch (e: any) {
      assert.isTrue(/BadRoundState|NotCurrentRound/.test(e.toString()), e.toString());
    }
  });

  it("§3C: reconcile -> cancel -> refund restores the staker's balance", async () => {
    // Fresh player with a clean escrow.
    const p = anchor.web3.Keypair.generate();
    const air = await provider.connection.requestAirdrop(p.publicKey, 3 * anchor.web3.LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(air);
    await program.methods.deposit(new anchor.BN(2 * anchor.web3.LAMPORTS_PER_SOL))
      .accounts({ authority: p.publicKey }).signers([p]).rpc();
    await program.methods.initMiner().accounts({ authority: p.publicKey }).signers([p]).rpc();

    // Open a short round, join, stake 0.5 SOL (L1-direct, as this suite does).
    const { id: rId, pda: rPda } = await freshInstantRound(15);
    await program.methods.joinRound(new anchor.BN(rId))
      .accounts({ authority: p.publicKey, config: configPda, escrow: escrowOf(p.publicKey) })
      .signers([p]).rpc();
    const STAKE = new anchor.BN(0.5 * anchor.web3.LAMPORTS_PER_SOL);
    await program.methods.stake(4, STAKE)
      .accounts(stakeAccts(p.publicKey, rPda)).signers([p]).rpc();

    // Reconcile (permissionless): debits escrow from the block_stake snapshot and
    // clears the lock. This is the step whose debit refund must later reverse.
    await program.methods.reconcileMiner(new anchor.BN(rId))
      .accounts({ config: configPda, escrow: escrowOf(p.publicKey), miner: minerOf(p.publicKey) }).rpc();
    const eStaked = await program.account.playerEscrow.fetch(escrowOf(p.publicKey));
    assert.equal(eStaked.balance.toNumber(), 1.5 * anchor.web3.LAMPORTS_PER_SOL, "debited by reconcile");
    assert.equal(eStaked.activeRound.toNumber(), 0, "reconcile released the lock");
    assert.equal(eStaked.reconciledRound.toNumber(), rId);
    const teBefore = (await program.account.config.fetch(configPda)).totalEscrowBalance.toNumber();

    // Cancel the round after its deadline (poll for on-chain clock lag).
    let canceled = false;
    for (let i = 0; i < 30 && !canceled; i++) {
      await sleep(1500);
      try {
        await program.methods.cancelRound().accounts({ admin: admin.publicKey, round: rPda }).rpc();
        canceled = true;
      } catch (e: any) { if (!e.toString().includes("RoundNotCancelable")) throw e; }
    }
    assert.isTrue(canceled);

    // Refund must CREDIT BACK the 0.5 SOL and clear the lock.
    await program.methods.refund(new anchor.BN(rId))
      .accounts({ authority: p.publicKey, config: configPda, round: rPda,
        escrow: escrowOf(p.publicKey), miner: minerOf(p.publicKey) })
      .signers([p]).rpc();
    const eRef = await program.account.playerEscrow.fetch(escrowOf(p.publicKey));
    assert.equal(eRef.balance.toNumber(), 2 * anchor.web3.LAMPORTS_PER_SOL, "stake credited back");
    assert.equal(eRef.activeRound.toNumber(), 0, "lock released");
    assert.equal(eRef.reconciledRound.toNumber(), 0, "reconciled_round consumed");
    const teAfter = (await program.account.config.fetch(configPda)).totalEscrowBalance.toNumber();
    assert.equal(teAfter - teBefore, 0.5 * anchor.web3.LAMPORTS_PER_SOL, "total_escrow_balance restored");

    // A second refund now no-ops (nothing to refund).
    try {
      await program.methods.refund(new anchor.BN(rId))
        .accounts({ authority: p.publicKey, config: configPda, round: rPda,
          escrow: escrowOf(p.publicKey), miner: minerOf(p.publicKey) })
        .signers([p]).rpc();
      assert.fail("double refund must be rejected");
    } catch (e: any) { assert.include(e.toString(), "NothingToRefund"); }

    // The credited balance is now withdrawable (lock released).
    await program.methods.withdraw(new anchor.BN(0.5 * anchor.web3.LAMPORTS_PER_SOL))
      .accounts({ authority: p.publicKey }).signers([p]).rpc();
  });
});
