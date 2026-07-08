"use client";
import { RoundState, type WireSnapshot } from "@ansem/sdk";
import { bullCells } from "../lib/board-layout.js";

const CELLS = bullCells();

export interface BoardProps {
  snapshot: WireSnapshot;
  /** Squares currently picked for staking (multi-select, ORE-style). */
  selectedSquares?: number[];
  /** When set, tiles are clickable; clicking toggles membership upstream. */
  onSelect?: (id: number) => void;
}

export function Board({ snapshot, selectedSquares = [], onSelect }: BoardProps) {
  const pot = BigInt(snapshot.pot || "0");
  const settled = snapshot.state >= RoundState.Settled;
  return (
    <div className="relative w-full aspect-[400/340] mx-auto max-w-[460px]">
      {CELLS.map((cell) => {
        const stake = BigInt(snapshot.blockSol[cell.id] ?? "0");
        const lit = stake > 0n;
        const jackpot = settled && snapshot.jackpotSquare === cell.id;
        // stake share [0,1] -> glow opacity; guard div-by-zero.
        const share = pot > 0n ? Number((stake * 1000n) / pot) / 1000 : 0;
        const glow = jackpot ? "0 0 18px 4px #e8c452" : lit ? `0 0 ${6 + share * 22}px 2px #35e07a` : "none";
        const selected = selectedSquares.includes(cell.id);
        return (
          <div
            key={cell.id}
            data-testid={`tile-${cell.id}`}
            data-square={cell.id}
            data-lit={lit ? "true" : "false"}
            data-jackpot={jackpot ? "true" : "false"}
            data-selected={selected ? "true" : "false"}
            onClick={onSelect ? () => onSelect(cell.id) : undefined}
            className={`absolute -translate-x-1/2 -translate-y-1/2 aspect-square rounded-md transition-all duration-300${onSelect ? " cursor-pointer" : ""}`}
            style={{
              left: `${cell.left * 100}%`,
              top: `${cell.top * 100}%`,
              width: "17%",
              boxShadow: glow,
              // Prototype palette (docs/design/bull-board.html): transparent square,
              // green-tint fill when staked, gold-tint on the jackpot square.
              background: jackpot ? "rgba(232,196,82,0.24)" : lit ? "rgba(53,224,122,0.15)" : "transparent",
              outline: selected ? "2px solid #fff" : jackpot ? "2px solid #e8c452" : lit ? "1px solid #35e07a" : "1px solid #2c4034",
              opacity: lit || jackpot || selected ? 1 : 0.5,
            }}
          >
            {cell.eye && (
              <span className="absolute inset-0 m-auto h-1/4 w-1/4 rounded-full bg-bull-green/80 blur-[1px]" />
            )}
          </div>
        );
      })}
    </div>
  );
}
