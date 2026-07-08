"use client";
import { useState } from "react";
import type { BN } from "@ansem/sdk";
import { solToLamports } from "../lib/amount.js";
import { formatSol } from "../lib/format.js";

export interface StakeRailProps {
  /** Multi-select (ORE-style): the amount is staked on EACH selected square. */
  selectedSquares: number[];
  sessionValid: boolean;
  busy: boolean;
  onStake: (squares: number[], amountPerSquare: BN) => void;
}

export function StakeRail({ selectedSquares, sessionValid, busy, onStake }: StakeRailProps) {
  const [amount, setAmount] = useState("");
  const parsed = solToLamports(amount);
  const n = selectedSquares.length;
  const canStake = sessionValid && n > 0 && !!parsed && !busy;
  return (
    <section className="rounded-lg border border-white/10 p-3 flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-bull-muted tracking-widest text-[10px]">STAKE · GASLESS</span>
        <span className="font-mono text-xs text-bull-muted">
          {n === 0 ? "pick tiles" : n === 1 ? `tile #${selectedSquares[0] + 1}` : `${n} tiles`}
        </span>
      </div>
      {!sessionValid && <p className="text-[10px] text-bull-muted">Enter the round to open a gasless session.</p>}
      <input
        inputMode="decimal" placeholder="amount (SOL)" value={amount}
        onChange={(e) => setAmount(e.target.value)}
        className="bg-black border border-white/15 rounded px-2 py-1 font-mono text-sm"
      />
      {n > 1 && parsed && (
        <p className="text-[10px] text-bull-muted font-mono">
          {formatSol(parsed.muln(n).toString())} total · {amount} on each tile
        </p>
      )}
      <button
        disabled={!canStake} onClick={() => canStake && onStake(selectedSquares, parsed!)}
        className="rounded bg-bull-green/20 text-bull-green py-1 text-sm disabled:opacity-40"
      >Stake · gasless</button>
    </section>
  );
}
