# ANSEM Miner — Design Spec

**Date:** 2026-07-06
**Status:** Approved for planning
**Network strategy:** Devnet first, mainnet-ready (config-flip cutover)

## 1. Overview

ANSEM Miner is an ORE-v2-style grid game on Solana. Players stake SOL on a 5×5 grid during short rounds; at settlement the round's entire SOL pool is converted into **$ANSEM** and dealt back to players at a randomized rate between **−20% and +20%** of par, decided per square by verifiable randomness. Rare **jackpot squares** (two tiers — a frequent small one at 1/100 and a rare big one at 1/625) pay extra ANSEM from externally funded jackpot vaults. Players "mine" ANSEM by staking into rounds — the game never mints its own token supply for payouts (it swaps real SOL for real ANSEM), so it is *mining*, not *minting*. The grid hot path runs in a **MagicBlock Ephemeral Rollup (ER)** for gasless, popup-free, ~50ms staking; all value (SOL custody, ANSEM payouts) settles on Solana L1.

The game is a **gamified swap**: it never mints real ANSEM, holds no price risk, and needs no bankroll. Each round distributes exactly the ANSEM the round's swap produced (solvency by construction). Only the jackpot is externally funded (by us, or ideally an airdrop from Ansem to the jackpot wallet).

**Unofficial fan project.** Not affiliated with or endorsed by Ansem. Devnet build uses a mock ANSEM token; the real $ANSEM (mainnet) is only touched in the mainnet phase.

### Goals
- Faithful ORE-v2 game feel (grid, deploy rail, rounds, leaderboard) with Black Bull branding.
- Real on-chain program (Anchor) + MagicBlock ER baked in from day one.
- Every payout backed 1:1 by swap proceeds; no protocol insolvency path.
- Devnet-complete and demoable without any mainnet dependency.

### Non-goals (v1)
- Mainnet deployment (separate phase: audit, legal review, real Jupiter integration, Ansem airdrop conversation).
- A general AMM/orderbook; swap is a narrow adapter.
- Mobile-native app; responsive web only.

## 2. Game design

### Core loop
1. **Deposit** (L1, one wallet popup): player funds their `PlayerEscrow` with SOL — a session budget covering many rounds.
2. **Stake** (ER, gasless, no popup): during a round (default **60s**), player clicks squares to place SOL amounts (+0.01 / +0.1 / +1 / MAX, multi-tile) against their escrow budget.
3. **Settle** (ER → L1): after the deadline, VRF draws randomness → per-square multipliers in **[0.8×, 1.2×]** plus two independent jackpot rolls (small **1/100**, big **1/625**) → round state commits back to L1.
4. **Swap** (L1): the round's SOL pool minus protocol fee (default **100 bps**) is converted to ANSEM — mock mint at a fixed rate on devnet, batched Jupiter swap by a keeper on mainnet.
5. **Claim** (L1): each player claims ANSEM = their stake-weighted, multiplier-adjusted share of the round's actual swap proceeds (+ jackpot share if their square hit).

### Payout math (defines solvency)
For round with per-square player stakes `stake(p, s)` and VRF-derived square multipliers `m(s) ∈ [0.8, 1.2]` (basis points 8000–12000, derived below):

```
weight(p)      = Σ_s stake(p, s) × m(s)
total_weight   = Σ_p weight(p)
payout(p)      = swap_proceeds × weight(p) / total_weight
```

- Payouts sum to exactly `swap_proceeds` — the vault can never over- or under-pay.
- Effective multiplier = `m(s) / stake-weighted-mean(m)`, so the advertised ±20% band flexes slightly at the edges. Documented, accepted.
- All math in `u128` intermediates; remainder dust (< 25 lamport-units of ANSEM) accrues to the treasury.

### Jackpot (two tiers)
Two **independent** jackpots roll every round, each with its own vault, odds, square, and payout %:
- **Small jackpot** — hit probability **1/100** (`small_jackpot_odds`), pays `small_jackpot_bps` (default **10%**) of the **small** jackpot vault. Frequent, modest.
- **Big jackpot** — hit probability **1/625** (`big_jackpot_odds`), pays `big_jackpot_bps` (default **10%**) of the **big** jackpot vault. Rare, chunky (the vault people chase; funded/seeded larger).

