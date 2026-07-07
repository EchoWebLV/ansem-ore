import { describe, it, expect } from "vitest";
import { Keypair } from "@solana/web3.js";
import {
  MINER_ROUND_ID_OFFSET, ESCROW_ACTIVE_ROUND_OFFSET, MINER_ACCOUNT_SIZE, ESCROW_ACCOUNT_SIZE,
  u64LEBytes, decodeMinerAuthority, decodeEscrowAuthority,
} from "../src/participants.js";

describe("participant index layout constants", () => {
  it("locks the memcmp offsets to the on-chain layout", () => {
    expect(MINER_ROUND_ID_OFFSET).toBe(40);       // 8 disc + 32 authority
    expect(ESCROW_ACTIVE_ROUND_OFFSET).toBe(72);  // 8 + 32 + 8*4
    expect(MINER_ACCOUNT_SIZE).toBe(249);         // 8 + 32 + 8 + 25*8 + 1
    expect(ESCROW_ACCOUNT_SIZE).toBe(89);         // 8 + 32 + 8*6 + 1
  });

  it("encodes a u64 round id little-endian for memcmp", () => {
    expect([...u64LEBytes(1)]).toEqual([1, 0, 0, 0, 0, 0, 0, 0]);
    expect([...u64LEBytes(256)]).toEqual([0, 1, 0, 0, 0, 0, 0, 0]);
  });

  it("decodes the authority pubkey from a raw miner account", () => {
    const kp = Keypair.generate();
    const data = Buffer.alloc(MINER_ACCOUNT_SIZE);
    kp.publicKey.toBuffer().copy(data, 8); // authority at offset 8
    expect(decodeMinerAuthority(data).equals(kp.publicKey)).toBe(true);
  });

  it("decodes the authority pubkey from a raw escrow account", () => {
    const kp = Keypair.generate();
    const data = Buffer.alloc(ESCROW_ACCOUNT_SIZE);
    kp.publicKey.toBuffer().copy(data, 8);
    expect(decodeEscrowAuthority(data).equals(kp.publicKey)).toBe(true);
  });
});
