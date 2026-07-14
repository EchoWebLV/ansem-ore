import { RoundState, ConfigState, RoundStateData, BoardSnapshot, toBoardSnapshot } from "@ansem/sdk";
import { decideAction, CrankAction, CrankState } from "./decide.js";
import { buildFullSnapshot, FullSnapshot, MinerRow } from "../read/snapshot.js";
import { diffEvents, KeeperEvent } from "../read/events.js";

/** The current round plus whether its PDA is still delegated to the DLP (live in the ER). */
export interface RoundView { round: RoundStateData; delegated: boolean; }

export interface TickDeps {
  fetchConfig: () => Promise<ConfigState>;
  fetchRound: (currentRoundId: number) => Promise<RoundView | null>;
  fetchMiners: (roundId: number) => Promise<MinerRow[]>;
  dispatch: (action: CrankAction, ctx: { config: ConfigState; round: RoundStateData | null }) => Promise<void>;
  broadcast: (snap: FullSnapshot, events: KeeperEvent[]) => void;
  nowSec: () => number;
  graceSecs?: number;
  getSnapshot?: (snap: FullSnapshot) => void; // optional: store latest for REST
}

export interface TickState {
  prevSnapshot: BoardSnapshot | null;
  vrfPendingSinceSec: number | null;
}

// Board-only projection reused for the event diff (avoids leaderboard cost).
const buildBoardOnly = (round: RoundStateData, config: ConfigState, now: number): BoardSnapshot =>
  toBoardSnapshot(round, config, now);

/** One crank+read tick. Returns the next TickState (prev snapshot + grace clock). */
export async function runTick(deps: TickDeps, state: TickState): Promise<TickState> {
  const config = await deps.fetchConfig();
  const view = await deps.fetchRound(config.currentRoundId);
  const round = view?.round ?? null;
  const delegated = view?.delegated ?? false;
  const now = deps.nowSec();

  // Grace clock: stamp the first tick we see VRF_PENDING; clear otherwise.
  let vrfPendingSinceSec = state.vrfPendingSinceSec;
  if (round?.state === RoundState.VrfPending) {
    vrfPendingSinceSec = vrfPendingSinceSec ?? now;
  } else {
    vrfPendingSinceSec = null;
  }

  // Build + broadcast the read snapshot.
  let prevSnapshot = state.prevSnapshot;
  if (round) {
    const miners = await deps.fetchMiners(round.roundId);
    const events = diffEvents(prevSnapshot, buildBoardOnly(round, config, now));
    const full = buildFullSnapshot(round, config, miners, events, now);
    deps.getSnapshot?.(full);
    deps.broadcast(full, events);
    prevSnapshot = full;
  }

  // Decide + dispatch the crank action.
  const crankState: CrankState = {
    finalized: config.currentRoundFinalized,
    currentRoundId: config.currentRoundId,
    round: round ? { state: round.state, deadlineTs: round.deadlineTs, roundId: round.roundId, pot: round.pot } : null,
    roundDelegated: delegated,
    nowSec: now,
    vrfPendingSinceSec,
    graceSecs: deps.graceSecs ?? 180,
  };
  const action = decideAction(crankState);
  await deps.dispatch(action, { config, round });

  return { prevSnapshot, vrfPendingSinceSec };
}
