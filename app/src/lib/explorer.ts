/** Solana Explorer links. Cluster comes from env so mainnet later is one var flip. */
export const CLUSTER = process.env.NEXT_PUBLIC_SOLANA_CLUSTER ?? "devnet";
const SUFFIX = CLUSTER === "mainnet-beta" ? "" : `?cluster=${CLUSTER}`;

export function explorerTx(signature: string): string {
  return `https://explorer.solana.com/tx/${signature}${SUFFIX}`;
}

export function explorerAddress(address: string): string {
  return `https://explorer.solana.com/address/${address}${SUFFIX}`;
}
