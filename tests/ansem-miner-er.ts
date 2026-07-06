import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { AnsemMiner } from "../target/types/ansem_miner";
import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import { GetCommitmentSignature } from "@magicblock-labs/ephemeral-rollups-sdk";
import { getAssociatedTokenAddressSync, getAccount } from "@solana/spl-token";
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

// Poll until an account's owner equals `expected` (commit/undelegate flush to
// the base layer lags the ER tx).
async function awaitOwnerIs(
  conn: Connection, pubkey: PublicKey, expected: string, tries = 40
): Promise<void> {
  let last = "?";
  for (let i = 0; i < tries; i++) {
    const acc = await conn.getAccountInfo(pubkey, "confirmed");
    if (acc) { last = acc.owner.toBase58(); if (last === expected) return; }
    await sleep(400);
  }
  throw new Error(`owner of ${pubkey.toBase58()} = ${last}, expected ${expected}`);
}

// Poll an ER-side account fetch until `pred` holds (handles ER read lag right
// after a confirmed ER write).
async function awaitEr<T>(
  fetchFn: () => Promise<T>, pred: (v: T) => boolean, tries = 25
): Promise<T> {
  let last: T | undefined;
  for (let i = 0; i < tries; i++) {
    try {
      last = await fetchFn();
      if (pred(last)) return last;
    } catch (_) { /* account may not be readable on the ER yet */ }
    await sleep(300);
  }
  throw new Error(`ER predicate not satisfied after ${tries} tries (last=${JSON.stringify(last)})`);
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
const STAKE_BLOCK = 0;
const STAKE_AMT = new anchor.BN(0.5 * anchor.web3.LAMPORTS_PER_SOL);
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

// Settle / swap / claim PDAs (mirrors tests/ansem-miner.ts) for the e2e tail.
const [ansemMint] = PublicKey.findProgramAddressSync([enc("ansem_mint")], program.programId);
const [vaultAuth] = PublicKey.findProgramAddressSync([enc("vault_auth")], program.programId);
const [mintAuth] = PublicKey.findProgramAddressSync([enc("mint_auth")], program.programId);
const [treasury] = PublicKey.findProgramAddressSync([enc("treasury")], program.programId);
const [smallJackpotAuth] = PublicKey.findProgramAddressSync([enc("jackpot_sm_auth")], program.programId);
const [bigJackpotAuth] = PublicKey.findProgramAddressSync([enc("jackpot_big_auth")], program.programId);
const payoutVault = getAssociatedTokenAddressSync(ansemMint, vaultAuth, true);
const smallJackpotVault = getAssociatedTokenAddressSync(ansemMint, smallJackpotAuth, true);
const bigJackpotVault = getAssociatedTokenAddressSync(ansemMint, bigJackpotAuth, true);
const playerAta = getAssociatedTokenAddressSync(ansemMint, player.publicKey);

const swapAccounts = () => ({
  payer: admin.publicKey, round: round1Pda, ansemMint,
  mintAuthority: mintAuth, vaultAuthority: vaultAuth, payoutVault,
  smallJackpotAuthority: smallJackpotAuth, smallJackpotVault,
  bigJackpotAuthority: bigJackpotAuth, bigJackpotVault,
  potVault: potVaultPda, treasury,
});
const claimAccounts = () => ({
  authority: player.publicKey, round: round1Pda, ansemMint, vaultAuthority: vaultAuth,
  smallJackpotAuthority: smallJackpotAuth, bigJackpotAuthority: bigJackpotAuth,
  payoutVault, smallJackpotVault, bigJackpotVault, playerAta,
});

// Settle round 1 once its (undelegated, on-L1) deadline passes — poll the
// on-chain check rather than trusting a wall-clock sleep (validator clock lag).
async function settleAfterDeadline(rnd: Buffer, tries = 40): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try {
      await program.methods.settle([...rnd])
        .accounts({ admin: admin.publicKey, round: round1Pda }).rpc();
      return;
    } catch (e: any) {
      if (!e.toString().includes("RoundNotEnded")) throw e;
      await sleep(1500);
    }
  }
  throw new Error("round 1 never became settleable after polling");
}

