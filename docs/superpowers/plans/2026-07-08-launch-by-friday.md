# Launch by Friday (2026-07-10) — Public Devnet Beta Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A publicly hosted, playable ANSEM Miner devnet beta — public URL, continuous keeper-run rounds, fresh wallet completes deposit → one-popup entry → gasless stake → VRF settle → claim — announced Friday 2026-07-10.

**Architecture:** Finish M4c (redeploy the committed program fix `9d84e03` to devnet, recover the poisoned round, re-verify with devnet ITs + the human runbook), then a Friday-cut M4d (production deploy: keeper → Railway container, app → Vercel; launch disclaimer; soak), then launch assets + go/no-go.

**Tech Stack:** Anchor 0.31.1 / sBPF v3 (`cargo build-sbf --arch v3 --tools-version v1.54`), pnpm monorepo (`@ansem/sdk` + `@ansem/keeper` + `@ansem/app` Next.js 14), MagicBlock ER + ephemeral VRF (devnet), Vercel CLI (authed as `yordanlv`), Railway (or equivalent always-on Node 22 host).

---

## CTO scope lock — what "market" means Friday

**Friday = public devnet beta launch.** Free to play (devnet SOL, mock ANSEM), marketed as the launch of the game. **Mainnet real-money is explicitly NOT Friday**: the real Jupiter swap path is unbuilt (devnet uses `execute_swap_mock`), and the design spec gates mainnet on audit + legal review + $ANSEM liquidity + jackpot funding. Launching unaudited fund-custody + randomness-payout contracts with real money in 48h is not a plan, it's an incident. Track D below starts the mainnet gate work in parallel; it does not ship Friday.

**Explicit Friday cuts from the M4d spec (§8):** productionized settle-reveal animation upgrade (current reveal — gold jackpot flash on REVEALED — ships as-is), Playwright e2e (the human runbook is the e2e gate), OG image cards (metadata title/description already exist), multi-region ER, analytics. Each is post-launch backlog, not launch-blocking.

**Hard user checkpoints (cannot be done by the agent):**
1. Human runbook on local stack (Task 7, Phantom wallet) — gates production deploy.
2. Railway account + `railway login` (Task 8) — or say the word and we pick Fly/Render/VPS instead.
3. Human runbook on the PRODUCTION URL (Task 11) — gates announcement.
4. Post the announcement from your X account (Task 13).

**Known risks accepted for a devnet beta:** public devnet RPC 429s (keeper backoff already absorbs; soak validates), the keeper host holds the devnet admin/upgrade-authority keypair (devnet-only key, no real funds; splitting keys is a Track D mainnet gate), devnet itself can hiccup (the app shows `KEEPER: CONNECTED` state as the degradation signal).

---

## Track A — Redeploy + verify (Wednesday)

### Task 1: Fix the deploy script (drop `--use-rpc`, deploy via public RPC)

M4b ground truth: `--use-rpc` stalled at ~9% and self-inflicted a 429 spiral; dropping it (TPU/QUIC chunk writes) landed the 605KB program in <45s. The Helius dev key is HARD rate-limited (`-32429` on every method), so the deploy must also not source Helius as `$ANCHOR_PROVIDER_URL`.

**Files:**
- Modify: `scripts/deploy-devnet.sh`

- [x] **Step 1: Edit the deploy invocation**

Replace the `solana program deploy` block at the bottom of `scripts/deploy-devnet.sh`:

```bash
# Deploy RPC: public devnet, NOT Helius (dev key is hard rate-limited) and NOT
# --use-rpc (chunk writes via rate-limited RPC 429-spiral; TPU/QUIC lands in <45s).
DEPLOY_RPC="${DEPLOY_RPC:-https://api.devnet.solana.com}"

echo "Deploying $SO ($(stat -f%z "$SO") bytes, sBPF v3) -> $PROGRAM_ID on devnet ..."
solana program deploy "$SO" \
  --program-id "$PROGRAM_KP" \
  --buffer "$BUFFER_KP" \
  --keypair "$DEVNET_WALLET" \
  --url "$DEPLOY_RPC" \
  --with-compute-unit-price 50000 \
  --max-sign-attempts 300

echo ""
echo "Deployed. Verifying ..."
solana program show "$PROGRAM_ID" --url "$DEPLOY_RPC"
```