Each tier is rolled independently from the round's randomness (distinct keccak domains), so a round can hit neither, either, or both, on the same or different squares. On a hit, the tier's winning-square stakers split its payout pro-rata by their stake on that square, paid at claim from that tier's vault ATA.

**Snapshot-and-conserve (solvency of the jackpot pool):** the payout pool for each tier is computed **once**, at the moment the round becomes claimable (`execute_swap_mock`), as `vault.amount × tier_bps / 10_000`, and frozen into the `Round` (`small_jackpot_pool` / `big_jackpot_pool`). Every claimant divides against that *fixed* snapshot — never the live vault balance — so payout is a pure function of stake share and independent of claim order. (This mirrors how `swap_proceeds` is snapshotted for the main payout. Reading the live balance per-claim was the M1-audit "order-dependent underpayment" bug.) Top-ups (`seed_*_jackpot`) that land after a round's swap accrue to *future* rounds' snapshots, not the already-frozen one.

- Both jackpot vaults are created at `initialize` (program-PDA-owned ATAs) so they always exist; anyone can top them up (us, or an Ansem airdrop). If a tier's vault is empty, its hits pay zero and the round is otherwise normal.
- If a tier's winning square has zero stake, nothing is paid; the vault carries over.

### Round-lifecycle safety (M1 hardening)
`create_round` is **gated on the previous round being finalized** (`Config.current_round_finalized`, set true when a round reaches Claimable via swap or Closed via cancel). This forbids opening round N+1 while round N is still Open/Settled, so a mis-ordered or abandoned settle cannot silently strand a growing set of stakers. Because that gate would otherwise let a single un-settleable round *halt the game*, there is a paired **escape hatch**:
- **`cancel_round`** (admin, past-deadline only, Open/Settled → Closed): marks an abandoned round dead and re-arms `current_round_finalized` so the game can resume. Bounded by the existing M1 admin-trust model (admin already supplies settle randomness); moves no funds.
- **`refund`** (permissionless, per-player, Closed rounds only): pure accounting — returns the player's own staked lamports from their round position back into their `PlayerEscrow.balance` (and `total_escrow_balance`), clears `active_round`, and marks the round refunded (`last_claimed_round`) against double-refund. Moves nothing to any external sink — it only unlocks the player's own funds. No lamport/token transfer occurs (the SOL is already sitting in the commingled `PotVault`; only the accounting is reversed).

### Tunable parameters (in `Config`, admin-settable)
| Param | Default | Notes |
|---|---|---|
| `round_duration_secs` | 60 | gated on `Clock::get().unix_timestamp`, never ER slots |
| `fee_bps` | 100 | skimmed from pot before swap, to treasury |
| `multiplier_min/max_bps` | 8000 / 12000 | the ±20% band |
| `small_jackpot_odds` | 100 | small tier: 1-in-N per round |
| `small_jackpot_bps` | 1000 | % of small jackpot vault paid per hit |
| `big_jackpot_odds` | 625 | big tier: 1-in-N per round |
| `big_jackpot_bps` | 1000 | % of big jackpot vault paid per hit |
| `min_stake_lamports` | 10_000_000 (0.01 SOL) | dust guard |
| `max_stake_per_round` | 100 SOL | per player; anti-whale + escrow sanity |
| `mock_rate` (devnet) | 2_800 ANSEM/SOL | fixed devnet swap rate |

## 3. Architecture

### ER vs L1 split (hard boundary)
A single transaction can never mix delegated (ER) and undelegated (L1) writable accounts — this shapes everything.

**Runs in the ER (delegated, gasless, session-key signed):**
- `Round` PDA — per-square stake totals, pot, deadline, VRF/settlement state.
- `MinerPosition` PDA (persistent, per player) — per-square stakes for the current round.
- `stake()` hot path; `request_settle` + `settle_callback` (VRF).
- Live grid reads: frontend subscribes to the delegated `Round` on the ER websocket.

