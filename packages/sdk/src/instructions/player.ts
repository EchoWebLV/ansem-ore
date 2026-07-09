import { Program } from "@coral-xyz/anchor";
import { BN } from "../bn.js";
import { PublicKey } from "@solana/web3.js";
import { AnsemMiner } from "../idl/ansem_miner.js";
import { configPda, roundPda, minerPda, escrowPda, playerAta, payoutVault, vaultAuthPda, ansemMintPda,
  beefConfigPda, beefMinerPda, beefRoundPda, playerBeefAta } from "../pdas.js";

export const depositIx = (p: Program<AnsemMiner>, wallet: PublicKey, lamports: BN) =>
  p.methods.deposit(lamports).accountsPartial({ authority: wallet });

export const withdrawIx = (p: Program<AnsemMiner>, wallet: PublicKey, lamports: BN) =>
  p.methods.withdraw(lamports).accountsPartial({ authority: wallet });

export const initMinerIx = (p: Program<AnsemMiner>, wallet: PublicKey) =>
  p.methods.initMiner().accountsPartial({ authority: wallet });

export const joinRoundIx = (p: Program<AnsemMiner>, wallet: PublicKey, roundId: number) =>
  p.methods.joinRound(new BN(roundId)).accountsPartial({ authority: wallet, config: configPda(), escrow: escrowPda(wallet) });

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
  square: number, amount: BN, roundId: number, sessionToken: PublicKey | null,
) => p.methods.stake(square, amount).accountsPartial({
  authority, config: configPda(), round: roundPda(roundId),
  miner: minerPda(stakerWallet), escrow: escrowPda(stakerWallet), sessionToken,
});

export const claimIx = (p: Program<AnsemMiner>, wallet: PublicKey, roundId: number) =>
  p.methods.claim(new BN(roundId)).accountsPartial({
    authority: wallet, round: roundPda(roundId), ansemMint: ansemMintPda(),
    vaultAuthority: vaultAuthPda(), payoutVault: payoutVault(), playerAta: playerAta(wallet),
  });

export const refundIx = (p: Program<AnsemMiner>, wallet: PublicKey, roundId: number) =>
  p.methods.refund(new BN(roundId)).accountsPartial({
    authority: wallet, config: configPda(), round: roundPda(roundId),
    escrow: escrowPda(wallet), miner: minerPda(wallet),
  });

// ---- Direct-stake engine (ORE model): wallet -> pot inside the stake tx.
// No escrow, no session, no delegation. Multi-square = several stakeDirect
// instructions batched into ONE transaction (single wallet approval).

export const stakeDirectIx = (p: Program<AnsemMiner>, wallet: PublicKey, roundId: number, square: number, amount: BN) =>
  p.methods.stakeDirect(new BN(roundId), square, amount).accountsPartial({
    authority: wallet, config: configPda(), round: roundPda(roundId), miner: minerPda(wallet),
  });

export const claimDirectIx = (p: Program<AnsemMiner>, wallet: PublicKey, roundId: number) =>
  p.methods.claimDirect(new BN(roundId)).accountsPartial({
    authority: wallet, config: configPda(), round: roundPda(roundId), miner: minerPda(wallet),
    ansemMint: ansemMintPda(), vaultAuthority: vaultAuthPda(), payoutVault: payoutVault(), playerAta: playerAta(wallet),
  });

export const refundDirectIx = (p: Program<AnsemMiner>, wallet: PublicKey, roundId: number) =>
  p.methods.refundDirect(new BN(roundId)).accountsPartial({
    authority: wallet, config: configPda(), round: roundPda(roundId), miner: minerPda(wallet),
  });

// ---- BEEF vault emission layer ----
// ORDERING INVARIANT: rollBeef must run BEFORE any block_stake-zeroing ix in
// the same bundle — claimDirect zeroes stakes and stakeDirect re-stamps the
// miner to a new round, either of which forfeits the un-rolled BEEF share.
//   harvest bundle:  [rollBeef(r), claimDirect(r), claimBeef]
//   restake bundle:  [rollBeef(prevR), stakeDirect(newR)...]
// rollBeef is a no-op (never an error) when already rolled / nothing to roll,
// so including it defensively can never block the ANSEM game.

export const rollBeefIx = (p: Program<AnsemMiner>, wallet: PublicKey, roundId: number) =>
  p.methods.rollBeef(new BN(roundId)).accountsPartial({
    authority: wallet, round: roundPda(roundId), miner: minerPda(wallet),
    beefRound: beefRoundPda(roundId), beefConfig: beefConfigPda(), beefMiner: beefMinerPda(wallet),
  });

export const claimBeefIx = (p: Program<AnsemMiner>, wallet: PublicKey, beefMint: PublicKey, beefVault: PublicKey) =>
  p.methods.claimBeef().accountsPartial({
    authority: wallet, beefConfig: beefConfigPda(), beefMiner: beefMinerPda(wallet),
    beefMint, vaultAuthority: vaultAuthPda(), beefVault,
    playerBeefAta: playerBeefAta(beefMint, wallet),
  });
