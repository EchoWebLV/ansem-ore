"use client";
import { useState } from "react";
import type { BN } from "@ansem/sdk";
import { solToLamports } from "../lib/amount.js";
import { formatSol } from "../lib/format.js";

export interface StakeRailProps {
  /** Multi-select (ORE-style): the amount is staked on EACH selected square. */
  selectedSquares: number[];
  /** Round is open + player has nothing forfeitable pending. */
  enabled: boolean;
  busy: boolean;
  onStake: (squares: number[], amountPerSquare: BN) => void;
}

// Direct-stake rail: ONE wallet approval moves the SOL into the pot.
export function StakeRail({ selectedSquares, enabled, busy, onStake }: StakeRailProps) {
  const [amount, setAmount] = useState("");
  const parsed = solToLamports(amount);
  const n = selectedSquares.length;
  const canStake = enabled && n > 0 && !!parsed && !busy;
  return (
    <section className="terminal-panel p-4">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-[14px] font-semibold text-bull-ink">Bet slip</h2>
        <span className="terminal-label">{n} {n === 1 ? "tile" : "tiles"}</span>
      </div>
      <div className="flex min-h-8 flex-wrap gap-1.5">
        {selectedSquares.length === 0
          ? <span className="text-[11px] text-bull-muted">Select tiles on the board</span>
          : selectedSquares.map((square) => <span key={square} className="rounded-[7px] border border-bull-dim bg-bull-raised px-2 py-1 font-mono text-[11px] text-bull-green">#{String(square + 1).padStart(2, "0")}</span>)}
      </div>
      <label htmlFor="stake-amount" className="mb-2 mt-4 block text-[11px] text-bull-muted">Amount per tile</label>
      <div className="flex items-center rounded-[10px] border border-bull-edge bg-bull-bg px-3 focus-within:border-bull-green">
        <input id="stake-amount" inputMode="decimal" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} className="min-w-0 flex-1 bg-transparent py-3 font-mono text-[18px] text-bull-ink outline-none" />
        <span className="text-[11px] font-semibold text-bull-muted">SOL</span>
      </div>
      {n > 0 && parsed && <p className="mt-3 flex justify-between text-[11px] text-bull-muted"><span>{n} × {amount} SOL</span><strong className="font-mono text-bull-ink">{formatSol(parsed.muln(n).toString())} total</strong></p>}
      <button disabled={!canStake} onClick={() => canStake && onStake(selectedSquares, parsed!)} className="terminal-primary mt-4 w-full">Place bet · one approval</button>
    </section>
  );
}
