import { Connection, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { PROGRAM_ID } from "@ansem/sdk";

// Offsets/sizes are locked to programs/ansem-miner/src/state/{miner,escrow}.rs.
export const MINER_ROUND_ID_OFFSET = 40;       // 8 disc + 32 authority
export const ESCROW_ACTIVE_ROUND_OFFSET = 72;  // 8 + 32 + 8 (balance) + 8 + 8 + 8
export const MINER_ACCOUNT_SIZE = 249;         // 8 + 32 + 8 + 25*8 + 1
export const ESCROW_ACCOUNT_SIZE = 89;         // 8 + 32 + 8*6 + 1

const AUTHORITY_OFFSET = 8; // both accounts: pubkey immediately after the discriminator

export function u64LEBytes(n: number | bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(n));
  return buf;
}
export const decodeMinerAuthority = (data: Buffer): PublicKey =>
  new PublicKey(data.subarray(AUTHORITY_OFFSET, AUTHORITY_OFFSET + 32));
export const decodeEscrowAuthority = (data: Buffer): PublicKey =>
  new PublicKey(data.subarray(AUTHORITY_OFFSET, AUTHORITY_OFFSET + 32));

/**
 * Authoritative joined roster: escrow is never delegated, so this returns every
 * wallet with escrow.active_round == roundId on L1. Drives BOTH the commit_miner
 * and the reconcile_miner passes (reconcile clears the withdraw-lock for joined-
 * but-unstaked wallets too -- spec §7).
 */
export async function fetchJoinedWallets(conn: Connection, roundId: number): Promise<PublicKey[]> {
  const accts = await conn.getProgramAccounts(PROGRAM_ID, {
    filters: [
      { dataSize: ESCROW_ACCOUNT_SIZE },
      { memcmp: { offset: ESCROW_ACTIVE_ROUND_OFFSET, bytes: bs58.encode(u64LEBytes(roundId)) } },
    ],
  });
  return accts.map((a) => decodeEscrowAuthority(a.account.data as Buffer));
}

/**
 * Program-owned (post-commit) miner PDAs for a round. Returns [] while the round
 * is OPEN (miners still delegated to the DLP). Used for the reconcile pass and
 * the leaderboard once accounts are back on L1.
 */
export async function fetchStakerWallets(conn: Connection, roundId: number): Promise<PublicKey[]> {
  const accts = await conn.getProgramAccounts(PROGRAM_ID, {
    filters: [
      { dataSize: MINER_ACCOUNT_SIZE },
      { memcmp: { offset: MINER_ROUND_ID_OFFSET, bytes: bs58.encode(u64LEBytes(roundId)) } },
    ],
  });
  return accts.map((a) => decodeMinerAuthority(a.account.data as Buffer));
}
