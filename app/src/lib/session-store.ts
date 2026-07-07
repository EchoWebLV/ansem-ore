export interface StoredSession {
  owner: string;        // owner wallet base58
  secretKey: number[];  // session Keypair secret (64 bytes) — devnet only
  tokenPda: string;     // gum session token PDA base58
  validUntil: number;   // unix seconds
}

const key = (owner: string) => `ansem.session.${owner}`;

export function saveSession(store: Storage, s: StoredSession): void {
  store.setItem(key(s.owner), JSON.stringify(s));
}
export function loadSession(store: Storage, owner: string): StoredSession | null {
  const raw = store.getItem(key(owner));
  if (!raw) return null;
  try { return JSON.parse(raw) as StoredSession; } catch { return null; }
}
export function clearSession(store: Storage, owner: string): void {
  store.removeItem(key(owner));
}
