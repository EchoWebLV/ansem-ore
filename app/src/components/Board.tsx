"use client";
import { RoundState, type WireSnapshot } from "@ansem/sdk";
import { svgCells } from "../lib/board-layout.js";

const CELLS = svgCells();

// Design tokens — docs/design/bull-board.html (the user's prototype).
const C = {
  green: "#35e07a", greenf: "rgba(53,224,122,0.15)",
  gold: "#e8c452", goldf: "rgba(232,196,82,0.24)",
  dim: "#2c4034",
} as const;

export interface BoardProps {
  snapshot: WireSnapshot;
  /** Squares currently picked for staking (multi-select, ORE-style). */
  selectedSquares?: number[];
  /** When set, tiles are clickable; clicking toggles membership upstream. */
  onSelect?: (id: number) => void;
  /** Reveal theater: ids unveiled so far (null = live board shows real stakes). */
  revealed?: number[] | null;
  /** Finale flag: the jackpot square flashes gold. */
  jackpotShown?: boolean;
}

export function Board({ snapshot, selectedSquares = [], onSelect, revealed = null, jackpotShown }: BoardProps) {
  const settled = snapshot.state >= RoundState.Settled;
  const revealSet = revealed === null ? null : new Set(revealed);
  return (
    <svg
      viewBox="0 0 400 340"
      role="img"
      aria-label="Bull-head board of 25 hex cells"
      className="block w-full my-[10px] mb-[4px]"
    >
      <defs>
        <filter id="glow" x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="2.6" />
        </filter>
      </defs>
      {CELLS.map((cell) => {
        const stake = BigInt(snapshot.blockSol[cell.id] ?? "0");
        // Live board lights real stakes; during the reveal, cells light as unveiled.
        const lit = revealSet === null ? stake > 0n : revealSet.has(cell.id);
        // The jackpot flashes gold once settled — during the reveal only at the finale.
        const jackpot = settled && snapshot.jackpotSquare === cell.id && (revealSet === null || jackpotShown === true);
        const selected = selectedSquares.includes(cell.id);
        const stroke = selected ? "#ffffff" : jackpot ? C.gold : lit ? C.green : C.dim;
        const fill = jackpot ? C.goldf : lit ? C.greenf : "transparent";
        const glow = jackpot ? C.gold : lit ? C.green : "none";
        return (
          <g
            key={cell.id}
            data-testid={`tile-${cell.id}`}
            data-square={cell.id}
            data-lit={lit ? "true" : "false"}
            data-jackpot={jackpot ? "true" : "false"}
            data-selected={selected ? "true" : "false"}
            onClick={onSelect ? () => onSelect(cell.id) : undefined}
            className={onSelect ? "cursor-pointer" : undefined}
          >
            <polygon points={cell.points} fill="none" stroke={glow} strokeWidth={3} filter="url(#glow)" />
            <polygon
              points={cell.points}
              fill={fill}
              stroke={stroke}
              strokeWidth={jackpot ? 2.8 : selected ? 2.2 : 1.5}
              strokeLinejoin="round"
              style={{ transition: "all .18s" }}
            />
            {cell.eye && (
              <circle cx={cell.cx} cy={cell.cy} r={cell.r * (0.24 / 0.9)} fill={C.green} opacity={0.85} filter="url(#glow)" />
            )}
          </g>
        );
      })}
    </svg>
  );
}
