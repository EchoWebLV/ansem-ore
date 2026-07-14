import { describe, it, expect, vi, beforeEach } from "vitest";

// Module state (muted flag) is per-import: reset modules so each test gets a
// fresh sound.ts that has never played anything.
describe("sound mute persistence", () => {
  beforeEach(() => {
    vi.resetModules();
    window.localStorage.clear();
  });

  it("isMuted() reads the persisted flag before any sound has ever played", async () => {
    window.localStorage.setItem("ansem.muted.v1", "1");
    const { isMuted } = await import("./sound.js");
    expect(isMuted()).toBe(true);
  });

  it("toggleMute() flips from the persisted baseline, not from a stale default", async () => {
    window.localStorage.setItem("ansem.muted.v1", "1");
    const { toggleMute, isMuted } = await import("./sound.js");
    expect(toggleMute()).toBe(false); // persisted muted -> first toggle unmutes
    expect(window.localStorage.getItem("ansem.muted.v1")).toBe("0");
    expect(isMuted()).toBe(false);
  });
});