**Stays on L1 (never delegated):**
- `Config` singleton, `PlayerEscrow` per player (SOL custody), `PotVault` PDA (round SOL), treasury, ANSEM payout vault ATA, jackpot vault ATA, the ANSEM mint (devnet mock) / real ANSEM mint address (mainnet).
- `initialize`, `create_round`/`delegate_round`, `init_miner`/`delegate_miner`, `deposit`, `withdraw`, `execute_swap_mock`/`record_swap`, `claim`, admin ops.

### Privacy (Private ER / sealed-bid rounds) — deferred, revisit pre-mainnet
M2 targets **transparent** ER (default MagicBlock behaviour — accounts are public unless explicitly restricted). MagicBlock's Private Ephemeral Rollups (Intel TDX TEEs; per-account opt-in via `set_privacy` on an `EphemeralPermission` account through the Permission Program) could hide live per-square stakes until the round deadline — a sealed-bid shape that reveals on commit, keeping provable fairness intact. **Decision (2026-07-06): not for M2.** Rationale: (1) the strategic value is soft for our mechanic — multipliers and the jackpot block are VRF-random, so seeing others' stakes gives no hard EV edge; the benefit is *experiential* (suspense, not demoralising minnows with visible whale positions), not a fairness bug we must fix; (2) TEE privacy can't be exercised in our local genesis-preload test workflow (needs real enclave hardware; the installed 0.12.0-era tooling won't simulate it) — we'd lose the local-green safety net; (3) it stacks TEE attestation + the Permission Program + a node-level OFAC/geofencing ingress layer (double-edged for a memecoin homage; possibly mandatory — unverified) on an already-large, still-unproven M2. It's a *clean additive toggle*, so we defer it cheaply: keep the ER `stake` path from emitting per-square stakes via public logs (forward-compat), and revisit as a deliberate "sealed-bid rounds" feature alongside M4 (frontend, where the suspense pays off) or the M5 mainnet gate (where the compliance question must be answered anyway). Open questions to resolve then: is the OFAC/geofencing layer separable from privacy, and can local tooling simulate private mode?

### M2a escrow model (as-built) — supersedes the escrow/miner notes in §4

M2a implements the ER split with a **reconcile-at-commit + up-front-lock** escrow model (chosen over up-front-debit). This supersedes the earlier "debit at `claim`" and "commit-only miner (read via UncheckedAccount)" descriptions in §4:

- **No escrow debit on the ER.** ER `stake` only writes the delegated `Round`/`MinerPosition`; escrow is a read-only clone it soft-checks (`Σ block_stake ≤ balance`). L1 `join_round` sets `PlayerEscrow.active_round` (the withdraw-lock) with **no** balance change.
- **Debit at reconcile.** A new permissionless L1 `reconcile_miner(round_id)` runs after the round commits back to L1; it debits `PlayerEscrow.balance` and `Config.total_escrow_balance` by the committed `Σ block_stake`, guarded by `PlayerEscrow.reconciled_round` (idempotent, no double-debit). It is the **single lock-release point** (clears `active_round` for stakers *and* join-without-stake players), which fixes the join-without-stake dead-lock.
- **Solvency is auto-gated by ordering.** Before reconcile, `total_escrow_balance` still counts the staked lamports as idle while `Round.pot` also claims them, so `execute_swap_mock`'s existing `pot_vault ≥ total_escrow_balance + pot` check **refuses the swap until every staker is reconciled**. An un-reconciled staker makes the check stricter, never unsafe; withdrawing the idle remainder after unlock drops `pot_vault` and `total_escrow_balance` equally, so `Round.pot`'s backing is untouched.
- **Miner is commit-AND-undelegated** (not commit-only) at round end, so it returns to the program on L1 and `reconcile_miner`/`claim` read it as a normal `Account<MinerPosition>` (a committed-only account stays DLP-owned, which anchor's owner check rejects — and a program cannot write an account it does not own, so per-round flags like reconcile state live on `PlayerEscrow`, not the miner). The persistent miner is re-delegated at the start of each round.
- **`refund` only unlocks now.** Under reconcile-at-commit, `stake` never debited and a cancelled round is never reconciled, so `refund` credits nothing — it only clears `active_round`. Abandoned *delegated* round recovery: admin force-commits on the ER (undelegate → L1) → L1 `cancel_round` → joiner `refund`s.
- `PlayerEscrow` gains `reconciled_round: u64`; `MinerPosition` has no `reconciled` field. Verified end-to-end on the two-provider local stack (`tests/ansem-miner-er.ts`, 8/8).

**Authorization (M2a security pass):** `commit_miner` requires the miner's owner to sign (read-only `authority` signer; the miner PDA is derived from it, so an attacker can't force-commit a victim's miner). `commit_round` is admin-only (an attacker can't force-commit a live round mid-staking). ER `stake` requires `escrow.active_round == round.round_id` (enforces join-before-stake and blocks re-staking a round after `reconcile_miner` cleared the lock — which would otherwise dodge the escrow debit via the `reconciled_round` guard).

