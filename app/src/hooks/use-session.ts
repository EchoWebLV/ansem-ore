"use client";
import { useCallback, useEffect, useState } from "react";
import { Keypair } from "@solana/web3.js";
import { isSessionValid } from "@ansem/sdk";
import { loadSession, saveSession, clearSession, type StoredSession } from "../lib/session-store.js";

export interface SessionInfo { session: StoredSession | null; signer: Keypair | null; valid: boolean; }

export function useSession(owner: string | undefined): SessionInfo & {
  persist: (s: StoredSession) => void; clear: () => void;
} {
  const [session, setSession] = useState<StoredSession | null>(null);

  const read = useCallback(() => {
    if (typeof window === "undefined" || !owner) { setSession(null); return; }
    setSession(loadSession(window.localStorage, owner));
  }, [owner]);

  useEffect(() => { read(); }, [read]);

  const persist = useCallback((s: StoredSession) => {
    if (typeof window !== "undefined") saveSession(window.localStorage, s);
    setSession(s);
  }, []);
  const clear = useCallback(() => {
    if (typeof window !== "undefined" && owner) clearSession(window.localStorage, owner);
    setSession(null);
  }, [owner]);

  // A corrupt/old-schema stored secret must not crash the render; null it and let the
  // player re-enter (valid=false forces the Enter button, which overwrites the bad entry).
  let signer: Keypair | null = null;
  if (session) {
    try { signer = Keypair.fromSecretKey(Uint8Array.from(session.secretKey)); }
    catch { signer = null; }
  }
  const nowSec = Math.floor((typeof Date !== "undefined" ? Date.now() : 0) / 1000);
  const valid = !!session && !!signer && isSessionValid(session.validUntil, nowSec);

  return { session, signer, valid, persist, clear };
}
