"use client";
import { useMemo } from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { clusterApiUrl } from "@solana/web3.js";
import "@solana/wallet-adapter-react-ui/styles.css";

const cluster = (process.env.NEXT_PUBLIC_SOLANA_CLUSTER ?? "devnet") as "devnet" | "mainnet-beta" | "testnet";

export function Providers({ children }: { children: React.ReactNode }) {
  // Endpoint is only used by the M4c write path; reads go through the keeper WS.
  // NEXT_PUBLIC_RPC_ENDPOINT overrides the public cluster URL (e.g. a paid RPC to dodge 429).
  const endpoint = useMemo(() => process.env.NEXT_PUBLIC_RPC_ENDPOINT ?? clusterApiUrl(cluster), []);
  // Empty wallet list = wallet-standard auto-detect (Phantom/Backpack inject themselves).
  const wallets = useMemo(() => [], []);
  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
