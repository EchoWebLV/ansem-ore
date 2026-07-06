import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { AnsemMiner } from "../target/types/ansem_miner";
import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, getAccount } from "@solana/spl-token";
import { GetCommitmentSignature } from "@magicblock-labs/ephemeral-rollups-sdk";
import { spawn, ChildProcess } from "child_process";
import { assert } from "chai";

// ANSEM Miner — M2b ephemeral-VRF suite. SELF-CONTAINED (own round 1, fresh
// player) so it doesn't ride on the M2a sequence.
//
// ARCHITECTURE (differs from the original spec §4): VRF settle runs on L1 AFTER
// commit, not inside the ER. Settle is a once-per-round event — it doesn't need
// the ER hot path — and the local ephemeral-validator does NOT delegate the VRF
// oracle queue to itself, so an in-ER request writing that queue is rejected by
// the ER's Magic finalizer (InvalidWritableAccount) regardless of lifecycle. On
// L1 the queue is an ordinary writable account and the base oracle fulfills the
// request — the standard, proven VRF path. The ER still owns the STAKING hot
// path; only the rare settle draw is on L1. request_settle/settle_callback are
// unchanged — only WHERE they're invoked (base program, after commit) moves.
//
// The BASE vrf-oracle is spawned BY THE TEST, up only for the request→callback
// window: run during ER staking it starves the ER (4 processes, one machine) and
// makes cold-account clones flake, so we keep it down for the ER phase.

const DLP_PROGRAM_ID = "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh";
const enc = (s: string) => Buffer.from(s);
const roundSeed = (id: number) => new anchor.BN(id).toArrayLike(Buffer, "le", 8);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function awaitOwner(conn: Connection, pubkey: PublicKey, tries = 25): Promise<string> {
  for (let i = 0; i < tries; i++) {
    const acc = await conn.getAccountInfo(pubkey, "confirmed");
    if (acc) return acc.owner.toBase58();
    await sleep(300);
  }
  throw new Error(`account ${pubkey.toBase58()} not found after ${tries} tries`);
}

async function awaitOwnerIs(conn: Connection, pubkey: PublicKey, expected: string, tries = 40): Promise<void> {
  let last = "?";
  for (let i = 0; i < tries; i++) {
    const acc = await conn.getAccountInfo(pubkey, "confirmed");
    if (acc) { last = acc.owner.toBase58(); if (last === expected) return; }
    await sleep(400);
  }
  throw new Error(`owner of ${pubkey.toBase58()} = ${last}, expected ${expected}`);
}

async function awaitEr<T>(fetchFn: () => Promise<T>, pred: (v: T) => boolean, tries = 30): Promise<T> {
  let last: T | undefined;
  for (let i = 0; i < tries; i++) {
    try { last = await fetchFn(); if (pred(last)) return last; } catch (_) { /* ER read lag */ }
    await sleep(400);
  }
  throw new Error(`ER predicate not satisfied after ${tries} tries (last=${JSON.stringify(last)})`);
}

// Send an ER tx tolerating the confirm flake; caller confirms via state polling.
async function erRpcTolerant(send: () => Promise<string>): Promise<void> {
  try { await send(); }
  catch (e: any) {
    const s = String(e);
    if (!/Unknown action|not confirmed|block height exceeded|Invalid response|failed to get|timeout|Blockhash not found/i.test(s)) throw e;
  }
}

// The BASE vrf-oracle, spawned by the test, up only for the request→callback window.
let oracle: ChildProcess | undefined;
function startOracle() {
  oracle = spawn("vrf-oracle", [], {
    env: {
      ...process.env,
      VRF_ORACLE_SKIP_PREFLIGHT: "true",
      RPC_URL: process.env.PROVIDER_ENDPOINT || "http://127.0.0.1:8899",
      WEBSOCKET_URL: process.env.WS_ENDPOINT || "ws://127.0.0.1:8900",
      RUST_LOG: "info",
    },
    stdio: "ignore",
  });
}
function stopOracle() {
  if (oracle) { try { oracle.kill("SIGKILL"); } catch (_) {} oracle = undefined; }
}

const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);
const program = anchor.workspace.AnsemMiner as Program<AnsemMiner>;
const admin = provider.wallet as anchor.Wallet;

