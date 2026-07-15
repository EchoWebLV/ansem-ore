import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { AnsemMiner } from "../target/types/ansem_miner";
import { PublicKey, Keypair } from "@solana/web3.js";
import { assert } from "chai";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { keccak256 } from "js-sha3";

const enc = (s: string) => Buffer.from(s);
const u64le = (n: number) => new anchor.BN(n).toArrayLike(Buffer, "le", 8);

// JACKPOT random-trigger + bet-scaled cap suite (spec D6, Motherlode pattern).
// The winning-square stakers ALWAYS split this round's own leftover; only the
// carried ROLLOVER is gated — it pays out (the "bite") only on a TRIGGERED round,
// capped to cap_mult x the winning-square stake's ANSEM value. finalize_swap_
// accounting (instructions/swap.rs) reads trigger_odds/cap_mult from the
// JackpotConfig PDA (defaults 1-in-25 / 100x).
//
// The trigger draw is `u64::from_le_bytes(randomness[16..24]) % odds == 0`
// (math::jackpot_triggered) — DISJOINT from the winning-square draw
// (keccak(randomness ++ "jackpot")[0] % 25) and the return multipliers
// (keccak(randomness ++ [square])[0..2]). This suite injects deterministic
// randomness via admin `settle` to drive both draws independently: bytes 16..24
// force the trigger, the full 32 bytes' keccak fixes the winning square (mirrored
// in TS so stakes land on/off it deliberately). Return band pinned to (0,0) so
// nj_total == 0 and round_leftover == ansem_out (clean, all-to-jackpot math).
describe("jackpot random-trigger + bet-scaled cap", () => {
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

  // ---- TS mirrors of the on-chain math (programs/ansem-miner/src/math.rs) ----
  // Winning square = keccak256(randomness ++ "jackpot")[0] % 25.
  const jackpotBlock = (r: Buffer): number => keccak256.array([...r, ...enc("jackpot")])[0] % 25;
  // Trigger = u64_le(randomness[16..24]) % odds == 0 (0|1 => always).
  const triggered = (r: Buffer, odds: number): boolean => {
    if (odds <= 1) return true;
    let draw = 0n;
    for (let i = 0; i < 8; i++) draw |= BigInt(r[16 + i]) << BigInt(8 * i);
    return draw % BigInt(odds) === 0n;
  };
  // execute_swap_mock proceeds: fee=floor(pot*feeBps/1e4), net=pot-fee, out=floor(net*rate/1e9).
  const ansemOut = (pot: bigint, feeBps: bigint, rate: bigint): bigint => {
    const fee = (pot * feeBps) / 10_000n;
    const net = pot - fee;
    return (net * rate) / 1_000_000_000n;
  };

  // Build a 32-byte randomness: `fill` varies the winning square; bytes 16..24
  // force the trigger (all-zero draw 0 => fires; draw 1 => misses at odds 25).
  const mkRand = (fill: number, fire: boolean): Buffer => {
    const r = Buffer.alloc(32, fill);
    for (let i = 16; i < 24; i++) r[i] = 0;
    if (!fire) r[16] = 1;
    return r;
  };

  async function freshRound(durationSecs: number): Promise<{ id: number; pda: PublicKey }> {
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
    throw new Error("round never settleable");
  }
  const swapAccounts = (roundPda: PublicKey) => ({
    payer: admin.publicKey, round: roundPda, ansemMint,
    mintAuthority: mintAuth, vaultAuthority: vaultAuth, payoutVault, potVault, treasury,
    tokenProgram: TOKEN_PROGRAM_ID,
  });
  const stakeDirectAccts = (pk: PublicKey, roundPda: PublicKey) => ({
    authority: pk, config: configPda, round: roundPda, miner: minerOf(pk), potVault,
  });
  async function fundedPlayer(sol: number): Promise<Keypair> {
    const kp = Keypair.generate();
    const sig = await provider.connection.requestAirdrop(kp.publicKey, sol * anchor.web3.LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(sig);
    return kp;
  }

  // Stake a layout, settle with `rnd`, swap. Returns realized pot/out/jsq + rollover
  // before/after and the round's jackpot_pool.
  async function play(rnd: Buffer, stakes: Array<{ square: number; lamports: number }>) {
    const dur = 8;
    const r = await freshRound(dur);
    let pot = 0n;
    for (const s of stakes) {
      const p = await fundedPlayer(Math.ceil(s.lamports / 1e9) + 1);
      await program.methods.stakeDirect(new anchor.BN(r.id), s.square, new anchor.BN(s.lamports))
        .accounts(stakeDirectAccts(p.publicKey, r.pda)).signers([p]).rpc();
      pot += BigInt(s.lamports);
    }
    const cfg0: any = await program.account.config.fetch(configPda);
    const rolloverIn = BigInt(cfg0.rolloverJackpot.toString());
    const feeBps = BigInt(cfg0.feeBps);
    const rate = BigInt(cfg0.mockRate.toString());
    await settleAfterDeadline(r.pda, rnd);
    await program.methods.executeSwapMock().accounts(swapAccounts(r.pda)).rpc();
    const round: any = await program.account.round.fetch(r.pda);
    const cfg1: any = await program.account.config.fetch(configPda);
    // sanity: our TS jackpot-square mirror equals the on-chain draw.
    assert.equal(jackpotBlock(rnd), round.jackpotSquare, "TS jackpot-square mirror matches on-chain");
    return {
      pot, jsq: round.jackpotSquare as number,
      out: ansemOut(pot, feeBps, rate),
      leftover: ansemOut(pot, feeBps, rate), // band (0,0) => nj_total 0 => leftover == out
      rolloverIn, rolloverOut: BigInt(cfg1.rolloverJackpot.toString()),
      jackpotPool: BigInt(round.jackpotPool.toString()),
    };
  }

  const off = (jsq: number) => (jsq + 1) % 25; // a square that is NOT the winner

  it("initializes with default jackpot params (1-in-25 / 100x) and all-to-jackpot band", async () => {
    await program.methods.initialize().accounts({ admin: admin.publicKey, tokenProgram: TOKEN_PROGRAM_ID }).rpc()
      .catch((e: any) => { if (!/already in use/.test(String(e))) throw e; });
    await program.methods.initJackpotConfig().accounts({ admin: admin.publicKey }).rpc();
    // (0,0): every non-jackpot square returns 0 => round_leftover == ansem_out.
    await program.methods.setReturnBand(0, 0).accounts({ admin: admin.publicKey }).rpc();
    const jc: any = await program.account.jackpotConfig.fetch(
      PublicKey.findProgramAddressSync([enc("jackpot_config")], program.programId)[0]);
    assert.equal(jc.triggerOdds, 25);
    assert.equal(jc.capMult, 100);
  });

  // Round A: no winner -> rollover grows by the whole leftover (regression guard).
  it("no-winner round: rollover grows by the round leftover; jackpot_pool == 0", async () => {
    const rnd = mkRand(1, true);
    const jsq = jackpotBlock(rnd);
    const res = await play(rnd, [{ square: off(jsq), lamports: 2_000_000_000 }]); // stake OFF the winner
    assert.equal(res.rolloverIn.toString(), "0", "precondition: rollover starts empty");
    assert.equal(res.jackpotPool.toString(), "0", "no winner -> this round's pool is 0");
    assert.equal(res.rolloverOut.toString(), res.leftover.toString(), "rollover grew by exactly the leftover");
    assert.isTrue(res.rolloverOut > 0n);
  });

  // Round B: winner, NOT triggered -> pool == own leftover, rollover untouched.
  it("non-trigger winner round: jackpot_pool == leftover and rollover is UNCHANGED", async () => {
    const rnd = mkRand(2, false); // draw 1 -> not triggered at odds 25
    const jsq = jackpotBlock(rnd);
    assert.isFalse(triggered(rnd, 25), "mirror: this randomness must NOT trigger");
    const res = await play(rnd, [{ square: jsq, lamports: 300_000_000 }]); // stake ON the winner
    assert.equal(res.jackpotPool.toString(), res.leftover.toString(), "winner splits only this round's leftover");
    assert.equal(res.rolloverOut.toString(), res.rolloverIn.toString(), "untriggered -> rollover untouched");
    assert.isTrue(res.rolloverIn > 0n, "there WAS a rollover to (not) bite");
  });

  // Round C: winner, triggered, cap BINDS -> bite == min(rollover, 100*stakeValue).
  it("trigger round: bite == min(rollover, 100 x winning-square ANSEM value); rollover decremented by exactly the bite", async () => {
    const rnd = mkRand(3, true);
    const jsq = jackpotBlock(rnd);
    assert.isTrue(triggered(rnd, 25), "mirror: this randomness must trigger");
    // Tiny winner stake + a big loser so 100x the winner's ANSEM value < rollover
    // (the cap is the binding side of the min, proving the bet-scaled cap).
    const winStake = 10_000_000n;   // 0.01 SOL on the winning square
    const loseStake = 5_000_000_000n; // 5 SOL on a losing square
    const res = await play(rnd, [
      { square: jsq, lamports: Number(winStake) },
      { square: off(jsq), lamports: Number(loseStake) },
    ]);
    const stakeValueAnsem = (winStake * res.out) / res.pot; // block_sol[jsq]*ansem_out/pot (floor)
    const cap = 100n * stakeValueAnsem;
    const expectedBite = cap < res.rolloverIn ? cap : res.rolloverIn;
    assert.isTrue(cap < res.rolloverIn, "test design: the cap is the binding constraint");
    assert.equal(res.jackpotPool.toString(), (res.leftover + expectedBite).toString(), "pool == own leftover + bite");
    assert.equal(res.rolloverOut.toString(), (res.rolloverIn - expectedBite).toString(), "rollover -= exactly the bite");
  });

  // Round D: legacy full-drain — set_jackpot_params(1, 0) => always fire + uncapped.
  it("set_jackpot_params(1, 0) restores legacy full-drain: winner consumes the ENTIRE rollover", async () => {
    await program.methods.setJackpotParams(1, 0).accounts({ admin: admin.publicKey }).rpc();
    const rnd = mkRand(4, false); // trigger bytes irrelevant at odds 1 (always fires)
    const jsq = jackpotBlock(rnd);
    const res = await play(rnd, [{ square: jsq, lamports: 400_000_000 }]);
    assert.isTrue(res.rolloverIn > 0n, "there is a carried rollover to drain");
    assert.equal(res.jackpotPool.toString(), (res.leftover + res.rolloverIn).toString(), "pool == leftover + WHOLE rollover");
    assert.equal(res.rolloverOut.toString(), "0", "legacy: winner drains the rollover to 0");
  });

  it("set_jackpot_params is admin-gated (non-admin rejected)", async () => {
    const outsider = await fundedPlayer(1);
    try {
      await program.methods.setJackpotParams(25, 100)
        .accounts({ admin: outsider.publicKey, config: configPda,
          jackpotConfig: PublicKey.findProgramAddressSync([enc("jackpot_config")], program.programId)[0] })
        .signers([outsider]).rpc();
      assert.fail("non-admin must not set jackpot params");
    } catch (e: any) { assert.include(e.toString(), "Unauthorized"); }
  });

  // ---- Fee dial (spec D5): set_fee_bps ----
  it("set_fee_bps: 500 reflected in config; 2001 rejected; non-admin rejected", async () => {
    await program.methods.setFeeBps(500).accounts({ admin: admin.publicKey }).rpc();
    let cfg: any = await program.account.config.fetch(configPda);
    assert.equal(cfg.feeBps, 500, "fee dialed to 5%");

    // > 2000 bps hard ceiling -> BadFeeBps (a mis-set can never confiscate >20%).
    try {
      await program.methods.setFeeBps(2001).accounts({ admin: admin.publicKey }).rpc();
      assert.fail("fee_bps 2001 must be rejected");
    } catch (e: any) { assert.include(e.toString(), "BadFeeBps"); }

    // non-admin cannot dial the fee.
    const outsider = await fundedPlayer(1);
    try {
      await program.methods.setFeeBps(300).accounts({ admin: outsider.publicKey }).signers([outsider]).rpc();
      assert.fail("non-admin must not set the fee");
    } catch (e: any) { assert.include(e.toString(), "Unauthorized"); }

    // the rejected calls left the dial exactly at 500.
    cfg = await program.account.config.fetch(configPda);
    assert.equal(cfg.feeBps, 500, "rejections did not move the dial");
  });
});
