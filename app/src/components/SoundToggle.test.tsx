import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// Mock the sound module: the toggle only orchestrates prime + flip + reflect.
const snd = vi.hoisted(() => {
  const state = { muted: true };
  return {
    state,
    isMuted: vi.fn(() => state.muted),
    toggleMute: vi.fn(() => { state.muted = !state.muted; return state.muted; }),
    primeAudio: vi.fn(),
  };
});
vi.mock("../lib/sound.js", () => ({
  isMuted: snd.isMuted, toggleMute: snd.toggleMute, primeAudio: snd.primeAudio,
}));

import { SoundToggle } from "./SoundToggle.js";

describe("SoundToggle", () => {
  beforeEach(() => { snd.state.muted = true; vi.clearAllMocks(); });

  it("hydrates aria-pressed from the persisted mute state", () => {
    render(<SoundToggle />);
    const btn = screen.getByRole("button", { name: /toggle sound/i });
    expect(btn).toHaveAttribute("aria-pressed", "false"); // muted -> sound not on
    expect(btn).toHaveClass("h-9", "w-9", "rounded-[9px]", "border");
  });

  it("click primes audio (the unlock gesture) and flips the state", () => {
    render(<SoundToggle />);
    const btn = screen.getByRole("button", { name: /toggle sound/i });
    fireEvent.click(btn);
    expect(snd.primeAudio).toHaveBeenCalledTimes(1);
    expect(snd.toggleMute).toHaveBeenCalledTimes(1);
    expect(btn).toHaveAttribute("aria-pressed", "true"); // unmuted -> sound on
  });
});
