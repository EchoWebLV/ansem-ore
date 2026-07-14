import { Program } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { AnsemMiner } from "./idl/ansem_miner.js";
import { GRID_SIZE, RoundState } from "./constants.js";

export interface ConfigState {
  admin: string; ansemMint: string; swapMode: number; currentRoundId: number;
  roundDurationSecs: number; feeBps: number; multMinBps: number; multMaxBps: number;
  minStake: bigint; maxStakePerRound: bigint; mockRate: bigint; totalEscrowBalance: bigint;
  rolloverJackpot: bigint; currentRoundFinalized: boolean;
  // Mainnet real-payout layer (plan 2026-07-14): ANSEM solvency ledger, claim window, swap floor.
  ansemObligations: bigint; claimWindowSecs: number; minSwapRate: bigint;
}
export interface RoundStateData {
  roundId: number; deadlineTs: number; blockSol: bigint[]; pot: bigint; state: RoundState;
  randomness: number[]; jackpotSquare: number; jackpotPool: bigint; swapProceeds: bigint;
  // Mainnet real-payout layer: entitlement ceiling frozen at swap + running claimed total.
  entitlementTotal: bigint; claimedProceeds: bigint;
}
export interface MinerState { authority: string; roundId: number; blockStake: bigint[]; }
export interface EscrowState {
  authority: string; balance: bigint; depositedTotal: bigint; withdrawnTotal: bigint;
  lastClaimedRound: number; activeRound: number; reconciledRound: number;
}

/** Live shared board state served to browsers by the keeper read-layer. */
export interface BoardSnapshot {
  roundId: number; state: RoundState; deadlineTs: number; pot: bigint;
  blockSol: bigint[]; jackpotSquare: number | null; jackpotPool: bigint; rolloverJackpot: bigint;
  updatedAt: number;
}

const n = (x: any) => (typeof x?.toNumber === "function" ? x.toNumber() : Number(x));
const big = (x: any) => (typeof x?.toString === "function" ? BigInt(x.toString()) : BigInt(x));

export async function fetchConfig(program: Program<AnsemMiner>, config: PublicKey): Promise<ConfigState> {
  const c: any = await program.account.config.fetch(config);
  return {
    admin: c.admin.toBase58(), ansemMint: c.ansemMint.toBase58(), swapMode: c.swapMode,
    currentRoundId: n(c.currentRoundId), roundDurationSecs: n(c.roundDurationSecs), feeBps: c.feeBps,
    multMinBps: c.multMinBps, multMaxBps: c.multMaxBps, minStake: big(c.minStake),
    maxStakePerRound: big(c.maxStakePerRound), mockRate: big(c.mockRate),
    totalEscrowBalance: big(c.totalEscrowBalance), rolloverJackpot: big(c.rolloverJackpot),
    currentRoundFinalized: c.currentRoundFinalized,
    ansemObligations: big(c.ansemObligations), claimWindowSecs: n(c.claimWindowSecs),
    minSwapRate: big(c.minSwapRate),
  };
}
export async function fetchRound(program: Program<AnsemMiner>, round: PublicKey): Promise<RoundStateData> {
  const r: any = await program.account.round.fetch(round);
  return {
    roundId: n(r.roundId), deadlineTs: n(r.deadlineTs), blockSol: r.blockSol.map(big), pot: big(r.pot),
    state: r.state as RoundState, randomness: r.randomness, jackpotSquare: r.jackpotSquare,
    jackpotPool: big(r.jackpotPool), swapProceeds: big(r.swapProceeds),
    entitlementTotal: big(r.entitlementTotal), claimedProceeds: big(r.claimedProceeds),
  };
}
export async function fetchMiner(program: Program<AnsemMiner>, miner: PublicKey): Promise<MinerState | null> {
  const m: any = await program.account.minerPosition.fetch(miner).catch(() => null);
  return m && { authority: m.authority.toBase58(), roundId: n(m.roundId), blockStake: m.blockStake.map(big) };
}
export async function fetchEscrow(program: Program<AnsemMiner>, escrow: PublicKey): Promise<EscrowState | null> {
  const e: any = await program.account.playerEscrow.fetch(escrow).catch(() => null);
  return e && {
    authority: e.authority.toBase58(), balance: big(e.balance), depositedTotal: big(e.depositedTotal),
    withdrawnTotal: big(e.withdrawnTotal), lastClaimedRound: n(e.lastClaimedRound),
    activeRound: n(e.activeRound), reconciledRound: n(e.reconciledRound),
  };
}

export function toBoardSnapshot(round: RoundStateData, config: ConfigState, updatedAt: number): BoardSnapshot {
  const settledOrLater = round.state >= RoundState.Settled;
  return {
    roundId: round.roundId, state: round.state, deadlineTs: round.deadlineTs, pot: round.pot,
    blockSol: round.blockSol, jackpotSquare: settledOrLater ? round.jackpotSquare : null,
    jackpotPool: round.jackpotPool, rolloverJackpot: config.rolloverJackpot, updatedAt,
  };
}

/** Grid width guard for consumers; blockSol/blockStake are fixed-length GRID_SIZE arrays. */
export const isFullGrid = (arr: unknown[]): boolean => arr.length === GRID_SIZE;

/** BEEF config (raw anchor-decoded: beefMint/beefVault are PublicKey, numeric fields BN). */
export const fetchBeefConfig = (p: Program<AnsemMiner>, pda: PublicKey) =>
  p.account.beefConfig.fetch(pda);
