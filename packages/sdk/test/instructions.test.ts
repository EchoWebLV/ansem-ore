import { describe, it, expect } from "vitest";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { Wallet, BN } from "@coral-xyz/anchor";
import { createProgram } from "../src/program.js";
import { stakeIx, joinRoundIx, claimIx } from "../src/instructions/player.js";
import { delegateRoundIx, executeSwapMockIx, initializeRealIx, executeSwapRealIx,
  sweepTreasuryIx, sweepBeefExcessIx, closeRoundIx, setClaimWindowIx, setMinSwapRateIx,
  setStakeLimitsIx } from "../src/instructions/keeper.js";
import { configPda, roundPda, minerPda, escrowPda, payoutVault, treasuryPda, beefConfigPda,
  payoutVaultForMint, ataForMint, programDataPda } from "../src/pdas.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "../src/constants.js";

const program = () => createProgram(new Connection("http://127.0.0.1:9999"), new Wallet(Keypair.generate()));
const has = (ix: { keys: { pubkey: PublicKey }[] }, pk: PublicKey) =>
  ix.keys.some((k) => k.pubkey.equals(pk));

describe("instruction builders resolve the right accounts", () => {
  const wallet = Keypair.generate().publicKey;

  it("stake (wallet-signed) references config/round/miner/escrow and null session", async () => {
    const ix = await stakeIx(program(), wallet, wallet, 3, new BN(1000), 7, null).instruction();
    expect(has(ix, configPda())).toBe(true);
    expect(has(ix, roundPda(7))).toBe(true);
    expect(has(ix, minerPda(wallet))).toBe(true);
    expect(has(ix, escrowPda(wallet))).toBe(true);
  });

  it("joinRound references escrow + config", async () => {
    const ix = await joinRoundIx(program(), wallet, 7).instruction();
    expect(has(ix, escrowPda(wallet))).toBe(true);
    expect(has(ix, configPda())).toBe(true);
  });

  it("claim references payout vault + round", async () => {
    const ix = await claimIx(program(), wallet, 7).instruction();
    expect(has(ix, payoutVault())).toBe(true);
    expect(has(ix, roundPda(7))).toBe(true);
  });

  it("delegateRound includes the ER validator in remaining accounts", async () => {
    const validator = Keypair.generate().publicKey;
    const ix = await delegateRoundIx(program(), wallet, 7, validator).instruction();
    expect(has(ix, validator)).toBe(true);
  });

  it("executeSwapMock references payout vault + round", async () => {
    const ix = await executeSwapMockIx(program(), wallet, 7).instruction();
    expect(has(ix, payoutVault())).toBe(true);
    expect(has(ix, roundPda(7))).toBe(true);
  });
});

