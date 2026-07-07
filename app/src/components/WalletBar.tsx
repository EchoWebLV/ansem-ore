"use client";
import dynamic from "next/dynamic";

// Load the button client-only to avoid SSR hydration mismatch from wallet state.
const WalletMultiButton = dynamic(
  () => import("@solana/wallet-adapter-react-ui").then((m) => m.WalletMultiButton),
  { ssr: false },
);

export function WalletBar() {
  return (
    <div className="flex items-center justify-between">
      <span className="font-mono text-bull-green tracking-widest text-sm">ANSEM · MINER</span>
      <WalletMultiButton />
    </div>
  );
}