**Known M2a limitation (admin-trust edge, follow-up):** because the debit now happens at `reconcile_miner` and `refund` no longer credits, a player who was *reconciled* for a round that is then *cancelled* cannot `refund` their debited stake (reconcile cleared `active_round`, and `refund` only unlocks). This is only reachable if the admin cancels a SETTLED+reconciled round instead of completing the (permissionless, always-solvent-once-all-reconciled) swap — an admin anomaly, which M2a's admin-trust model excludes. A full fix (make `refund` credit reconciled players, or forbid cancelling a reconciled round) is deferred.

Session keys are **M2c**, not M2a. VRF (`request_settle`/`settle_callback`) shipped in **M2b** (below); M2a kept M1's admin-injected `settle`.

### M2b VRF settle (as-built) — supersedes the "ER" placement in §3/§4 for settle

Real MagicBlock ephemeral VRF replaces admin-injected randomness. `request_settle` (admin-gated; `Open` + past-deadline → `VrfPending`) fires `create_request_randomness_ix`; `settle_callback` (authorized *only* by the injected `VRF_PROGRAM_IDENTITY` signer; one-shot `require!(state == VrfPending)`) writes the drawn randomness, rolls both jackpot tiers with the M1 math, and sets `Settled`. M1 admin `settle` is retained as a devnet/test fallback (mainnet gates it out).

**Settle runs on L1 (post-commit), NOT in the ER — a deliberate change from §4's ER placement.** An in-ER VRF request must write the oracle queue, but the local `ephemeral-validator` does not delegate that queue to itself, so the ER's Magic finalizer rejects the write (`InvalidWritableAccount`) regardless of lifecycle (`ephemeral`/`replica`) or oracle state — the foundation's unresolved risk §7.4, now confirmed. Since settle is a rare per-round event that needs no ER speed, the flow is `stake (ER) → commit (undelegate) → request_settle (L1) → base oracle → settle_callback (L1) → reconcile → swap → claim`. On L1 the queue is an ordinary writable account and the base oracle fulfills the request (the standard VRF path). The program code is unchanged — only the invocation moved from ER to L1. **Liveness:** `cancel_round` now also accepts a past-deadline `VrfPending` round, so a request the oracle never fulfills can't strand the game/escrow. **Pin:** `ephemeral-vrf-sdk =0.3.0` (matches `vrf-oracle 0.3.0`; yanked, so the lock entry is seeded from the reference example). **Follow-up:** in-ER settle is possible on managed MagicBlock infra (devnet/mainnet) where the ER's VRF queue is delegated to the validator — not needed for the mechanic.

### Swap adapter (the devnet/mainnet seam)
One program-level interface, two modes set in `Config.swap_mode`:
- **Devnet `Mock`:** `execute_swap_mock` (permissionless crank) mints `pot_after_fee × mock_rate` of mock ANSEM straight into the payout vault and records `swap_proceeds` on the round. Mock mint authority is a program PDA. Fully automated, no keeper.
- **Mainnet `Jupiter`:** a keeper bot withdraws the round's `pot_after_fee` from `PotVault` via `begin_swap` (locks the round in `Swapping` state, records vault ANSEM balance), executes one batched Jupiter swap (API-built tx) into the payout vault ATA, then calls `record_swap`, which sets `swap_proceeds = vault_balance_now − vault_balance_before` — **measured, not keeper-reported**. Trust boundary: the keeper can delay or execute badly (slippage), but can never fake proceeds or redirect payouts; players are only ever paid from what actually landed. A `swap_timeout` escape hatch lets anyone refund the round's SOL pro-rata if the keeper stalls > N minutes.