describe("ansem-miner (ER)", () => {
  before("L1 prelude: initialize, fund player, create round 1, init miner", async () => {
    // Idempotent-ish: fresh validator each run (scripts/test-er.sh --reset).
    await program.methods.initialize().accounts({ admin: admin.publicKey }).rpc();
    // 30s round: long enough to stay OPEN through delegate/join/stake/commit
    // (staking happens within the first few seconds), short enough that the e2e
    // tail can wait out the deadline to settle without a long stall.
    await program.methods.setRoundDuration(new anchor.BN(30))
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

  it("task 5: stake runs on the ER (delegated round/miner updated; L1 escrow untouched)", async () => {
    const escrowBefore = await program.account.playerEscrow.fetch(escrowPda); // L1

    // First real ER transaction: player stakes into the delegated round/miner.
    await ephemeralProgram.methods.stake(STAKE_BLOCK, STAKE_AMT)
      .accounts({
        authority: player.publicKey, config: configPda,
        round: round1Pda, miner: minerPda, escrow: escrowPda,
      })
      .signers([player])
      .rpc({ skipPreflight: true, commitment: "confirmed" });

    // ER-side: the delegated miner reflects the stake.
    const miner = await awaitEr(
      () => ephemeralProgram.account.minerPosition.fetch(minerPda),
      (m: any) => m.blockStake[STAKE_BLOCK].toString() === STAKE_AMT.toString()
    );
    assert.equal(miner.roundId.toNumber(), ROUND_ID, "miner tagged to this round");

    // ER-side: the delegated round pot grew by the stake.
    const round = await ephemeralProgram.account.round.fetch(round1Pda);
    assert.equal(round.pot.toString(), STAKE_AMT.toString(), "round pot == stake");
    assert.equal(round.blockSol[STAKE_BLOCK].toString(), STAKE_AMT.toString());

    // L1-side: escrow balance is UNTOUCHED (debit relocated to reconcile_miner).
    const escrowAfter = await program.account.playerEscrow.fetch(escrowPda);
    assert.equal(
      escrowAfter.balance.toString(), escrowBefore.balance.toString(),
      "ER stake must not debit L1 escrow"
    );
  });

  it("task 6: commit_round + commit_miner both commit-and-undelegate back to L1", async () => {
    // commit_round = commit AND undelegate: Round returns to our program on L1
    // (writable again) carrying the ER's final pot. Payer is the ER fee payer
    // (admin) — a non-fee-payer writable signer would trip InvalidWritableAccount.
    const sigR = await ephemeralProgram.methods.commitRound()
      .accounts({ payer: admin.publicKey, config: configPda, round: round1Pda })
      .rpc({ skipPreflight: true, commitment: "confirmed" });
    await GetCommitmentSignature(sigR, erConnection);

    await awaitOwnerIs(provider.connection, round1Pda, program.programId.toBase58());
    const roundL1 = await program.account.round.fetch(round1Pda); // now our-program-owned
    assert.equal(roundL1.pot.toString(), STAKE_AMT.toString(), "committed pot landed on L1");

    // SECURITY REGRESSION: an attacker must NOT be able to commit the victim's
    // miner (the miner PDA is derived from the authority *signer*, so a wrong
    // signer fails ConstraintSeeds). Without the authority check this force-
    // commit would truncate the victim's staking mid-round.
    const attacker = Keypair.generate();
    let griefBlocked = false;
    try {
      await ephemeralProgram.methods.commitMiner()
        .accounts({ payer: admin.publicKey, authority: attacker.publicKey, miner: minerPda })
        .signers([attacker])
        .rpc({ skipPreflight: true, commitment: "confirmed" });
    } catch { griefBlocked = true; }
    assert.isTrue(griefBlocked, "attacker must not commit a victim's miner");

    // commit_miner = commit AND undelegate: the block_stake snapshot flushes to
    // L1 and the miner returns to our program (so reconcile_miner/claim can read
    // it as a normal Account). Authorized by the miner owner (player). It is
    // re-delegated next round.
    const sigM = await ephemeralProgram.methods.commitMiner()
      .accounts({ payer: admin.publicKey, authority: player.publicKey, miner: minerPda })
      .signers([player])
      .rpc({ skipPreflight: true, commitment: "confirmed" });
    await GetCommitmentSignature(sigM, erConnection);

    await awaitOwnerIs(provider.connection, minerPda, program.programId.toBase58());
    const minerL1 = await program.account.minerPosition.fetch(minerPda); // our-program-owned
    assert.equal(
      minerL1.blockStake[STAKE_BLOCK].toString(), STAKE_AMT.toString(),
      "committed miner snapshot on L1"
    );
  });

  it("task 8: e2e tail — settle -> [swap Insolvent] -> reconcile -> swap -> claim", async () => {
    // Round 1 is committed+undelegated (task 6) and still OPEN on L1. Settle it
    // once its deadline passes (M1 admin-injected randomness; real VRF is M2b).
    await settleAfterDeadline(Buffer.alloc(32, 7));
    assert.equal((await program.account.round.fetch(round1Pda)).state, 2, "round SETTLED");

    // SOLVENCY GATE: swapping BEFORE reconcile must fail Insolvent —
    // total_escrow_balance still counts the staked lamports as idle while
    // round.pot also claims them, so pot_vault can't cover both.
    let insolvent = false;
    try {
      await program.methods.executeSwapMock().accounts(swapAccounts()).rpc();
    } catch (e: any) {
      insolvent = /Insolvent/.test(e.toString());
    }
    assert.isTrue(insolvent, "pre-reconcile swap must fail Insolvent (the solvency gate)");

    // reconcile_miner reads the committed (DLP-owned) miner snapshot and debits
    // escrow — this is the real ER-flow exercise of the UncheckedAccount read.
    const cfgBefore = await program.account.config.fetch(configPda);
    const escBefore = await program.account.playerEscrow.fetch(escrowPda);
    await program.methods.reconcileMiner(new anchor.BN(ROUND_ID))
      .accounts({ config: configPda, escrow: escrowPda, miner: minerPda })
      .rpc({ skipPreflight: true, commitment: "confirmed" });
    const cfgAfter = await program.account.config.fetch(configPda);
    const escAfter = await program.account.playerEscrow.fetch(escrowPda);
    assert.equal(
      escBefore.balance.sub(escAfter.balance).toString(), STAKE_AMT.toString(),
      "escrow debited by the committed block_stake"
    );
    assert.equal(
      cfgBefore.totalEscrowBalance.sub(cfgAfter.totalEscrowBalance).toString(), STAKE_AMT.toString()
    );
    assert.equal(escAfter.activeRound.toNumber(), 0, "withdraw-lock released");

    // Now solvent: the swap succeeds and the round becomes Claimable.
    await program.methods.executeSwapMock().accounts(swapAccounts()).rpc();
    assert.equal((await program.account.round.fetch(round1Pda)).state, 4, "round CLAIMABLE");

    // Sole staker claims the full ANSEM proceeds.
    await program.methods.claim(new anchor.BN(ROUND_ID))
      .accounts(claimAccounts()).signers([player]).rpc();
    const ata = await getAccount(provider.connection, playerAta);
    assert.isAbove(Number(ata.amount), 0, "player received ANSEM proceeds");
  });

  it("task 9: recovers an abandoned DELEGATED round (commit-undelegate -> cancel -> refund)", async () => {
    // Round 1 is finalized (Claimable), so a new round may open. Create round 2
    // with a short window and delegate it — then abandon it (nobody stakes or
    // commits). A delegated round can't be cancelled purely from L1 (L1 can't
    // act on a DLP-owned account), so the documented recovery path is: admin
    // force-commits it on the ER (undelegate back to L1) -> L1 cancel_round ->
    // the joiner refunds to release their withdraw-lock.
    const ROUND2 = 2;
    const [round2Pda] = PublicKey.findProgramAddressSync(
      [enc("round"), roundSeed(ROUND2)], program.programId);
    await program.methods.setRoundDuration(new anchor.BN(4))
      .accounts({ admin: admin.publicKey }).rpc();
    await program.methods.createRound()
      .accounts({ payer: admin.publicKey, round: round2Pda }).rpc();
    await program.methods.delegateRound(new anchor.BN(ROUND2))
      .accounts({ payer: admin.publicKey, round: round2Pda })
      .remainingAccounts(validatorMeta)
      .rpc({ skipPreflight: true, commitment: "confirmed" });
    assert.equal(await awaitOwner(provider.connection, round2Pda), DLP_PROGRAM_ID);

    // player (escrow unlocked after claiming round 1) joins, then it's abandoned.
    await program.methods.joinRound(new anchor.BN(ROUND2))
      .accounts({ authority: player.publicKey, config: configPda, escrow: escrowPda })
      .signers([player]).rpc();
    assert.equal((await program.account.playerEscrow.fetch(escrowPda)).activeRound.toNumber(), ROUND2);

    // Recovery step 1: admin force-commits on the ER -> round 2 undelegates to L1.
    const sig = await ephemeralProgram.methods.commitRound()
      .accounts({ payer: admin.publicKey, config: configPda, round: round2Pda })
      .rpc({ skipPreflight: true, commitment: "confirmed" });
    await GetCommitmentSignature(sig, erConnection);
    await awaitOwnerIs(provider.connection, round2Pda, program.programId.toBase58());

    // Recovery step 2: L1 cancel_round (Open + past deadline -> Closed). The
    // ~commit round-trip already outlasts the 4s window; poll for clock lag.
    let closed = false;
    for (let i = 0; i < 20 && !closed; i++) {
      try {
        await program.methods.cancelRound()
          .accounts({ admin: admin.publicKey, round: round2Pda }).rpc();
        closed = true;
      } catch (e: any) {
        if (!e.toString().includes("RoundNotCancelable")) throw e;
        await sleep(1000);
      }
    }
    assert.isTrue(closed, "abandoned round 2 should cancel after its deadline");
    assert.equal((await program.account.round.fetch(round2Pda)).state, 5, "round CLOSED");

    // Recovery step 3: refund releases the joiner's withdraw-lock (no credit —
    // the round was never reconciled, so nothing was ever debited).
    const escBefore = await program.account.playerEscrow.fetch(escrowPda);
    await program.methods.refund(new anchor.BN(ROUND2))
      .accounts({ authority: player.publicKey, round: round2Pda }).signers([player]).rpc();
    const escAfter = await program.account.playerEscrow.fetch(escrowPda);
    assert.equal(escAfter.activeRound.toNumber(), 0, "withdraw-lock released");
    assert.equal(escAfter.balance.toString(), escBefore.balance.toString(), "no credit on refund");
  });
});
