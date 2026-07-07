import { describe, it, expect } from "vitest";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { getAccount } from "@solana/spl-token";
import * as anchor from "@coral-xyz/anchor";
import { Wallet } from "@coral-xyz/anchor";
import { SessionTokenManager } from "@magicblock-labs/gum-sdk";
import {
  createProgram, createErProgram, configPda, roundPda, minerPda, playerAta,
  fetchConfig, fetchRound, RoundState, DLP_PROGRAM_ID, PROGRAM_ID,
  depositIx, initMinerIx, joinRoundIx, delegateMinerIx, stakeIx, claimIx,
  awaitOwnerIs, awaitEr, erRpcTolerant, l1Send, sleep,
} from "@ansem/sdk";
import { loadKeeperConfig, fsLoadKeypair } from "../src/env.js";
import { createService } from "../src/service.js";
import { makeLogger } from "../src/logger.js";

const RUN = process.env.KEEPER_DEVNET_IT === "1";
const d = RUN ? describe : describe.skip;

d("keeper drives a full hands-off devnet round (M4a verify)", () => {
  it("opens -> gasless session stake -> keeper settles+swaps -> scripted claim; snapshot reflects it", async () => {
    // Requires `source scripts/devnet-env.sh` first (ANCHOR_PROVIDER_URL, DEVNET_WALLET, ER endpoints).
    const cfg = loadKeeperConfig(process.env, fsLoadKeypair);
    const log = makeLogger();
    const step = (msg: string, fields?: Record<string, unknown>) => log.info(`[player] ${msg}`, fields);

    // 180s round: the keeper is Idle during the OPEN window (settles only at the
    // deadline), so the scripted player has the full duration to onboard+stake.
    const service = createService({ ...cfg, roundDurationSecs: 180, httpPort: 0 }, log);
    // start() runs the crank loop forever (while running) and never resolves, so
    // fire-and-forget it (like main.ts) and let the player flow run concurrently.
    void service.start().catch((e) => log.error("keeper start failed", { err: String(e) }));
    try {
      const conn = new Connection(cfg.rpcUrl, { commitment: "confirmed" });
      const program = createProgram(conn, new Wallet(cfg.adminKeypair));
      const erConn = new Connection(cfg.erEndpoint, { wsEndpoint: cfg.erWsEndpoint, commitment: "confirmed" });
      const erAdminProgram = createErProgram(erConn, new Wallet(cfg.adminKeypair));

      // Target ANY currently-OPEN round with enough runway to onboard+stake. While
      // the round is delegated its live deadline is in the ER, so read from the
      // right cluster by ownership (no need to wait through a full cleanup cycle).
      step("searching for an OPEN round with >120s runway...");
      let roundId = 0;
      for (let i = 0; i < 200; i++) {
        const c = await fetchConfig(program, configPda()).catch(() => null);
        if (c && !c.currentRoundFinalized && c.currentRoundId > 0) {
          const rpda = roundPda(c.currentRoundId);
          const info = await conn.getAccountInfo(rpda, "confirmed").catch(() => null);
          if (info) {
            const delegated = info.owner.toBase58() === DLP_PROGRAM_ID.toBase58();
            const r = await fetchRound(delegated ? erAdminProgram : program, rpda).catch(() => null);
            const nowS = Math.floor(Date.now() / 1000);
            if (r && r.state === RoundState.Open && r.deadlineTs - nowS > 120) {
              roundId = c.currentRoundId;
              step("locked onto round", { roundId, runwaySec: r.deadlineTs - nowS, delegated });
              break;
            }
          }
        }
        await sleep(3000);
      }
      if (!roundId) throw new Error("keeper did not present an OPEN round with runway in time");
      await awaitOwnerIs(conn, roundPda(roundId), DLP_PROGRAM_ID.toBase58());

      // Scripted player: fund -> deposit -> init_miner -> session mint -> join -> delegate -> ER session stake.
      const player = Keypair.generate();
      step("funding player", { player: player.publicKey.toBase58() });
      await program.provider.sendAndConfirm!(
        new Transaction().add(SystemProgram.transfer({
          fromPubkey: cfg.adminKeypair.publicKey, toPubkey: player.publicKey, lamports: 0.1 * LAMPORTS_PER_SOL,
        })));
      const pProgram = createProgram(conn, new Wallet(player));
      const pErProgram = createErProgram(erConn, new Wallet(player));
      step("deposit");
      await l1Send(() => depositIx(pProgram, player.publicKey, new anchor.BN(0.05 * LAMPORTS_PER_SOL)).signers([player]).rpc());
      step("init_miner");
      await initMinerIx(pProgram, player.publicKey).signers([player]).rpc().catch(() => {});

      step("session mint");
      const gum = new SessionTokenManager(new Wallet(player), conn).program;
      const sessionKp = Keypair.generate();
      const [tokenPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("session_token_v2"), PROGRAM_ID.toBuffer(), sessionKp.publicKey.toBuffer(), player.publicKey.toBuffer()],
        gum.programId);
      await l1Send(() => gum.methods.createSessionV2(false, new anchor.BN(Math.floor(Date.now() / 1000) + 3600), null)
        .accountsPartial({ sessionToken: tokenPda, sessionSigner: sessionKp.publicKey, feePayer: player.publicKey, authority: player.publicKey, targetProgram: PROGRAM_ID })
        .signers([sessionKp]).rpc());

      step("join_round", { roundId });
      await l1Send(() => joinRoundIx(pProgram, player.publicKey, roundId).signers([player]).rpc());
      step("delegate_miner");
      await l1Send(() => delegateMinerIx(pProgram, player.publicKey, cfg.validator)
        .signers([player]).rpc({ skipPreflight: true, commitment: "confirmed" }));
      await awaitOwnerIs(conn, minerPda(player.publicKey), DLP_PROGRAM_ID.toBase58());

      step("ER session stake (gasless)");
      const STAKE = new anchor.BN(0.02 * LAMPORTS_PER_SOL);
      for (let i = 0; i < 12; i++) {
        const m: any = await pErProgram.account.minerPosition.fetch(minerPda(player.publicKey)).catch(() => null);
        if (m && m.blockStake[0].toString() === STAKE.toString()) break;
        await erRpcTolerant(() => stakeIx(pErProgram, sessionKp.publicKey, player.publicKey, 0, STAKE, roundId, tokenPda)
          .signers([sessionKp]).rpc({ skipPreflight: true, commitment: "confirmed" }));
        await sleep(2500);
      }
      const staked = await awaitEr(
        () => pErProgram.account.minerPosition.fetch(minerPda(player.publicKey)) as any,
        (m: any) => m.blockStake[0].toString() === STAKE.toString(), 20, 2000);
      expect(staked.blockStake[0].toString()).toBe(STAKE.toString());
      step("stake landed in the ER (wallet never signed it)");

      // The keeper (no UI) now commits + settles + reconciles + swaps hands-off. Wait for CLAIMABLE.
      step("waiting for the keeper to drive the round to CLAIMABLE...");
      const claimable = await awaitEr(
        () => fetchRound(program, roundPda(roundId)),
        (r) => r.state === RoundState.Claimable, 400, 2000);
      expect(claimable.state).toBe(RoundState.Claimable);
      step("round CLAIMABLE", { roundId });

      // Scripted claim succeeds; player mints ANSEM.
      step("claim");
      await l1Send(() => claimIx(pProgram, player.publicKey, roundId).signers([player]).rpc());
      const minted = await awaitEr(
        async () => Number((await getAccount(conn, playerAta(player.publicKey))).amount),
        (a) => a > 0, 25, 2000);
      expect(minted).toBeGreaterThan(0);
      log.info("M4a verify: keeper drove a full hands-off round", { roundId, minted });
    } finally {
      await service.stop();
    }
  }, 1_800_000);
});
