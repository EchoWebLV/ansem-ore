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
    // 180s round: the keeper opens+delegates the round, then the scripted player
    // must onboard (deposit/init/session/join/delegate/ER-stake) before the
    // deadline — devnet tx + ER clone latency (and dev-RPC 429 retries) need the
    // headroom (the proven tests/ansem-miner-devnet.ts phase-4 uses 90s with a
    // pre-delegated round; here the keeper also runs the whole loop concurrently).
    const service = createService({ ...cfg, roundDurationSecs: 180, httpPort: 0 }, log);
    await service.start();
    try {
      const conn = new Connection(cfg.rpcUrl, { commitment: "confirmed" });
      const program = createProgram(conn, new Wallet(cfg.adminKeypair));
      const erConn = new Connection(cfg.erEndpoint, { wsEndpoint: cfg.erWsEndpoint, commitment: "confirmed" });

      // Target a round the keeper opens FRESHLY after boot (id advances past any
      // round it inherits/cleans up on start), so the player gets the full round
      // duration to onboard+stake instead of racing a round about to settle.
      const startId = (await fetchConfig(program, configPda())).currentRoundId;
      let roundId = 0;
      for (let i = 0; i < 200; i++) {
        const c = await fetchConfig(program, configPda()).catch(() => null);
        if (c && !c.currentRoundFinalized && c.currentRoundId > startId) { roundId = c.currentRoundId; break; }
        await sleep(2000);
      }
      if (!roundId) throw new Error("keeper did not open a fresh round in time");
      await awaitOwnerIs(conn, roundPda(roundId), DLP_PROGRAM_ID.toBase58());

      // Scripted player: fund -> deposit -> init_miner -> session mint -> join -> delegate -> ER session stake.
      const player = Keypair.generate();
      await program.provider.sendAndConfirm!(
        new Transaction().add(SystemProgram.transfer({
          fromPubkey: cfg.adminKeypair.publicKey, toPubkey: player.publicKey, lamports: 0.1 * LAMPORTS_PER_SOL,
        })));
      const pProgram = createProgram(conn, new Wallet(player));
      const pErProgram = createErProgram(erConn, new Wallet(player));
      await depositIx(pProgram, player.publicKey, new anchor.BN(0.05 * LAMPORTS_PER_SOL)).signers([player]).rpc();
      await initMinerIx(pProgram, player.publicKey).signers([player]).rpc().catch(() => {});

      const gum = new SessionTokenManager(new Wallet(player), conn).program;
      const sessionKp = Keypair.generate();
      const [tokenPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("session_token_v2"), PROGRAM_ID.toBuffer(), sessionKp.publicKey.toBuffer(), player.publicKey.toBuffer()],
        gum.programId);
      await gum.methods.createSessionV2(false, new anchor.BN(Math.floor(Date.now() / 1000) + 900), null)
        .accountsPartial({ sessionToken: tokenPda, sessionSigner: sessionKp.publicKey, feePayer: player.publicKey, authority: player.publicKey, targetProgram: PROGRAM_ID })
        .signers([sessionKp]).rpc();

      await l1Send(() => joinRoundIx(pProgram, player.publicKey, roundId).signers([player]).rpc());
      await l1Send(() => delegateMinerIx(pProgram, player.publicKey, cfg.validator)
        .signers([player]).rpc({ skipPreflight: true, commitment: "confirmed" }));
      await awaitOwnerIs(conn, minerPda(player.publicKey), DLP_PROGRAM_ID.toBase58());

      const STAKE = new anchor.BN(0.02 * LAMPORTS_PER_SOL);
      for (let i = 0; i < 8; i++) {
        const m: any = await pErProgram.account.minerPosition.fetch(minerPda(player.publicKey)).catch(() => null);
        if (m && m.blockStake[0].toString() === STAKE.toString()) break;
        await erRpcTolerant(() => stakeIx(pErProgram, sessionKp.publicKey, player.publicKey, 0, STAKE, roundId, tokenPda)
          .signers([sessionKp]).rpc({ skipPreflight: true, commitment: "confirmed" }));
        await sleep(2500);
      }

      // The keeper (no UI) now settles + commits + reconciles + swaps hands-off. Wait for CLAIMABLE.
      const claimable = await awaitEr(
        () => fetchRound(program, roundPda(roundId)),
        (r) => r.state === RoundState.Claimable, 300, 2000);
      expect(claimable.state).toBe(RoundState.Claimable);

      // Scripted claim succeeds; player mints ANSEM.
      await l1Send(() => claimIx(pProgram, player.publicKey, roundId).signers([player]).rpc());
      const minted = await awaitEr(
        async () => Number((await getAccount(conn, playerAta(player.publicKey))).amount),
        (a) => a > 0, 25, 2000);
      expect(minted).toBeGreaterThan(0);
      log.info("M4a verify: keeper drove a full hands-off round", { roundId, minted });
    } finally {
      await service.stop();
    }
  }, 900_000);
});
