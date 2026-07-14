import { Program } from "@coral-xyz/anchor";
import { BN } from "../bn.js";
import { PublicKey } from "@solana/web3.js";
import { AnsemMiner } from "../idl/ansem_miner.js";
import { configPda, roundPda, payoutVault, vaultAuthPda, mintAuthPda, potVaultPda, treasuryPda, ansemMintPda,
  beefConfigPda, beefRoundPda, payoutVaultForMint, ataForMint, programDataPda } from "../pdas.js";
import { VRF_BASE_QUEUE, PROGRAM_ID, TOKEN_PROGRAM_ID } from "../constants.js";

const validatorMeta = (v: PublicKey) => [{ pubkey: v, isSigner: false, isWritable: false }];

export const createRoundIx = (p: Program<AnsemMiner>, keeper: PublicKey, newRoundId: number) =>
  p.methods.createRound().accountsPartial({ payer: keeper, round: roundPda(newRoundId) });

export const delegateRoundIx = (p: Program<AnsemMiner>, keeper: PublicKey, roundId: number, validator: PublicKey) =>
  p.methods.delegateRound(new BN(roundId)).accountsPartial({ payer: keeper, round: roundPda(roundId) })
    .remainingAccounts(validatorMeta(validator));

export const requestSettleIx = (p: Program<AnsemMiner>, keeper: PublicKey, roundId: number, clientSeed: number, oracleQueue = VRF_BASE_QUEUE) =>
  p.methods.requestSettle(clientSeed).accountsPartial({ payer: keeper, round: roundPda(roundId), config: configPda(), oracleQueue });

export const settleIx = (p: Program<AnsemMiner>, keeper: PublicKey, roundId: number, randomness: number[]) =>
  p.methods.settle(randomness).accountsPartial({ admin: keeper, config: configPda(), round: roundPda(roundId) });

export const commitRoundIx = (erProgram: Program<AnsemMiner>, keeper: PublicKey, roundId: number) =>
  erProgram.methods.commitRound().accountsPartial({ payer: keeper, config: configPda(), round: roundPda(roundId) });

/** ER, keeper-signed; round seeded on the miner's stored round_id (pass its pubkey). */
export const commitMinerIx = (erProgram: Program<AnsemMiner>, keeper: PublicKey, minerAccount: PublicKey, roundAccount: PublicKey) =>
  erProgram.methods.commitMiner().accountsPartial({ payer: keeper, miner: minerAccount, round: roundAccount });

export const reconcileMinerIx = (p: Program<AnsemMiner>, roundId: number, escrow: PublicKey, miner: PublicKey) =>
  p.methods.reconcileMiner(new BN(roundId)).accountsPartial({ config: configPda(), escrow, miner });

// The mock PDA mint is always classic SPL; tokenProgram is no longer auto-resolvable
// (the program's token layer is an Interface with two ids), so pass it explicitly.
export const executeSwapMockIx = (p: Program<AnsemMiner>, keeper: PublicKey, roundId: number) =>
  p.methods.executeSwapMock().accountsPartial({
    payer: keeper, round: roundPda(roundId), ansemMint: ansemMintPda(), mintAuthority: mintAuthPda(),
    vaultAuthority: vaultAuthPda(), payoutVault: payoutVault(), potVault: potVaultPda(), treasury: treasuryPda(),
    tokenProgram: TOKEN_PROGRAM_ID,
  });

export const cancelRoundIx = (p: Program<AnsemMiner>, keeper: PublicKey, roundId: number) =>
  p.methods.cancelRound().accountsPartial({ admin: keeper, round: roundPda(roundId) });

// Admin setters
export const setRoundDurationIx = (p: Program<AnsemMiner>, admin: PublicKey, secs: number) =>
  p.methods.setRoundDuration(new BN(secs)).accountsPartial({ admin });
export const setReturnBandIx = (p: Program<AnsemMiner>, admin: PublicKey, minBps: number, maxBps: number) =>
  p.methods.setReturnBand(minBps, maxBps).accountsPartial({ admin });

// ---- BEEF vault emission layer (admin/keeper) ----

export const initBeefIx = (
  p: Program<AnsemMiner>, admin: PublicKey, beefMint: PublicKey, beefVault: PublicKey,
  divisor: BN, tickBps: number, bonusCapBps: number, activityWindowSecs: BN, secsPerTick: BN,
) => p.methods.initBeef(divisor, tickBps, bonusCapBps, activityWindowSecs, secsPerTick)
  .accountsPartial({ admin, beefMint, vaultAuthority: vaultAuthPda(), beefVault });

export const setBeefParamsIx = (
  p: Program<AnsemMiner>, admin: PublicKey,
  divisor: BN, tickBps: number, bonusCapBps: number, activityWindowSecs: BN, secsPerTick: BN,
) => p.methods.setBeefParams(divisor, tickBps, bonusCapBps, activityWindowSecs, secsPerTick)
  .accountsPartial({ admin, config: configPda(), beefConfig: beefConfigPda() });

export const stampBeefIx = (p: Program<AnsemMiner>, payer: PublicKey, roundId: number, beefVault: PublicKey) =>
  p.methods.stampBeef(new BN(roundId)).accountsPartial({
    payer, config: configPda(), round: roundPda(roundId),
    beefConfig: beefConfigPda(), beefVault, beefRound: beefRoundPda(roundId),
  });

