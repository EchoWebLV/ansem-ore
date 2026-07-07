# ANSEM Miner — M4: playable devnet dApp (bull board) — Design

**Status:** approved design (2026-07-07). Supersedes the `docs/design/bull-board.html` prototype as the reference for the real frontend.

**Goal:** Ship a fully playable devnet dApp — connect wallet → approve one session key → stake SOL gaslessly on a live bull board → watch a real-VRF settle-reveal → claim ANSEM — with continuous, hands-off rounds run by a keeper.

**Architecture:** A monorepo adding three pieces around the existing Anchor program: a shared TS `sdk`, a long-running `keeper` service (round loop **and** read-layer), and a Next.js `app`. Browsers read live shared state from the keeper over WebSocket (never polling devnet directly) and send their own player transactions to devnet.

**Tech stack:** Next.js (App Router) + TypeScript + Tailwind, `@solana/wallet-adapter` (Phantom/Backpack), `@coral-xyz/anchor` client from the on-chain IDL, `@magicblock-labs/{ephemeral-rollups-sdk, gum-sdk}`, Node/TS keeper (ws + a small REST surface), pnpm/turbo workspace. Web on Vercel; keeper on an always-on host.

**Network:** Solana **devnet** only. Program `8Q9EnK7ydn6ywo7ZxeqhubqYybf7FFNNwnz8JzJjXZjz` (live, loader-v3, sBPF v3). Mainnet (real Jupiter/ANSEM, jackpot funding, legal) is **M5** and out of scope.

---

## 1. Scope

**In:** the full player loop against the live devnet program; a keeper that runs continuous rounds hands-off; a keeper-backed read-layer; the bull-board UI (Black-Bull skin, 25 named bull tiles); a **small program-change bundle** (§3 — delegation + recovery hardening: keeper-drivable `commit_miner`, keeper-gated `delegate_round`, credit-back `refund`) that makes hands-off settlement possible and closes two HIGH fund-safety bugs; deploy of web + keeper.

**Out (deferred):** mainnet swap (Jupiter) and real ANSEM — devnet uses the mock mint (`execute_swap_mock`); the pre-mainnet program hardening items in §12; Private ER; multi-region ER.

**Decisions locked during brainstorming (2026-07-07):**

| # | Decision | Rationale |
|---|---|---|
| 1 | **Fully playable devnet dApp** (not a read-only showcase) | Uses the live, e2e-verified program; proves the product. |
| 2 | **Automated keeper** (long-running Node) runs continuous rounds | The round loop is shared/admin work the UI can't do; hands-off is the product feel. |
| 3 | **Keeper-backed read API** (WebSocket) for live shared state | Dev-tier RPC 429'd during M3; one RPC consumer + instant multiplayer board beats every-client polling. |
| 4 | **Board-hero Black-Bull skin** (green = staked, gold = jackpot, glowing eyes, gasless badge); settle-reveal plays on the board | Matches the Ansem homage; reveal is honest (outcomes VRF-fixed) theater. |
| 5 | **Bull-head silhouette of 25 bull tiles** (one named bull per on-chain square 0–24) | The 25 `generated/bulls/*.png` assets; every square is a character. |
| 6 | **Small program-change bundle** (§3): keeper-drivable `commit_miner`, keeper-gated `delegate_round`, credit-back `refund` | `commit_miner` enables hands-off rounds; the other two fix HIGH fund-safety bugs a pre-M4 stress test found on the same delegation/recovery seams. |

---

## 2. On-chain orchestration reference (grounded in source, 2026-07-07)

Extracted directly from `programs/ansem-miner/src/**` — this is authoritative and corrects prior memory.

**Round state machine:** `OPEN(0) → VRF_PENDING(1) → SETTLED(2) → CLAIMABLE(4)`; `SWAPPING(3)` reserved for the mainnet Jupiter path (unused in mock). Recovery: `{OPEN|VRF_PENDING|SETTLED} → CLOSED(5)` via `cancel_round` (then per-player `refund`). Only **one** un-finalized round exists at a time (`Config.current_round_finalized` gate on `create_round`).

