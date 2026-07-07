# @ansem/app — ANSEM Miner web (M4c: playable)

Live bull-head board that renders real devnet rounds streamed from the keeper, and
a full in-browser write path: deposit → **one-popup** round entry → **gasless** staking
→ claim ANSEM. Reads go through the keeper WS (`{snapshot, events}`) + REST `/snapshot`
cold-load (never devnet RPC); player writes go straight to devnet (L1) and the
MagicBlock ER (gasless stake, signed by an ephemeral session key).

## Run locally against devnet

1. Start the keeper (serves the read-layer on `:8787`; public RPC dodges Helius 429):
   ```bash
   source scripts/devnet-env.sh
   export ANCHOR_PROVIDER_URL=https://api.devnet.solana.com WS_ENDPOINT=wss://api.devnet.solana.com
   pnpm --filter @ansem/sdk build
   pnpm run keeper:dev
   ```
2. In another terminal, start the web app (Node 22 — `nvm use 22`):
   ```bash
   cp app/.env.local.example app/.env.local   # defaults point at 127.0.0.1:8787
   pnpm run app:dev                            # serves on :3100
   ```
3. Open http://localhost:3100 — board fills, stakes light green, settle flips the
   jackpot bull gold. Connect a devnet wallet to reveal the write column.

**Full playable walkthrough:** `docs/superpowers/runbooks/2026-07-08-m4c-e2e-devnet.md`.

## Env
- `NEXT_PUBLIC_KEEPER_WS` (default `ws://127.0.0.1:8787`)
- `NEXT_PUBLIC_KEEPER_HTTP` (default `http://127.0.0.1:8787`)
- `NEXT_PUBLIC_SOLANA_CLUSTER` (default `devnet`)
- `NEXT_PUBLIC_RPC_ENDPOINT` — override the L1 RPC for player writes (default: public devnet cluster URL). Set a paid RPC to avoid 429s.
- `NEXT_PUBLIC_ER_ENDPOINT` / `NEXT_PUBLIC_ER_WS_ENDPOINT` — override the MagicBlock ER endpoint (default `https://devnet-us.magicblock.app`).

## Write-path model (M4c)
- **Onboarding (wallet-signed):** `deposit` funds escrow; `init_miner` is folded into first entry.
- **Round entry — ONE popup:** a single tx batching `init_miner?` + gum `createSessionV2` + `join_round` + `delegate_miner`. Wallet signs once; the ephemeral session keypair co-signs. (~739-byte legacy tx — proven on devnet.)
- **Gasless stake — ZERO popups:** ER tx signed by the session keypair (which is also the ER fee payer), `skipPreflight`, confirmed by re-reading `miner.blockStake`.
- **Claim / refund / withdraw (wallet-signed):** individual popups — distinct value-moving actions.
- Session keypair persists in `localStorage` (`ansem.session.<wallet>`), devnet only.

## Test
```bash
pnpm --filter @ansem/app test        # unit + jsdom component tests (network-free)
pnpm --filter @ansem/app build       # regenerates public/bulls/ via sharp prebuild
```
> PDA-deriving logic is unit-tested in the `node` environment (`// @vitest-environment node`):
> web3.js `findProgramAddressSync` needs real curve/crypto that jsdom lacks. Real browsers
> derive PDAs fine (verified) — jsdom is the only place it fails.

## Architecture
- `src/lib/board-layout.ts` — pure bull-head lattice (25 cells).
- `src/lib/keeper-client.ts` — framework-free WS/REST client (injectable I/O, reconnect).
- `src/lib/format.ts` / `src/lib/amount.ts` — display + SOL⇄lamports parsing.
- `src/lib/anchor.ts` — L1/ER `Program` factories (`useL1Program`, `erProgramForSession`, browser-safe `keypairWallet`).
- `src/lib/session-store.ts` / `src/lib/writes.ts` — session persistence + `enterRound`/`gaslessStake`.
- `src/hooks/` — `use-keeper-snapshot`, `use-player-state`, `use-session`.
- `src/components/` — `Board` (+ tile selection), `Hud`/`Countdown`, `Leaderboard`, `ActivityFeed`,
  `WalletBar`/`Providers`, `EscrowPanel`/`StakeRail`/`ClaimPanel`, `PlayControls`, `PlayBoard`.
- `scripts/optimize-bulls.mjs` — sharp prebuild: `generated/bulls/*.png` → `public/bulls/NN.webp`.

Wire types + PDA/ix builders live in `@ansem/sdk`, shared with the keeper. **After any SDK
source change, run `pnpm --filter @ansem/sdk build`** — the app consumes the built `dist`.

## Deferred to M4d
- Productionized ascending settle-reveal choreography, AVIF, responsive/mobile polish,
  Playwright e2e, and Vercel + keeper deploy.
