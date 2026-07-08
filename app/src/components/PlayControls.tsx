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
import { enterWouldForfeit } from "../lib/claim-gate.js";
import { EscrowPanel } from "./EscrowPanel.js";
import { StakeRail } from "./StakeRail.js";
import { ClaimPanel } from "./ClaimPanel.js";
import type { ReceiptInput } from "./VerifyPanel.js";

export interface PlayControlsProps {
  l1: Program<AnsemMiner>;
  wallet: WalletAdapter;
  snapshot: WireSnapshot;
  selectedSquares: number[];
  onStaked?: () => void;
  /** Fired with an explorer-linkable artifact after every landed action. */
  onReceipt?: (r: ReceiptInput) => void;
}

export function PlayControls({ l1, wallet, snapshot, selectedSquares, onStaked, onReceipt }: PlayControlsProps) {
  const { connection } = useConnection();
  const owner = wallet.publicKey;
  const { escrow, miner, loaded, refresh } = usePlayerState({ program: l1, wallet: owner });
  const { session, signer, valid, persist } = useSession(owner.toBase58());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Wallet SOL balance — lets EscrowPanel block deposits the wallet can't cover.
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

  // Raw AnchorErrors are for us, not players — translate the ones a player can hit.
  const friendly = (m: string) =>
    /AccountNotInitialized|3012/.test(m)
      ? "No escrow account yet — make your first deposit to create it."
      : m;

  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setErr(null);
    try { await fn(); refresh(); }
    catch (e) { setErr(friendly(String((e as Error)?.message ?? e))); }
    finally { setBusy(false); }
  };

  const roundId = snapshot.roundId;
  const joinedThisRound = escrow?.activeRound === roundId;
  // A delegated miner is unreadable on L1, so gate staking on the always-readable escrow + session.
  const canStake = valid && !!signer && joinedThisRound;
  const needsEntry = !joinedThisRound || !valid;

  const doDeposit = (lamports: BN) => run(async () => {
    const sig = await depositIx(l1, owner, lamports).rpc();
    onReceipt?.({ label: "deposit → escrow", sig });
  });
  const doWithdraw = (lamports: BN) => run(async () => {
    const sig = await withdrawIx(l1, owner, lamports).rpc();
    onReceipt?.({ label: "withdraw ← escrow", sig });
  });

  const doEnter = () => run(async () => {
    // Decide init_miner by the RAW account (fetchMiner is null while delegated too — would double-init).
    const info = await connection.getAccountInfo(minerPda(owner));
    const landed = await enterRound({
      l1, connection, wallet, roundId, validator: DEFAULT_ER_VALIDATOR,
      includeInitMiner: info === null, validUntilSec: Math.floor(Date.now() / 1000) + 3600,
      // Persist the moment the entry confirms (before propagation waits) so a slow wait
      // can't strand a joined+delegated player with a forgotten session key.
      onLanded: ({ sessionSigner, tokenPda, validUntil }) => persist({
        owner: owner.toBase58(), secretKey: Array.from(sessionSigner.secretKey),
        tokenPda: tokenPda.toBase58(), validUntil,
      }),
    });
    onReceipt?.({ label: `enter round ${roundId} · one popup`, sig: landed.signature });
  });

  const doStake = (squares: number[], amountPerSquare: BN) => run(async () => {
    if (!signer || !session) throw new Error("no active session — enter the round first");
    const er = erProgramForSession(erConnection(), signer);
    // Sequential on purpose: gaslessStake's landed-signal logic is per-square, and a
    // mid-loop failure leaves earlier squares genuinely staked (the board shows them).
    for (const square of squares) {
      await gaslessStake({ er, ownerWallet: owner, sessionSigner: signer, tokenPda: new PublicKey(session.tokenPda), square, amount: amountPerSquare, roundId });
    }
    // Gasless stakes live on the ephemeral rollup — the L1 artifact is the miner
    // account, where they land at settle via ProcessUndelegation.
    onReceipt?.({ label: `stake ×${squares.length} · gasless (ER)`, addr: minerPda(owner).toBase58() });
    onStaked?.();
  });

  const doClaim = (rid: number) => run(async () => {
    const sig = await claimIx(l1, owner, rid).rpc();
    onReceipt?.({ label: `claim round ${rid}`, sig });
  });
  const doRefund = (rid: number) => run(async () => {
    const sig = await refundIx(l1, owner, rid).rpc();
    onReceipt?.({ label: `refund round ${rid}`, sig });
  });

  // The claimable round is the player's STAKED round (miner.roundId), not the live snapshot round.
  const stakedRound = miner?.roundId ?? 0;
  const unclaimed = stakedRound > 0 && (escrow?.lastClaimedRound ?? 0) < stakedRound;
  const [stakedRoundState, setStakedRoundState] = useState<RoundState | null>(null);
  useEffect(() => {
    if (!unclaimed) { setStakedRoundState(null); return; }
    let live = true;
    const poll = () => fetchRound(l1, roundPda(stakedRound))
      .then((r) => { if (live) setStakedRoundState(r.state); })
      .catch(() => { if (live) setStakedRoundState(null); });
    poll();
    // Keep polling so the Claim/Refund panel appears the instant the keeper advances the
    // staked round to Claimable/Closed — a single fetch leaves the payout invisible until
    // a manual page reload (the round transitions without stakedRound/unclaimed changing).
    const id = setInterval(poll, 5000);
    return () => { live = false; clearInterval(id); };
  }, [l1, stakedRound, unclaimed]);

  // Entering re-stamps miner.round_id (join_round), which would forfeit an unresolved
  // staked round — a claimable-but-unclaimed payout, or a reconciled-but-unrefunded
  // Closed round. Gate Enter until the player resolves it below.
  const forfeit = enterWouldForfeit({
    activeRound: escrow?.activeRound ?? 0, stakedRound,
    lastClaimedRound: escrow?.lastClaimedRound ?? 0,
    reconciledRound: escrow?.reconciledRound ?? 0, stakedRoundState,
  });
  // join_round requires an existing escrow with >= min_stake (0.01 SOL) — without a
  // deposit the entry tx reverts on-chain with AccountNotInitialized. Gate + hint.
  const MIN_STAKE_LAMPORTS = 10_000_000n;
  const noFunds = loaded && (escrow?.balance ?? 0n) < MIN_STAKE_LAMPORTS;
  // Fail-safe: never enable Enter until player state has loaded. Before then escrow/miner are
  // null and collapse to "fresh player, nothing to forfeit", which would let a RETURNING player
  // forfeit a pending payout by clicking Enter during the load window.
  const enterBlocked = !loaded || forfeit || noFunds;

  return (
    <div className="flex flex-col gap-3">
      <EscrowPanel
        balanceLamports={escrow?.balance ?? 0n}
        walletLamports={walletLamports}
        locked={(escrow?.activeRound ?? 0) !== 0}
        busy={busy} onDeposit={doDeposit} onWithdraw={doWithdraw}
      />
      {needsEntry ? (
        <div className="flex flex-col gap-1">
          <button
            disabled={busy || snapshot.state !== RoundState.Open || enterBlocked} onClick={doEnter}
            className="rounded-lg bg-bull-green/20 text-bull-green py-3 text-sm font-medium disabled:opacity-40 active:scale-[0.98] transition-transform"
          >Enter round · one popup</button>
          {!loaded ? (
            <p className="text-[10px] text-bull-muted">checking your prior round…</p>
          ) : forfeit ? (
            <p className="text-[10px] text-amber-400">
              {stakedRoundState === RoundState.Closed ? "Refund" : "Claim"} round {stakedRound} below first — entering now forfeits it.
            </p>
          ) : noFunds ? (
            <p className="text-[10px] text-amber-400">Deposit at least 0.01 SOL to your escrow first.</p>
          ) : null}
        </div>
      ) : (
        <StakeRail selectedSquares={selectedSquares} sessionValid={canStake} busy={busy} onStake={doStake} />
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
