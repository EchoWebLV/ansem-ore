import { BN } from "@ansem/sdk";

const LAMPORTS_PER_SOL = 1_000_000_000n;

/** Parse a SOL string to a lamports BN. Returns null for junk, non-positive, or sub-lamport precision. */
export function solToLamports(input: string): BN | null {
  const s = input.trim();
  if (!/^\d*\.?\d*$/.test(s) || s === "" || s === ".") return null;
  const [whole, frac = ""] = s.split(".");
  if (frac.length > 9) return null; // sub-lamport precision not representable
  const lamports = BigInt(whole || "0") * LAMPORTS_PER_SOL + BigInt((frac + "000000000").slice(0, 9));
  if (lamports <= 0n) return null;
  return new BN(lamports.toString());
}

/** Format lamports as a trimmed SOL string (no trailing zeros). */
export function lamportsToSolStr(lamports: bigint): string {
  const whole = lamports / LAMPORTS_PER_SOL;
  const frac = (lamports % LAMPORTS_PER_SOL).toString().padStart(9, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}
