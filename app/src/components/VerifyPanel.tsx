"use client";
import { useMemo } from "react";
import { PROGRAM_ID, roundPda } from "@ansem/sdk";
import { explorerAddress, explorerTx } from "../lib/explorer.js";
import { shortAddr } from "../lib/format.js";

/** One verifiable artifact of play — an L1 tx signature or an account to watch. */
export interface Receipt {
  label: string;
  sig?: string;
  addr?: string;
  at: number;
}
export type ReceiptInput = Omit<Receipt, "at">;

function Row({ href, left, right }: { href: string; left: string; right: string }) {
  return (
    <li className="flex items-center justify-between gap-3 text-sm font-mono">
      <span className="text-bull-muted truncate">{left}</span>
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className="text-bull-green hover:underline whitespace-nowrap py-1"
      >
        {right} ↗
      </a>
    </li>
  );
}

/**
 * Every round, stake and payout is a public Solana transaction. This panel hands the
 * player the actual links: the program + current round accounts (live keeper txs), and
 * a receipt per action THEY fired (deposit / one-popup entry / claim), straight to the
 * explorer. Nothing here is testimony — it's all checkable.
 */
export function VerifyPanel({ roundId, receipts }: { roundId: number; receipts: Receipt[] }) {
  const program = PROGRAM_ID.toBase58();
  // PDA derivation needs real crypto (jsdom can't) — degrade to program-only links there.
  const roundAddr = useMemo(() => {
    try {
      return roundPda(roundId).toBase58();
    } catch {
      return null;
    }
  }, [roundId]);
  return (
    <div className="rounded-xl border border-bull-edge bg-bull-bg p-3">
      <h2 className="text-[10px] tracking-widest text-bull-muted mb-2">VERIFY ON-CHAIN</h2>
      <ul className="space-y-1">
        <Row href={explorerAddress(program)} left="program" right={shortAddr(program)} />
        {roundAddr && (
          <Row href={explorerAddress(roundAddr)} left={`round ${roundId}`} right={shortAddr(roundAddr)} />
        )}
        {receipts.map((r, i) =>
          r.sig ? (
            <Row key={`${r.at}-${i}`} href={explorerTx(r.sig)} left={r.label} right={shortAddr(r.sig)} />
          ) : r.addr ? (
            <Row key={`${r.at}-${i}`} href={explorerAddress(r.addr)} left={r.label} right={shortAddr(r.addr)} />
          ) : null,
        )}
      </ul>
      <p className="text-[10px] text-bull-muted mt-2">
        every round, stake and payout is a public Solana transaction — click through and check the math.
      </p>
    </div>
  );
}