// ---- Mainnet real-payout layer (plan 2026-07-14, Task 6) ----
// initialize_real / execute_swap_real / sweep_* / close_round / set_* live in the
// no-feature (mainnet) binary; the mock initialize + execute_swap_mock above are the
// devnet-feature counterparts. In real mode `ansemMint` is the EXTERNAL ANSEM mint
// (config.ansem_mint), so payout/source token accounts derive against it, not the PDA mint.

/**
 * initialize_real — the mainnet init path. SIGNER is the program's UPGRADE AUTHORITY
 * (the deploy wallet, gated by the program_data.upgrade_authority constraint), which
 * kills init-squatting; `keeperAdmin` becomes config.admin (the Railway hot key that
 * cranks the admin-gated ixs). Binds the pre-existing external `ansemMint`.
 */
export const initializeRealIx = (
  p: Program<AnsemMiner>, upgradeAuthority: PublicKey, keeperAdmin: PublicKey, ansemMint: PublicKey,
) => p.methods.initializeReal(keeperAdmin).accountsPartial({
  admin: upgradeAuthority, ansemMint, program: PROGRAM_ID, programData: programDataPda(),
});

/**
 * execute_swap_real — mainnet payout: pull `ansemOut` of the real external mint out of
 * the keeper's own ATA (`sourceAta`) into the payout vault (no minting), pot -> treasury.
 * Admin-gated on config.admin == payer inside the accounts.
 */
// `tokenProgramId` selects the mint's owning program (classic for the mock/devnet mint,
// Token-2022 for real $ANSEM). It threads into BOTH the ATA derivation (payout vault +
// keeper source ATA) AND the tokenProgram account passed to the ix. Defaults to classic.
export const executeSwapRealIx = (
  p: Program<AnsemMiner>, keeper: PublicKey, roundId: number, ansemOut: BN, ansemMint: PublicKey,
  tokenProgramId: PublicKey = TOKEN_PROGRAM_ID,
) => p.methods.executeSwapReal(ansemOut).accountsPartial({
  payer: keeper, round: roundPda(roundId), ansemMint,
  vaultAuthority: vaultAuthPda(),
  payoutVault: payoutVaultForMint(ansemMint, tokenProgramId),
  sourceAta: ataForMint(ansemMint, keeper, tokenProgramId),
  potVault: potVaultPda(), treasury: treasuryPda(),
  tokenProgram: tokenProgramId,
});

/** sweep_treasury — admin exit: move `amount` treasury lamports to any `destination`. */
export const sweepTreasuryIx = (p: Program<AnsemMiner>, admin: PublicKey, amount: BN, destination: PublicKey) =>
  p.methods.sweepTreasury(amount).accountsPartial({ admin, treasury: treasuryPda(), destination });

/**
 * sweep_beef_excess — admin exit for BEEF above the total_owed solvency floor. `beefMint`
 * and `beefVault` are passed explicitly (runtime beef_config fields, not static PDAs — same
 * convention as the other beef builders); `destinationAta` is the admin-named BEEF ATA. The
 * mint account is required for transfer_checked; `tokenProgramId` (default classic) selects
 * its owning program so a Token-2022 BEEF mint settles correctly.
 */
export const sweepBeefExcessIx = (
  p: Program<AnsemMiner>, admin: PublicKey, amount: BN, beefMint: PublicKey, beefVault: PublicKey,
  destinationAta: PublicKey, tokenProgramId: PublicKey = TOKEN_PROGRAM_ID,
) => p.methods.sweepBeefExcess(amount).accountsPartial({
  admin, config: configPda(), beefConfig: beefConfigPda(), vaultAuthority: vaultAuthPda(),
  beefMint, beefVault, destinationAta, tokenProgram: tokenProgramId,
});

/**
 * close_round — permissionless rent-recycler (gates are time + state, not identity). `roundId`
 * is used CLIENT-SIDE only to seed the Round PDA; the on-chain ix takes no args. `adminDest`
 * must equal config.admin (the close rent sink); passed explicitly to keep the builder
 * synchronous like the rest — the keeper crank fetches config.admin once and threads it in.
 */
export const closeRoundIx = (p: Program<AnsemMiner>, caller: PublicKey, roundId: number, adminDest: PublicKey) =>
  p.methods.closeRound().accountsPartial({ caller, round: roundPda(roundId), adminDest });

// Admin setters (SetParams) — mainnet claim-window + swap-rate floor tuners.
export const setClaimWindowIx = (p: Program<AnsemMiner>, admin: PublicKey, secs: number) =>
  p.methods.setClaimWindow(new BN(secs)).accountsPartial({ admin });
export const setMinSwapRateIx = (p: Program<AnsemMiner>, admin: PublicKey, rate: BN) =>
  p.methods.setMinSwapRate(rate).accountsPartial({ admin });
// Launch stake-cap tuner: cap max_stake at 1 SOL (and retune min) without a program upgrade.
export const setStakeLimitsIx = (p: Program<AnsemMiner>, admin: PublicKey, minStake: BN, maxStakePerRound: BN) =>
  p.methods.setStakeLimits(minStake, maxStakePerRound).accountsPartial({ admin });
