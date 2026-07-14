"use client";
import { useEffect, useState } from "react";
import { isMuted, primeAudio, toggleMute } from "../lib/sound.js";

/**
 * Header sound switch. The click doubles as the browser audio-unlock gesture,
 * so even a pure spectator who only touches this button hears the reveals.
 */
export function SoundToggle() {
  const [muted, setMuted] = useState(false);
  // SSR-safe hydration: read the persisted flag only on the client, after mount.
  useEffect(() => { setMuted(isMuted()); }, []);
  return (
    <button
      type="button"
      aria-label="Toggle sound"
      aria-pressed={!muted}
      onClick={() => { primeAudio(); setMuted(toggleMute()); }}
      className="flex h-11 w-11 items-center justify-center rounded-[9px] border border-bull-edge bg-bull-raised text-[14px] text-bull-muted hover:border-bull-green/60 hover:text-bull-ink"
    >
      {muted ? "🔇" : "🔊"}
    </button>
  );
}
