import { Program } from "@coral-xyz/anchor";
import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { AnsemMiner } from "../idl/ansem_miner.js";
import { configPda, roundPda, minerPda, escrowPda, playerAta, payoutVault, vaultAuthPda, ansemMintPda } from "../pdas.js";

export const depositIx = (p: Program<AnsemMiner>, wallet: PublicKey, lamports: anchor.BN) =>
  p.methods.deposit(lamports).accountsPartial({ authority: wallet });

export const withdrawIx = (p: Program<AnsemMiner>, wallet: PublicKey, lamports: anchor.BN) =>
  p.methods.withdraw(lamports).accountsPartial({ authority: wallet });

export const initMinerIx = (p: Program<AnsemMiner>, wallet: PublicKey) =>
  p.methods.initMiner().accountsPartial({ authority: wallet });

export const joinRoundIx = (p: Program<AnsemMiner>, wallet: PublicKey, roundId: number) =>
  p.methods.joinRound(new anchor.BN(roundId)).accountsPartial({ authority: wallet, config: configPda(), escrow: escrowPda(wallet) });

export const delegateMinerIx = (p: Program<AnsemMiner>, wallet: PublicKey, validator: PublicKey) =>
  p.methods.delegateMiner().accountsPartial({ payer: wallet, miner: minerPda(wallet) })
    .remainingAccounts([{ pubkey: validator, isSigner: false, isWritable: false }]);

/**
 * stake — the only gasless action. `authority` is whichever key SIGNS:
 *  - wallet-signed: authority = wallet, sessionToken = null
 *  - session-signed: authority = session signer pubkey, sessionToken = its token PDA
 * `stakerWallet` is always the OWNING wallet (miner/escrow are seeded on it).
 */
export const stakeIx = (
  p: Program<AnsemMiner>, authority: PublicKey, stakerWallet: PublicKey,
  square: number, amount: anchor.BN, roundId: number, sessionToken: PublicKey | null,
) => p.methods.stake(square, amount).accountsPartial({
  authority, config: configPda(), round: roundPda(roundId),
  miner: minerPda(stakerWallet), escrow: escrowPda(stakerWallet), sessionToken,
});

export const claimIx = (p: Program<AnsemMiner>, wallet: PublicKey, roundId: number) =>
  p.methods.claim(new anchor.BN(roundId)).accountsPartial({
    authority: wallet, round: roundPda(roundId), ansemMint: ansemMintPda(),
    vaultAuthority: vaultAuthPda(), payoutVault: payoutVault(), playerAta: playerAta(wallet),
  });

export const refundIx = (p: Program<AnsemMiner>, wallet: PublicKey, roundId: number) =>
  p.methods.refund(new anchor.BN(roundId)).accountsPartial({
    authority: wallet, config: configPda(), round: roundPda(roundId),
    escrow: escrowPda(wallet), miner: minerPda(wallet),
  });
