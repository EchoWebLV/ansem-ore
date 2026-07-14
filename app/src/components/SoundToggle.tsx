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
      className="flex h-10 w-10 items-center justify-center rounded-full border border-bull-edge bg-white/[0.03] text-[15px] hover:border-bull-green/60"
    >
      {muted ? "🔇" : "🔊"}
    </button>
  );
}
