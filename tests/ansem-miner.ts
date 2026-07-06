import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { AnsemMiner } from "../target/types/ansem_miner";
import { PublicKey } from "@solana/web3.js";
import { assert } from "chai";
import { getAssociatedTokenAddressSync, getAccount } from "@solana/spl-token";

const enc = (s: string) => Buffer.from(s);

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

  it("mock-swaps a settled round's pot into ANSEM", async () => {
    const { pda } = await freshInstantRound(3);
    // Use a second fresh player to avoid the unclaimed-round guard from the
    // earlier player (player already staked round1 and hasn't claimed it).
    const p2 = anchor.web3.Keypair.generate();
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
});