**Per-instruction cluster + signer:**

| Instruction | Cluster | Signer | Gasless? | Role |
|---|---|---|---|---|
| `initialize` | L1 | admin | – | one-time bootstrap; sets `config.admin` (the keeper key) |
| `deposit` / `withdraw` | L1 | player wallet (never session) | no | value in/out of escrow; `withdraw` locked while `active_round≠0` |
| `create_round` | L1 | **permissionless** | – | opens round; guard `current_round_finalized==true` |
| `delegate_round` | L1 | **keeper (admin-gated)** ← §3B | – | hands Round PDA to the DLP (→ ER); OPEN + current-round only |
| `init_miner` | L1 | player wallet | no | one-time MinerPosition PDA (persistent) |
| `join_round` | L1 | player wallet | no | per-round entry; sets `escrow.active_round` (no debit) |
| `delegate_miner` | L1 | player wallet (owner) | no | per-round re-delegate MinerPosition → ER |
| SessionTokenV2 mint | L1 (gum) | player wallet | no | one approval → ≤7-day ephemeral key |
| `stake` | **ER** | **session key** or owner | **yes** | the only gasless action; tallies `block_sol`/`block_stake`/`pot` |
| `request_settle` | ER | admin/keeper | – | `OPEN→VRF_PENDING`; fires VRF CPI (post-deadline) |
| `settle_callback` | ER | VRF identity | – | `VRF_PENDING→SETTLED`; writes randomness + jackpots |
| `settle` (fallback) | ER/L1 | admin/keeper | – | admin-randomness `OPEN→SETTLED`; **no mainnet gate** (see §12) |
| `commit_round` | ER | admin/keeper | – | `commit_and_undelegate` the settled Round → L1 |
| `commit_miner` | ER | **player wallet (owner)** ← changing (see §3) | no | `commit_and_undelegate` the MinerPosition → L1 |
| `process_undelegation` | L1 | DLP (auto) | – | `#[ephemeral]`-injected L1 finalizer |
| `reconcile_miner` | L1 | **permissionless** (keeper) | – | debits escrow from committed `block_stake`; clears lock |
| `execute_swap_mock` | L1 | **permissionless** (keeper) | – | `SETTLED→CLAIMABLE`; mints ANSEM to payout vault; solvency-gated |
| `claim` | L1 | player wallet | no | transfers ANSEM payout + jackpot shares to player ATA |
| `cancel_round` / `refund` | L1 | admin / player | – | escape hatch; `refund` unlocks **and credits back reconciled stake** (§3C) |

**Canonical hands-off round (after the §3 fix):**
1. `[KEEPER]` `create_round` → `delegate_round` (L1).
2. `[PLAYER]` one batched L1 entry tx: `join_round` + `delegate_miner` + SessionTokenV2 mint (skip mint if a valid session exists).
3. `[PLAYER]` `stake` ×N in the ER — **gasless** (session key), no popups.
4. *— deadline —*
5. `[KEEPER]` `request_settle` (ER) → `[ORACLE]` `settle_callback` (ER) → `SETTLED`.
6. `[KEEPER]` `commit_miner`×all **then** `commit_round` (ER, while accounts are still delegated so the `commit_miner` gate can read the Round) → `[DLP]` `process_undelegation` (L1).
7. `[KEEPER]` `reconcile_miner`×all → `execute_swap_mock` (L1) → `CLAIMABLE`, next round opens.
8. `[PLAYER]` `claim` (L1) — any time after CLAIMABLE.

