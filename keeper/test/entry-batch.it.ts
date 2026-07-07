import { describe, it, expect } from "vitest";
import { Connection, Keypair, SystemProgram, Transaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import { Wallet } from "@coral-xyz/anchor";
import {
  createProgram, createErProgram, configPda, roundPda, minerPda, escrowPda, sessionTokenPda,
  fetchConfig, fetchRound, fetchEscrow, fetchMiner, RoundState, DLP_PROGRAM_ID,
  depositIx, buildEntryInstructions, awaitOwnerIs, awaitEr, l1Send, sleep,
} from "@ansem/sdk";
import { loadKeeperConfig, fsLoadKeypair } from "../src/env.js";
import { createService } from "../src/service.js";
import { makeLogger } from "../src/logger.js";

// Gate: only runs with ENTRY_BATCH_IT=1. Proves the ONE-POPUP batched entry lands on
// devnet BEFORE any UI is built on it (M4c Task 4). Mirrors devnet-round.it.ts setup,
// swapping the 3 sequential entry txs (session mint / join / delegate) for a single tx.
const RUN = process.env.ENTRY_BATCH_IT === "1";
const d = RUN ? describe : describe.skip;

d("one-popup batched entry lands on devnet (M4c gate)", () => {
  it("init_miner + createSessionV2 + join_round + delegate_miner in ONE tx", async () => {
    const cfg = loadKeeperConfig(process.env, fsLoadKeypair);
    const log = makeLogger();
    const step = (msg: string, fields?: Record<string, unknown>) => log.info(`[spike] ${msg}`, fields);

    // Keeper opens rounds in-process (fire-and-forget, like main.ts).
    const service = createService({ ...cfg, roundDurationSecs: 180, httpPort: 0 }, log);
    void service.start().catch((e) => log.error("keeper start failed", { err: String(e) }));
    try {
      const conn = new Connection(cfg.rpcUrl, { commitment: "confirmed" });
      const program = createProgram(conn, new Wallet(cfg.adminKeypair));
      const erConn = new Connection(cfg.erEndpoint, { wsEndpoint: cfg.erWsEndpoint, commitment: "confirmed" });
      const erAdminProgram = createErProgram(erConn, new Wallet(cfg.adminKeypair));

      // Find any OPEN round with >120s runway (read from ER while delegated).
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

      // Onboarding (separate txs, as in the real UX): fund + deposit.
      const player = Keypair.generate();
      step("funding player", { player: player.publicKey.toBase58() });
      await program.provider.sendAndConfirm!(
        new Transaction().add(SystemProgram.transfer({
          fromPubkey: cfg.adminKeypair.publicKey, toPubkey: player.publicKey, lamports: 0.1 * LAMPORTS_PER_SOL,
        })));
      const pWallet = new Wallet(player);
      const l1 = createProgram(conn, pWallet);
      step("deposit");
      await l1Send(() => depositIx(l1, player.publicKey, new anchor.BN(0.05 * LAMPORTS_PER_SOL)).signers([player]).rpc());

      // THE one-popup batched entry.
      const noMiner = (await fetchMiner(l1, minerPda(player.publicKey))) === null;
      step("building batched entry", { includeInitMiner: noMiner });
      const entry = await buildEntryInstructions(
        l1, conn, pWallet, roundId, cfg.validator, Math.floor(Date.now() / 1000) + 3600,
        { includeInitMiner: noMiner },
      );
      const tx = new Transaction().add(...entry.instructions);
      tx.feePayer = player.publicKey;
      tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
      tx.partialSign(entry.sessionSigner);   // session co-signs (createSessionV2)
      tx.partialSign(player);                // in-browser this is wallet.signTransaction (the single popup)
      const bytes = tx.serialize().length;
      step("batched entry tx size", { bytes });
      await l1Send(() => conn.sendRawTransaction(tx.serialize(), { skipPreflight: true }));

      // Assertions: the ONE tx did all three things.
      const esc = await awaitEr(() => fetchEscrow(l1, escrowPda(player.publicKey)), (e) => e?.activeRound === roundId, 30, 1000);
      expect(esc?.activeRound).toBe(roundId);                                          // join_round
      await awaitOwnerIs(conn, minerPda(player.publicKey), DLP_PROGRAM_ID.toBase58()); // init_miner + delegate_miner
      const token = await conn.getAccountInfo(sessionTokenPda(entry.sessionSigner.publicKey, player.publicKey));
      expect(token).not.toBeNull();                                                    // createSessionV2
      step("ONE-POPUP entry landed", { roundId, txBytes: bytes });
    } finally {
      await service.stop();
    }
  }, 600_000);
});
