# @ansem/keeper

Hands-off ANSEM Miner round runner + live read-layer for devnet.

## What it does
One always-on Node process holding the `config.admin` wallet:
- **Round loop (crank):** opens + delegates a round, settles it via the devnet VRF oracle at the deadline, commits + reconciles every participant, swaps the pot to ANSEM, then loops — with a grace window that cancels a stuck round instead of stalling the game.
- **Participant index:** discovers the round's joined wallets (escrow `active_round` scan) to drive commit/reconcile, and stakers (miner `round_id` scan) for the leaderboard.
- **Read-layer:** aggregates a live `BoardSnapshot` and pushes it to browsers over WebSocket + REST, so clients never touch devnet RPC.

## Run against devnet
```bash
source scripts/devnet-env.sh          # ANCHOR_PROVIDER_URL, DEVNET_WALLET (= config.admin), ER endpoints
pnpm --filter @ansem/sdk build        # keeper imports the built SDK
pnpm --filter @ansem/keeper dev       # tsx src/main.ts — opens rounds, settles, swaps, serves :8787
```
- REST snapshot: `curl http://127.0.0.1:8787/snapshot`
- WS live board: connect to `ws://127.0.0.1:8787` — receives `{ snapshot, events }` on connect + each tick.
- Health: `curl http://127.0.0.1:8787/health`

## Env knobs
`KEEPER_ROUND_SECS` (60), `KEEPER_GRACE_SECS` (180, oracle wait before cancel), `KEEPER_POLL_MS` (4000), `KEEPER_HTTP_PORT` (8787).

## Tests
```bash
pnpm --filter @ansem/keeper test        # 34 fast unit tests (network-free); the devnet IT self-skips
```

## M4a verification (full hands-off round on devnet)
```bash
source scripts/devnet-env.sh
pnpm --filter @ansem/sdk build
KEEPER_DEVNET_IT=1 pnpm --filter @ansem/keeper test devnet-round
```
Drives one round end-to-end with a scripted gasless session-player and asserts the keeper settles+swaps and a claim mints ANSEM — no UI.
