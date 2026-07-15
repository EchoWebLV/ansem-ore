import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { getAccount, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey, Transaction } from "@solana/web3.js";
import { assert } from "chai";
import { keccak256 } from "js-sha3";
import { AnsemMiner } from "../target/types/ansem_miner";

const enc = (value: string) => Buffer.from(value);
const randomness = Buffer.alloc(32, 7); // u64(bytes 16..24) % 25 == 11, so no rollover bite.
const STAKE_WINDOW_SECS = 5;

describe("cross-rail double claim", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.AnsemMiner as Program<AnsemMiner>;
  const admin = provider.wallet as anchor.Wallet;

  const [config] = PublicKey.findProgramAddressSync([enc("config")], program.programId);
  const [ansemMint] = PublicKey.findProgramAddressSync([enc("ansem_mint")], program.programId);
  const [potVault] = PublicKey.findProgramAddressSync([enc("pot_vault")], program.programId);
  const [vaultAuthority] = PublicKey.findProgramAddressSync([enc("vault_auth")], program.programId);
  const [mintAuthority] = PublicKey.findProgramAddressSync([enc("mint_auth")], program.programId);
  const [treasury] = PublicKey.findProgramAddressSync([enc("treasury")], program.programId);
  const payoutVault = getAssociatedTokenAddressSync(ansemMint, vaultAuthority, true);

  const minerOf = (wallet: PublicKey) =>
    PublicKey.findProgramAddressSync([enc("miner"), wallet.toBuffer()], program.programId)[0];
  const escrowOf = (wallet: PublicKey) =>
    PublicKey.findProgramAddressSync([enc("escrow"), wallet.toBuffer()], program.programId)[0];
  const roundOf = (roundId: number) =>
    PublicKey.findProgramAddressSync(
      [enc("round"), new anchor.BN(roundId).toArrayLike(Buffer, "le", 8)],
      program.programId,
    )[0];
  const jackpotSquare = () =>
    keccak256.array([...randomness, ...Buffer.from("jackpot")])[0] % 25;

  const swapAccounts = (round: PublicKey) => ({
    payer: admin.publicKey,
    round,
    ansemMint,
    mintAuthority,
    vaultAuthority,
    payoutVault,
    potVault,
    treasury,
    tokenProgram: TOKEN_PROGRAM_ID,
  });
  const claimAccounts = (wallet: PublicKey, round: PublicKey, playerAta: PublicKey) => ({
    authority: wallet,
    config,
    round,
    miner: minerOf(wallet),
    escrow: escrowOf(wallet),
    ansemMint,
    vaultAuthority,
    payoutVault,
    playerAta,
    tokenProgram: TOKEN_PROGRAM_ID,
  });
  const claimDirectAccounts = (wallet: PublicKey, round: PublicKey, playerAta: PublicKey) => ({
    authority: wallet,
    config,
    round,
    miner: minerOf(wallet),
    ansemMint,
    vaultAuthority,
    payoutVault,
    playerAta,
    tokenProgram: TOKEN_PROGRAM_ID,
  });

  async function fundedPlayer(sol = 2): Promise<anchor.web3.Keypair> {
    const player = anchor.web3.Keypair.generate();
    const signature = await provider.connection.requestAirdrop(
      player.publicKey,
      sol * anchor.web3.LAMPORTS_PER_SOL,
    );
    await provider.connection.confirmTransaction(signature);
    return player;
  }

  async function settleAfterDeadline(round: PublicKey) {
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        await program.methods
          .settle([...randomness])
          .accounts({ admin: admin.publicKey, round })
          .rpc();
        return;
      } catch (error: any) {
        if (!error.toString().includes("RoundNotEnded")) throw error;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    throw new Error("round never became settleable");
  }

  async function freshRound(): Promise<{ id: number; pda: PublicKey }> {
    const current = await program.account.config.fetch(config);
    const id = current.currentRoundId.toNumber() + 1;
    const pda = roundOf(id);
    await program.methods.createRound().accounts({ payer: admin.publicKey, round: pda }).rpc();
    return { id, pda };
  }

  async function stakeSettleAndSwap(
    player: anchor.web3.Keypair,
    square: number,
    lamports: number,
  ): Promise<{ id: number; pda: PublicKey }> {
    const round = await freshRound();
    await program.methods
      .stakeDirect(new anchor.BN(round.id), square, new anchor.BN(lamports))
      .accounts({
        authority: player.publicKey,
        config,
        round: round.pda,
        miner: minerOf(player.publicKey),
        potVault,
      })
      .signers([player])
      .rpc();
    await settleAfterDeadline(round.pda);
    await program.methods.executeSwapMock().accounts(swapAccounts(round.pda)).rpc();
    return round;
  }

  before(async () => {
    await program.methods
      .initialize()
      .accounts({ admin: admin.publicKey, tokenProgram: TOKEN_PROGRAM_ID })
      .rpc();
    await program.methods.initJackpotConfig().accounts({ admin: admin.publicKey }).rpc();
    await program.methods
      .setRoundDuration(new anchor.BN(STAKE_WINDOW_SECS))
      .accounts({ admin: admin.publicKey })
      .rpc();
    await program.methods.setReturnBand(0, 0).accounts({ admin: admin.publicKey }).rpc();

    const seedPlayer = await fundedPlayer();
    const losingSquare = (jackpotSquare() + 1) % 25;
    await stakeSettleAndSwap(seedPlayer, losingSquare, 200_000_000);

    const seeded = await program.account.config.fetch(config);
    assert.isAbove(seeded.rolloverJackpot.toNumber(), 0, "seed round must fund rollover inventory");
  });

  async function assertSinglePayout(order: "legacy-first" | "direct-first") {
    const player = await fundedPlayer();
    const round = await stakeSettleAndSwap(player, jackpotSquare(), 100_000_000);

    // A direct staker can create the legacy escrow account with a zero deposit.
    await program.methods.deposit(new anchor.BN(0)).accounts({ authority: player.publicKey }).signers([player]).rpc();

    const playerAta = getAssociatedTokenAddressSync(ansemMint, player.publicKey);
    const legacy = await program.methods
      .claim(new anchor.BN(round.id))
      .accounts(claimAccounts(player.publicKey, round.pda, playerAta))
      .instruction();
    const direct = await program.methods
      .claimDirect(new anchor.BN(round.id))
      .accounts(claimDirectAccounts(player.publicKey, round.pda, playerAta))
      .instruction();

    const configBefore = await program.account.config.fetch(config);
    const roundBefore = await program.account.round.fetch(round.pda);
    const expected = BigInt(roundBefore.swapProceeds.toString());

    const transaction = new Transaction();
    transaction.add(...(order === "legacy-first" ? [legacy, direct] : [direct, legacy]));
    await provider.sendAndConfirm(transaction, [player]);

    const paid = (await getAccount(provider.connection, playerAta)).amount;
    const configAfter = await program.account.config.fetch(config);
    const roundAfter = await program.account.round.fetch(round.pda);
    const minerAfter = await program.account.minerPosition.fetch(minerOf(player.publicKey));

    assert.equal(paid.toString(), expected.toString(), `${order} must pay exactly once`);
    assert.equal(
      roundAfter.claimedProceeds.sub(roundBefore.claimedProceeds).toString(),
      expected.toString(),
      `${order} must record one payout`,
    );
    assert.equal(
      configBefore.ansemObligations.sub(configAfter.ansemObligations).toString(),
      expected.toString(),
      `${order} must decrement obligations once`,
    );
    assert.equal(
      minerAfter.blockStake.reduce((sum: number, value: anchor.BN) => sum + value.toNumber(), 0),
      0,
      `${order} must consume the shared stake`,
    );
  }

  it("claim then claim_direct in one transaction pays once", async () => {
    await assertSinglePayout("legacy-first");
  });

  it("claim_direct then claim in one transaction pays once", async () => {
    await assertSinglePayout("direct-first");
  });
});
