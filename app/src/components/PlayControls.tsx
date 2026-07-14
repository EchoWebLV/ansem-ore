"use client";
import { useEffect, useState } from "react";
import type { Program } from "@coral-xyz/anchor";
import { useConnection } from "@solana/wallet-adapter-react";
import {
  refundDirectIx, roundPda, beefRoundPda, fetchRound, fetchConfig, configPda,
  RoundState, type AnsemMiner, type BN,
} from "@ansem/sdk";
import { PublicKey } from "@solana/web3.js";
import { usePlayerState } from "../hooks/use-player-state.js";
import { directStake, claimRound, type WalletAdapter } from "../lib/writes.js";
import { accountExists } from "../lib/beef.js";
import { CLUSTER } from "../lib/explorer.js";
import { lamportsToSolStr } from "../lib/amount.js";
import type { AppSnapshot } from "../lib/keeper-client.js";
import { StakeRail } from "./StakeRail.js";
import { ClaimPanel } from "./ClaimPanel.js";
import type { ReceiptInput } from "./VerifyPanel.js";

export interface PlayControlsProps {
  l1: Program<AnsemMiner>;
  wallet: WalletAdapter;
  snapshot: AppSnapshot;
  selectedSquares: number[];
  onRemoveSquare?: (square: number) => void;
  onStaked?: () => void;
  /** Fired with an explorer-linkable artifact after every landed action. */
  onReceipt?: (r: ReceiptInput) => void;
  /**
   * BEEF is live on-chain (BeefConfig exists). Same gate the BeefChip uses. When false
   * (today's mainnet, or wallet disconnected), claim/stake bundles are EXACTLY the
   * pre-BEEF single transactions — zero behavior change. When true, a defensive
   * `rollBeef` is prepended so a played round's BEEF share is captured before the
   * ANSEM claim/stake zeroes the stake it is computed from.
   */
  beefLive?: boolean;
}

