import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { AnsemMiner } from "../target/types/ansem_miner";
import { PublicKey, Keypair } from "@solana/web3.js";
import { assert } from "chai";
import { createMint } from "@solana/spl-token";

const enc = (s: string) => Buffer.from(s);

// The upgradeable BPF loader that owns program accounts on a real cluster (and on a
// plainly-deployed localnet program). ProgramData PDA = [programId] under this loader.
const BPF_LOADER_UPGRADEABLE = new PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111"
);

// Mainnet-path suite: real-mode initialization (`initialize_real`). Unlike the mock
// `initialize`, this path is gated to the program's UPGRADE AUTHORITY (kills init-
// squatting) and records an EXTERNAL, pre-existing ANSEM mint (no PDA mint minted).
// The upgrade-authority signer is NOT necessarily the admin: `keeper_admin` (a hot
// key) becomes `config.admin`, so the cold deploy wallet can never crank admin ixs.
//
// REQUIRES the program to be deployed with the UPGRADEABLE loader (so a ProgramData
// account exists and its upgrade authority == the provider wallet). A genesis
// `--bpf-program` preload has NO ProgramData and will fail this suite. Deploy recipe:
//   solana-test-validator  (plain, fresh test-ledger)
//   solana airdrop <provider wallet>
//   solana program deploy target/deploy/ansem_miner.so \
//     --program-id target/deploy/ansem_miner-keypair.json -u localhost
describe("mainnet-path: initialize_real (upgrade-authority gated, external ANSEM mint)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.AnsemMiner as Program<AnsemMiner>;
  // provider wallet == the program's upgrade authority (upgradeable deploy).
  const deployer = provider.wallet as anchor.Wallet;

  const [configPda] = PublicKey.findProgramAddressSync([enc("config")], program.programId);
  const [mintAuth] = PublicKey.findProgramAddressSync([enc("mint_auth")], program.programId);
  const [vaultAuth] = PublicKey.findProgramAddressSync([enc("vault_auth")], program.programId);
  const [potVault] = PublicKey.findProgramAddressSync([enc("pot_vault")], program.programId);
  const [treasury] = PublicKey.findProgramAddressSync([enc("treasury")], program.programId);
  const [programData] = PublicKey.findProgramAddressSync(
    [program.programId.toBuffer()],
    BPF_LOADER_UPGRADEABLE
  );

  // The Railway hot key: passed as `keeper_admin`, becomes config.admin. Distinct
  // from the deploy wallet so we can prove signer != admin.
  const keeperAdmin = Keypair.generate();
  // A wallet that is neither the upgrade authority nor the admin.
  const stranger = Keypair.generate();
  let ansemMint: PublicKey;

  const initRealAccounts = (adminPk: PublicKey) => ({
    admin: adminPk,
    config: configPda,
    ansemMint,
    mintAuthority: mintAuth,
    vaultAuthority: vaultAuth,
    potVault,
    treasury,
    program: program.programId,
    programData,
    systemProgram: anchor.web3.SystemProgram.programId,
  });

  const airdrop = async (pk: PublicKey, sol: number) => {
    const sig = await provider.connection.requestAirdrop(
      pk,
      sol * anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(sig);
  };

  before(async () => {
    await airdrop(keeperAdmin.publicKey, 2);
    await airdrop(stranger.publicKey, 2);
    // A plain, pre-existing SPL mint (6 decimals) stands in for the real ANSEM mint.
    // The program holds NO authority over it; it is passed in as an external account.
    ansemMint = await createMint(
      provider.connection,
      deployer.payer,
      deployer.publicKey,
      null,
      6
    );
  });

  // Negative FIRST: while Config does not yet exist, a non-upgrade-authority signer
  // must be rejected. (Running this before the successful init proves the failure is
  // the upgrade-authority constraint, not an "already in use" Config collision.)
  it("rejects init by a non-upgrade-authority signer (Unauthorized)", async () => {
    try {
      await (program.methods as any)
        .initializeReal(keeperAdmin.publicKey)
        .accountsPartial(initRealAccounts(stranger.publicKey))
        .signers([stranger])
        .rpc();
      assert.fail("initialize_real must reject a non-upgrade-authority signer");
    } catch (e: any) {
      assert.include(e.toString(), "Unauthorized");
    }
  });

  it("initialize_real: external mint, JUPITER mode, admin = keeper_admin (not the signer)", async () => {
    await (program.methods as any)
      .initializeReal(keeperAdmin.publicKey)
      .accountsPartial(initRealAccounts(deployer.publicKey))
      .rpc();

    const cfg: any = await program.account.config.fetch(configPda);
    assert.equal(cfg.swapMode, 1, "swap_mode == SWAP_MODE_JUPITER");
    assert.equal(
      cfg.ansemMint.toBase58(),
      ansemMint.toBase58(),
      "records the external ANSEM mint"
    );
    assert.equal(cfg.mockRate.toString(), "0", "no mock rate in real mode");
    // The signer was the deploy wallet, but admin is the passed keeper key.
    assert.equal(
      cfg.admin.toBase58(),
      keeperAdmin.publicKey.toBase58(),
      "config.admin == keeper_admin arg (signer is only the upgrade authority)"
    );
    // Sanity: Task-1 fields carry the same defaults the mock initialize sets.
    assert.equal(cfg.ansemObligations.toString(), "0");
    assert.equal(cfg.rolloverJackpot.toString(), "0");
    assert.equal(cfg.minSwapRate.toString(), "0");
    assert.isTrue(cfg.currentRoundFinalized);
  });

  it("admin-gated ix signed by the DEPLOY wallet now FAILS Unauthorized", async () => {
    try {
      await program.methods
        .setRoundDuration(new anchor.BN(42))
        .accounts({ admin: deployer.publicKey })
        .rpc();
      assert.fail("deploy wallet must not be able to crank admin ixs");
    } catch (e: any) {
      assert.include(e.toString(), "Unauthorized");
    }
  });

  it("the SAME admin-gated ix signed by keeper_admin SUCCEEDS", async () => {
    await program.methods
      .setRoundDuration(new anchor.BN(42))
      .accounts({ admin: keeperAdmin.publicKey })
      .signers([keeperAdmin])
      .rpc();
    const cfg: any = await program.account.config.fetch(configPda);
    assert.equal(cfg.roundDurationSecs.toString(), "42");
  });
});