(Exactly the command that landed the M4b deploy, parameterized. `--use-rpc` removed; `--max-sign-attempts` 60 → 300.)

- [x] **Step 2: Commit**

```bash
git add scripts/deploy-devnet.sh
git commit -m "fix(deploy): drop --use-rpc + deploy via public devnet RPC (M4b lesson: TPU lands <45s, RPC chunk-writes 429-spiral)"
```

### Task 2: Rebuild IDL + SDK from the fixed program; confirm `joinRound` carries the `miner` account

The CRIT-1 fix added a `mut miner` account to `JoinRound` (`round_entry.rs`) — the IDL changed. The SDK IDL (`packages/sdk/src/idl/ansem_miner.{json,ts}`) is GITIGNORED and must be regenerated. `anchor build` also overwrites `target/deploy/ansem_miner.so` with a v2-flags artifact, so this task runs BEFORE the v3 build (Task 3), never after.

- [x] **Step 1: Check whether the working-tree IDL already has the fix**

```bash
python3 -c "
import json
idl = json.load(open('packages/sdk/src/idl/ansem_miner.json'))
jr = next(i for i in idl['instructions'] if i['name'] == 'joinRound' or i['name'] == 'join_round')
names = [a['name'] for a in jr['accounts']]
print('joinRound accounts:', names)
print('HAS MINER' if any(n == 'miner' for n in names) else 'MISSING MINER — regenerate')
"
```

Expected: `HAS MINER` (the local anchor suite ran green at commit, so the tree is likely synced). If `MISSING MINER`, run Step 2; else skip to Step 3.

- [ ] **Step 2 (only if missing): Regenerate + sync**

```bash
anchor build                                # emits target/idl/ansem_miner.json (+ overwrites .so with v2 — Task 3 rebuilds v3)
pnpm --filter @ansem/sdk sync-idl
pnpm --filter @ansem/sdk build
```

- [x] **Step 3: Re-run the automated gates against the tree that will deploy**

```bash
pnpm -r test && pnpm -r typecheck
```

Expected: SDK 19 / keeper 42 (+2 gated ITs self-skip) / app 71 — all green (matches commit `9d84e03`).

- [x] **Step 4: Commit if Step 2 changed the SDK dist inputs** (IDL itself is gitignored; only commit if any tracked file moved)

```bash
git status --short   # expect empty; if tracked files changed, commit them
```

### Task 3: Build the sBPF v3 artifact

- [x] **Step 1: Build**

```bash
cd programs/ansem-miner   # or repo root — build-sbf resolves the workspace
cargo build-sbf --arch v3 --tools-version v1.54
```

- [x] **Step 2: Verify v3 flags (the deploy script also guards this)**

```bash
"$(ls ~/.cache/solana/*/platform-tools/llvm/bin/llvm-readelf | head -1)" -h target/deploy/ansem_miner.so | grep Flags
```

Expected: `Flags: 0x3`

### Task 4: Deploy to devnet

- [x] **Step 1: Pre-flight — deploy wallet balance**

```bash
solana balance 9FuMzZyQaTabe5PhXYZxSxRDgxx5576aByJtNXucBVbF --url https://api.devnet.solana.com
```

Expected: ~7.2 SOL (M4b left it there). Need ≥ ~4.3 transient for the upgrade buffer (rent returns on finalize). If short, mine: `devnet-pow mine -k ~/.config/solana/ansem-devnet.json -u dev -t 5000000000 --reward 0.02 -d 3 --no-infer` (stop with `pkill -f devnet-pow` before ER tests). If the balance RPC 429s, back off ~30s and retry (per-IP, transient).

- [x] **Step 2: Deploy**

```bash
bash scripts/deploy-devnet.sh
```

Expected: finishes in ~1 min; `solana program show` output at the end.

- [x] **Step 3: Verify the deploy actually advanced**

```bash
solana program show 8Q9EnK7ydn6ywo7ZxeqhubqYybf7FFNNwnz8JzJjXZjz --url https://api.devnet.solana.com | grep "Last Deployed In Slot"
```

Expected: slot **> 474633473** (the pre-fix deploy). This is the check that failed silently last time — do not skip.

