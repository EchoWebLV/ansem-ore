"use client";
import { useState } from "react";
import type { BN } from "@ansem/sdk";
import { solToLamports, lamportsToSolStr } from "../lib/amount.js";

// Keep a little SOL in the wallet for transaction fees.
const FEE_BUFFER_LAMPORTS = 1_000_000n; // 0.001 SOL

export interface EscrowPanelProps {
  balanceLamports: bigint; locked: boolean; busy: boolean;
  /** Wallet SOL balance; when known, deposits larger than it are blocked. */
  walletLamports?: bigint | null;
  onDeposit: (lamports: BN) => void; onWithdraw: (lamports: BN) => void;
}

export function EscrowPanel({ balanceLamports, walletLamports = null, locked, busy, onDeposit, onWithdraw }: EscrowPanelProps) {
  const [amount, setAmount] = useState("");
  const parsed = solToLamports(amount);
  const overWallet = parsed !== null && walletLamports !== null &&
    BigInt(parsed.toString()) + FEE_BUFFER_LAMPORTS > walletLamports;
  // A withdraw beyond the escrow (incl. an EMPTY escrow — the account doesn't even
  // exist before the first deposit) reverts on-chain with AccountNotInitialized/
  // InsufficientEscrow. Gate it here with a human hint instead.
  const overEscrow = parsed !== null && BigInt(parsed.toString()) > balanceLamports;
  return (
    <section className="rounded-lg border border-white/10 p-3 flex flex-col gap-2">
      <div className="flex items-center justify-between text-sm">
        <span className="text-bull-muted tracking-widest text-[10px]">ESCROW</span>
        <span className="font-mono text-bull-green">{lamportsToSolStr(balanceLamports)} SOL</span>
      </div>
      {walletLamports !== null && (
        <div className="flex justify-end">
          <span className="font-mono text-[10px] text-bull-muted">wallet {lamportsToSolStr(walletLamports)} SOL</span>
        </div>
      )}
      <input
        inputMode="decimal" placeholder="amount (SOL)" value={amount}
        onChange={(e) => setAmount(e.target.value)}
        className="bg-black border border-white/15 rounded-lg px-3 py-2 font-mono text-sm"
      />
      {overWallet && (
        <p className="text-[10px] text-amber-400">That&apos;s more than your wallet holds — deposit a smaller amount.</p>
      )}
      <div className="flex gap-2">
        <button
          disabled={busy || !parsed || overWallet} onClick={() => parsed && onDeposit(parsed)}
          className="flex-1 rounded-lg bg-bull-green/20 text-bull-green py-2.5 text-sm font-medium disabled:opacity-40 active:scale-[0.98] transition-transform"
        >Deposit</button>
        <button
          disabled={busy || locked || !parsed || overEscrow} onClick={() => parsed && onWithdraw(parsed)}
          title={locked ? "Locked while a round is active" : undefined}
          className="flex-1 rounded-lg border border-white/15 py-2.5 text-sm disabled:opacity-40 active:scale-[0.98] transition-transform"
        >Withdraw</button>
      </div>
      {overEscrow && !locked && (
        <p className="text-[10px] text-bull-muted">
          {balanceLamports === 0n
            ? "Nothing in escrow to withdraw yet — deposit first."
            : "That's more than your escrow holds."}
        </p>
      )}
      {locked && <p className="text-[10px] text-bull-muted">Withdraw unlocks after the round finalizes.</p>}
    </section>
  );
}
