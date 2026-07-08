import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { AnsemMiner } from "../target/types/ansem_miner";
import { PublicKey } from "@solana/web3.js";
import { assert } from "chai";

const enc = (s: string) => Buffer.from(s);

// ---- CRITICAL 1 regression (join-without-stake wedge) ----
// The one-popup entry batch ALWAYS delegates the miner (entry.ts), even for a
// player who never stakes. `commit_miner`'s `round` account is seed-bound to
// `miner.round_id` (delegation.rs). Before this fix `join_round` never touched the
// miner, so a joined-but-unstaked miner kept round_id=0 -> commit_miner resolves
// roundPda(0) (ConstraintSeeds against the current round the keeper passes) ->
// the miner can never be undelegated -> the round wedges and the escrow stays
// withdraw-locked. Fix: join_round stamps miner.round_id and zeros block_stake, so
// EVERY joined miner is committable via the normal current-round path.
//
// Runs standalone against a fresh local validator (own `before`, no ER needed).
describe("join_round stamps the miner (CRIT-1 regression)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.AnsemMiner as Program<AnsemMiner>;
  const admin = provider.wallet as anchor.Wallet;

  const [configPda] = PublicKey.findProgramAddressSync([enc("config")], program.programId);
  const player = anchor.web3.Keypair.generate();
  const [escrowPda] = PublicKey.findProgramAddressSync(
    [enc("escrow"), player.publicKey.toBuffer()], program.programId);
  const [minerPda] = PublicKey.findProgramAddressSync(
    [enc("miner"), player.publicKey.toBuffer()], program.programId);
  const roundPda = (id: number) =>
    PublicKey.findProgramAddressSync(
      [enc("round"), new anchor.BN(id).toArrayLike(Buffer, "le", 8)], program.programId)[0];

  let ROUND_ID: number;

  before("initialize, fund, open a round, init the miner", async function () {
    this.timeout(60000);
    await program.methods.initialize().accounts({ admin: admin.publicKey }).rpc()
      .catch((e: any) => { if (!/already in use|custom program error: 0x0\b/i.test(String(e))) throw e; });
    const sig = await provider.connection.requestAirdrop(
      player.publicKey, 5 * anchor.web3.LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(sig, "confirmed");
    await program.methods.deposit(new anchor.BN(2 * anchor.web3.LAMPORTS_PER_SOL))
      .accounts({ authority: player.publicKey }).signers([player]).rpc();

    const cfg = await program.account.config.fetch(configPda);
    ROUND_ID = cfg.currentRoundId.toNumber() + 1;
    await program.methods.setRoundDuration(new anchor.BN(60)).accounts({ admin: admin.publicKey }).rpc();
    await program.methods.createRound()
      .accounts({ payer: admin.publicKey, round: roundPda(ROUND_ID) }).rpc();
    await program.methods.initMiner().accounts({ authority: player.publicKey }).signers([player]).rpc();

    const m0 = await program.account.minerPosition.fetch(minerPda);
    assert.equal(m0.roundId.toNumber(), 0, "sanity: a fresh miner starts at round 0");
  });

  it("stamps miner.round_id and zeros block_stake on join (no stake required)", async () => {
    await program.methods.joinRound(new anchor.BN(ROUND_ID))
      .accountsPartial({ authority: player.publicKey, config: configPda, escrow: escrowPda })
      .signers([player]).rpc();

    const m = await program.account.minerPosition.fetch(minerPda);
    assert.equal(
      m.roundId.toNumber(), ROUND_ID,
      "join_round must stamp miner.round_id so commit_miner can undelegate an unstaked miner",
    );
    assert.deepEqual(
      [...m.blockStake].map((x: any) => x.toNumber()), new Array(25).fill(0),
      "join_round must (re)zero block_stake for the new round",
    );
  });
});