// Direct-stake engine (ORE model): pick squares -> ONE approval moves the SOL
// wallet->pot in that tx. No escrow, no session key, no round entry. Winnings
// are pull-claimed per round (claim_direct); cancelled rounds refund exactly.
export function PlayControls({ l1, wallet, snapshot, selectedSquares, onRemoveSquare, onStaked, onReceipt, beefLive }: PlayControlsProps) {
  const { connection } = useConnection();
  const owner = wallet.publicKey;
  const { miner, config, loaded, refresh } = usePlayerState({ program: l1, wallet: owner });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Wallet SOL balance — stakes larger than the wallet can cover are blocked up front.
  const [walletLamports, setWalletLamports] = useState<bigint | null>(null);
  useEffect(() => {
    let live = true;
    const poll = () => connection.getBalance(owner, "confirmed")
      .then((b) => { if (live) setWalletLamports(BigInt(b)); })
      .catch(() => { /* keep last known value */ });
    poll();
    const id = setInterval(poll, 10_000);
    return () => { live = false; clearInterval(id); };
  }, [connection, owner]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setErr(null);
    try { await fn(); refresh(); }
    catch (e) { setErr(String((e as Error)?.message ?? e)); }
    finally { setBusy(false); }
  };

  const roundId = snapshot.roundId;

  // Staking a NEW round re-stamps (zeroes) the miner — it would forfeit an
  // unresolved prior round's unclaimed winnings/refund. Gate staking until the
  // player claims/refunds below. (blockStake sums to zero once claimed.)
  const stakedRound = miner?.roundId ?? 0;
  const unresolvedLamports = (miner?.blockStake ?? []).reduce((a, b) => a + b, 0n);
  const priorUnresolved = stakedRound > 0 && stakedRound !== roundId && unresolvedLamports > 0n;
  // Fail-safe: block staking until player state loads (an unresolved prior round
  // must never be forfeit-able during the initial null window).
  const stakeBlocked = !loaded || priorUnresolved || snapshot.state !== RoundState.Open;

  const FEE_HEADROOM = 5_000_000n; // keep some SOL back for fees
  const doStake = (squares: number[], amountPerSquare: BN) => run(async () => {
    const total = BigInt(amountPerSquare.toString()) * BigInt(squares.length);
    if (walletLamports !== null && total + FEE_HEADROOM > walletLamports) {
      throw new Error(`that's ${lamportsToSolStr(total)} SOL + fees — more than your wallet holds`);
    }
    // Staking a NEW round re-stamps (zeroes) the miner — roll the prior stamped round's
    // BEEF share FIRST so it survives. Only when BEEF is live AND that round is stamped;
    // otherwise the bundle is exactly the pre-BEEF [stakeDirect…] (BEEF never blocks a stake).
    const rollBeefRound =
      beefLive && stakedRound > 0 && stakedRound !== roundId && (await accountExists(connection, beefRoundPda(stakedRound)))
        ? stakedRound
        : null;
    const sig = await directStake({ l1, owner, roundId, squares, amountPerSquare, rollBeefRound });
    onReceipt?.({ label: `stake ×${squares.length} · one approval`, sig });
    onStaked?.();
  });

  const doClaim = (rid: number) => run(async () => {
    // Resolve the payout mint + its token program from chain: on mainnet this is
    // the real external ANSEM (Token-2022), on devnet the mock PDA mint (classic).
    // The claim builder derives payout_vault/player ATA from these, so the mock
    // PDA default must NOT be used against the real mint.
    const cfg = await fetchConfig(l1, configPda());
    const ansemMint = new PublicKey(cfg.ansemMint);
    const mintInfo = await connection.getAccountInfo(ansemMint);
    if (!mintInfo) throw new Error("could not resolve the ANSEM mint on-chain");
    // Roll this round's BEEF share FIRST (claim_direct zeroes the stake it's derived from),
    // but only when BEEF is live AND the round is stamped — else exactly the pre-BEEF claim.
    const rollBeef = !!beefLive && (await accountExists(connection, beefRoundPda(rid)));
    const sig = await claimRound({ l1, owner, roundId: rid, ansemMint, ansemTokenProgramId: mintInfo.owner, rollBeef });
    onReceipt?.({ label: `claim round ${rid}`, sig });
  });
  const doRefund = (rid: number) => run(async () => {
    const sig = await refundDirectIx(l1, owner, rid).rpc();
    onReceipt?.({ label: `refund round ${rid}`, sig });
  });

  // Poll the staked round's state whenever unclaimed stakes exist, so the
  // Claim/Refund panel appears the instant the keeper advances it. Also capture
  // the round's deadline — the claim window is measured from it.
  const offerable = stakedRound > 0 && unresolvedLamports > 0n;
  const [stakedRoundState, setStakedRoundState] = useState<RoundState | null>(null);
  const [stakedRoundDeadline, setStakedRoundDeadline] = useState<number | null>(null);
  // The round's on-chain draw, captured so the panel can label WON vs NO-WIN honestly.
  const [stakedJackpotSquare, setStakedJackpotSquare] = useState<number | null>(null);
  const [stakedJackpotPool, setStakedJackpotPool] = useState<bigint | null>(null);
  useEffect(() => {
    if (!offerable) {
      setStakedRoundState(null); setStakedRoundDeadline(null);
      setStakedJackpotSquare(null); setStakedJackpotPool(null);
      return;
    }
    let live = true;
    const poll = () => fetchRound(l1, roundPda(stakedRound))
      .then((r) => { if (live) {
        setStakedRoundState(r.state); setStakedRoundDeadline(r.deadlineTs);
        setStakedJackpotSquare(r.jackpotSquare); setStakedJackpotPool(r.jackpotPool);
      } })
      .catch(() => { if (live) {
        setStakedRoundState(null); setStakedRoundDeadline(null);
        setStakedJackpotSquare(null); setStakedJackpotPool(null);
      } });
    poll();
    const id = setInterval(poll, 5000);
    return () => { live = false; clearInterval(id); };
  }, [l1, stakedRound, offerable]);

  // Did this player actually win the staked round? jackpotPool > 0 ⟺ someone hit the
  // drawn square and it pays; == 0 ⟺ no winner, the pot rolled into the jackpot. A
  // nonzero return band (config.multMaxBps > 0) pays every staked square, so any stake
  // wins. null until the draw + the player's stakes + the config band are all known —
  // the panel must never flash WON before it can prove it. (multMaxBps is 0 live today.)
  const won: boolean | null =
    stakedJackpotPool === null || stakedJackpotSquare === null || !miner || !config
      ? null
      : config.multMaxBps > 0
        ? unresolvedLamports > 0n
        : stakedJackpotPool > 0n && (miner.blockStake[stakedJackpotSquare] ?? 0n) > 0n;

  // Gate copy mirrors the panel's honesty: a refundable round says "forfeits it"; a
  // no-win round just needs clearing before restaking; a real win (or unknown) keeps
  // the neutral claim wording.
  const gateCopy =
    stakedRoundState === RoundState.Closed
      ? `Refund round ${stakedRound} below first. Staking now forfeits it.`
      : won === false
        ? `Clear round ${stakedRound} below first to stake again.`
        : won === true
          ? `Claim round ${stakedRound} below first. Staking now forfeits it.`
          : `Resolve round ${stakedRound} below first to stake again.`;

  // Claim-by deadline (unix secs) = staked round's deadline + the config claim
  // window carried on the snapshot. Undefined until both are known (or if the
  // keeper serves no window) — ClaimPanel then simply shows no countdown.
  const claimWindowSecs = snapshot.claimWindowSecs;
  const claimByTs =
    stakedRoundDeadline !== null && claimWindowSecs !== undefined && claimWindowSecs > 0
      ? stakedRoundDeadline + claimWindowSecs
      : undefined;

  return (
    <div className="flex flex-col gap-3">
      {walletLamports !== null && (
        <div className="flex items-center justify-between px-1 text-[10px] text-bull-muted">
          <span>Wallet balance</span>
          <span className="font-mono">{lamportsToSolStr(walletLamports)} SOL</span>
        </div>
      )}
      <StakeRail
        selectedSquares={selectedSquares}
        enabled={!stakeBlocked}
        busy={busy}
        onStake={doStake}
        onRemoveSquare={onRemoveSquare}
        feeReserveSol={lamportsToSolStr(FEE_HEADROOM)}
      />
      {!loaded ? (
        <p className="px-1 text-[10px] text-bull-muted">Checking your prior round…</p>
      ) : priorUnresolved ? (
        <p className="px-1 text-[10px] text-amber-400">{gateCopy}</p>
      ) : snapshot.state !== RoundState.Open ? (
        <p className="px-1 text-[10px] text-bull-muted">Round is settling. Betting opens with the next round.</p>
      ) : null}
      {offerable && stakedRoundState !== null && (
        <ClaimPanel roundId={stakedRound} roundState={stakedRoundState} lastClaimedRound={0} claimByTs={claimByTs} won={won} busy={busy} onClaim={doClaim} onRefund={doRefund} />
      )}
      {CLUSTER !== "mainnet-beta" && (
        <a href="https://faucet.solana.com" target="_blank" rel="noreferrer" className="self-end text-[10px] text-bull-muted underline">Get devnet SOL</a>
      )}
      {err && <p role="alert" className="break-words px-1 text-xs text-red-400">{err}</p>}
    </div>
  );
}
