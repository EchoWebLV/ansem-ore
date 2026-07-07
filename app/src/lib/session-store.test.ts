import { describe, it, expect, beforeEach } from "vitest";
import { Keypair } from "@solana/web3.js";
import { saveSession, loadSession, clearSession, type StoredSession } from "./session-store.js";

function fakeStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k), clear: () => m.clear(),
    key: (i) => [...m.keys()][i] ?? null, get length() { return m.size; },
  } as Storage;
}

describe("session-store", () => {
  let store: Storage;
  beforeEach(() => { store = fakeStorage(); });

  it("round-trips a session keyed by owner wallet", () => {
    const owner = Keypair.generate().publicKey.toBase58();
    const signer = Keypair.generate();
    const s: StoredSession = { owner, secretKey: Array.from(signer.secretKey), tokenPda: "TokenPda111", validUntil: 1_900_000_000 };
    saveSession(store, s);
    const back = loadSession(store, owner);
    expect(back?.tokenPda).toBe("TokenPda111");
    expect(back?.validUntil).toBe(1_900_000_000);
    expect(back?.secretKey).toEqual(s.secretKey);
  });

  it("returns null for a different owner and after clear", () => {
    const owner = Keypair.generate().publicKey.toBase58();
    const signer = Keypair.generate();
    saveSession(store, { owner, secretKey: Array.from(signer.secretKey), tokenPda: "T", validUntil: 1 });
    expect(loadSession(store, "OtherOwner")).toBeNull();
    clearSession(store, owner);
    expect(loadSession(store, owner)).toBeNull();
  });

  it("returns null for corrupt stored JSON", () => {
    const owner = "Owner1";
    store.setItem(`ansem.session.${owner}`, "{not json");
    expect(loadSession(store, owner)).toBeNull();
  });
});
