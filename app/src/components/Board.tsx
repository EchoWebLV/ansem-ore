"use client";
import { useEffect, useRef } from "react";
import { RoundState, type WireSnapshot } from "@ansem/sdk";
import { svgCells } from "../lib/board-layout.js";
import { playTap, playFill, playJackpot, playRollover } from "../lib/sound.js";

const CELLS = svgCells();

// Design tokens — docs/design/bull-board.html (the user's prototype).
const C = {
  green: "#35e07a", greenf: "rgba(53,224,122,0.15)",
  gold: "#e8c452", goldf: "rgba(232,196,82,0.24)",
  dim: "#2c4034",
} as const;

// How far each hex face floats above its prism side (viewBox units).
const DEPTH = 5;

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
  /** Which show is running — the sweep finale plays the rollover sound, not the bell. */
  revealMode?: "settle" | "sweep" | null;
}

/**
 * The prototype's hex bull-head, extruded: every cell is a glass prism (dark side
 * layer + gradient face), lit cells breathe, revealed cells pop in, the jackpot
 * detonates a gold shockwave ring. All state/testid contracts unchanged.
 */
export function Board({ snapshot, selectedSquares = [], onSelect, revealed = null, jackpotShown, revealMode }: BoardProps) {
  const settled = snapshot.state >= RoundState.Settled;
  const revealSet = revealed === null ? null : new Set(revealed);

  // Reveal cascade audio: chime the next rising note each time a cell is unveiled,
  // and ring the jackpot bell once the gold square detonates.
  const revealedCount = revealed?.length ?? 0;
  const prevRevealed = useRef(0);
  useEffect(() => {
    if (revealedCount > prevRevealed.current) {
      for (let i = prevRevealed.current; i < revealedCount; i++) playFill(i);
    }
    prevRevealed.current = revealedCount;
  }, [revealedCount]);
  const jackpotRung = useRef(false);
  useEffect(() => {
    if (jackpotShown && !jackpotRung.current) {
      // Sweep finales (empty round, no draw) get the soft rollover, not the bell.
      if (revealMode === "sweep") playRollover(); else playJackpot();
      jackpotRung.current = true;
    }
    if (!jackpotShown) jackpotRung.current = false;
  }, [jackpotShown, revealMode]);
  return (
    <svg
      viewBox="0 0 400 348"
      role="img"
      aria-label="Bull-head board of 25 hex cells"
      className="block w-full my-[10px] mb-[4px] select-none touch-manipulation"
    >
      <defs>
        <filter id="glow" x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="2.6" />
        </filter>
        {/* Face gradients: light falls from the top edge, prism-style. */}
        <linearGradient id="faceIdle" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="rgba(255,255,255,0.055)" />
          <stop offset="100%" stopColor="rgba(8,8,12,0.6)" />
        </linearGradient>
        <linearGradient id="faceLit" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="rgba(53,224,122,0.34)" />
          <stop offset="100%" stopColor="rgba(53,224,122,0.07)" />
        </linearGradient>
        <linearGradient id="faceGold" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="rgba(232,196,82,0.45)" />
          <stop offset="100%" stopColor="rgba(232,196,82,0.12)" />
        </linearGradient>
        <radialGradient id="floorGlow">
          <stop offset="0%" stopColor="rgba(53,224,122,0.16)" />
          <stop offset="100%" stopColor="rgba(53,224,122,0)" />
        </radialGradient>
      </defs>
      {/* Soft floor glow the bull hovers over. */}
      <ellipse cx={200} cy={338} rx={160} ry={9} fill="url(#floorGlow)" />
      {CELLS.map((cell) => {
        const stake = BigInt(snapshot.blockSol[cell.id] ?? "0");
        // Live board lights real stakes; during the reveal, cells light as unveiled.
        const lit = revealSet === null ? stake > 0n : revealSet.has(cell.id);
        // The jackpot flashes gold once settled — during the reveal only at the finale.
        const jackpot = settled && snapshot.jackpotSquare === cell.id && (revealSet === null || jackpotShown === true);
        const selected = selectedSquares.includes(cell.id);
        const stroke = selected ? "#ffffff" : jackpot ? C.gold : lit ? C.green : C.dim;
        const fill = jackpot ? "url(#faceGold)" : lit ? "url(#faceLit)" : "url(#faceIdle)";
        // Selected picks glow white so they pop against lit/idle neighbours.
        const glow = selected ? "rgba(255,255,255,0.85)" : jackpot ? C.gold : lit ? C.green : "none";
        const side = jackpot ? "#3a2c10" : lit ? "#0d2b1a" : "#060609";
        const faceClass =
          "cell-face" +
          (selected ? " lift" : "") +
          (revealSet !== null && lit && !jackpot ? " pop" : "") +
          (jackpot ? " burst" : "");
        return (
          <g
            key={cell.id}
            data-testid={`tile-${cell.id}`}
            data-square={cell.id}
            data-lit={lit ? "true" : "false"}
            data-jackpot={jackpot ? "true" : "false"}
            data-selected={selected ? "true" : "false"}
            onClick={onSelect ? () => { playTap(); onSelect(cell.id); } : undefined}
            className={onSelect ? "cursor-pointer" : undefined}
          >
            {/* Prism side: the dark extrusion the face floats above. */}
            <polygon
              data-depth
              points={cell.points}
              transform={`translate(0 ${DEPTH})`}
              fill={side}
              stroke="#000"
              strokeOpacity={0.55}
              strokeWidth={1}
              strokeLinejoin="round"
            />
            <g className={faceClass}>
              <polygon
                points={cell.points}
                fill="none"
                stroke={glow}
                strokeWidth={3}
                filter="url(#glow)"
                className={revealSet === null && lit ? "glow-live" : undefined}
              />
              <polygon
                points={cell.points}
                fill={fill}
                stroke={stroke}
                strokeWidth={jackpot ? 2.8 : selected ? 2.2 : 1.5}
                strokeLinejoin="round"
                style={{ transition: "all .18s" }}
              />
              {cell.eye && (
                <circle
                  className="bull-eye"
                  cx={cell.cx}
                  cy={cell.cy}
                  r={cell.r * (0.24 / 0.9)}
                  fill={C.green}
                  opacity={0.85}
                  filter="url(#glow)"
                />
              )}
              {jackpot && (
                <circle
                  data-testid={`ring-${cell.id}`}
                  className="jackpot-ring"
                  cx={cell.cx}
                  cy={cell.cy}
                  r={cell.r * 1.05}
                  fill="none"
                  stroke={C.gold}
                  strokeWidth={2}
                />
              )}
            </g>
          </g>
        );
      })}
    </svg>
  );
}
