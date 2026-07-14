"use client";
import { useEffect, useRef } from "react";
import { RoundState, type WireSnapshot } from "@ansem/sdk";
import { svgCells } from "../lib/board-layout.js";
import { playTap, playFill, playJackpot, playRollover } from "../lib/sound.js";

const CELLS = svgCells();

// Design tokens — docs/design/bull-board.html (the user's prototype).
const C = {
  green: "#a8f080",
  gold: "#d6b75f",
  dim: "#344035",
  ink: "#f2f1e9",
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
  /** Which reveal show is running. */
  revealMode?: "settle" | "sweep" | null;
}

/**
 * The prototype's hex bull-head, extruded: every cell is a glass prism (dark side
 * layer + gradient face), lit cells glow, revealed cells pop in, the jackpot
 * detonates a gold shockwave ring. All state/testid contracts unchanged.
 */
export function Board({ snapshot, selectedSquares = [], onSelect, revealed = null, jackpotShown, revealMode }: BoardProps) {
  const settled = snapshot.state >= RoundState.Settled;
  const provenJackpot = settled && snapshot.jackpotSquare !== null && BigInt(snapshot.jackpotPool || "0") > 0n;
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
      // A draw alone does not prove a winner. Only a nonzero paid pool gets the bell.
      if (provenJackpot) playJackpot(); else playRollover();
      jackpotRung.current = true;
    }
    if (!jackpotShown) jackpotRung.current = false;
  }, [jackpotShown, provenJackpot, revealMode]);
  return (
    <svg
      viewBox="0 0 400 348"
      role="img"
      aria-label="Bull-head board of 25 hex cells"
      data-testid="bull-board"
      className="block w-full select-none touch-manipulation bg-[#0e100e] px-2 py-4 lg:px-5 lg:py-6"
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
          <stop offset="0%" stopColor="rgba(168,240,128,0.34)" />
          <stop offset="100%" stopColor="rgba(168,240,128,0.07)" />
        </linearGradient>
        <linearGradient id="faceGold" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="rgba(214,183,95,0.45)" />
          <stop offset="100%" stopColor="rgba(214,183,95,0.12)" />
        </linearGradient>
        <radialGradient id="floorGlow">
          <stop offset="0%" stopColor="rgba(168,240,128,0.16)" />
          <stop offset="100%" stopColor="rgba(168,240,128,0)" />
        </radialGradient>
      </defs>
      {/* Soft floor glow the bull hovers over. */}
      <ellipse cx={200} cy={338} rx={160} ry={9} fill="url(#floorGlow)" />
      {CELLS.map((cell) => {
        const stake = BigInt(snapshot.blockSol[cell.id] ?? "0");
        // Live board lights real stakes; during the reveal, cells light as unveiled.
        const lit = revealSet === null ? stake > 0n : revealSet.has(cell.id);
        // The jackpot flashes gold once settled — during the reveal only at the finale.
        const jackpot = provenJackpot && snapshot.jackpotSquare === cell.id && (revealSet === null || jackpotShown === true);
        const selected = selectedSquares.includes(cell.id);
        const stroke = selected ? C.ink : jackpot ? C.gold : lit ? C.green : C.dim;
        const fill = jackpot ? "url(#faceGold)" : lit ? "url(#faceLit)" : "url(#faceIdle)";
        // Selected picks glow warm white so they pop against lit/idle neighbours.
        const glow = selected ? "rgba(242,241,233,0.85)" : jackpot ? C.gold : lit ? "rgba(168,240,128,0.55)" : "none";
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
              />
              <polygon
                points={cell.points}
                fill={fill}
                stroke={stroke}
                strokeWidth={jackpot ? 2.8 : selected ? 2.2 : 1.5}
                strokeLinejoin="round"
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
