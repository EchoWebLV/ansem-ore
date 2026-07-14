import { Connection, Keypair, VersionedTransaction } from "@solana/web3.js";

// Wrapped-SOL mint — the input side of every keeper buy (SOL -> ANSEM).
export const SOL_MINT = "So11111111111111111111111111111111111111112";

/**
 * Minimal structural `fetch` so tests can inject a stub without pulling in the DOM
 * lib (keeper tsconfig is `lib: ["ES2022"]`, no global fetch types). Node 20's global
 * `fetch` and any stub returning `{ok,status,json,text}` both satisfy this shape.
 */
export interface FetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<any>;
  text(): Promise<string>;
}
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<FetchResponse>;

/** Everything the Jupiter calls need that isn't a live connection/keypair. */
export interface JupCfg {
  /** e.g. https://lite-api.jup.ag/swap/v1 */
  jupBaseUrl: string;
  /** config.ansem_mint (base58) — the output mint of every buy. */
  ansemMint: string;
  slippageBps: number;
}

/** Raw `/quote` fetch (shared by the quote helper and the swap builder). */
async function fetchQuote(cfg: JupCfg, fetchImpl: FetchLike, lamports: bigint): Promise<any> {
  const url =
    `${cfg.jupBaseUrl}/quote?inputMint=${SOL_MINT}&outputMint=${cfg.ansemMint}` +
    `&amount=${lamports.toString()}&slippageBps=${cfg.slippageBps}`;
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`jupiter quote failed: ${res.status} ${await res.text().catch(() => "")}`);
  return res.json();
}

/**
 * Quote `lamports` of SOL -> ANSEM base units. Returns the quoted `outAmount`
 * (pre-slippage best route) as a bigint — the exact figure the keeper hands to
 * execute_swap_real as the round's payout. Injectable fetch; never called in mock mode.
 */
export async function quoteSolToAnsem(cfg: JupCfg, fetchImpl: FetchLike, lamports: bigint): Promise<bigint> {
  const q = await fetchQuote(cfg, fetchImpl, lamports);
  if (q?.outAmount === undefined || q?.outAmount === null) {
    throw new Error("jupiter quote missing outAmount");
  }
  return BigInt(q.outAmount);
}

/**
 * Buy ANSEM with `lamports` of SOL: quote -> POST /swap -> deserialize the returned
 * base64 versioned tx -> sign with the keeper keypair -> send + confirm on L1.
 * Returns the transaction signature. Injectable fetch; never called in mock mode.
 */
export async function swapSolToAnsem(
  cfg: JupCfg,
  conn: Connection,
  keypair: Keypair,
  fetchImpl: FetchLike,
  lamports: bigint,
): Promise<string> {
  const quoteResponse = await fetchQuote(cfg, fetchImpl, lamports);
  const res = await fetchImpl(`${cfg.jupBaseUrl}/swap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      quoteResponse,
      userPublicKey: keypair.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
    }),
  });
  if (!res.ok) throw new Error(`jupiter swap failed: ${res.status} ${await res.text().catch(() => "")}`);
  const { swapTransaction } = await res.json();
  if (!swapTransaction) throw new Error("jupiter swap missing swapTransaction");

  const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, "base64"));
  tx.sign([keypair]);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  const bh = await conn.getLatestBlockhash("confirmed");
  await conn.confirmTransaction(
    { signature: sig, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight },
    "confirmed",
  );
  return sig;
}
