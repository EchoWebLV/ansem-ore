import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { AnsemMiner } from "../target/types/ansem_miner";
import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import { GetCommitmentSignature } from "@magicblock-labs/ephemeral-rollups-sdk";
import { getAssociatedTokenAddressSync, getAccount, TOKEN_PROGRAM_ID } from "@solana/spl-token";
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

// Send an ER tx tolerating a confirm-layer flake — mb-test-validator + the ER's
// aperture RPC can make anchor's sendAndConfirm throw a mangled "Unknown action
// 'undefined'" (getTransaction on the ER returns null, so anchor re-throws the
// raw confirm error) even though the tx LANDED. Caller confirms via state polling.
// A NON-flake error (real anchor/program error) still throws.
async function erRpcTolerant(send: () => Promise<string>): Promise<void> {
  try { await send(); }
  catch (e: any) {
    const s = String(e);
    if (!/Unknown action|not confirmed|block height exceeded|Invalid response|failed to get|timeout|Blockhash not found/i.test(s)) throw e;
  }
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
const payoutVault = getAssociatedTokenAddressSync(ansemMint, vaultAuth, true);
const playerAta = getAssociatedTokenAddressSync(ansemMint, player.publicKey);

// tokenProgram is no longer auto-resolvable (the token layer is an Interface after
// the Token-2022 conversion, commit 1ab3f46); the mock ANSEM mint is classic SPL.
const swapAccounts = () => ({
  payer: admin.publicKey, round: round1Pda, ansemMint,
  mintAuthority: mintAuth, vaultAuthority: vaultAuth, payoutVault,
  potVault: potVaultPda, treasury, tokenProgram: TOKEN_PROGRAM_ID,
});
const claimAccounts = () => ({
  authority: player.publicKey, round: round1Pda, ansemMint, vaultAuthority: vaultAuth,
  payoutVault, playerAta, tokenProgram: TOKEN_PROGRAM_ID,
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

// Settle round 1 ON THE ER while it is still delegated (production ordering for
// §3A: commit_miner requires the round to have left OPEN). Poll-retry: the ER
// clock may lag the round's L1-set deadline (RoundNotEnded), and the ER confirm
// layer can flake (see erRpcTolerant). Idempotent — returns early once SETTLED.
async function settleOnErAfterDeadline(rnd: Buffer, tries = 60): Promise<void> {
  for (let i = 0; i < tries; i++) {
    const r: any = await ephemeralProgram.account.round.fetch(round1Pda).catch(() => null);
    if (r && r.state === 2) return;
    try {
      await ephemeralProgram.methods.settle([...rnd])
        .accounts({ admin: admin.publicKey, round: round1Pda })
        .rpc({ skipPreflight: true, commitment: "confirmed" });
    } catch (e: any) {
      const s = String(e);
      if (!/RoundNotEnded|Unknown action|not confirmed|block height exceeded|Invalid response|failed to get|timeout|Blockhash not found/i.test(s)) throw e;
    }
    await sleep(1500);
  }
  throw new Error("round 1 never became settleable on the ER after polling");
}

describe("ansem-miner (ER)", () => {
  before("L1 prelude: initialize, fund player, create round 1, init miner", async () => {
    // Idempotent-ish: fresh validator each run (scripts/test-er.sh --reset).
    await program.methods.initialize().accounts({ admin: admin.publicKey, tokenProgram: TOKEN_PROGRAM_ID }).rpc();
    // Fixture (BEEF/jackpot upgrade): execute_swap_mock now reads the JackpotConfig
    // PDA (spec D6). Seed it once so the swap resolves it — defaults (1-in-25/100x)
    // run at rollover 0 in this suite, so the bite is 0 and payouts are unchanged.
    await program.methods.initJackpotConfig().accounts({ admin: admin.publicKey }).rpc();
    // 30s round: long enough to stay OPEN through delegate/join/stake/commit
    // (staking happens within the first few seconds), short enough that the e2e
    // tail can wait out the deadline to settle without a long stall.
    await program.methods.setRoundDuration(new anchor.BN(30))
      .accounts({ admin: admin.publicKey }).rpc();
    // Lottery model: pin the return band to a flat 50% so the sole staker always
    // receives a positive payout regardless of which square is the jackpot square.
    await program.methods.setReturnBand(5000, 5000).accounts({ admin: admin.publicKey }).rpc();

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
    // This is the cold ER write (clones config/escrow + references the freshly-
    // delegated round/miner) and can lag on a loaded machine, so retry
    // idempotently (check-before → never double-stakes).
    for (let i = 0; i < 6; i++) {
      const m: any = await ephemeralProgram.account.minerPosition.fetch(minerPda).catch(() => null);
      if (m && m.blockStake[STAKE_BLOCK].toString() === STAKE_AMT.toString()) break;
      await erRpcTolerant(() => ephemeralProgram.methods.stake(STAKE_BLOCK, STAKE_AMT)
        .accounts({
          authority: player.publicKey, config: configPda,
          round: round1Pda, miner: minerPda, escrow: escrowPda, sessionToken: null,
        })
        .signers([player])
        .rpc({ skipPreflight: true, commitment: "confirmed" }));
      await sleep(2000);
    }

    // ER-side: the delegated miner reflects the stake.
    const miner = await awaitEr(
      () => ephemeralProgram.account.minerPosition.fetch(minerPda),
      (m: any) => m.blockStake[STAKE_BLOCK].toString() === STAKE_AMT.toString(), 10
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

  it("task 6: settle(ER) -> commit_miner(keeper) -> commit_round (settle-before-commit, §3A)", async () => {
    // §3A NEGATIVE: committing a miner while its round is still OPEN must fail
    // (staking not closed). The round is still delegated + OPEN on the ER here.
    // commit_miner is now keeper-signable (no owner signature), so this state
    // gate is what replaces the old owner-signature griefing guard.
    let tooEarlyBlocked = false;
    try {
      await ephemeralProgram.methods.commitMiner()
        .accounts({ payer: admin.publicKey, miner: minerPda, round: round1Pda })
        .rpc({ skipPreflight: true, commitment: "confirmed" });
    } catch { tooEarlyBlocked = true; }
    assert.isTrue(tooEarlyBlocked, "commit_miner must be rejected while round is OPEN (CommitTooEarly)");

    // Settle ON THE ER while the Round is still delegated (production ordering):
    // commit_miner requires round.state != OPEN, so the round must reach SETTLED
    // on the ER (where commit_miner reads it as its gate) BEFORE we commit.
    await settleOnErAfterDeadline(Buffer.alloc(32, 7));
    const rSettled = await awaitEr(
      () => ephemeralProgram.account.round.fetch(round1Pda),
      (r: any) => r.state === 2, 20
    );
    assert.equal(rSettled.state, 2, "round SETTLED on the ER");

    // KEEPER commits the miner — NO owner signature (payer = keeper/admin). The
    // §3A gate passes now that the round is SETTLED. commit_miner runs BEFORE
    // commit_round so its read-only `round` gate account is still delegated and
    // available on the ER.
    const sigM = await ephemeralProgram.methods.commitMiner()
      .accounts({ payer: admin.publicKey, miner: minerPda, round: round1Pda })
      .rpc({ skipPreflight: true, commitment: "confirmed" });
    await GetCommitmentSignature(sigM, erConnection);
    await awaitOwnerIs(provider.connection, minerPda, program.programId.toBase58());
    const minerL1 = await program.account.minerPosition.fetch(minerPda); // our-program-owned
    assert.equal(
      minerL1.blockStake[STAKE_BLOCK].toString(), STAKE_AMT.toString(),
      "committed miner snapshot on L1"
    );

    // THEN commit_round = commit AND undelegate: the Round returns to our program
    // on L1 carrying the ER's final SETTLED state + pot. Payer is the ER fee payer
    // (admin) — a non-fee-payer writable signer would trip InvalidWritableAccount.
    const sigR = await ephemeralProgram.methods.commitRound()
      .accounts({ payer: admin.publicKey, config: configPda, round: round1Pda })
      .rpc({ skipPreflight: true, commitment: "confirmed" });
    await GetCommitmentSignature(sigR, erConnection);
    await awaitOwnerIs(provider.connection, round1Pda, program.programId.toBase58());
    const roundL1 = await program.account.round.fetch(round1Pda); // now our-program-owned
    assert.equal(roundL1.pot.toString(), STAKE_AMT.toString(), "committed pot landed on L1");
    assert.equal(roundL1.state, 2, "round SETTLED on L1 after commit");
  });

  it("task 8: e2e tail — [swap Insolvent] -> reconcile -> swap -> claim", async () => {
    // Round 1 was settled on the ER and committed+undelegated in task 6, so it
    // arrives here already SETTLED on L1 (settle-before-commit, §3A). No L1 settle.
    assert.equal((await program.account.round.fetch(round1Pda)).state, 2, "round SETTLED on L1");

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

    // Recovery step 3: refund releases the joiner's withdraw-lock. This round-2
    // player joined but was never reconciled (nobody staked/committed/reconciled
    // round 2), so refund takes the no-credit branch: lock released, balance
    // unchanged. The §3C account shape now includes config + miner (read only in
    // the reconciled branch, but Anchor still loads them).
    const escBefore = await program.account.playerEscrow.fetch(escrowPda);
    await program.methods.refund(new anchor.BN(ROUND2))
      .accounts({ authority: player.publicKey, config: configPda, round: round2Pda,
        escrow: escrowPda, miner: minerPda }).signers([player]).rpc();
    const escAfter = await program.account.playerEscrow.fetch(escrowPda);
    assert.equal(escAfter.activeRound.toNumber(), 0, "withdraw-lock released");
    assert.equal(escAfter.balance.toString(), escBefore.balance.toString(), "no credit on refund (never reconciled)");
  });
});
