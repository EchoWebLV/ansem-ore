# @ansem/app — ANSEM Miner web (M4b: read-only)

Live bull-head board that renders real devnet rounds streamed from the keeper.
The browser never touches devnet RPC — it reads the keeper's WS (`{snapshot, events}`)
with a REST `/snapshot` cold-load fallback. No staking yet (that's M4c).

## Run locally against devnet

1. Start the keeper (serves the read-layer on `:8787`):
   ```bash
   source scripts/devnet-env.sh
   pnpm --filter @ansem/sdk build
   pnpm run keeper:dev
   ```
2. In another terminal, start the web app:
   ```bash
   cp app/.env.local.example app/.env.local   # defaults point at 127.0.0.1:8787
   pnpm run app:dev
   ```
3. Open http://localhost:3000 — the board fills as the keeper opens a round,
   stakes light green, the countdown ticks, and settle flips the jackpot bull gold.

## Env
- `NEXT_PUBLIC_KEEPER_WS` (default `ws://127.0.0.1:8787`)
- `NEXT_PUBLIC_KEEPER_HTTP` (default `http://127.0.0.1:8787`)
- `NEXT_PUBLIC_SOLANA_CLUSTER` (default `devnet`, wallet-adapter only; unused for reads)

## Test
```bash
pnpm --filter @ansem/app test        # unit + jsdom component tests (network-free)
pnpm --filter @ansem/app build       # regenerates public/bulls/ via sharp prebuild
```

## Architecture (M4b slice)
- `src/lib/board-layout.ts` — pure bull-head lattice (25 cells, from the prototype).
- `src/lib/keeper-client.ts` — framework-free WS/REST client (injectable I/O, reconnect).
- `src/lib/format.ts` — SOL / countdown / state-label / event-text helpers.
- `src/hooks/use-keeper-snapshot.ts` — React hook: `{ snapshot, events, status }`.
- `src/components/` — `Board`, `Hud`/`Countdown`, `Leaderboard`, `ActivityFeed`,
  `WalletBar`/`Providers` (wallet connect, read-only), `PlayBoard` (composition).
- `scripts/optimize-bulls.mjs` — sharp prebuild: `generated/bulls/*.png` → `public/bulls/NN.webp`.

Wire types (`WireSnapshot`, `KeeperEvent`) live in `@ansem/sdk` and are shared with
the keeper — the app consumes exactly what the keeper serves (bigints as strings).

## Deferred to later M4 phases
- Gasless staking + claim (the write path) — **M4c**.
- Productionized ascending settle-reveal choreography, AVIF, responsive/mobile
  polish, Playwright e2e, and Vercel deploy — **M4d**.
