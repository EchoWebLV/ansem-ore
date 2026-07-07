import { Connection, PublicKey, Keypair, TransactionInstruction } from "@solana/web3.js";
import { Wallet } from "@coral-xyz/anchor";
import { BN } from "./bn.js";
import { SessionTokenManager } from "@magicblock-labs/gum-sdk";
import { PROGRAM_ID } from "./constants.js";
import { sessionTokenPda } from "./pdas.js";

export const deriveSessionToken = (sessionSigner: PublicKey, authorityWallet: PublicKey, target = PROGRAM_ID) =>
  sessionTokenPda(sessionSigner, authorityWallet, target);

/** now < valid_until, minus a margin (seconds) so a stake can't race expiry. */
export const isSessionValid = (validUntil: number, nowSec: number, marginSec = 30) =>
  nowSec + marginSec < validUntil;

/**
 * Mint a SessionTokenV2 (one wallet popup). Returns the token PDA + the ephemeral signer
 * and a `send()` that submits the createSessionV2 tx (feePayer + authority = the owner wallet,
 * signed additionally by the ephemeral session signer). The app/keeper controls submission.
 */
export function buildCreateSession(
  connection: Connection, ownerWallet: Wallet, validUntilSec: number, target = PROGRAM_ID,
): { sessionSigner: Keypair; tokenPda: PublicKey; send: () => Promise<string> } {
  const gum = new SessionTokenManager(ownerWallet, connection).program;
  const sessionSigner = Keypair.generate();
  const tokenPda = sessionTokenPda(sessionSigner.publicKey, ownerWallet.publicKey, target);
  const send = () =>
    gum.methods.createSessionV2(false, new BN(validUntilSec), null)
      .accountsPartial({
        sessionToken: tokenPda, sessionSigner: sessionSigner.publicKey,
        feePayer: ownerWallet.publicKey, authority: ownerWallet.publicKey, targetProgram: target,
      })
      .signers([sessionSigner]).rpc();
  return { sessionSigner, tokenPda, send };
}

/**
 * The gum `createSessionV2` instruction (not sent) so it can be batched into the
 * one-popup entry tx. The returned tx must be co-signed by `sessionSigner` and the
 * owner wallet (feePayer + authority).
 */
export async function buildCreateSessionIx(
  connection: Connection, ownerWallet: Wallet, validUntilSec: number, target = PROGRAM_ID,
): Promise<{ sessionSigner: Keypair; tokenPda: PublicKey; ix: TransactionInstruction; validUntil: number }> {
  const gum = new SessionTokenManager(ownerWallet, connection).program;
  const sessionSigner = Keypair.generate();
  const tokenPda = sessionTokenPda(sessionSigner.publicKey, ownerWallet.publicKey, target);
  const ix = await gum.methods.createSessionV2(false, new BN(validUntilSec), null)
    .accountsPartial({
      sessionToken: tokenPda, sessionSigner: sessionSigner.publicKey,
      feePayer: ownerWallet.publicKey, authority: ownerWallet.publicKey, targetProgram: target,
    })
    .instruction();
  return { sessionSigner, tokenPda, ix, validUntil: validUntilSec };
}