### Task 5: Recover the poisoned round (cursor past 474653546)

Round 474653546 (Open, delegated, pot 0, past deadline — created by the pre-fix T4 spike) wedges the keeper on start. `set_round_cursor` finalizes the cursor so the keeper opens the next fresh round. Accepted loss: the throwaway spike wallet's 0.05 devnet SOL escrow.

- [x] **Step 1: Probe current state**

```bash
node scripts/_cursor.mjs
```

Expected: `admin==wallet: true`, `current_round_id: 474653546`, `finalized: false`, round PDA owner = DLP (delegated).

- [x] **Step 2: Set the cursor**

```bash
node scripts/_cursor.mjs --set
```

Expected: `set_round_cursor(...)` tx signature printed; re-probe shows `finalized: true`.

### Task 6: Devnet integration proof (incl. the CRIT-1 ER path)

The join-without-stake committability fix has only been proven on local L1 (23/23) — the ER path proof happens here, on real MagicBlock devnet infra.

- [x] **Step 1: Keeper hands-off round IT (drives a scripted gasless session player)**

```bash
source scripts/devnet-env.sh
export ANCHOR_PROVIDER_URL=https://api.devnet.solana.com PROVIDER_ENDPOINT=https://api.devnet.solana.com WS_ENDPOINT=wss://api.devnet.solana.com
pnpm --filter @ansem/sdk build
KEEPER_DEVNET_IT=1 pnpm --filter @ansem/keeper test devnet-round
```

Expected: PASS — keeper opens+delegates → commits → real-VRF settles → swaps → scripted player claims ANSEM.

- [x] **Step 2: Devnet smoke phases (run individually — public RPC rate limits a combined run)**

```bash
yarn run ts-mocha -p ./tsconfig.json -t 1000000 -g "phase 1" tests/ansem-miner-devnet.ts
yarn run ts-mocha -p ./tsconfig.json -t 1000000 -g "phase 2" tests/ansem-miner-devnet.ts
yarn run ts-mocha -p ./tsconfig.json -t 1000000 -g "phase 3" tests/ansem-miner-devnet.ts
yarn run ts-mocha -p ./tsconfig.json -t 1000000 -g "phase 4" tests/ansem-miner-devnet.ts
```

Expected: each phase green in isolation (L1 flow / ER stake+commit / VRF settle / full gasless e2e).

- [x] **Step 3: Explicit CRIT-1 probe — join WITHOUT staking, watch the keeper commit it.** Start the keeper locally (`pnpm run keeper:dev` with the public-RPC overrides above), use the app (Task 7 stack) or the entry IT (`ENTRY_BATCH_IT=1 pnpm --filter @ansem/keeper run entry-it`) to enter a round and stake NOTHING, then let the deadline pass.

Expected keeper logs: `round committed back to L1` → `request_settle posted` → `round swapped -> CLAIMABLE`, and the NEXT round opens — no ConstraintSeeds(2006) wedge, no deferred-forever commit_round. This is the exact failure mode that poisoned devnet; it must pass before anything public.

### Task 7: 🧑 USER GATE — human e2e runbook (local stack, live devnet)

- [ ] Execute `docs/superpowers/runbooks/2026-07-08-m4c-e2e-devnet.md` top to bottom with a fresh Phantom devnet wallet (~0.2 SOL from the faucet). Every PASS condition must hold: one-popup entry, ZERO-popup gasless stake, live board updates, settle-reveal, claim mints ANSEM.
- [ ] Addendum step (CRIT-1 human proof): with a second fresh wallet, **enter a round and do NOT stake**; confirm the round still settles and the next round opens, and your escrow unlocks (withdraw succeeds after the round finalizes).

**M4c is DONE when this checklist is fully checked. Production deploy (Track B) is gated on it.**

---

## Track B — Production deploy + soak (Thursday)

### Task 8: Keeper → always-on host (Railway)

The keeper is one Node 22 process (`node dist/main.js`), HTTP+WS on one port, health at `/health`. It needs the pnpm workspace built (imports `@ansem/sdk` dist) and the admin keypair as a file — the container entrypoint writes it from a secret env var.

