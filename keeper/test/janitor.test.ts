import { describe, it, expect } from "vitest";
import { RoundState } from "@ansem/sdk";
import { selectCloseable, CloseableRound, MAX_CLOSE_PER_PASS } from "../src/janitor.js";

const r = (over: Partial<CloseableRound>): CloseableRound =>
  ({ roundId: 1, state: RoundState.Claimable, deadlineTs: 1000, pot: 0n, ...over });

describe("selectCloseable", () => {
  it("closes a CLAIMABLE round once its claim window has fully elapsed", () => {
    // window 60s: closeable when now >= deadline(1000) + 60 = 1060
    expect(selectCloseable([r({ roundId: 7, pot: 15n })], 60, 1100)).toEqual([7]);
  });

  it("leaves a CLAIMABLE round whose claim window is still open", () => {
    expect(selectCloseable([r({ roundId: 7, pot: 15n })], 60, 1030)).toEqual([]);
  });

  it("closes an EMPTY cancelled round instantly (CLOSED && pot == 0)", () => {
    expect(selectCloseable([r({ roundId: 9, state: RoundState.Closed, pot: 0n })], 60, 0)).toEqual([9]);
  });

  it("NEVER closes a NON-EMPTY cancelled round (refund_direct path must stay alive)", () => {
    expect(selectCloseable([r({ roundId: 9, state: RoundState.Closed, pot: 5n })], 60, 999_999)).toEqual([]);
  });

  it("ignores OPEN / SETTLED / VRF_PENDING rounds entirely", () => {
    const rounds = [
      r({ roundId: 1, state: RoundState.Open, pot: 0n }),
      r({ roundId: 2, state: RoundState.Settled, pot: 9n }),
      r({ roundId: 3, state: RoundState.VrfPending, pot: 9n }),
    ];
    expect(selectCloseable(rounds, 60, 999_999)).toEqual([]);
  });

  it("caps a single pass at MAX_CLOSE_PER_PASS", () => {
    const rounds: CloseableRound[] = Array.from({ length: MAX_CLOSE_PER_PASS + 5 }, (_, i) =>
      r({ roundId: i, state: RoundState.Closed, pot: 0n }));
    expect(selectCloseable(rounds, 60, 0)).toHaveLength(MAX_CLOSE_PER_PASS);
  });
});
