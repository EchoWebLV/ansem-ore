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
// Domains: "jkblock_sm" (small tier), "jkblock_big" (big tier).
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
    // Tiered jackpots: small 1/100, big 1/625, each paying 10% of its vault.
    assert.equal(cfg.smallJackpotOdds, 100);
    assert.equal(cfg.bigJackpotOdds, 625);
    assert.equal(cfg.smallJackpotBps, 1000);
    assert.equal(cfg.bigJackpotBps, 1000);
    // Both jackpot vaults are created (empty) at init, so claims never DoS on a
    // missing vault.
    assert.equal(Number((await getAccount(provider.connection, smallJackpotVault)).amount), 0);
    assert.equal(Number((await getAccount(provider.connection, bigJackpotVault)).amount), 0);
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

    // player joined + staked 0.5 SOL on round 1 (0.3 + 0.2). Under reconcile-at-
    // commit, stake never debited escrow, and this abandoned round is never
    // reconciled — so refund only RELEASES the withdraw-lock; it credits nothing
    // (balance and total_escrow_balance are unchanged by refund).
    const eBefore = await program.account.playerEscrow.fetch(escrowPda);
    assert.equal(eBefore.activeRound.toNumber(), 1);
    assert.equal(eBefore.balance.toNumber(), anchor.web3.LAMPORTS_PER_SOL); // never debited
    const teBefore = (await program.account.config.fetch(configPda)).totalEscrowBalance.toNumber();
    await program.methods.refund(new anchor.BN(1))
      .accounts(stakeAccts(player.publicKey, round1)).signers([player]).rpc();
    const eAfter = await program.account.playerEscrow.fetch(escrowPda);
    assert.equal(eAfter.balance.toNumber(), anchor.web3.LAMPORTS_PER_SOL); // unchanged (no credit)
    assert.equal(eAfter.activeRound.toNumber(), 0); // lock released
    assert.equal(eAfter.lastClaimedRound.toNumber(), 1);
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
  const [smallJackpotAuth] = PublicKey.findProgramAddressSync([enc("jackpot_sm_auth")], program.programId);
  const [bigJackpotAuth] = PublicKey.findProgramAddressSync([enc("jackpot_big_auth")], program.programId);

  // Vault ATAs (payout + both jackpot tiers). The jackpot vaults are created at
  // initialize, so tests never need to create them client-side anymore.
  const payoutVault = getAssociatedTokenAddressSync(ansemMint, vaultAuth, true);
  const smallJackpotVault = getAssociatedTokenAddressSync(ansemMint, smallJackpotAuth, true);
  const bigJackpotVault = getAssociatedTokenAddressSync(ansemMint, bigJackpotAuth, true);

  // Account-set helpers (both swap and claim now reference both jackpot tiers).
  const swapAccounts = (roundPda: PublicKey) => ({
    payer: admin.publicKey, round: roundPda, ansemMint,
    mintAuthority: mintAuth, vaultAuthority: vaultAuth, payoutVault,
    smallJackpotAuthority: smallJackpotAuth, smallJackpotVault,
    bigJackpotAuthority: bigJackpotAuth, bigJackpotVault,
    potVault, treasury,
  });
  const claimAccounts = (roundPda: PublicKey, authority: PublicKey, playerAta: PublicKey) => ({
    authority, round: roundPda, ansemMint, vaultAuthority: vaultAuth,
    smallJackpotAuthority: smallJackpotAuth, bigJackpotAuthority: bigJackpotAuth,
    payoutVault, smallJackpotVault, bigJackpotVault, playerAta,
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
    await program.methods.stake(5, new anchor.BN(anchor.web3.LAMPORTS_PER_SOL))
      .accounts(stakeAccts(p2.publicKey, pda)).signers([p2]).rpc();
    // reconcile debits escrow from block_stake — required or the swap is Insolvent.
    await reconcile(p2);
    await settleAfterDeadline(pda, Buffer.alloc(32, 3));

    await program.methods.executeSwapMock().accounts(swapAccounts(pda)).rpc();

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
    await program.methods.stake(2, new anchor.BN(0.6 * anchor.web3.LAMPORTS_PER_SOL))
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
    // varied stakes across squares
    await program.methods.stake(0, new anchor.BN(0.3e9)).accounts(stakeAccts(players[0].publicKey, pda)).signers([players[0]]).rpc();
    await program.methods.stake(1, new anchor.BN(0.2e9)).accounts(stakeAccts(players[0].publicKey, pda)).signers([players[0]]).rpc();
    await program.methods.stake(1, new anchor.BN(0.5e9)).accounts(stakeAccts(players[1].publicKey, pda)).signers([players[1]]).rpc();
    await program.methods.stake(7, new anchor.BN(0.1e9)).accounts(stakeAccts(players[1].publicKey, pda)).signers([players[1]]).rpc();
    await program.methods.stake(7, new anchor.BN(0.9e9)).accounts(stakeAccts(players[2].publicKey, pda)).signers([players[2]]).rpc();
    for (const p of players) await reconcile(p);

    await settleAfterDeadline(pda, Buffer.alloc(32, 42));
    await program.methods.executeSwapMock().accounts(swapAccounts(pda)).rpc();
    const r = await program.account.round.fetch(pda);
    const proceeds = r.swapProceeds.toNumber();

    // Jackpot vaults are unseeded here, so even if a tier's roll hits, its
    // snapshot pool is 0 and the sum-to-proceeds invariant is unaffected.
    let sum = 0;
    for (const p of players) {
      const ata = getAssociatedTokenAddressSync(ansemMint, p.publicKey);
      await program.methods.claim(new anchor.BN(id))
        .accounts(claimAccounts(pda, p.publicKey, ata)).signers([p]).rpc();
      const bal = await getAccount(provider.connection, ata);
      sum += Number(bal.amount);
    }
    assert.isAtMost(proceeds - sum, players.length); // floor dust only
    assert.isAbove(sum, proceeds - players.length - 1);
  });

  it("pays both jackpot tiers from settle-time snapshots to a sole staker", async () => {
    // Force both tiers to always hit; seed the big vault larger than the small
    // so "big" genuinely pays more.
    await program.methods.setSmallJackpotOdds(1).accounts({ admin: admin.publicKey }).rpc();
    await program.methods.setBigJackpotOdds(1).accounts({ admin: admin.publicKey }).rpc();
    await program.methods.seedSmallJackpot(new anchor.BN(1_000_000_000)).accounts({
      admin: admin.publicKey, ansemMint, smallJackpotAuthority: smallJackpotAuth, smallJackpotVault,
    }).rpc();
    await program.methods.seedBigJackpot(new anchor.BN(5_000_000_000)).accounts({
      admin: admin.publicKey, ansemMint, bigJackpotAuthority: bigJackpotAuth, bigJackpotVault,
    }).rpc();

    const p = anchor.web3.Keypair.generate();
    const s = await provider.connection.requestAirdrop(p.publicKey, 3 * anchor.web3.LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(s);
    await program.methods.deposit(new anchor.BN(2e9)).accounts({ authority: p.publicKey }).signers([p]).rpc();
    await program.methods.initMiner().accounts({ authority: p.publicKey }).signers([p]).rpc();
    const { id, pda } = await freshInstantRound(STAKE_WINDOW);

    const rnd = Buffer.alloc(32, 5);
    const smallBlock = computeJackpotBlock(rnd, "jkblock_sm");
    const bigBlock = computeJackpotBlock(rnd, "jkblock_big");
    // Sole staker stakes both winning squares (dedup if they coincide) so both
    // tiers pay; sole staker => main payout == full proceeds regardless.
    const blocks = smallBlock === bigBlock ? [smallBlock] : [smallBlock, bigBlock];
    await joinOnce(id, p);
    for (const b of blocks) {
      await program.methods.stake(b, new anchor.BN(0.5e9))
        .accounts(stakeAccts(p.publicKey, pda)).signers([p]).rpc();
    }
    await reconcile(p);

    await settleAfterDeadline(pda, rnd);
    await program.methods.executeSwapMock().accounts(swapAccounts(pda)).rpc();

    const r = await program.account.round.fetch(pda);
    assert.isTrue(r.smallJackpotHit);
    assert.isTrue(r.bigJackpotHit);
    assert.equal(r.smallJackpotBlock, smallBlock);
    assert.equal(r.bigJackpotBlock, bigBlock);
    // pools snapshotted at swap: 10% of each seeded vault (1e9 and 5e9)
    assert.equal(r.smallJackpotPool.toNumber(), 100_000_000);
    assert.equal(r.bigJackpotPool.toNumber(), 500_000_000);

    const ata = getAssociatedTokenAddressSync(ansemMint, p.publicKey);
    await program.methods.claim(new anchor.BN(id))
      .accounts(claimAccounts(pda, p.publicKey, ata)).signers([p]).rpc();
    const bal = await getAccount(provider.connection, ata);
    // sole staker: main == proceeds; + small pool (1e8) + big pool (5e8)
    const mainProceeds = r.swapProceeds.toNumber();
    assert.equal(Number(bal.amount), mainProceeds + 100_000_000 + 500_000_000);
  });

  it("jackpot snapshot makes multi-winner payouts order-independent", async () => {
    // Regression test for the audit's Important finding: two equally-staked
    // winners on the same jackpot square must receive EQUAL jackpot shares
    // regardless of who claims first. Pre-fix (live vault balance read per
    // claim), the second claimant was shortchanged.
    await program.methods.setSmallJackpotOdds(1).accounts({ admin: admin.publicKey }).rpc();
    await program.methods.setBigJackpotOdds(0).accounts({ admin: admin.publicKey }).rpc(); // isolate small tier
    await program.methods.seedSmallJackpot(new anchor.BN(1_000_000_000)).accounts({
      admin: admin.publicKey, ansemMint, smallJackpotAuthority: smallJackpotAuth, smallJackpotVault,
    }).rpc();

    const pa = anchor.web3.Keypair.generate();
    const pb = anchor.web3.Keypair.generate();
    for (const p of [pa, pb]) {
      const s = await provider.connection.requestAirdrop(p.publicKey, 3 * anchor.web3.LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(s);
      await program.methods.deposit(new anchor.BN(2e9)).accounts({ authority: p.publicKey }).signers([p]).rpc();
      await program.methods.initMiner().accounts({ authority: p.publicKey }).signers([p]).rpc();
    }
    const { id, pda } = await freshInstantRound(STAKE_WINDOW);
    const rnd = Buffer.alloc(32, 5);
    const smallBlock = computeJackpotBlock(rnd, "jkblock_sm");
    // both stake the SAME amount on the SAME winning square
    await joinOnce(id, pa);
    await joinOnce(id, pb);
    await program.methods.stake(smallBlock, new anchor.BN(1e9))
      .accounts(stakeAccts(pa.publicKey, pda)).signers([pa]).rpc();
    await program.methods.stake(smallBlock, new anchor.BN(1e9))
      .accounts(stakeAccts(pb.publicKey, pda)).signers([pb]).rpc();
    await reconcile(pa);
    await reconcile(pb);

    await settleAfterDeadline(pda, rnd);
    await program.methods.executeSwapMock().accounts(swapAccounts(pda)).rpc();

    const r = await program.account.round.fetch(pda);
    assert.isTrue(r.smallJackpotHit);
    assert.isFalse(r.bigJackpotHit);
    const pool = r.smallJackpotPool.toNumber();
    const proceeds = r.swapProceeds.toNumber();
    const expectedEach = Math.floor(proceeds / 2) + Math.floor(pool / 2);

    // pb claims FIRST, pa SECOND — order must not matter.
    const pbAta = getAssociatedTokenAddressSync(ansemMint, pb.publicKey);
    const paAta = getAssociatedTokenAddressSync(ansemMint, pa.publicKey);
    await program.methods.claim(new anchor.BN(id))
      .accounts(claimAccounts(pda, pb.publicKey, pbAta)).signers([pb]).rpc();
    await program.methods.claim(new anchor.BN(id))
      .accounts(claimAccounts(pda, pa.publicKey, paAta)).signers([pa]).rpc();

    const balB = Number((await getAccount(provider.connection, pbAta)).amount);
    const balA = Number((await getAccount(provider.connection, paAta)).amount);
    assert.equal(balA, balB, "equal stakers must get equal payouts regardless of claim order");
    assert.equal(balA, expectedEach);
    assert.equal(balB, expectedEach);

    // reset odds so the remaining tests see no jackpot interference
    await program.methods.setSmallJackpotOdds(0).accounts({ admin: admin.publicKey }).rpc();
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

    // join_round (lock) -> stake (sole staker) -> reconcile_miner (debit)
    await joinOnce(id, fresh);
    await program.methods.stake(11, new anchor.BN(stakeAmount))
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
});
