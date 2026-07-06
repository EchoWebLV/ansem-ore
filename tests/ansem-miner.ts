import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { AnsemMiner } from "../target/types/ansem_miner";
import { PublicKey } from "@solana/web3.js";
import { assert } from "chai";

const enc = (s: string) => Buffer.from(s);

describe("ansem-miner", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.AnsemMiner as Program<AnsemMiner>;
  const admin = provider.wallet as anchor.Wallet;

  const [configPda] = PublicKey.findProgramAddressSync([enc("config")], program.programId);
  const [ansemMint] = PublicKey.findProgramAddressSync([enc("ansem_mint")], program.programId);

  it("initializes config and mock mint", async () => {
    await program.methods.initialize().accounts({ admin: admin.publicKey }).rpc();
    const cfg = await program.account.config.fetch(configPda);
    assert.equal(cfg.admin.toBase58(), admin.publicKey.toBase58());
    assert.equal(cfg.ansemMint.toBase58(), ansemMint.toBase58());
    assert.equal(cfg.currentRoundId.toNumber(), 0);
    assert.equal(cfg.feeBps, 100);
    assert.equal(cfg.swapMode, 0);
  });
});
