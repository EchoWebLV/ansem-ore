import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { RoundState } from "@ansem/sdk";
import type { WireSnapshot } from "@ansem/sdk";

// Sound is a side effect of the finale; mock the module so the tests can assert
// WHICH finale rang (bell vs rollover) without touching Web Audio.
const sound = vi.hoisted(() => ({
  playTap: vi.fn(), playFill: vi.fn(), playJackpot: vi.fn(), playRollover: vi.fn(),
}));
vi.mock("../lib/sound.js", () => sound);

import { Board } from "./Board.js";

const snap = (over: Partial<WireSnapshot> = {}): WireSnapshot => ({
  roundId: 1, state: RoundState.Open, deadlineTs: 0, pot: "100",
  blockSol: Array(25).fill("0"), jackpotSquare: null, jackpotPool: "0",
  rolloverJackpot: "0", updatedAt: 1, leaderboard: [], recentEvents: [], ...over,
});

describe("Board", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("renders 25 tiles keyed by on-chain square", () => {
    render(<Board snapshot={snap()} />);
    for (let i = 0; i < 25; i++) {
      expect(screen.getByTestId(`tile-${i}`)).toBeInTheDocument();
    }
  });

  it("renders plain squares — no image assets", () => {
    const { container } = render(<Board snapshot={snap()} />);
    expect(container.querySelector("img")).toBeNull();
  });

  it("lights a staked square green (data-lit)", () => {
    const blockSol = Array(25).fill("0"); blockSol[3] = "60"; blockSol[8] = "40";
    render(<Board snapshot={snap({ blockSol, pot: "100" })} />);
    expect(screen.getByTestId("tile-3")).toHaveAttribute("data-lit", "true");
    expect(screen.getByTestId("tile-0")).toHaveAttribute("data-lit", "false");
  });

  it("uses the terminal board surface without continuous live breathing", () => {
    const blockSol = Array(25).fill("0"); blockSol[3] = "60";
    render(<Board snapshot={snap({ blockSol })} />);
    expect(screen.getByTestId("bull-board")).toBeInTheDocument();
    expect(screen.getByTestId("tile-3").querySelector(".glow-live")).toBeNull();
  });

  it("flags the jackpot square gold only once settled", () => {
    const settled = snap({ state: RoundState.Settled, jackpotSquare: 7 });
    render(<Board snapshot={settled} />);
    expect(screen.getByTestId("tile-7")).toHaveAttribute("data-jackpot", "true");
  });

  it("renders nothing-jackpot while still open", () => {
    render(<Board snapshot={snap({ state: RoundState.Open, jackpotSquare: null })} />);
    expect(screen.getByTestId("tile-7")).toHaveAttribute("data-jackpot", "false");
  });

  it("renders the 3D prism: one extrusion layer under every face", () => {
    const { container } = render(<Board snapshot={snap()} />);
    expect(container.querySelectorAll("[data-depth]")).toHaveLength(25);
  });

  it("fires the gold shockwave ring on the jackpot square once settled", () => {
    render(<Board snapshot={snap({ state: RoundState.Settled, jackpotSquare: 7 })} />);
    expect(screen.getByTestId("ring-7")).toBeInTheDocument();
    expect(screen.queryByTestId("ring-3")).toBeNull();
  });

  it("calls onSelect with the square id when a tile is clicked and highlights every selected square", () => {
    const onSelect = vi.fn();
    const { container, rerender } = render(<Board snapshot={snap()} onSelect={onSelect} selectedSquares={[]} />);
    const tiles = container.querySelectorAll("[data-square]");
    fireEvent.click(tiles[3]);
    expect(onSelect).toHaveBeenCalledWith(3);
    rerender(<Board snapshot={snap()} onSelect={onSelect} selectedSquares={[3, 7]} />);
    expect(container.querySelector('[data-square="3"]')?.getAttribute("data-selected")).toBe("true");
    expect(container.querySelector('[data-square="7"]')?.getAttribute("data-selected")).toBe("true");
    expect(container.querySelector('[data-square="0"]')?.getAttribute("data-selected")).toBe("false");
  });

  it("finale rings the jackpot bell for settle/default reveals", () => {
    render(
      <Board
        snapshot={snap({ state: RoundState.Settled, jackpotSquare: 7 })}
        revealed={Array.from({ length: 25 }, (_, i) => i)}
        jackpotShown
      />,
    );
    expect(sound.playJackpot).toHaveBeenCalledTimes(1);
    expect(sound.playRollover).not.toHaveBeenCalled();
  });

  it("finale plays the rollover sound, not the bell, in sweep mode", () => {
    render(
      <Board
        snapshot={snap()}
        revealMode="sweep"
        revealed={Array.from({ length: 25 }, (_, i) => i)}
        jackpotShown
      />,
    );
    expect(sound.playRollover).toHaveBeenCalledTimes(1);
    expect(sound.playJackpot).not.toHaveBeenCalled();
  });
});
