"use client";
import { useState } from "react";
import type { BN } from "@ansem/sdk";
import { solToLamports, lamportsToSolStr } from "../lib/amount.js";

export interface EscrowPanelProps {
  balanceLamports: bigint; locked: boolean; busy: boolean;
  onDeposit: (lamports: BN) => void; onWithdraw: (lamports: BN) => void;
}

export function EscrowPanel({ balanceLamports, locked, busy, onDeposit, onWithdraw }: EscrowPanelProps) {
  const [amount, setAmount] = useState("");
  const parsed = solToLamports(amount);
  return (
    <section className="rounded-lg border border-white/10 p-3 flex flex-col gap-2">
      <div className="flex items-center justify-between text-sm">
        <span className="text-bull-muted tracking-widest text-[10px]">ESCROW</span>
        <span className="font-mono text-bull-green">{lamportsToSolStr(balanceLamports)} SOL</span>
      </div>
      <input
        inputMode="decimal" placeholder="amount (SOL)" value={amount}
        onChange={(e) => setAmount(e.target.value)}
        className="bg-black border border-white/15 rounded px-2 py-1 font-mono text-sm"
      />
      <div className="flex gap-2">
        <button
          disabled={busy || !parsed} onClick={() => parsed && onDeposit(parsed)}
          className="flex-1 rounded bg-bull-green/20 text-bull-green py-1 text-sm disabled:opacity-40"
        >Deposit</button>
        <button
          disabled={busy || locked || !parsed} onClick={() => parsed && onWithdraw(parsed)}
          title={locked ? "Locked while a round is active" : undefined}
          className="flex-1 rounded border border-white/15 py-1 text-sm disabled:opacity-40"
        >Withdraw</button>
      </div>
      {locked && <p className="text-[10px] text-bull-muted">Withdraw unlocks after the round finalizes.</p>}
    </section>
  );
}