const erConnection = new Connection(
  process.env.EPHEMERAL_PROVIDER_ENDPOINT || "http://127.0.0.1:7799",
  { wsEndpoint: process.env.EPHEMERAL_WS_ENDPOINT || "ws://127.0.0.1:7800", commitment: "confirmed" }
);
const erProvider = new anchor.AnchorProvider(erConnection, anchor.Wallet.local(), { commitment: "confirmed" });
const ephemeralProgram = new Program<AnsemMiner>(program.idl, erProvider);

const VALIDATOR = new PublicKey(process.env.VALIDATOR || "mAGicPQYBMvcYveUZA5F5UNNwyHvfYh5xkLS2Fr1mev");
const validatorMeta = [{ pubkey: VALIDATOR, isSigner: false, isWritable: false }];
// The BASE oracle's queue (index 0 for the local oracle identity). On L1 it's an
// ordinary writable account. Override with VRF_BASE_QUEUE env.
const VRF_BASE_QUEUE = new PublicKey(
  process.env.VRF_BASE_QUEUE || "GKE6d7iv8kCBrsxr78W3xVdjGLLLJnxsGiuzrsZCGEvb"
);

const [configPda] = PublicKey.findProgramAddressSync([enc("config")], program.programId);
const ROUND_ID = 1;
const STAKE_BLOCK = 0;
const STAKE_AMT = new anchor.BN(0.5 * anchor.web3.LAMPORTS_PER_SOL);
const [roundPda] = PublicKey.findProgramAddressSync([enc("round"), roundSeed(ROUND_ID)], program.programId);
const player = Keypair.generate();
const [escrowPda] = PublicKey.findProgramAddressSync([enc("escrow"), player.publicKey.toBuffer()], program.programId);
const [minerPda] = PublicKey.findProgramAddressSync([enc("miner"), player.publicKey.toBuffer()], program.programId);
const [potVaultPda] = PublicKey.findProgramAddressSync([enc("pot_vault")], program.programId);
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
  payer: admin.publicKey, round: roundPda, ansemMint, mintAuthority: mintAuth,
  vaultAuthority: vaultAuth, payoutVault, smallJackpotAuthority: smallJackpotAuth,
  smallJackpotVault, bigJackpotAuthority: bigJackpotAuth, bigJackpotVault,
  potVault: potVaultPda, treasury,
});
const claimAccounts = () => ({
  authority: player.publicKey, round: roundPda, ansemMint, vaultAuthority: vaultAuth,
  smallJackpotAuthority: smallJackpotAuth, bigJackpotAuthority: bigJackpotAuth,
  payoutVault, smallJackpotVault, bigJackpotVault, playerAta,
});

