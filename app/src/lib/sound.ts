"use client";

// Procedural game audio — synthesized with the Web Audio API, no asset files
// (keeps the bundle light and every sound original/license-clean). Safe to call
// in any environment: it no-ops when Web Audio is unavailable (SSR, jsdom tests).

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let muted = false;
let muteLoaded = false;

const MUTE_KEY = "ansem.muted.v1";

/**
 * Load the persisted mute flag once, lazily — BEFORE any audio initializes, so
 * isMuted()/toggleMute() are honest even if no sound has ever played.
 */
function ensureMuteLoaded(): void {
  if (muteLoaded || typeof window === "undefined") return;
  muteLoaded = true;
  try { muted = window.localStorage?.getItem(MUTE_KEY) === "1"; } catch { /* ignore */ }
}

function audio(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return null;
  if (!ctx) {
    try {
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = 0.5;
      master.connect(ctx.destination);
    } catch {
      return null;
    }
  }
  // Browsers start the context suspended until a user gesture; resume on demand.
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

/**
 * User-gesture unlock: create/resume the context inside a click so spectators
 * (who never tap a tile) still hear the reveal when it comes.
 */
export function primeAudio(): void {
  void audio();
}

/** One enveloped voice: oscillator -> gain -> master, with a quick pluck decay. */
function voice(
  freq: number,
  { type = "triangle", dur = 0.18, gain = 0.16, delay = 0, attack = 0.006 }:
    { type?: OscillatorType; dur?: number; gain?: number; delay?: number; attack?: number } = {},
): void {
  ensureMuteLoaded();
  const ac = audio();
  if (!ac || !master || muted) return;
  const t0 = ac.currentTime + delay;
  const osc = ac.createOscillator();
  const g = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  // Percussive envelope: fast attack, exponential decay to near-silence.
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g);
  g.connect(master);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

// A-minor pentatonic (Hz), the ascending run the reveal walks through.
const PENTA = [440.0, 523.25, 587.33, 659.25, 783.99, 880.0, 1046.5, 1174.66, 1318.51, 1567.98];

/** Hex pick: a soft marimba-ish pluck (root + a whisper of the octave for warmth). */
export function playTap(): void {
  voice(523.25, { type: "triangle", dur: 0.16, gain: 0.16 });
  voice(1046.5, { type: "sine", dur: 0.12, gain: 0.05, delay: 0.005 });
}

/** Reveal cascade: the nth unveiled cell plays the nth step of the rising run. */
export function playFill(index: number): void {
  const f = PENTA[Math.min(index, PENTA.length - 1)];
  voice(f, { type: "triangle", dur: 0.22, gain: 0.14 });
  voice(f * 2, { type: "sine", dur: 0.14, gain: 0.04, delay: 0.004 });
}

/** Jackpot finale: a bright bell chord (root/third/fifth/octave) that rings out. */
export function playJackpot(): void {
  const chord = [523.25, 659.25, 783.99, 1046.5];
  chord.forEach((f, i) =>
    voice(f, { type: "sine", dur: 1.1, gain: 0.13, delay: i * 0.05, attack: 0.01 }),
  );
  // A little shimmer on top.
  voice(1567.98, { type: "triangle", dur: 0.9, gain: 0.05, delay: 0.18 });
}

/** Empty-round finale: a soft downward glide + a low quiet thud — "nothing this round". */
export function playRollover(): void {
  ensureMuteLoaded();
  const ac = audio();
  if (!ac || !master || muted) return;
  const t0 = ac.currentTime;
  const osc = ac.createOscillator();
  const g = ac.createGain();
  osc.type = "triangle";
  osc.frequency.setValueAtTime(660, t0);
  osc.frequency.exponentialRampToValueAtTime(440, t0 + 0.3);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(0.1, t0 + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.34);
  osc.connect(g);
  g.connect(master);
  osc.start(t0);
  osc.stop(t0 + 0.36);
  voice(110, { type: "sine", dur: 0.3, gain: 0.08, attack: 0.01 });
}

export function isMuted(): boolean {
  ensureMuteLoaded();
  return muted;
}

/** Toggle + persist mute; returns the new state. */
export function toggleMute(): boolean {
  ensureMuteLoaded();
  muted = !muted;
  try { window.localStorage?.setItem(MUTE_KEY, muted ? "1" : "0"); } catch { /* ignore */ }
  return muted;
}
