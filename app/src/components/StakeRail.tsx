"use client";
import { useState } from "react";
import type { BN } from "@ansem/sdk";
import { solToLamports } from "../lib/amount.js";

export interface StakeRailProps {
  selectedSquare: number | null; sessionValid: boolean; busy: boolean;
  onStake: (square: number, amount: BN) => void;
}

export function StakeRail({ selectedSquare, sessionValid, busy, onStake }: StakeRailProps) {
  const [amount, setAmount] = useState("");
  const parsed = solToLamports(amount);
  const canStake = sessionValid && selectedSquare !== null && !!parsed && !busy;
  return (
    <section className="rounded-lg border border-white/10 p-3 flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-bull-muted tracking-widest text-[10px]">STAKE · GASLESS</span>
        <span className="font-mono text-xs text-bull-muted">
          {selectedSquare === null ? "pick a tile" : `tile #${selectedSquare + 1}`}
        </span>
      </div>
      {!sessionValid && <p className="text-[10px] text-bull-muted">Enter the round to open a gasless session.</p>}
      <input
        inputMode="decimal" placeholder="amount (SOL)" value={amount}
        onChange={(e) => setAmount(e.target.value)}
        className="bg-black border border-white/15 rounded px-2 py-1 font-mono text-sm"
      />
      <button
        disabled={!canStake} onClick={() => canStake && onStake(selectedSquare!, parsed!)}
        className="rounded bg-bull-green/20 text-bull-green py-1 text-sm disabled:opacity-40"
      >Stake · gasless</button>
    </section>
  );
}
