import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { BN } from "./bn.js";
import { PROGRAM_ID, GUM_PROGRAM_ID, SEED } from "./constants.js";

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

/** Single lottery payout vault = the vault-authority ATA of the ANSEM mint. */
export const payoutVault = () => getAssociatedTokenAddressSync(ansemMintPda(), vaultAuthPda(), true);
export const playerAta = (wallet: PublicKey) => getAssociatedTokenAddressSync(ansemMintPda(), wallet);

/** Gum SessionTokenV2 PDA: ["session_token_v2", targetProgram, sessionSigner, authorityWallet]. */
export const sessionTokenPda = (sessionSigner: PublicKey, authorityWallet: PublicKey, target = PROGRAM_ID) =>
  pda([enc(SEED.sessionTokenV2), target.toBuffer(), sessionSigner.toBuffer(), authorityWallet.toBuffer()], GUM_PROGRAM_ID);

// ---- BEEF vault emission layer ----
export const beefConfigPda = () => pda([enc(SEED.beefConfig)]);
export const beefMinerPda = (wallet: PublicKey) => pda([enc(SEED.beefMiner), wallet.toBuffer()]);
export const beefRoundPda = (roundId: number | bigint) => pda([enc(SEED.beefRound), u64le(roundId)]);
/** Player's BEEF ATA (mint comes from BeefConfig, passed by the caller). */
export const playerBeefAta = (beefMint: PublicKey, wallet: PublicKey) =>
  getAssociatedTokenAddressSync(beefMint, wallet);
