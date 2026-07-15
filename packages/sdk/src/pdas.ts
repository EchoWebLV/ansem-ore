import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { BN } from "./bn.js";
import { PROGRAM_ID, GUM_PROGRAM_ID, BPF_LOADER_UPGRADEABLE_ID, SEED } from "./constants.js";

const enc = (s: string) => Buffer.from(s);
const u64le = (id: number | bigint) => new BN(id.toString()).toArrayLike(Buffer, "le", 8);
const pda = (seeds: (Buffer | Uint8Array)[], programId = PROGRAM_ID) =>
  PublicKey.findProgramAddressSync(seeds, programId)[0];

export const configPda = () => pda([enc(SEED.config)]);
export const potVaultPda = () => pda([enc(SEED.potVault)]);
export const treasuryPda = () => pda([enc(SEED.treasury)]);
export const vaultAuthPda = () => pda([enc(SEED.vaultAuth)]);
export const mintAuthPda = () => pda([enc(SEED.mintAuth)]);
export const ansemMintPda = () => pda([enc(SEED.ansemMint)]);

export const roundPda = (roundId: number | bigint) => pda([enc(SEED.round), u64le(roundId)]);
export const minerPda = (wallet: PublicKey) => pda([enc(SEED.miner), wallet.toBuffer()]);
export const escrowPda = (wallet: PublicKey) => pda([enc(SEED.escrow), wallet.toBuffer()]);

/** Single lottery payout vault = the vault-authority ATA of the ANSEM mint. The PDA mock
 *  mint is classic SPL, so tokenProgramId defaults classic; a real (Token-2022) claim path
 *  passes its program so the ATA seeds match. */
export const payoutVault = (tokenProgramId: PublicKey = TOKEN_PROGRAM_ID) =>
  getAssociatedTokenAddressSync(ansemMintPda(), vaultAuthPda(), true, tokenProgramId);
export const playerAta = (wallet: PublicKey, tokenProgramId: PublicKey = TOKEN_PROGRAM_ID) =>
  getAssociatedTokenAddressSync(ansemMintPda(), wallet, false, tokenProgramId);

// ---- Mainnet real-payout layer (external ANSEM mint) ----
// In real mode config.ansem_mint is a pre-existing EXTERNAL mint (not the PDA mint),
// so payout/source token accounts must be derived against that mint, not ansemMintPda.
// The real $ANSEM mint is Token-2022, so the ATA derivation MUST include the token
// program in the seeds — pass its program id (defaults to classic for the mock mint).

/** Payout vault (vault-authority ATA) for an arbitrary mint — the real-ANSEM payout vault. */
export const payoutVaultForMint = (mint: PublicKey, tokenProgramId: PublicKey = TOKEN_PROGRAM_ID) =>
  getAssociatedTokenAddressSync(mint, vaultAuthPda(), true, tokenProgramId);
/** A wallet's ATA for an arbitrary mint (e.g. the keeper's real-ANSEM inventory ATA). */
export const ataForMint = (mint: PublicKey, owner: PublicKey, tokenProgramId: PublicKey = TOKEN_PROGRAM_ID) =>
  getAssociatedTokenAddressSync(mint, owner, false, tokenProgramId);

/**
 * ProgramData PDA = [programId] under the upgradeable BPF loader. This is the account
 * whose `upgrade_authority_address` gates initialize_real, so the builder derives it and
 * the deploy/upgrade-authority wallet signs.
 */
export const programDataPda = (programId = PROGRAM_ID) =>
  pda([programId.toBuffer()], BPF_LOADER_UPGRADEABLE_ID);

/** Gum SessionTokenV2 PDA: ["session_token_v2", targetProgram, sessionSigner, authorityWallet]. */
export const sessionTokenPda = (sessionSigner: PublicKey, authorityWallet: PublicKey, target = PROGRAM_ID) =>
  pda([enc(SEED.sessionTokenV2), target.toBuffer(), sessionSigner.toBuffer(), authorityWallet.toBuffer()], GUM_PROGRAM_ID);

// ---- Jackpot params PDA (spec D6): random-trigger + bet-scaled cap ----
// Canonical derivation for keeper/app. Seed matches program JACKPOT_CONFIG_SEED
// ("jackpot_config"); keeper/src/read/jackpot.ts derives it raw pending a swap to this.
export const jackpotConfigPda = () => pda([enc(SEED.jackpotConfig)]);

// ---- BEEF vault emission layer ----
export const beefConfigPda = () => pda([enc(SEED.beefConfig)]);
export const beefMinerPda = (wallet: PublicKey) => pda([enc(SEED.beefMiner), wallet.toBuffer()]);
export const beefRoundPda = (roundId: number | bigint) => pda([enc(SEED.beefRound), u64le(roundId)]);
/** Player's BEEF ATA (mint comes from BeefConfig, passed by the caller). BEEF's future
 *  token is a pump.fun (Token-2022) mint, so tokenProgramId threads into the ATA seeds. */
export const playerBeefAta = (beefMint: PublicKey, wallet: PublicKey, tokenProgramId: PublicKey = TOKEN_PROGRAM_ID) =>
  getAssociatedTokenAddressSync(beefMint, wallet, false, tokenProgramId);
