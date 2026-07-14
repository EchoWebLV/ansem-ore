"use client";
import { useCallback, useEffect, useState } from "react";
import type { Program } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { useConnection } from "@solana/wallet-adapter-react";
import {
  beefMinerPda, minerPda, playerBeefAta, beefRoundPda, fetchMiner,
  TOKEN_PROGRAM_ID, type BeefConfigState, type AnsemMiner,
} from "@ansem/sdk";
import { beefPayout, accountExists } from "../lib/beef.js";
import { claimBeef, type WalletAdapter } from "../lib/writes.js";
import { formatBeef } from "../lib/format.js";

export interface BeefAccountData {
  /** Player's BEEF ATA balance — already claimed, sitting in the wallet. */
  claimedBase: bigint;
  /** beefPayout(unclaimed, bonusBps): the guaranteed FLOOR a claim delivers right now.
   *  On-chain a claim first accrues more bonus and the roll only adds share, so the real
   *  payout is always >= this — never a number a claim wouldn't deliver (D12). */
  pendingBase: bigint;
  /** The miner's stamped round; rolled in first at claim when its BeefRound exists (0 = none). */
  stakedRound: number;
  /** BEEF mint owner program (classic vs Token-2022), resolved from chain. */
  tokenProgramId: PublicKey;
}

export interface BeefChipProps {
  l1: Program<AnsemMiner>;
  wallet: WalletAdapter;
  /** THE gate: null => BEEF isn't live (today's mainnet) — the chip renders nothing. */
  beefConfig: BeefConfigState | null;
  /** Injectable per-player read (tests/preview). Defaults to the real on-chain reads. */
  read?: () => Promise<BeefAccountData>;
  /** Balance poll cadence (default 15s). */
  pollMs?: number;
}

/**
 * Compact HUD chip (mounted in Hud's reserved slot) for the connected player's mined
 * $BEEF: the claimable floor + wallet-held balance, and a one-tx cash-out. Honest by
 * construction (D12) — every figure is a real on-chain quantity, and the claimable
 * number is the exact program-computed floor. Gold appears ONLY on a landed claim.
 */
export function BeefChip({ l1, wallet, beefConfig, read, pollMs = 15_000 }: BeefChipProps) {
  const { connection } = useConnection();
  const owner = wallet.publicKey;
  const [data, setData] = useState<BeefAccountData | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [justClaimed, setJustClaimed] = useState<bigint | null>(null);

  const beefMintB58 = beefConfig?.beefMint;
  const beefVaultB58 = beefConfig?.beefVault;

  // Default per-player read: BEEF ATA balance (claimed) + beefPayout(BeefMiner) (pending
  // floor) + the miner's stamped round (roll target). Every read is failure-tolerant so a
  // cold ATA / missing BeefMiner simply reads as zero, never an error.
  const defaultRead = useCallback(async (): Promise<BeefAccountData> => {
    const beefMint = new PublicKey(beefMintB58!);
    const info = await connection.getAccountInfo(beefMint).catch(() => null);
    const tokenProgramId = info?.owner ?? TOKEN_PROGRAM_ID;
    const ata = playerBeefAta(beefMint, owner, tokenProgramId);
    const claimedBase = await connection
      .getTokenAccountBalance(ata)
      .then((r) => BigInt(r.value.amount))
      .catch(() => 0n);
    const bm = await l1.account.beefMiner.fetch(beefMinerPda(owner)).catch(() => null);
    const pendingBase = bm ? beefPayout(BigInt(bm.unclaimed.toString()), Number(bm.bonusBps)) : 0n;
    const miner = await fetchMiner(l1, minerPda(owner)).catch(() => null);
    return { claimedBase, pendingBase, stakedRound: miner?.roundId ?? 0, tokenProgramId };
  }, [connection, l1, owner, beefMintB58]);

  const doRead = read ?? defaultRead;

  const refresh = useCallback(() => {
    if (!beefConfig) return;
    doRead().then(setData).catch(() => { /* keep last known values */ });
  }, [beefConfig, doRead]);

  useEffect(() => {
    if (!beefConfig) { setData(null); return; }
    refresh();
    if (!pollMs) return;
    const id = setInterval(refresh, pollMs);
    return () => clearInterval(id);
  }, [beefConfig, refresh, pollMs]);

  // Gate — nothing to render until BEEF is live (and, upstream, a wallet is connected).
  if (!beefConfig || !beefMintB58 || !beefVaultB58) return null;

  const pending = data?.pendingBase ?? 0n;
  const claimed = data?.claimedBase ?? 0n;
  const canClaim = !busy && !!data && pending > 0n;

  const onClaim = async () => {
    if (!data || pending <= 0n) return;
    setBusy(true); setErr(null);
    try {
      // Roll the staked round FIRST, but only when its BeefRound provably exists — a
      // current OPEN round isn't stamped yet, and a missing BeefRound would abort the
      // whole cash-out (BEEF must never block the game). Absent => plain [claimBeef].
      const rollRound =
        data.stakedRound > 0 && (await accountExists(connection, beefRoundPda(data.stakedRound)))
          ? data.stakedRound
          : null;
      await claimBeef({
        l1, owner,
        beefMint: new PublicKey(beefMintB58),
        beefVault: new PublicKey(beefVaultB58),
        tokenProgramId: data.tokenProgramId,
        rollRound,
      });
      setJustClaimed(pending);
      refresh();
      setTimeout(() => setJustClaimed(null), 4_000);
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      data-testid="beef-chip"
      className="rounded-[10px] border border-bull-edge bg-bull-raised px-3 py-1.5"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col leading-tight">
          <span className="terminal-label">beef mined</span>
          {justClaimed !== null ? (
            <span role="status" className="font-mono tabular-nums text-[13px] font-semibold text-bull-gold">
              +{formatBeef(justClaimed)} claimed
            </span>
          ) : (
            <span className="font-mono tabular-nums text-[13px] text-bull-ink" title="claimable now">
              {formatBeef(pending)}
            </span>
          )}
          {claimed > 0n && justClaimed === null && (
            <span className="font-mono text-[10px] text-bull-muted" title="already in your wallet">
              {formatBeef(claimed)} held
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={onClaim}
          disabled={!canClaim}
          aria-label={busy ? "Claiming mined BEEF" : "Claim mined BEEF"}
          className="min-h-9 shrink-0 rounded-[8px] bg-bull-green px-3 py-1.5 text-[12px] font-bold text-[#0b1209] disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? "claiming…" : "claim"}
        </button>
      </div>
      {err && <p role="alert" className="mt-1 break-words text-[10px] text-red-400">{err}</p>}
    </div>
  );
}
