import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { AnsemMiner } from "../target/types/ansem_miner";
import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import { assert } from "chai";

// ANSEM Miner — Ephemeral Rollup integration suite (M2a).
//
// Runs against the two-provider local stack from scripts/test-er.sh:
//   base layer  : mb-test-validator @ http://127.0.0.1:8899  (our program + DLP)
//   ephemeral   : ephemeral-validator @ http://127.0.0.1:7799 (the ER)
//
// Tasks: 0 smoke, 2 delegate_round, 3 delegate_miner. (join/stake/commit/
// reconcile/e2e appended by later M2a tasks.)

const BPF_LOADER_UPGRADEABLE = "BPFLoaderUpgradeab1e11111111111111111111111";
const DLP_PROGRAM_ID = "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh";
const enc = (s: string) => Buffer.from(s);
const roundSeed = (id: number) =>
  new anchor.BN(id).toArrayLike(Buffer, "le", 8);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// mb-test-validator confirms but never finalizes (Finalized Slot stays 0) and
// has a read-your-writes lag at "confirmed" — an account can read null for a
// moment right after a confirmed write. Poll until it resolves.
async function awaitOwner(
  conn: Connection, pubkey: PublicKey, tries = 25
): Promise<string> {
  for (let i = 0; i < tries; i++) {
    const acc = await conn.getAccountInfo(pubkey, "confirmed");
    if (acc) return acc.owner.toBase58();
    await sleep(300);
  }
  throw new Error(`account ${pubkey.toBase58()} not found after ${tries} tries`);
}

// Base-layer (L1) provider + program — from ANCHOR_PROVIDER_URL/ANCHOR_WALLET.
const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);
const program = anchor.workspace.AnsemMiner as Program<AnsemMiner>;
const admin = provider.wallet as anchor.Wallet;

// Ephemeral-rollup provider — same wallet, different endpoint.
const erConnection = new Connection(
  process.env.EPHEMERAL_PROVIDER_ENDPOINT || "http://127.0.0.1:7799",
  {
    wsEndpoint: process.env.EPHEMERAL_WS_ENDPOINT || "ws://127.0.0.1:7800",
    commitment: "confirmed",
  }
);
const erProvider = new anchor.AnchorProvider(erConnection, anchor.Wallet.local(), {
  commitment: "confirmed",
});
const ephemeralProgram = new Program<AnsemMiner>(program.idl, erProvider);

// Local ER validator identity — delegated accounts are pinned to it.
const VALIDATOR = new PublicKey(
  process.env.VALIDATOR || "mAGicPQYBMvcYveUZA5F5UNNwyHvfYh5xkLS2Fr1mev"
);
const validatorMeta = [{ pubkey: VALIDATOR, isSigner: false, isWritable: false }];

const [configPda] = PublicKey.findProgramAddressSync([enc("config")], program.programId);

// Shared lifecycle state for the incremental (round 1) tests.
const ROUND_ID = 1;
const [round1Pda] = PublicKey.findProgramAddressSync(
  [enc("round"), roundSeed(ROUND_ID)],
  program.programId
);
const player = Keypair.generate();
const [escrowPda] = PublicKey.findProgramAddressSync(
  [enc("escrow"), player.publicKey.toBuffer()],
  program.programId
);
const [minerPda] = PublicKey.findProgramAddressSync(
  [enc("miner"), player.publicKey.toBuffer()],
  program.programId
);
const [potVaultPda] = PublicKey.findProgramAddressSync(
  [enc("pot_vault")],
  program.programId
);

describe("ansem-miner (ER)", () => {
  before("L1 prelude: initialize, fund player, create round 1, init miner", async () => {
    // Idempotent-ish: fresh validator each run (scripts/test-er.sh --reset).
    await program.methods.initialize().accounts({ admin: admin.publicKey }).rpc();
    // 120s round so it stays OPEN through ER staking in later tasks.
    await program.methods.setRoundDuration(new anchor.BN(120))
      .accounts({ admin: admin.publicKey }).rpc();

    const sig = await provider.connection.requestAirdrop(
      player.publicKey, 5 * anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(sig, "confirmed");
    await program.methods.deposit(new anchor.BN(2 * anchor.web3.LAMPORTS_PER_SOL))
      .accounts({ authority: player.publicKey }).signers([player]).rpc();

    await program.methods.createRound()
      .accounts({ payer: admin.publicKey, round: round1Pda }).rpc();
    await program.methods.initMiner()
      .accounts({ authority: player.publicKey }).signers([player]).rpc();
  });

  it("smoke: two-provider stack is up (program + DLP on base, ER RPC live)", async () => {
    const prog = await provider.connection.getAccountInfo(program.programId, "confirmed");
    assert.isNotNull(prog, "our program must be present on the base validator");
    assert.equal(prog!.owner.toBase58(), BPF_LOADER_UPGRADEABLE);
    assert.isTrue(prog!.executable);

    const dlp = await provider.connection.getAccountInfo(new PublicKey(DLP_PROGRAM_ID), "confirmed");
    assert.isNotNull(dlp, "DLP must be cloned onto the base validator");

    const v: any = await erConnection.getVersion();
    assert.property(v, "magicblock-core");
    assert.notEqual(provider.connection.rpcEndpoint, erConnection.rpcEndpoint);
  });

  it("task 2: delegate_round hands round 1 to the DLP (owner -> DLP)", async () => {
    // skipPreflight avoids mb-test-validator's "Blockhash not found" preflight race.
    await program.methods.delegateRound(new anchor.BN(ROUND_ID))
      .accounts({ payer: admin.publicKey, round: round1Pda })
      .remainingAccounts(validatorMeta)
      .rpc({ skipPreflight: true, commitment: "confirmed" });

    assert.equal(
      await awaitOwner(provider.connection, round1Pda), DLP_PROGRAM_ID,
      "round should be owned by the delegation program"
    );
  });

  it("task 3: delegate_miner hands the persistent miner to the DLP (owner -> DLP)", async () => {
    await program.methods.delegateMiner()
      .accounts({ payer: player.publicKey, miner: minerPda })
      .remainingAccounts(validatorMeta)
      .signers([player])
      .rpc({ skipPreflight: true, commitment: "confirmed" });

    assert.equal(
      await awaitOwner(provider.connection, minerPda), DLP_PROGRAM_ID,
      "miner should be owned by the delegation program"
    );
  });

  it("task 4: join_round locks the escrow against withdrawal (no debit)", async () => {
    const before = await program.account.playerEscrow.fetch(escrowPda);
    assert.equal(before.activeRound.toNumber(), 0, "precondition: not yet joined");

    await program.methods.joinRound(new anchor.BN(ROUND_ID))
      .accounts({ authority: player.publicKey, config: configPda, escrow: escrowPda })
      .signers([player]).rpc();

    const after = await program.account.playerEscrow.fetch(escrowPda);
    assert.equal(after.activeRound.toNumber(), ROUND_ID, "escrow locked to this round");
    assert.equal(
      after.balance.toString(), before.balance.toString(),
      "join_round must NOT debit escrow (debit is relocated to reconcile_miner)"
    );

    // withdraw is now locked by the active_round guard.
    let withdrawFailed = false;
    try {
      await program.methods.withdraw(new anchor.BN(1))
        .accounts({
          authority: player.publicKey, config: configPda,
          escrow: escrowPda, potVault: potVaultPda,
        })
        .signers([player]).rpc();
    } catch (e) {
      withdrawFailed = /WithdrawLocked/.test(e.toString());
    }
    assert.isTrue(withdrawFailed, "withdraw must be locked while joined to a round");
  });
});
