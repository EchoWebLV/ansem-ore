import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { AnsemMiner } from "../target/types/ansem_miner";
import { Connection, PublicKey } from "@solana/web3.js";
import { assert } from "chai";

// ANSEM Miner — Ephemeral Rollup integration suite (M2a).
//
// Runs against the two-provider local stack from scripts/test-er.sh:
//   base layer  : mb-test-validator @ http://127.0.0.1:8899  (our program + DLP)
//   ephemeral   : ephemeral-validator @ http://127.0.0.1:7799 (the ER)
//
// This file starts with a stack smoke test (Task 0). Delegation / stake / commit
// / reconcile tests are appended by later M2a tasks.

const BPF_LOADER_UPGRADEABLE = "BPFLoaderUpgradeab1e11111111111111111111111";
const DLP_PROGRAM_ID = "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh";

// Base-layer (L1) provider + program — from ANCHOR_PROVIDER_URL/ANCHOR_WALLET.
const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);
const program = anchor.workspace.AnsemMiner as Program<AnsemMiner>;

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

describe("ansem-miner (ER)", () => {
  it("smoke: two-provider stack is up (program + DLP on base, ER RPC live)", async () => {
    // Base: our program preloaded at genesis (owned by the upgradeable loader).
    const prog = await provider.connection.getAccountInfo(program.programId, "confirmed");
    assert.isNotNull(prog, "our program must be present on the base validator");
    assert.equal(prog!.owner.toBase58(), BPF_LOADER_UPGRADEABLE);
    assert.isTrue(prog!.executable);

    // Base: the delegation program (DLP) must be cloned by mb-test-validator.
    const dlp = await provider.connection.getAccountInfo(new PublicKey(DLP_PROGRAM_ID), "confirmed");
    assert.isNotNull(dlp, "DLP must be cloned onto the base validator");
    assert.equal(dlp!.owner.toBase58(), BPF_LOADER_UPGRADEABLE);

    // ER: RPC is live and reports the magicblock core version.
    const v: any = await erConnection.getVersion();
    assert.property(v, "solana-core");
    assert.property(v, "magicblock-core");
    console.log("        ER magicblock-core:", v["magicblock-core"], "| base:", provider.connection.rpcEndpoint, "| er:", erConnection.rpcEndpoint);

    // Sanity: the two providers are genuinely distinct endpoints.
    assert.notEqual(provider.connection.rpcEndpoint, erConnection.rpcEndpoint);
  });
});