**Player signing model (after the fix):** onboarding once (`init_miner` + `deposit`); **one** batched L1 popup to enter each round; **zero** popups to stake (gasless); **zero** popups at settle (keeper-driven); **one** L1 popup to claim. Value-moving/ownership ops stay wallet-only so a leaked session key can never move funds (max blast = one round's stake, ≤7-day expiry).

---

## 3. Program change (M3.5, folded into M4a): delegation + recovery hardening

M4a ships one on-chain upgrade bundle. It was scoped as just the keeper-drivable `commit_miner` (needed for hands-off settlement); a pre-M4 stress test (170k+ adversarial math trials via `programs/ansem-miner/tests/invariants.rs` + adversarial handler review, 2026-07-07) then found two **HIGH** fund-safety bugs on the same delegation/recovery seams, so they ride along in the same redeploy. The payout/jackpot math itself was proven bulletproof and is unchanged; the state machine, VRF-callback auth, finalization gate, and admin/session/commit access control all held.

### 3A. Keeper-drivable `commit_miner` (liveness)

**Problem:** As deployed, `commit_miner` requires the *miner owner's* wallet signature (seed `[MINER_SEED, authority.key()]`, `authority: Signer`; not session-gated, no admin path). Since the round can't reach `CLAIMABLE` until **every** staker's miner is committed → reconciled (the `execute_swap_mock` solvency gate passes only when cumulative reconciled stake ≥ `round.pot`), a single offline staker stalls the whole round — and because `create_round` needs `current_round_finalized`, it blocks **all** future rounds until a `cancel_round` void. That makes hands-off continuous rounds impossible and opens a griefing/liveness hole.

**Change (mirror the existing permissionless `reconcile_miner` pattern + a "staking closed" gate):**
- `CommitMiner` accounts:
  - `payer: Signer(mut)` — ER fee payer (the keeper, or anyone). **Remove** the `authority: Signer`.
  - `miner: Account<MinerPosition>(mut)` — seeds `[MINER_SEED, miner.authority.as_ref()]` (self-referential, like `reconcile_miner`), `bump = miner.bump`.
  - `round: Account<Round>` (read-only) — seeds `[ROUND_SEED, miner.round_id.to_le_bytes()]`; used only for the gate.
  - `magic_context`, `magic_program` (injected by `#[commit]`).
- Guard: `require!(round.round_id == miner.round_id, MinerRoundMismatch)` and `require!(round.state != STATE_OPEN, CommitTooEarly)`. Because `stake` requires `STATE_OPEN && now < deadline`, a non-OPEN round guarantees staking is closed → the `block_stake` snapshot is final.
- Keep `commit_and_undelegate` (returns the miner program-owned on L1).

**Ordering:** the keeper runs `commit_miner` for all stakers **after `settle`/`settle_callback` but before `commit_round`**, while the Round is still delegated in the ER, so the read-only `round` gate account is available there; `commit_round` then undelegates the Round. Both are ER ops on delegated accounts; `process_undelegation` lands them all on L1.

**Safety argument:** After the round leaves `OPEN` (which only `request_settle`/`settle` can do, both post-deadline), no further staking is possible, so committing a miner's final snapshot is purely mechanical and beneficial. The guarded `reconcile_miner` (`reconciled_round`) still performs the one-and-only debit. This neutralizes the original review concern (an attacker force-committing a victim's miner *mid-round* to truncate staking) because the gate forbids commits while the round is still `OPEN`. No new value-movement path is introduced; this mirrors the already-permissionless `reconcile_miner`.

### 3B. Keeper-gate `delegate_round` (anti-freeze) — stress finding #1, HIGH

**Problem:** `delegate_round` is fully permissionless — `DelegateRound` is only `payer: Signer` + `round: UncheckedAccount` (seeds `[ROUND_SEED, round_id]`), with no admin gate, no round-state check, and the ER validator taken from `remaining_accounts[0]` (caller-chosen). Anyone can delegate the **current** round — or **any past CLAIMABLE round** (its PDA is still program-owned) — to a validator they pick. The account's owner becomes the delegation program, so every L1 instruction on it (`settle`, `execute_swap_mock`, `cancel_round`, `claim`) then fails Anchor's owner check → **claims + escrow freeze and new rounds halt** (`current_round_finalized` stuck false). `commit_round`/`commit_miner` were deliberately gated; `delegate_round` was the miss. Per §2 the delegator is always the **keeper**, so gating it costs nothing.