describe("ansem-miner (M2b VRF)", () => {
  before("L1 prelude: initialize, fund player, create round 1, init miner", async () => {
    await program.methods.initialize().accounts({ admin: admin.publicKey }).rpc();
    await program.methods.setRoundDuration(new anchor.BN(20))
      .accounts({ admin: admin.publicKey }).rpc();
    const sig = await provider.connection.requestAirdrop(player.publicKey, 5 * anchor.web3.LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(sig, "confirmed");
    await program.methods.deposit(new anchor.BN(2 * anchor.web3.LAMPORTS_PER_SOL))
      .accounts({ authority: player.publicKey }).signers([player]).rpc();
    await program.methods.createRound().accounts({ payer: admin.publicKey, round: roundPda }).rpc();
    await program.methods.initMiner().accounts({ authority: player.publicKey }).signers([player]).rpc();
  });

  after(() => stopOracle()); // safety net if the test throws inside the oracle window

  it("stakes in the ER, then settles on L1 via ephemeral VRF (request_settle -> oracle callback -> Settled -> claim)", async function () {
    this.timeout(150000);

    // ---- ER staking phase (oracle DOWN → reliable) ----
    await program.methods.delegateRound(new anchor.BN(ROUND_ID))
      .accounts({ payer: admin.publicKey, round: roundPda })
      .remainingAccounts(validatorMeta).rpc({ skipPreflight: true, commitment: "confirmed" });
    assert.equal(await awaitOwner(provider.connection, roundPda), DLP_PROGRAM_ID);
    await program.methods.delegateMiner()
      .accounts({ payer: player.publicKey, miner: minerPda })
      .remainingAccounts(validatorMeta).signers([player])
      .rpc({ skipPreflight: true, commitment: "confirmed" });
    assert.equal(await awaitOwner(provider.connection, minerPda), DLP_PROGRAM_ID);

    await program.methods.joinRound(new anchor.BN(ROUND_ID))
      .accounts({ authority: player.publicKey, config: configPda, escrow: escrowPda })
      .signers([player]).rpc();

    // Stake on the ER. The first ER write clones config/escrow + references the
    // freshly-delegated round/miner; on one machine that can lag, so retry
    // idempotently (check-before → never double-stakes).
    for (let i = 0; i < 6; i++) {
      const m: any = await ephemeralProgram.account.minerPosition.fetch(minerPda).catch(() => null);
      if (m && m.blockStake[STAKE_BLOCK].toString() === STAKE_AMT.toString()) break;
      await erRpcTolerant(() => ephemeralProgram.methods.stake(STAKE_BLOCK, STAKE_AMT)
        .accounts({ authority: player.publicKey, config: configPda, round: roundPda, miner: minerPda, escrow: escrowPda })
        .signers([player]).rpc({ skipPreflight: true, commitment: "confirmed" }));
      await sleep(2000);
    }
    await awaitEr(
      () => ephemeralProgram.account.minerPosition.fetch(minerPda),
      (m: any) => m.blockStake[STAKE_BLOCK].toString() === STAKE_AMT.toString(), 10
    );

    // Commit round + miner back to L1 (undelegate) — settle happens on L1.
    await erRpcTolerant(() => ephemeralProgram.methods.commitRound()
      .accounts({ payer: admin.publicKey, config: configPda, round: roundPda })
      .rpc({ skipPreflight: true, commitment: "confirmed" }));
    await awaitOwnerIs(provider.connection, roundPda, program.programId.toBase58());
    await erRpcTolerant(() => ephemeralProgram.methods.commitMiner()
      .accounts({ payer: admin.publicKey, authority: player.publicKey, miner: minerPda })
      .signers([player]).rpc({ skipPreflight: true, commitment: "confirmed" }));
    await awaitOwnerIs(provider.connection, minerPda, program.programId.toBase58());

    // Round is back on L1, still OPEN, with the ER's committed pot.
    const roundOpen = await program.account.round.fetch(roundPda);
    assert.equal(roundOpen.state, 0, "committed round is OPEN on L1");
    assert.equal(roundOpen.pot.toString(), STAKE_AMT.toString(), "committed pot landed on L1");

    // Wait out the deadline on L1.
    await awaitEr(
      () => program.account.round.fetch(roundPda),
      (r: any) => Date.now() / 1000 >= r.deadlineTs.toNumber(), 60
    );

    // ---- VRF settle phase (BASE oracle UP only here) ----
    let settled: any;
    try {
      startOracle();
      await sleep(4000); // let the base oracle subscribe

      // Diagnostic (oracle up): simulate surfaces a real CPI/program failure with logs.
      try {
        await program.methods.requestSettle(7)
          .accounts({ payer: admin.publicKey, round: roundPda, config: configPda, oracleQueue: VRF_BASE_QUEUE })
          .simulate({ commitment: "processed" });
        console.log("   request_settle simulate: OK");
      } catch (e: any) {
        const logs = e?.simulationResponse?.logs || e?.logs;
        console.log("   request_settle SIMULATE logs:\n" + (logs ? logs.join("\n") : String(e)).slice(0, 1500));
      }

      // Idempotent request on L1: re-send until the round leaves OPEN.
      for (let i = 0; i < 6; i++) {
        const r: any = await program.account.round.fetch(roundPda).catch(() => null);
        console.log(`   request attempt ${i}: round.state=${r ? r.state : "?"}`);
        if (r && r.state !== 0) break;
        try {
          await program.methods.requestSettle(7)
            .accounts({ payer: admin.publicKey, round: roundPda, config: configPda, oracleQueue: VRF_BASE_QUEUE })
            .rpc({ skipPreflight: true, commitment: "confirmed" });
        } catch (e: any) {
          if (!/BadRoundState/.test(String(e))) console.log("   request_settle send error:", String(e).slice(0, 300));
        }
        await sleep(2000);
      }
      const advanced: any = await awaitEr(
        () => program.account.round.fetch(roundPda),
        (r: any) => r.state === 1 || r.state === 2, 20
      );
      console.log(`   round advanced to state=${advanced.state} (1=VrfPending, 2=Settled)`);

      // The base oracle fulfills → settle_callback flips the round to Settled(2).
      settled = await awaitEr(
        () => program.account.round.fetch(roundPda),
        (r: any) => r.state === 2, 120
      );
    } finally {
      stopOracle();
    }
    assert.notDeepEqual(
      [...settled.randomness], new Array(32).fill(0),
      "VRF-drawn randomness must be nonzero (the oracle actually fulfilled)"
    );

    // ---- L1 tail: reconcile → swap → claim ----
    await program.methods.reconcileMiner(new anchor.BN(ROUND_ID))
      .accounts({ config: configPda, escrow: escrowPda, miner: minerPda })
      .rpc({ skipPreflight: true, commitment: "confirmed" });
    await program.methods.executeSwapMock().accounts(swapAccounts()).rpc();
    assert.equal((await program.account.round.fetch(roundPda)).state, 4, "round CLAIMABLE");
    await program.methods.claim(new anchor.BN(ROUND_ID)).accounts(claimAccounts()).signers([player]).rpc();
    const ata = await getAccount(provider.connection, playerAta);
    assert.isAbove(Number(ata.amount), 0, "player mined ANSEM via the VRF-settled round");
  });

  it("recovers a VrfPending round the oracle never fulfilled (request_settle -> cancel -> refund)", async function () {
    this.timeout(60000);
    // Round 1 is Claimable (previous test), so a new round may open. No oracle is
    // running here — request_settle posts to the queue and the round is stuck in
    // VrfPending, which the M2b liveness fix makes cancelable.
    // Guarantee NO oracle fulfills round 2 — test 1's base oracle must be dead, or
    // it would settle this request too (defeating the "never fulfilled" scenario).
    stopOracle();
    await new Promise<void>((res) => {
      const p = spawn("pkill", ["-9", "-f", "vrf-oracle"], { stdio: "ignore" });
      p.on("close", () => res()); p.on("error", () => res());
    });
    await sleep(2500);

    const ROUND2 = 2;
    const [round2Pda] = PublicKey.findProgramAddressSync([enc("round"), roundSeed(ROUND2)], program.programId);
    await program.methods.setRoundDuration(new anchor.BN(3)).accounts({ admin: admin.publicKey }).rpc();
    await program.methods.createRound().accounts({ payer: admin.publicKey, round: round2Pda }).rpc();

    // Player joins (holds a withdraw-lock) but never stakes.
    await program.methods.joinRound(new anchor.BN(ROUND2))
      .accounts({ authority: player.publicKey, config: configPda, escrow: escrowPda })
      .signers([player]).rpc();

    // request_settle on L1 posts the VRF request → VrfPending. Poll past the
    // deadline; idempotent (check state first) + tolerate the confirm-layer flake.
    for (let i = 0; i < 20; i++) {
      const r: any = await program.account.round.fetch(round2Pda).catch(() => null);
      if (r && r.state !== 0) break; // VrfPending (or beyond) reached
      try {
        await program.methods.requestSettle(9)
          .accounts({ payer: admin.publicKey, round: round2Pda, config: configPda, oracleQueue: VRF_BASE_QUEUE })
          .rpc({ skipPreflight: true, commitment: "confirmed" });
      } catch (e: any) {
        const s = String(e);
        if (!/RoundNotEnded|Unknown action|not confirmed|block height|Blockhash not found|BadRoundState/i.test(s)) throw e;
      }
      await sleep(1000);
    }
    await awaitEr(() => program.account.round.fetch(round2Pda), (r: any) => r.state === 1, 15);
    assert.equal((await program.account.round.fetch(round2Pda)).state, 1, "round is stuck in VrfPending");

    // The fix: cancel_round now accepts a past-deadline VrfPending round → Closed.
    await program.methods.cancelRound().accounts({ admin: admin.publicKey, round: round2Pda }).rpc();
    assert.equal((await program.account.round.fetch(round2Pda)).state, 5, "VrfPending round cancels to Closed");

    // The joined-but-unstaked player releases their withdraw-lock (no credit — the
    // round was never reconciled, so nothing was debited).
    const escBefore = await program.account.playerEscrow.fetch(escrowPda);
    await program.methods.refund(new anchor.BN(ROUND2))
      .accounts({ authority: player.publicKey, round: round2Pda }).signers([player]).rpc();
    const escAfter = await program.account.playerEscrow.fetch(escrowPda);
    assert.equal(escAfter.activeRound.toNumber(), 0, "withdraw-lock released");
    assert.equal(escAfter.balance.toString(), escBefore.balance.toString(), "no credit on refund");
  });
});