**Files:**
- Create: `keeper/Dockerfile`
- Create: `keeper/Dockerfile.dockerignore` (BuildKit per-Dockerfile ignore — a plain `keeper/.dockerignore` is INERT when the build context is the repo root)

- [x] **Step 1: Write `keeper/Dockerfile`** (build context = repo root)

```dockerfile
# syntax=docker/dockerfile:1
FROM node:22-slim
WORKDIR /repo
RUN corepack enable
# Workspace manifests first (layer cache), then sources.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/sdk/package.json packages/sdk/package.json
COPY keeper/package.json keeper/package.json
COPY app/package.json app/package.json
RUN pnpm install --frozen-lockfile --filter @ansem/sdk --filter @ansem/keeper
COPY packages/sdk packages/sdk
COPY keeper keeper
RUN pnpm --filter @ansem/sdk build && pnpm --filter @ansem/keeper build
# Entrypoint: materialize the admin keypair from the secret env, bind to the host's PORT.
RUN printf '#!/bin/sh\nset -e\n[ -n "$KEEPER_WALLET_JSON" ] || { echo "KEEPER_WALLET_JSON missing"; exit 1; }\nprintf "%%s" "$KEEPER_WALLET_JSON" > /repo/wallet.json\nexport DEVNET_WALLET=/repo/wallet.json\nexport KEEPER_HTTP_PORT="${PORT:-8787}"\nexec node keeper/dist/main.js\n' > /entrypoint.sh && chmod +x /entrypoint.sh
EXPOSE 8787
CMD ["/entrypoint.sh"]
```

- [x] **Step 2: Write `keeper/Dockerfile.dockerignore`** (paths relative to the CONTEXT root = repo root; keep `app/package.json` — the pnpm workspace install needs every workspace manifest)

```
.git
**/node_modules
**/dist
target
test-ledger
magicblock-test-storage
generated
docs
tests
scripts
programs
app/*
!app/package.json
```

- [x] **Step 3: Local container proof before any host**

```bash
docker build -f keeper/Dockerfile -t ansem-keeper .
docker run --rm -p 8787:8787 \
  -e ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
  -e WS_ENDPOINT=wss://api.devnet.solana.com \
  -e KEEPER_WALLET_JSON="$(cat ~/.config/solana/ansem-devnet.json)" \
  ansem-keeper
# other terminal:
curl -s http://127.0.0.1:8787/health && curl -s http://127.0.0.1:8787/snapshot | head -c 300
```

Expected: health OK; snapshot JSON with a live round (keeper opened one). Stop with Ctrl-C — one keeper at a time (it holds the admin key; two keepers = dueling cranks).

- [ ] **Step 4: 🧑 USER — Railway account + login** (`npm i -g @railway/cli && railway login`). If Railway is a no-go, Fly.io (`fly launch --dockerfile keeper/Dockerfile`) or any Docker VPS is equivalent — the container is host-agnostic.

- [ ] **Step 5: Deploy + configure**

```bash
railway init                      # new project "ansem-keeper"
railway up --dockerfile keeper/Dockerfile   # build context = repo root
railway variables set \
  ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
  WS_ENDPOINT=wss://api.devnet.solana.com \
  KEEPER_WALLET_JSON="$(cat ~/.config/solana/ansem-devnet.json)"
railway domain                    # note the public https://<domain> — WSS rides the same domain
```

(ER endpoints, validator, VRF queue all default correctly in `keeper/src/env.ts` — devnet-us region.)

- [ ] **Step 6: Verify hosted keeper**

```bash
curl -s https://<railway-domain>/health
curl -s https://<railway-domain>/snapshot | head -c 300
```

Expected: health OK, snapshot advancing round ids across ~2 min (continuous rounds). **Make sure the local keeper/docker keeper are STOPPED once the hosted one is up.**

- [ ] **Step 7: Commit**

```bash
git add keeper/Dockerfile keeper/Dockerfile.dockerignore
git commit -m "feat(keeper): production Dockerfile (workspace build, secret-env keypair, PORT bind)"
```

### Task 9: Launch disclaimer footer (legal must-have)

Unofficial fan project marketing someone else's brand — the disclaimer ships before the URL is public.