describe("mainnet-path builders resolve the right accounts", () => {
  const upgradeAuth = Keypair.generate().publicKey;
  const keeper = Keypair.generate().publicKey;
  const admin = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey; // external ANSEM mint

  it("initializeReal binds the external mint + program_data gate + config", async () => {
    const ix = await initializeRealIx(program(), upgradeAuth, keeper, mint).instruction();
    expect(has(ix, mint)).toBe(true);
    expect(has(ix, programDataPda())).toBe(true);
    expect(has(ix, configPda())).toBe(true);
  });

  it("executeSwapReal pulls from the payer ATA into the mint's payout vault", async () => {
    const ix = await executeSwapRealIx(program(), keeper, 7, new BN(1_000), mint).instruction();
    expect(has(ix, payoutVaultForMint(mint))).toBe(true);
    expect(has(ix, ataForMint(mint, keeper))).toBe(true);
    expect(has(ix, roundPda(7))).toBe(true);
    expect(has(ix, treasuryPda())).toBe(true);
  });

  it("sweepTreasury references treasury + the named destination", async () => {
    const dest = Keypair.generate().publicKey;
    const ix = await sweepTreasuryIx(program(), admin, new BN(50), dest).instruction();
    expect(has(ix, treasuryPda())).toBe(true);
    expect(has(ix, dest)).toBe(true);
  });

  it("sweepBeefExcess references the beef mint, vault, destination ATA + beef config", async () => {
    const beefMint = Keypair.generate().publicKey;
    const beefVault = Keypair.generate().publicKey;
    const destAta = Keypair.generate().publicKey;
    const ix = await sweepBeefExcessIx(program(), admin, new BN(10), beefMint, beefVault, destAta).instruction();
    expect(has(ix, beefMint)).toBe(true);
    expect(has(ix, beefVault)).toBe(true);
    expect(has(ix, destAta)).toBe(true);
    expect(has(ix, beefConfigPda())).toBe(true);
    expect(has(ix, TOKEN_PROGRAM_ID)).toBe(true); // classic default
  });

  it("closeRound seeds the round PDA from roundId + pins admin_dest", async () => {
    const adminDest = Keypair.generate().publicKey;
    const ix = await closeRoundIx(program(), keeper, 7, adminDest).instruction();
    expect(has(ix, roundPda(7))).toBe(true);
    expect(has(ix, adminDest)).toBe(true);
    expect(has(ix, configPda())).toBe(true);
  });

  it("setClaimWindow / setMinSwapRate resolve the admin-gated config", async () => {
    const cw = await setClaimWindowIx(program(), admin, 86_400).instruction();
    expect(has(cw, configPda())).toBe(true);
    const msr = await setMinSwapRateIx(program(), admin, new BN(1_000)).instruction();
    expect(has(msr, configPda())).toBe(true);
  });

  it("setStakeLimits resolves the admin-gated config", async () => {
    const ix = await setStakeLimitsIx(program(), admin, new BN(10_000_000), new BN(1_000_000_000)).instruction();
    expect(has(ix, configPda())).toBe(true);
  });
});

// Token-2022 support: the token layer is now anchor_spl::token_interface, so tokenProgram
// is passed explicitly and the ATA seeds must include the mint's owning program. These
// prove the builders thread the SAME program into both the ATA derivation and the account.
describe("token-program threading (Token-2022 vs classic)", () => {
  const keeper = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;

  it("executeSwapReal defaults to the classic token program", async () => {
    const ix = await executeSwapRealIx(program(), keeper, 7, new BN(1_000), mint).instruction();
    expect(has(ix, TOKEN_PROGRAM_ID)).toBe(true);
    expect(has(ix, payoutVaultForMint(mint, TOKEN_PROGRAM_ID))).toBe(true);
    expect(has(ix, ataForMint(mint, keeper, TOKEN_PROGRAM_ID))).toBe(true);
  });

  it("executeSwapReal threads Token-2022 into the payout vault, source ATA + tokenProgram", async () => {
    const ix = await executeSwapRealIx(program(), keeper, 7, new BN(1_000), mint, TOKEN_2022_PROGRAM_ID).instruction();
    expect(has(ix, TOKEN_2022_PROGRAM_ID)).toBe(true);
    // 2022-derived ATAs differ from the classic derivation for the same mint/owner.
    expect(has(ix, payoutVaultForMint(mint, TOKEN_2022_PROGRAM_ID))).toBe(true);
    expect(has(ix, ataForMint(mint, keeper, TOKEN_2022_PROGRAM_ID))).toBe(true);
    expect(payoutVaultForMint(mint, TOKEN_2022_PROGRAM_ID).equals(payoutVaultForMint(mint, TOKEN_PROGRAM_ID))).toBe(false);
  });

  it("sweepBeefExcess threads Token-2022 into the tokenProgram account", async () => {
    const admin = Keypair.generate().publicKey;
    const beefMint = Keypair.generate().publicKey;
    const beefVault = Keypair.generate().publicKey;
    const destAta = Keypair.generate().publicKey;
    const ix = await sweepBeefExcessIx(program(), admin, new BN(10), beefMint, beefVault, destAta, TOKEN_2022_PROGRAM_ID).instruction();
    expect(has(ix, TOKEN_2022_PROGRAM_ID)).toBe(true);
  });
});
