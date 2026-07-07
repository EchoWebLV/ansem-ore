import { Program, BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { AnsemMiner } from "../idl/ansem_miner.js";
import { configPda, roundPda, payoutVault, vaultAuthPda, mintAuthPda, potVaultPda, treasuryPda, ansemMintPda } from "../pdas.js";
import { VRF_BASE_QUEUE } from "../constants.js";

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

export const executeSwapMockIx = (p: Program<AnsemMiner>, keeper: PublicKey, roundId: number) =>
  p.methods.executeSwapMock().accountsPartial({
    payer: keeper, round: roundPda(roundId), ansemMint: ansemMintPda(), mintAuthority: mintAuthPda(),
    vaultAuthority: vaultAuthPda(), payoutVault: payoutVault(), potVault: potVaultPda(), treasury: treasuryPda(),
  });

export const cancelRoundIx = (p: Program<AnsemMiner>, keeper: PublicKey, roundId: number) =>
  p.methods.cancelRound().accountsPartial({ admin: keeper, round: roundPda(roundId) });

// Admin setters
export const setRoundDurationIx = (p: Program<AnsemMiner>, admin: PublicKey, secs: number) =>
  p.methods.setRoundDuration(new BN(secs)).accountsPartial({ admin });
export const setReturnBandIx = (p: Program<AnsemMiner>, admin: PublicKey, minBps: number, maxBps: number) =>
  p.methods.setReturnBand(minBps, maxBps).accountsPartial({ admin });