**Change:**
- Add `config: Account<Config>` (seeds `[CONFIG_SEED]`) with `constraint = config.admin == payer.key()` — keeper-only (mirrors `commit_round`).
- Defense-in-depth: in the handler, deserialize the (still program-owned) Round from account data and `require!(state == STATE_OPEN)` and `require!(round_id == config.current_round_id)` — a stale / past / already-settled round can never be delegated.
- With the keeper as the sole caller the keeper-supplied validator is trusted; a config-pinned validator allow-list is a possible M5 hardening, not needed for devnet.

### 3C. Credit-back `refund` (anti-strand) — stress finding #2, HIGH

**Problem:** `reconcile_miner` (permissionless, no round-state check) **debits** escrow (`balance` and `total_escrow_balance`) from the committed `block_stake` and clears `escrow.active_round`. `refund` gives **no credit** and requires `escrow.active_round == round_id`. So a staker reconciled *before* a `cancel_round` — the exact VRF-stuck recovery path, or an honest crank that reconciles then cancels — can neither `refund` (lock already cleared) nor `claim` (CLOSED ≠ CLAIMABLE). Their staked lamports orphan in `pot_vault` (the round never swaps, so they were never moved out) and are swept to treasury on a later swap. Fund loss, not insolvency (`refund`'s "a Closed round is never reconciled" comment is false for any committed round).

**Change — make `refund` reverse the reconcile debit:**
- `Refund` accounts add `config: Account<Config>(mut)` (for `total_escrow_balance`) and `miner: Account<MinerPosition>` (read-only, seeds `[MINER_SEED, authority.key()]`, for the `block_stake` snapshot).
- Handler (round must be `CLOSED`):
  - `joined = escrow.active_round == round_id`; `reconciled = escrow.reconciled_round == round_id`; `require!(joined || reconciled, NothingToRefund)`.
  - If `reconciled`: `require!(miner.round_id == round_id)`; `staked = Σ miner.block_stake`; `escrow.balance += staked`; `config.total_escrow_balance += staked` (both checked); set `escrow.reconciled_round = 0` (consumes it → no double credit).
  - Always: `escrow.active_round = 0`. **Remove** the `escrow.last_claimed_round = round_id` write — the (`active_round`, `reconciled_round`) guards already block replay, and dropping it also fixes the LOW bug where refunding a later round blocked claiming an earlier unclaimed one.
- Solvency stays intact: the credited lamports were never moved out of `pot_vault`, so restoring `total_escrow_balance += staked` re-matches `total_escrow_balance == Σ escrow.balance ≤ pot_vault.lamports()`.
- Optional M5 defense-in-depth: also round-state-gate `reconcile_miner` to refuse a `CLOSED` round; not required once `refund` credits back.

### Verification (M4a)
Rebuild v3 (`cargo build-sbf --arch v3 --tools-version v1.54`). Extend the local gate with regression tests for all three changes — keeper-signed `commit_miner` (no owner signature); permissionless `delegate_round` **rejected** / keeper `delegate_round` OK / stale-or-past round rejected; the reconcile→cancel→refund round-trip restores the staker's withdrawable balance and a second refund no-ops — alongside the existing ER/session/vrf/M1/unit suites and the new `programs/ansem-miner/tests/invariants.rs` math harness (the same 40/40+ gate). Then redeploy the upgrade to devnet (`scripts/deploy-devnet.sh`, loader-v3, resumable), re-run `tests/ansem-miner-devnet.ts`, and regenerate the IDL/types the `sdk` consumes. Adversarially review all three handler changes before merge (M2/M3 rigor).

---

## 4. Repo / workspace structure

pnpm + turbo monorepo; the Anchor program stays at repo root (unchanged layout).

```
/ (existing anchor workspace: programs/, tests/, Anchor.toml, target/…)
  package.json                 # becomes the workspace root (pnpm-workspace.yaml added)
  packages/
    sdk/                       # shared TS: IDL, types, PDAs, ix builders, ER/session helpers
  keeper/                      # long-running Node service: round loop + read-layer (ws/rest)
  app/                         # Next.js App Router frontend
  generated/bulls/…            # the 25 bull PNGs (already tracked); optimized into app/public at build
```

Existing `tests/` keep using their current toolchain; the new packages use pnpm workspaces. The `sdk` is the single source of truth for program constants, PDA seeds, and instruction builders — **lifted from the passing `tests/*.ts` suites** so client and keeper share one, already-verified implementation (no re-derivation drift).

---

## 5. Component design

### 5.1 `packages/sdk`
- The Anchor `Program<AnsemMiner>` factory (IDL + typed methods), for L1 and ER providers.
- PDA/seed helpers: `config`, `round(id)`, `miner(wallet)`, `escrow(wallet)`, pot/treasury/mint/jackpot vaults, ATAs. Note the self-referential seeds (miner/escrow keyed on the **wallet**, not the signer) — callers pass accounts explicitly.
- Instruction builders for every player + keeper action, incl. the batched L1 entry tx and the ER session-signed stake.
- Session-key helpers (gum `SessionTokenManager.createSessionV2`, token PDA derivation, validity check).
- Round/miner/escrow account decoders and a normalized `BoardSnapshot` type shared with the keeper + app.
- No secrets; browser-safe. Unit-tested (PDA vectors, builder shapes).

### 5.2 `keeper` (round loop + read-layer)
Two concerns in one always-on process (holds the operator/admin wallet = `config.admin`):

**Round loop (crank):** the §2 hands-off sequence on a timer, with the M3 devnet hardening reused (validator-clock-lag retries, pre-send 429 retries, regional ER endpoint `devnet-us.magicblock.app` for ER writes, idempotent/self-healing steps). Handles: open+delegate a round; at deadline `request_settle` and await the oracle; `commit_round` + `commit_miner`×all (now keeper-signed); `reconcile_miner`×all; `execute_swap_mock`; loop. Grace/stall policy: if the oracle never fulfills or a round strands, `cancel_round` after a bounded grace window (logged, not silent).

**Participant index:** the program has **no on-chain roster** of a round's stakers. The keeper indexes participants from `join_round`/`stake` transactions + `MinerPosition` PDAs (logs/`getProgramAccounts` filtered by `round_id`) so it knows whom to `commit_miner`/`reconcile`. This index also feeds the read-layer leaderboard.

**Read-layer:** subscribes **once** to `Config` + the current `Round` + participant `MinerPosition`s + jackpot vaults (websocket account subscriptions), maintains an in-memory `BoardSnapshot` (per-square stake totals, pot, deadline, state, jackpot pots, leaderboard, recent events), and serves it to browsers over **WebSocket** (live push) with a REST snapshot for cold loads. Clients never touch devnet RPC. Emits typed events: `round.open`, `stake`, `round.settling`, `round.revealed` (with the per-square outcomes + jackpot squares), `round.claimable`.

### 5.3 `app` (Next.js)
Routes/areas:
- **Play** (`/`): the bull-head board (25 tiles), round HUD (round #, countdown, pool, miners, small/big pot), staking rail (select square, amount, **stake · gasless**, escrow + deposit/withdraw, session status), activity feed. Subscribes to the keeper WS.
- **Wallet/session** context: connect (wallet-adapter), the batched L1 entry tx (join + delegate_miner + session mint), session-key lifecycle (create/reuse/expiry), gasless staking via the session key, claim.
- **Claim** surface: shows claimable rounds for the connected wallet; one-popup `claim`.
- **Admin (optional, wallet-gated to `config.admin`):** health/status of the keeper + manual `seed_small/big_jackpot`, `set_*` params, and a manual crank/cancel for demos. Read-only status even for non-admins.
- Devnet onboarding helper: a "get devnet SOL" affordance (faucet link / docs) since L1 actions need devnet SOL.

---

## 6. The board & skin

- **Layout:** bull-head silhouette from the prototype's `(col,row)` hex lattice, but each cell renders its **square** bull tile `i` (`generated/bulls/NN-name.png`, `i = NN-1`) = on-chain square `i`. Tiles share a near-black background, so on the near-black page the square edges recede and the bull-head shape reads from tile positions + green glow; tune tile gaps + a subtle per-tile vignette for a crisp silhouette.
- **States:** dim (idle) → **lit green** (staked; intensity ∝ square's stake share) → **ascending reveal** on settle (unveil smallest→largest payout for drama) → **gold flash** on the jackpot square(s). Persistent glowing eyes (the two `|col|==1, row==0` cells). The reveal is presentation-only — outcomes are already VRF-fixed on-chain; the client animates `round.revealed` data.
- **Assets:** 25 × 1254px opaque PNG (~41 MB tracked). Build-time pipeline: downscale to ~256px + WebP/AVIF via `next/image` (or a prebuild step into `app/public/bulls/`), lazy-load, so the board is instant. Keep the full-res originals in `generated/` as source.
- **Skin tokens:** green `#35e07a` (staked/positive), gold `#e8c452` (jackpot), near-black `#0b0b0e` surfaces; the M4 palette formalizes the prototype's variables.

---

## 7. Error handling & edge cases

- **No-show at settle:** eliminated by the §3A fix — the keeper commits every miner. Residual: an unfulfilled VRF or an RPC outage → keeper retries within a grace window, then `cancel_round` (round voided, all `refund`-unlockable **and credited back** per §3C) and logs it. One stuck round no longer silently blocks the game forever.
- **Join-without-stake lock:** a wallet that `join_round`s but never stakes holds the withdraw-lock (`active_round≠0`). If the round finalizes it can't `refund` (needs CLOSED) or `claim` (no stake), so its escrow looks frozen. It IS recoverable — `init_miner` (if needed) then the permissionless `reconcile_miner` clears the lock with no debit — so the **keeper's reconcile pass covers every joined wallet**, staked or not, and the app surfaces "unlocking…" rather than "frozen".
- **RPC rate limits (429):** browsers never hit RPC (read via keeper WS). The keeper is the single consumer; reuse M3's pre-send retry + a paid RPC tier if needed. Player write txs go direct to devnet but are infrequent (entry + claim).
- **ER races / clone-lag:** reuse M3 hardening — `awaitJoined` (join→stake propagation), tolerant ER read retries, regional endpoint for writes.
- **Session expiry / missing:** app detects `now ≥ valid_until` or no token → re-runs the one-popup entry (mint a fresh session). Staking falls back to wallet-signed if the user declines a session.
- **WS reconnect:** app resubscribes and re-fetches the REST snapshot; idempotent board render.
- **Stale/leftover round on boot:** keeper self-heals (reuse M3's stranded-round handling, incl. committing/undelegating a delegated stranded round before cancel).
- **Devnet SOL exhaustion:** keeper wallet low-balance alarm; player onboarding faucet link.

---

## 8. Phased delivery (each phase = working, independently verifiable software)

- **M4a — Program fix + SDK + keeper + read-layer (backbone).**
  Do the §3 change bundle (keeper-drivable `commit_miner`, keeper-gated `delegate_round`, credit-back `refund`) and re-verify (40/40+ local incl. the new `invariants.rs` math harness, redeploy to devnet, `tests/ansem-miner-devnet.ts` green). Build `packages/sdk` (from the test suites). Build the `keeper`: full hands-off round loop on devnet + participant index + read-layer (WS/REST). **Verify:** keeper runs continuous rounds end-to-end on devnet with **no UI** (rounds open, gasless stakes via a scripted session, keeper settles + swaps hands-off, a scripted claim succeeds); `curl`/ws shows a live `BoardSnapshot`.
- **M4b — Web read path.**
  Next.js app, wallet connect, live bull-head board (25 optimized tiles) + HUD + countdown + activity feed + leaderboard off the keeper WS. **Verify:** open the browser, watch real devnet rounds open/stake/settle/reveal live (read-only; no staking yet).
- **M4c — Write path (the loop).**
  Deposit/withdraw, `init_miner`, the batched L1 entry (join + delegate_miner + session mint), gasless session staking on tiles, claim. **Verify:** a human connects a fresh wallet, funds it, stakes gaslessly on the board, and claims ANSEM on devnet — the whole loop in-browser.
- **M4d — Reveal polish + deploy.**
  Productionized settle-reveal animation (ascending + jackpot finale on the board), asset pipeline, responsive/mobile, empty/loading/error states, deploy web (Vercel) + keeper (host), ops runbook. **Verify:** the deployed URL plays a full public round; keeper stays up across rounds.

Each phase gets its own implementation plan (`writing-plans`), mirroring the M2/M3 cadence. M4a ships first.

---

## 9. Testing strategy

- **Program (M4a):** the existing Rust unit + the ER/session/VRF/M1 suites re-run green, plus the new `programs/ansem-miner/tests/invariants.rs` math stress harness. New/adjusted regressions: (a) a **keeper-signed** `commit_miner` (no owner signature) undelegates the miner and a full multi-staker round settles hands-off; (b) permissionless `delegate_round` is **rejected** while keeper `delegate_round` succeeds, and a stale/past/non-OPEN round is rejected; (c) the reconcile→`cancel_round`→`refund` round-trip restores the staker's withdrawable balance and a second `refund` no-ops. `tests/ansem-miner-devnet.ts` re-verifies on devnet post-redeploy.
- **SDK:** unit tests for PDA derivations (vectors vs the program) and instruction-builder account shapes.
- **Keeper:** an integration test driving one full multi-participant round headless on devnet; assertions on the read-layer snapshot/events.
- **Web:** Playwright e2e against a keeper pointed at devnet — connect (mock wallet), entry, gasless stake, observe reveal, claim; plus component tests for the board render/reveal.

---

## 10. Success criteria (M4 done)

- Program upgraded on devnet with keeper-drivable `commit_miner`; all suites green; adversarial review of the change clean.
- A public devnet URL where a new user connects a wallet, approves one session key, stakes gaslessly on the bull board, watches a real-VRF settle-reveal, and claims ANSEM — with rounds running continuously and hands-off via the keeper, and **no single player able to stall the game**.
- Browsers never rate-limited (read via keeper); the board updates live for all players.

---

## 11. Open items (sensible defaults; adjustable, non-blocking)

- **Keeper host:** default Railway (simplest always-on Node); Fly.io/Render fine. Decide at M4a deploy.
- **Player devnet SOL onboarding:** faucet link + docs by default; optional relayer-funded tiny onboarding later.
- **"ANSEM" on devnet** = the mock mint minted by `execute_swap_mock`; balances read from that mint. Real Jupiter/ANSEM is M5.
- **Rounds pacing:** start ~60s (config `round_duration_secs`); tune for devnet cost/RPC.

---

## 12. Deferred to M5 (pre-mainnet hardening — surfaced by the M4 grounding, NOT M4 scope)

- **`settle` admin fallback has no on-chain mainnet gate** — admin can supply favorable randomness; hard-gate or remove before mainnet (require VRF).
- **`create_round` is permissionless** — harmless today (the `current_round_finalized` gate serializes to one round slot and a griefer only opens the round the keeper would have), but tighten to keeper-only for mainnet hygiene. (`delegate_round` was the dangerous half — fixed in §3B.)
- **A round stranded *delegated* in the ER can't be `cancel_round`'d** (cancel needs an L1/program-owned Round) — add an ER-side recovery path + keeper redundancy assumptions for mainnet.
- **No on-chain claim-before-restake enforcement** (`UnclaimedRound` is defined but unused) — a player who re-enters before claiming forfeits the prior round's payout (it sits in the payout vault). Frontend auto-claims to mask it; on-chain enforcement is M5.
- **Jackpot pool is a % of the live admin-seeded vault**, snapshotted per hit — across many hits with delayed claims the cumulative snapshots can exceed the vault until re-seeded; per-round funded pools are M5.
- Real swap adapter (Jupiter batch), jackpot vault funding, Private ER opt-in, legal/geo — all M5.
