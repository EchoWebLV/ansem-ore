import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { AnsemMiner } from "../target/types/ansem_miner";
import { PublicKey, Keypair } from "@solana/web3.js";
import { assert, expect } from "chai";
import { createMint, createAccount, getAccount, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";

const enc = (s: string) => Buffer.from(s);
const u64le = (n: number) => new anchor.BN(n).toArrayLike(Buffer, "le", 8);

// BEEF hard-cap EXHAUSTION suite (spec D2). Split out from direct-beef.ts because
// the clamp `min(curve*decay, hard_cap - minted_total)` only ever bites when the
// bare curve exceeds the hard cap — reachable only with a LOW hard_cap, which is
// incompatible with direct-beef.ts's full-lifecycle emissions. BeefConfig is a
// singleton PDA (seeds=[BEEF_CONFIG_SEED], no close ix), so a low cap needs its own
// validator instance.
//
// Cap = 120_000_000. Genesis 1-SOL round mints 105_000_000 (decay factor 1). A
// 2-SOL round would emit 17_500_000 (curve 140M * decay 15/120) but is CLAMPED to
// the 15_000_000 remainder -> minted_total == hard_cap. Every later round mints 0.
describe("beef hard-cap exhaustion", () => {
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
  const ansemPayoutVault = getAssociatedTokenAddressSync(ansemMint, vaultAuth, true);
  const minerOf = (pk: PublicKey) =>
    PublicKey.findProgramAddressSync([enc("miner"), pk.toBuffer()], program.programId)[0];
  const beefRoundOf = (id: number) =>
    PublicKey.findProgramAddressSync([enc("beef_round"), u64le(id)], program.programId)[0];

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const HARD_CAP = 120_000_000n;   // low, so the remainder clamp is reachable
  const MAX_ROUND_MINT = 210_000_000n;
  const SAT = 1_000_000_000n;
  const TREASURY_BPS = 2_000n;

  let beefMint: PublicKey;
  let beefVault: PublicKey;
  let beefTreasury: PublicKey;

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
    throw new Error("round never settleable");
  }
  const swapAccounts = (roundPda: PublicKey) => ({
    payer: admin.publicKey, round: roundPda, ansemMint,
    mintAuthority: mintAuth, vaultAuthority: vaultAuth, payoutVault: ansemPayoutVault, potVault, treasury,
    tokenProgram: TOKEN_PROGRAM_ID,
  });
  const stakeDirectAccts = (pk: PublicKey, roundPda: PublicKey) => ({
    authority: pk, config: configPda, round: roundPda, miner: minerOf(pk), potVault,
  });
  const stampAccts = (roundId: number, roundPda: PublicKey) => ({
    payer: admin.publicKey, config: configPda, round: roundPda, beefConfig: beefConfigPda,
    beefMint, vaultAuthority: vaultAuth, beefVault, beefTreasury,
    beefRound: beefRoundOf(roundId), tokenProgram: TOKEN_PROGRAM_ID,
  });
  async function fundedPlayer(sol = 3): Promise<Keypair> {
    const kp = Keypair.generate();
    const sig = await provider.connection.requestAirdrop(kp.publicKey, sol * anchor.web3.LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(sig);
    return kp;
  }
  // Stake `lamports` on square 4 (single staker -> pot == lamports), settle+swap+stamp.
  async function playAndStamp(lamports: number, dur = 10): Promise<{ id: number; pda: PublicKey }> {
    const p = await fundedPlayer(Math.ceil(lamports / 1e9) + 2);
    const r = await freshRound(dur);
    await program.methods.stakeDirect(new anchor.BN(r.id), 4, new anchor.BN(lamports))
      .accounts(stakeDirectAccts(p.publicKey, r.pda)).signers([p]).rpc();
    await settleAfterDeadline(r.pda, Buffer.alloc(32, 5));
    await program.methods.executeSwapMock().accounts(swapAccounts(r.pda)).rpc();
    await program.methods.stampBeef(new anchor.BN(r.id)).accounts(stampAccts(r.id, r.pda)).rpc();
    return r;
  }
  const mintedTotal = async (): Promise<bigint> =>
    BigInt((await program.account.beefConfig.fetch(beefConfigPda)).mintedTotal.toString());
  const assertCollateralized = async () => {
    const bc = await program.account.beefConfig.fetch(beefConfigPda);
    const vault = await getAccount(provider.connection, beefVault);
    expect(vault.amount >= BigInt(bc.totalOwed.toString())).to.equal(true);
  };

  it("bootstraps with a LOW hard_cap (120_000_000)", async () => {
    await program.methods.initialize().accounts({ admin: admin.publicKey, tokenProgram: TOKEN_PROGRAM_ID }).rpc()
      .catch((e: any) => { if (!/already in use/.test(String(e))) throw e; });
    await program.methods.initJackpotConfig().accounts({ admin: admin.publicKey }).rpc();

    beefMint = await createMint(provider.connection, admin.payer, vaultAuth, null, 6);
    beefVault = await createAccount(provider.connection, admin.payer, beefMint, vaultAuth, Keypair.generate());
    beefTreasury = await createAccount(provider.connection, admin.payer, beefMint, admin.publicKey, Keypair.generate());

    await program.methods
      .initBeef(new anchor.BN(MAX_ROUND_MINT.toString()), new anchor.BN(SAT.toString()),
        new anchor.BN(HARD_CAP.toString()), Number(TREASURY_BPS), 0, 0, new anchor.BN(86_400), new anchor.BN(60))
      .accounts({ admin: admin.publicKey, beefMint, vaultAuthority: vaultAuth, beefVault, beefTreasury }).rpc();
    const bc = await program.account.beefConfig.fetch(beefConfigPda);
    assert.equal(bc.tickBps, 0);
    assert.equal(bc.bonusCapBps, 0);
    assert.equal(bc.mintedTotal.toString(), "0");
    await assertCollateralized();
  });

  it("genesis 1-SOL round mints 105_000_000 (decay factor 1)", async () => {
    await playAndStamp(1_000_000_000);
    assert.equal((await mintedTotal()).toString(), "105000000", "genesis fills 105M of the 120M cap");
    await assertCollateralized();
  });

  it("a 2-SOL round is CLAMPED to the 15_000_000 remainder (not the 17_500_000 curve*decay)", async () => {
    const before = await mintedTotal(); // 105M
    const r = await playAndStamp(2_000_000_000);
    const after = await mintedTotal();
    assert.equal((after - before).toString(), "15000000", "mints ONLY the 15M remainder, clamped");
    assert.equal(after.toString(), HARD_CAP.toString(), "minted_total == hard_cap (exhausted)");
    // players' share of the clamped 15M total: 15M - 20% = 12M.
    const br = await program.account.beefRound.fetch(beefRoundOf(r.id));
    assert.equal(br.emission.toString(), "12000000", "BeefRound.emission == players' 80% of the remainder");
    await assertCollateralized();
  });

  it("every round after exhaustion mints 0 (emission stops forever at the cap)", async () => {
    const before = await mintedTotal(); // == hard_cap
    const r = await playAndStamp(1_000_000_000);
    const after = await mintedTotal();
    assert.equal((after - before).toString(), "0", "past the cap -> zero mint");
    const br = await program.account.beefRound.fetch(beefRoundOf(r.id));
    assert.equal(br.emission.toString(), "0", "BeefRound.emission == 0 at/after the cap");
    await assertCollateralized();
  });
});