**Files:**
- Create: `app/src/components/Disclaimer.tsx`
- Create: `app/src/components/Disclaimer.test.tsx`
- Modify: `app/src/app/page.tsx` (render `<Disclaimer />` after the board/write column)

- [x] **Step 1: Write the failing test**

```tsx
// app/src/components/Disclaimer.test.tsx
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { Disclaimer } from "./Disclaimer";

describe("Disclaimer", () => {
  it("states unofficial, devnet-only, no-real-funds", () => {
    render(<Disclaimer />);
    const t = screen.getByTestId("disclaimer").textContent ?? "";
    expect(t).toMatch(/unofficial fan project/i);
    expect(t).toMatch(/not affiliated with or endorsed by Ansem/i);
    expect(t).toMatch(/devnet/i);
    expect(t).toMatch(/no real funds|test tokens/i);
  });
});
```

- [x] **Step 2: Run it — expect FAIL** (`pnpm --filter @ansem/app test Disclaimer`)

- [x] **Step 3: Implement**

```tsx
// app/src/components/Disclaimer.tsx
export function Disclaimer() {
  return (
    <footer
      data-testid="disclaimer"
      className="mx-auto max-w-3xl px-4 py-6 text-center text-xs leading-relaxed text-zinc-500"
    >
      ANSEM Miner is an <strong>unofficial fan project</strong> — not affiliated with or
      endorsed by Ansem. This is a <strong>devnet beta</strong>: it uses Solana devnet SOL
      and a mock ANSEM test token only. <strong>No real funds</strong> are used, held, or
      paid out. Play is for entertainment and testing.
    </footer>
  );
}
```

Then render it in `app/src/app/page.tsx` (import `{ Disclaimer }` and place it as the last child of the page container).

- [x] **Step 4: Run tests + typecheck — expect PASS** (`pnpm --filter @ansem/app test && pnpm --filter @ansem/app typecheck`)

- [x] **Step 5: Commit**

```bash
git add app/src/components/Disclaimer.tsx app/src/components/Disclaimer.test.tsx app/src/app/page.tsx
git commit -m "feat(app): launch disclaimer footer (unofficial fan project, devnet beta, no real funds)"
```

### Task 10: App → Vercel

App already reads `NEXT_PUBLIC_KEEPER_WS`/`NEXT_PUBLIC_KEEPER_HTTP` (`page.tsx:3-4`); `prebuild` regenerates bull tiles (source PNGs are committed); `next.config.mjs` already has the `extensionAlias` fix. Vercel auto-detects the pnpm workspace (installs at repo root); the only extra is building the SDK before `next build`.

**Files:**
- Create: `app/vercel.json`

- [x] **Step 1: Write `app/vercel.json`**

```json
{
  "buildCommand": "pnpm --filter @ansem/sdk build && pnpm run build",
  "framework": "nextjs"
}
```