### Round lifecycle
```
L1: create_round → delegate_round (to Config.er_validator)
      ↓ (frontend waits for ER clone)
ER: stake × N (session-signed, gasless)          ← players, ~50ms
ER: request_settle (permissionless, after deadline; unix-time gate)
ER: settle_callback(randomness)                   ← VRF oracle only
ER: commit_and_undelegate (Round)                 → await GetCommitmentSignature
L1: execute_swap_mock | begin_swap→record_swap    → swap_proceeds fixed
L1: claim(round_id) per player                    → ANSEM transfer (+ jackpot)
L1: (next round) create_round; MinerPosition reset in place on next stake
```
A permissionless `force_undelegate` crank mirrors the settle crank so a crashed client can never leave state locked in the ER.

## 4. On-chain program (Anchor)

Program: `ansem_miner`. Anchor 1.0.x line, pinned to the versions in `magicblock-engine-examples` (see §10).

### Accounts
- **`Config`** (singleton, L1): admin, `swap_mode`, `er_validator: Pubkey` (pinned ER validator identity; devnet `MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57`), ANSEM mint address, payout/small-jackpot/big-jackpot/treasury vault addresses & bumps, `current_round_id`, `current_round_finalized: bool` (round-lifecycle gate, see §2), `total_escrow_balance`, all §2 params. Never delegated; never written in the same tx as a delegated account.
- **`Round`** (delegatable; seeds `[b"round", round_id.to_le_bytes()]`): `round_id`, `deadline_ts: i64`, `block_sol: [u64; 25]`, `pot`, `state` (Open → VrfPending → Settled → Swapping → Claimable → Closed), `randomness: [u8; 32]`, per-tier jackpot fields `small_jackpot_hit/block/pool` + `big_jackpot_hit/block/pool` (`*_pool` are the u64 snapshots frozen at swap time), `swap_proceeds: u64`. `total_weight = Σ_s block_sol[s] × m(s)` is derivable from the Round alone — recomputed in `claim`, no cross-player scan needed. Created on L1 **before** delegation (cannot init inside the ER). Typed `UncheckedAccount` in the `#[delegate]` accounts struct with `#[account(mut, del)]`; call `round.exit(&crate::ID)?` before commit bundles.
- **`MinerPosition`** (delegatable; **persistent per player**, seeds `[b"miner", authority]`): `authority: Pubkey`, `round_id: u64`, `block_stake: [u64; 25]`. No `claimed` flag here — L1 `claim` cannot write a delegated account; claim state lives in `PlayerEscrow.last_claimed_round` (L1). Stays delegated across rounds; **committed** (not undelegated) at settle, so L1 `claim` reads the committed snapshot (delegation-owned account: deserialize via `UncheckedAccount` + PDA re-derivation, since `Account<T>`'s owner check would reject it). Reset in place at the player's first stake of a new round (zero stakes, bump `round_id`); **reset is gated in ER `stake()` on the escrow clone showing the prior round claimed** — so unclaimed winnings can never be overwritten.
- **`PlayerEscrow`** (L1, never delegated; seeds `[b"escrow", authority]`): accounting only — `balance`, `deposited_total`, `withdrawn_total`, `last_claimed_round`. Physical lamports live in `PotVault`; escrow tracks each player's share. The player's session budget: ER `stake()` reads it as a **readonly cloned account** to enforce `Σ block_stake ≤ balance`. **Withdraw guard:** withdrawals are rejected while the player has stakes in any round newer than `last_claimed_round` (prevents a stale ER clone from authorizing an overdraft; deposits-only staleness is safe — a late-appearing deposit merely delays staking).
- **`PotVault`** (L1 PDA): the single physical SOL vault. `deposit` moves lamports here (crediting `PlayerEscrow.balance`); `claim` debits the player's committed stake total from their escrow accounting; `begin_swap`/`execute_swap_mock` withdraws exactly the round's committed pot minus fee; `withdraw` pays out per escrow accounting. Invariant: `PotVault` lamports ≥ Σ escrow balances − Σ committed-but-unswapped stakes at all times.
- **Vault ATAs** (L1): payout vault (holds swap proceeds until claimed), jackpot vault (externally topped up), treasury (fees + dust).

### Instructions
| Ix | Layer | Signer | Notes |
|---|---|---|---|
| `initialize` | L1 | admin | Config, vaults, (devnet) mock mint + metadata |
| `create_round` / `delegate_round` | L1 | permissionless crank | gated on `Config.current_round_finalized`; init then delegate to `Config.er_validator` |
| `cancel_round` | L1 | admin | past-deadline Open/Settled → Closed; re-arms `current_round_finalized` (abandoned-round escape hatch) |
| `refund(round_id)` | L1 | **real wallet** | Closed rounds only; returns player's own stake to escrow accounting; no external transfer |
| `init_miner` / `delegate_miner` | L1 | player (first time only) | persistent MinerPosition |
| `deposit(amount)` | L1 | **real wallet** | fund PlayerEscrow (the one popup) |
| `withdraw(amount)` | L1 | **real wallet** | subject to withdraw guard |
| `stake(block: u8, amount: u64)` | **ER** | session key **or** wallet | the only session-gated ix; validates `block < 25`, min/max stake, escrow budget vs readonly clone, round Open + before deadline |
| `request_settle` | ER | permissionless crank | after `deadline_ts`; fires VRF request, sets VrfPending |
| `settle_callback(randomness)` | ER | **VRF identity only** | stores randomness, rolls both jackpot tiers (small 1/100, big 1/625) + their squares, sets Settled |
| `seed_small_jackpot` / `seed_big_jackpot(amount)` | L1 | admin | top up a tier's jackpot vault (mock-mint on devnet; real ANSEM transfer on mainnet) |
| `commit_round` | ER | permissionless crank | `MagicIntentBundleBuilder ….commit_and_undelegate()` on Round (+ commit MinerPositions) |
| `execute_swap_mock` | L1 | permissionless crank | devnet only: mint mock ANSEM to payout vault, set `swap_proceeds`, Claimable |
| `begin_swap` / `record_swap` | L1 | keeper (mainnet) | balance-delta-measured proceeds; `swap_timeout_refund` escape hatch |
| `claim(round_id)` | L1 | **real wallet** | computes `payout(p)` from committed Round + MinerPosition; transfers ANSEM from payout vault (+ jackpot share); marks claimed; reconciles escrow lamports |
| `force_undelegate` | ER/L1 | permissionless crank | crash recovery |
| `set_params` / `set_swap_mode` | L1 | admin | tunables; mainnet cutover flips mint address + swap mode |

### Security invariants (enforced in code + tests)
1. **Solvency:** `Σ payouts(round) ≤ swap_proceeds(round)`; proceeds measured from vault balance delta, never trusted input.
2. **Session containment:** only `stake()` carries `#[session_auth_or(…)]`. `deposit/withdraw/claim` require the real wallet. Session tokens: **`SessionTokenV2` only** (V1 expiry check is inverted), `#[session(signer = …)]` typed `Signer<'info>` (never `UncheckedAccount`), `top_up = false`, expiry minutes-scale. A leaked session key can only place stakes within the victim's existing escrow budget — it can never move SOL or ANSEM out.
3. **Mixed-tx boundary:** no instruction's account set mixes delegated + undelegated writables; verified by a negative test.
4. **VRF integrity:** `settle_callback` callable only by the VRF program identity; `caller_seed` mixes `round_id` (no replay); randomness stored once (`state == VrfPending` guard).
5. **Time base:** round deadline compares `unix_timestamp` only (ER slots are ~50ms and unreliable).
6. **Escrow safety:** withdraw guard (above); stake checks budget against escrow clone; claim reconciles exact committed totals.
7. **Liveness:** every off-happy-path state has a permissionless exit (`force_undelegate`, `swap_timeout_refund`, round-skip crank if VRF never calls back — refund path reuses `swap_timeout_refund` semantics pre-swap).
8. **No admin rug surface beyond params:** admin can tune params and flip swap mode but cannot touch vaults directly; treasury only receives declared fees/dust.

## 5. Randomness

**MagicBlock Ephemeral VRF** (`ephemeral-vrf-sdk ≈ 0.3.0`, `#[vrf]` / `#[vrf_callback]`), requested inside the ER against `DEFAULT_EPHEMERAL_QUEUE` (tests: `DEFAULT_EPHEMERAL_TEST_QUEUE`). **Never** SlotHashes/blockhash: inside the ER those are single-party values from the same validator sequencing the stakes — worthless for value decisions (and `SlotHashes::get()` is unsupported on-chain anyway).

From one `randomness: [u8; 32]`:
- `m(s) = 8000 + (u16::from_le(keccak(randomness ‖ s)[0..2]) % 4001)` for each square `s` — deterministic, recomputable by anyone from committed state.
- `small_jackpot_hit = keccak(randomness ‖ "jackpot_sm")[0..4] as u32 % small_jackpot_odds == 0`; `small_jackpot_block = keccak(randomness ‖ "jkblock_sm")[0] % 25`.
- `big_jackpot_hit = keccak(randomness ‖ "jackpot_big")[0..4] as u32 % big_jackpot_odds == 0`; `big_jackpot_block = keccak(randomness ‖ "jkblock_big")[0] % 25`.
- The two tiers use **distinct keccak domains**, so their hits and squares are independent.

Settlement is therefore **async** (request → oracle callback), which is why `settle_round` is split into `request_settle` + `settle_callback`.

## 6. Frontend

Next.js (App Router) + `@solana/wallet-adapter` (Phantom, Solflare). **Layout: ORE v2 clone** — grid left (25 tiles, per-tile SOL, dimmed empty tiles), right rail (DEPLOYED / JACKPOT / TIME header, last-round strip, Manual|Auto toggle, amount chips +0.01/+0.1/+1/MAX, TILES all/−/+ selector, Deploy button, MINERS leaderboard with per-round deployed amounts). **Skin: Black Bull** — gold-on-black (`#e8c452` on `#0c0c0f` family), monospace numerals, 🐂 mark. "Motherlode" → **JACKPOT** (shows jackpot vault balance & odds).

Key client behaviors:
- **Two connections** (not the Magic Router — the live grid needs a pinned ER websocket): base devnet RPC for L1 ixs; ER region endpoint (e.g. `https://devnet.magicblock.app` region matching `Config.er_validator`) with its own `wsEndpoint` for ER ixs + subscriptions. Two `Program` instances; **blockhashes always from the matching connection**.
- **Live grid:** `erConnection.onAccountChange(roundPda, cb, 'processed')` (ER doesn't reliably emit `confirmed`); decode via `program.coder.accounts.decode('round', …)`; after delegation, nudge the ER (a read) until the clone appears before enabling staking.
- **Session flow:** on first Deploy, one approval creates the session (`createSession(programId, topUp=false, ~15 min)`); thereafter clicking tiles fires popup-free ER stakes. Deposit/withdraw/claim use the real wallet (expected popups). Session-key TS package pinned after npm verification (namespace drift: `@magicblock-labs/gum-react-sdk` vs `@gumhq/react-sdk`).
- **Round chrome:** countdown from `deadline_ts`; settle/claim cranks surfaced as buttons anyone can press (with tiny lamport reward noted in UI); auto-mode re-stakes the same layout each round within escrow budget (client-side loop, still session-signed).
- **Devnet helpers:** airdrop faucet button, "mock rate" banner, explorer links.

## 7. Testing

**Local stack:** `mb-test-validator` (base, :8899) + `ephemeral-validator --remotes http://localhost:8899 -l 7799 --lifecycle ephemeral` (local ER identity `mAGicPQYBMvcYveUZA5F5UNNwyHvfYh5xkLS2Fr1mev`) + local `vrf-oracle` process. Anchor tests run with `EPHEMERAL_PROVIDER_ENDPOINT`/`EPHEMERAL_WS_ENDPOINT` env and two providers, per the `binary-prediction` example (closest structural analog).

**Must-pass suites:**
1. **Payout math (Rust unit):** multiplier derivation range, normalization sums exactly to proceeds across randomized fuzz cases (u128 paths, dust), jackpot split, fee.
2. **Lifecycle (integration):** full happy path deposit → stake×N (session) → settle → commit → swap-mock → claim for 1 and 24 players; escrow reconciliation exact.
3. **Session security:** session-signed `stake` passes; session-signed `claim`/`withdraw`/`deposit` **fail**; expired V2 token fails; token minted for another program fails; wallet-signed stake (no session) passes.
4. **Boundary/negative:** mixed delegated+undelegated writable tx fails; stake after deadline fails; double-claim fails; `settle_callback` from non-VRF identity fails; withdraw during active round fails; stake over escrow budget fails.
5. **Liveness:** `force_undelegate` recovers a stuck round; VRF-never-called-back refund path; swap-timeout refund (mainnet mode, simulated keeper stall).
6. **Statistical smoke:** over ~2k simulated rounds, multipliers uniform-ish in band; jackpot rate ≈ 1/625.

## 8. Repo structure

```
ansem-ore/
├── programs/ansem-miner/          # Anchor program (Rust)
├── app/                           # Next.js frontend
├── keeper/                        # mainnet-phase Jupiter keeper (stub in v1)
├── tests/                         # anchor TS integration tests
├── scripts/                       # init, create-mock-mint, seed-jackpot, cranks, faucet
└── docs/superpowers/specs/        # this spec
```

## 9. Milestones

1. **M1 — Program core (local):** accounts + instructions on plain localnet, mock swap, full payout math, unit tests green. (ER macros present but exercised in M2.)
2. **M2 — ER integration (local ER + VRF):** delegation lifecycle, session keys, async VRF settle, cranks, integration suites 2–5 green.
3. **M3 — Devnet deploy:** program + mock ANSEM mint w/ Metaplex metadata ("ANSEM 🐂 (devnet)"), pinned devnet ER validator, cranks scripted.
4. **M4 — Frontend:** ORE-v2-layout UI, Black Bull skin, session flow, live grid, leaderboard, faucet; e2e demo on devnet.
5. **M5 — Mainnet readiness (separate approval gate):** Jupiter keeper, real ANSEM mint config, audit, legal review, jackpot-wallet seeding / Ansem airdrop outreach. **Not started without explicit go.**

## 10. Version pins (verify at plan time against `magicblock-engine-examples` HEAD)

- Rust: `ephemeral-rollups-sdk` — one version supporting both delegate/commit macros **and** the VRF path (0.15.x + `vrf` feature expected; features are mutually exclusive — pick one era, modern `MagicIntentBundleBuilder` API, not deprecated `commit_accounts`); `ephemeral-vrf-sdk = 0.3.x`; `session-keys = 3.1.1` (`no-entrypoint`); `anchor-lang`/`anchor-spl` 1.0.x matching examples.
- TS: `@magicblock-labs/ephemeral-rollups-sdk`, `@solana/web3.js ^1.98`, wallet-adapter trio, session-key React SDK (pin after npm check).
- Tooling: `@magicblock-labs/ephemeral-validator` (dev).

## 11. Risks & accepted trade-offs

- **ER SDK version drift** is real (API renames across 0.14→0.15); mitigated by pinning to a specific examples commit and copying its patterns.
- **Deposit popup:** staking is popup-free only after the one escrow deposit; honest UX copy.
- **Keeper trust (mainnet only):** bounded to execution quality/liveness, never solvency; timeout refund caps the damage.
- **±20% band flex** from normalization; disclosed in UI ("target band").
- **Devnet mock ≠ real slippage;** mainnet phase must re-test economics with real Jupiter quotes.
- **Legal/brand:** real-money game of chance + a living person's brand — mainnet gated on M5 review; devnet build carries the unofficial disclaimer.
- **Jackpot depends on external funding;** game degrades gracefully (zero-pay jackpot) if unfunded.
