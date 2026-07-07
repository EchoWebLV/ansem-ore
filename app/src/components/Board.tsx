"use client";
import Image from "next/image";
import { RoundState, type WireSnapshot } from "@ansem/sdk";
import { bullCells } from "../lib/board-layout.js";

const CELLS = bullCells();

function tileNo(id: number): string { return String(id + 1).padStart(2, "0"); }

export interface BoardProps { snapshot: WireSnapshot; }

export function Board({ snapshot }: BoardProps) {
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
        return (
          <div
            key={cell.id}
            data-testid={`tile-${cell.id}`}
            data-lit={lit ? "true" : "false"}
            data-jackpot={jackpot ? "true" : "false"}
            className="absolute -translate-x-1/2 -translate-y-1/2 rounded-md overflow-hidden transition-all duration-300"
            style={{
              left: `${cell.left * 100}%`,
              top: `${cell.top * 100}%`,
              width: "17%",
              boxShadow: glow,
              outline: jackpot ? "2px solid #e8c452" : lit ? "1px solid #35e07a" : "1px solid #2c4034",
              opacity: lit || jackpot ? 1 : 0.5,
            }}
          >
            <Image
              src={`/bulls/${tileNo(cell.id)}.webp`}
              alt={`Bull #${cell.id + 1}`}
              width={128}
              height={128}
              className="w-full h-auto block"
            />
            {cell.eye && (
              <span className="absolute inset-0 m-auto h-1/4 w-1/4 rounded-full bg-bull-green/80 blur-[1px]" />
            )}
          </div>
        );
      })}
    </div>
  );
}