- [ ] **Step 2: Link + set env (values from Task 8 Step 5's domain)**

```bash
cd app
vercel link                       # scope yordanlv, new project "ansem-miner"
vercel env add NEXT_PUBLIC_KEEPER_WS production    # wss://<railway-domain>
vercel env add NEXT_PUBLIC_KEEPER_HTTP production  # https://<railway-domain>
```

- [ ] **Step 3: Preview deploy first, then production**

```bash
vercel                            # preview URL — verify before prod
vercel --prod
```

- [ ] **Step 4: Verify the deployed read path** — open the prod URL: bull-head board renders (25 outlined SQUARES — the PNG tile pipeline was removed 2026-07-08; no prebuild step exists anymore), `KEEPER: CONNECTED`, live round + countdown ticking, disclaimer visible. Check the browser console for errors and that the WS connects to the Railway domain (Network tab).

- [x] **Step 5: Commit**

```bash
git add app/vercel.json
git commit -m "feat(app): vercel config (workspace SDK build before next build)"
```

### Task 11: 🧑 USER GATE — production smoke (the runbook, on the public URL)

- [ ] Repeat runbook steps 1–7 against the **production URL** with a fresh Phantom devnet wallet: deposit → one-popup enter → gasless stake → reveal → claim. Same PASS conditions as Task 7 — this is the go/no-go input.

### Task 12: Overnight soak (Thu → Fri)

- [ ] Leave the hosted keeper running. Verify at three spot checks (evening / late / Friday morning): `curl -s https://<railway-domain>/health` OK and `/snapshot` round id has advanced; Railway logs show no crash-restarts and no wedged round (a stuck `VRF_PENDING` older than grace = investigate — the keeper's grace-cancel should have cleared it).
- [ ] PASS: ≥12h continuous hands-off rounds. FAIL: diagnose before launch — a keeper that can't survive a night can't survive launch traffic.

---

## Track C — Launch (Friday)

### Task 13: Launch assets + announcement

- [ ] Draft (agent): landing-accurate copy — hook ("mine $ANSEM on the bull board — gasless, popup-free, live rounds every 60s"), how-to (3 steps: faucet SOL → deposit+enter (one popup) → stake gasless & claim), the tech flex (MagicBlock ER + ephemeral VRF + session keys, real on-chain program), the disclaimer line verbatim, the URL.
- [ ] Capture (agent): 15–30s demo GIF of a full round on the prod URL (board stake → reveal → claim) via browser capture.
- [ ] 🧑 USER: approve copy, post the thread from your X account Friday; drop the link in the MagicBlock Discord ecosystem channel (they amplify ER showcase projects).
- [ ] Go/no-go gate (all must be true): Task 11 checklist fully green · soak PASS (Task 12) · disclaimer live on prod · keeper + Vercel dashboards clean.

### Task 14: Launch-day watch

- [ ] Monitor loop after posting: `/health` + `/snapshot` every few minutes, Railway logs for crank errors, Vercel function/edge errors, X replies for user-reported breakage. Rollback lever: Vercel instant rollback for the app; `railway down`/redeploy for the keeper; `set_round_cursor` remains the round-recovery escape hatch.

---

## Track D — Mainnet gate (starts now, ships when gated — NOT Friday)

Parallel work items, each its own plan later: real Jupiter `begin_swap`/`record_swap` keeper path (mock swap replacement) · security audit engagement · legal review (gambling-shaped mechanics, IP/likeness) · Ansem/community outreach + jackpot-vault seeding conversation · key hygiene (split program upgrade authority from the keeper's hot admin key; move admin off any shared host) · $ANSEM mainnet liquidity depth check · mainnet gate for the admin `settle` fallback (spec §12).

**Custody-minimization ladder (user directive 2026-07-08: "we should not hold any of the funds").** The pot must be program-held during a round (inherent to a pooled game); everything else is removable — the target claim is "autonomous code holds funds; no human, including us, can redirect a lamport":
1. No admin fund-moving paths — already true by design; keep it a review invariant.
2. Permissionless crank — make the full round-driving loop permissionless (several calls already are); we run a keeper for liveness, not as a gatekeeper.
3. Upgrade authority ladder: Squads multisig → timelock (changes visible before they apply) → BURN after audit + soak (immutable program = nobody holds the vault).
4. On-chain swap guardrails: output mint pinned to $ANSEM, min-out enforced, proceeds only to the payout vault — a malicious keeper can stall, never siphon.
5. Fee policy decision: zero / community multisig / keep-as-revenue (fees are the one true "we receive funds" flow). Jackpot vault externally funded.
6. Optional: auto-sweep escrow remainders post-claim to shrink the custody window to minutes (trades away the session-budget UX; withdraw-anytime already exists).
Caveat recorded: code-custody ≠ gambling-law immunity — legal review still gates mainnet regardless.

---

## Self-review notes

- Spec coverage: M4c completion (Tasks 1–7) matches the memory's task #8 chain exactly; M4d is deliberately cut to deploy+stability+disclaimer (cuts listed in the scope lock); launch track covers assets/announcement/monitoring; mainnet items parked in Track D by design.
- Ordering hazard encoded: `anchor build` (IDL, v2 .so) strictly before `cargo build-sbf --arch v3` (final .so); deploy script guards Flags=0x3.
- Single-keeper invariant called out twice (Tasks 8.3, 8.6) — two cranks with one admin key would fight.
- All commands verified against: `scripts/deploy-devnet.sh` (read), `scripts/_cursor.mjs` (read), `keeper/src/env.ts` + `main.ts` (read), `app/package.json` + `page.tsx` env usage (read), M4b deploy memory (proven command), `vercel whoami` (authed).
