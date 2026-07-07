"use client";
import { useEffect, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import type { Program } from "@coral-xyz/anchor";
import { useConnection } from "@solana/wallet-adapter-react";
import {
  depositIx, withdrawIx, claimIx, refundIx, minerPda, roundPda, fetchRound,
  RoundState, DEFAULT_ER_VALIDATOR, type AnsemMiner, type WireSnapshot, type BN,
} from "@ansem/sdk";
import { erConnection, erProgramForSession } from "../lib/anchor.js";
import { usePlayerState } from "../hooks/use-player-state.js";
import { useSession } from "../hooks/use-session.js";
import { enterRound, gaslessStake, type WalletAdapter } from "../lib/writes.js";
import { EscrowPanel } from "./EscrowPanel.js";
import { StakeRail } from "./StakeRail.js";
import { ClaimPanel } from "./ClaimPanel.js";

export interface PlayControlsProps {
  l1: Program<AnsemMiner>;
  wallet: WalletAdapter;
  snapshot: WireSnapshot;
  selectedSquare: number | null;
  onStaked?: () => void;
}

export function PlayControls({ l1, wallet, snapshot, selectedSquare, onStaked }: PlayControlsProps) {
  const { connection } = useConnection();
  const owner = wallet.publicKey;
  const { escrow, miner, refresh } = usePlayerState({ program: l1, wallet: owner });
  const { session, signer, valid, persist } = useSession(owner.toBase58());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setErr(null);
    try { await fn(); refresh(); }
    catch (e) { setErr(String((e as Error)?.message ?? e)); }
    finally { setBusy(false); }
  };

  const roundId = snapshot.roundId;
  const joinedThisRound = escrow?.activeRound === roundId;
  // A delegated miner is unreadable on L1, so gate staking on the always-readable escrow + session.
  const canStake = valid && !!signer && joinedThisRound;
  const needsEntry = !joinedThisRound || !valid;

  const doDeposit = (lamports: BN) => run(async () => { await depositIx(l1, owner, lamports).rpc(); });
  const doWithdraw = (lamports: BN) => run(async () => { await withdrawIx(l1, owner, lamports).rpc(); });

  const doEnter = () => run(async () => {
    // Decide init_miner by the RAW account (fetchMiner is null while delegated too — would double-init).
    const info = await connection.getAccountInfo(minerPda(owner));
    await enterRound({
      l1, connection, wallet, roundId, validator: DEFAULT_ER_VALIDATOR,
      includeInitMiner: info === null, validUntilSec: Math.floor(Date.now() / 1000) + 3600,
      // Persist the moment the entry confirms (before propagation waits) so a slow wait
      // can't strand a joined+delegated player with a forgotten session key.
      onLanded: ({ sessionSigner, tokenPda, validUntil }) => persist({
        owner: owner.toBase58(), secretKey: Array.from(sessionSigner.secretKey),
        tokenPda: tokenPda.toBase58(), validUntil,
      }),
    });
  });

  const doStake = (square: number, amount: BN) => run(async () => {
    if (!signer || !session) throw new Error("no active session — enter the round first");
    const er = erProgramForSession(erConnection(), signer);
    await gaslessStake({ er, ownerWallet: owner, sessionSigner: signer, tokenPda: new PublicKey(session.tokenPda), square, amount, roundId });
    onStaked?.();
  });

  const doClaim = (rid: number) => run(async () => { await claimIx(l1, owner, rid).rpc(); });
  const doRefund = (rid: number) => run(async () => { await refundIx(l1, owner, rid).rpc(); });

  // The claimable round is the player's STAKED round (miner.roundId), not the live snapshot round.
  const stakedRound = miner?.roundId ?? 0;
  const unclaimed = stakedRound > 0 && (escrow?.lastClaimedRound ?? 0) < stakedRound;
  const [stakedRoundState, setStakedRoundState] = useState<RoundState | null>(null);
  useEffect(() => {
    if (!unclaimed) { setStakedRoundState(null); return; }
    let live = true;
    fetchRound(l1, roundPda(stakedRound)).then((r) => { if (live) setStakedRoundState(r.state); }).catch(() => { if (live) setStakedRoundState(null); });
    return () => { live = false; };
  }, [l1, stakedRound, unclaimed]);

  return (
    <div className="flex flex-col gap-3">
      <EscrowPanel
        balanceLamports={escrow?.balance ?? 0n}
        locked={(escrow?.activeRound ?? 0) !== 0}
        busy={busy} onDeposit={doDeposit} onWithdraw={doWithdraw}
      />
      {needsEntry ? (
        <button
          disabled={busy || snapshot.state !== RoundState.Open} onClick={doEnter}
          className="rounded bg-bull-green/20 text-bull-green py-2 text-sm disabled:opacity-40"
        >Enter round · one popup</button>
      ) : (
        <StakeRail selectedSquare={selectedSquare} sessionValid={canStake} busy={busy} onStake={doStake} />
      )}
      {unclaimed && stakedRoundState !== null && (
        <ClaimPanel
          roundId={stakedRound} roundState={stakedRoundState} lastClaimedRound={escrow?.lastClaimedRound ?? 0}
          busy={busy} onClaim={doClaim} onRefund={doRefund}
        />
      )}
      <a href="https://faucet.solana.com" target="_blank" rel="noreferrer"
        className="text-[10px] text-bull-muted underline self-end">get devnet SOL</a>
      {err && <p className="text-red-400 text-xs break-words">{err}</p>}
    </div>
  );
}
