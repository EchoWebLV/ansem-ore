# ANSEM Miner — Payout Economics Redesign (lottery model)

**Date:** 2026-07-07
**Status:** Design (pending user review)
**Supersedes:** the −20/+20 gamified-swap payout model and the two-tier pre-seeded reserve jackpots described in the M1 design and the M4 frontend spec's economics section. All other subsystems (SOL escrow, delegation/ER flow, VRF settle mechanism, session keys, recovery, the round state machine) are unchanged.

---

## 1. Motivation & product shift

The original payout was a **low-variance gamified swap**: stake SOL → receive ANSEM at a VRF per-square multiplier in `[0.8, 1.2]` (−20%/+20%), plus two rare pre-seeded reserve jackpots (small/big) paid from separate ANSEM vaults on a probabilistic hit.

This redesign makes it a **high-variance lottery**:

- Every **non-jackpot** square returns a VRF-random **0–50%** of its stake (you lose 50–100%).
- One VRF-picked **jackpot square** per round; its stakers split the entire **retained** value.
- The jackpot is **funded from the losers' forfeited value** (self-contained, provably solvent) and **rolls over** across rounds when nobody staked the jackpot square.
- The two pre-seeded reserve jackpots are **removed**.

Same total ANSEM issued per round; radically different distribution. This is a deliberate product change from a swap to a casino/lottery.

---

## 2. What is UNCHANGED (guardrails)

- **SOL side:** deposit → escrow → join → stake (ER) → reconcile-at-commit → at swap the round's SOL pot moves to `treasury`. The SOL solvency invariant `pot_vault.lamports ≥ total_escrow_balance + round.pot` is untouched. `reconcile_miner` / refund / escrow accounting unchanged.
- **The swap itself:** `Q = net × mock_rate` ANSEM is minted to `payout_vault`, where `net = pot − fee`, `fee = pot × fee_bps / 10_000`. **`fee_bps` remains the house edge.** Only the *distribution of Q among stakers* changes.
- **Lifecycle / state machine / delegation / ER / VRF settle mechanism** (only the stored settle *outputs* change) / **session keys** / **recovery** (cancel_round, refund).
- **Claim-order independence:** every payout derives only from frozen round state (`block_sol`, `randomness`, `swap_proceeds`, `pot`, `jackpot_square`, `jackpot_pool`) plus the player's `block_stake`.

---

## 3. The payout model

Per round, VRF randomness `R` (32 bytes, set at settle / vrf settle_callback — unchanged mechanism) determines:

- **Jackpot square** `J = jackpot_block(R)` ∈ `[0, GRID_SIZE)` (one square per round).
- **Return fraction** for each non-jackpot square `j`:
  `f_j = multiplier_bps(R, j, RETURN_MIN_BPS, RETURN_MAX_BPS)` ∈ `[0, 5000]` bps (0–50%), uniform, **per-square** (all stakers on `j` share the same `f_j`, exactly like today's multiplier).

Let `Q = round.swap_proceeds`, `pot = round.pot`, `block_sol[]` the per-square SOL totals.

**Non-jackpot payout** for a player with `block_stake[]`:
```
NJ_player = Q × ( Σ_{j≠J} block_stake[j] × f_j ) / ( pot × 10_000 )
```

**Jackpot pool** (frozen at swap into `round.jackpot_pool`), where
`NJ_total = Q × ( Σ_{j≠J} block_sol[j] × f_j ) / ( pot × 10_000 )`:
- If `block_sol[J] > 0` (someone staked the jackpot square):
  `jackpot_pool = (Q − NJ_total) + rollover_in`, then `Config.rollover_jackpot = 0`.
- If `block_sol[J] == 0` (nobody staked it):
  `jackpot_pool = 0`, and `Config.rollover_jackpot += (Q − NJ_total)` (carried to the next round — see §4).

**Jackpot payout** for a player (only if `block_stake[J] > 0`):
```
JP_player = jackpot_pool × block_stake[J] / block_sol[J]
```

**Total player payout** `= NJ_player + JP_player`, paid entirely from `payout_vault` (single vault; no reserve jackpot vaults). A jackpot-square staker receives **only** the jackpot (not also a 0–50% return) — the pool already contains their own stake value plus the losers' forfeits.

### Worked example
pot = 10 SOL, `mock_rate` = 1 SOL → 1000 ANSEM, `fee_bps` = 0 ⇒ Q = 10,000 ANSEM; VRF picks square #12:

| Player | Square | Stake | Outcome | ANSEM out |
|--------|--------|-------|---------|-----------|
| Alice | #12 (JACKPOT) | 1 SOL | splits pool | **7,600** |
| Bob | #3 | 4 SOL | returns 30% | 1,200 |
| Carol | #7 | 3 SOL | returns 10% | 300 |
| Dave | #20 | 2 SOL | returns 45% | 900 |
| | | **10 SOL** | | **10,000 = Q** |

`NJ_total = 1,200 + 300 + 900 = 2,400`; `jackpot_pool = 10,000 − 2,400 = 7,600` → Alice (sole staker on #12) takes it all. Total out = Q, conserved.

---

## 4. Rollover mechanic

- New field `Config.rollover_jackpot: u64` (ANSEM), initialized to 0.
- At swap, with a jackpot winner (`block_sol[J] > 0`): the winner(s) split this round's `(Q − NJ_total)` **plus** the accumulated `rollover_jackpot`; then `rollover_jackpot = 0`.
- With no winner (`block_sol[J] == 0`): `rollover_jackpot += (Q − NJ_total)`.
- **Where the ANSEM lives:** the un-won jackpot ANSEM stays in `payout_vault` (it was minted there that round and never claimed). Across empty rounds `payout_vault` accumulates exactly `rollover_jackpot`, so the eventual winner's claim is always physically covered.
- **Solvency:** `payout_vault` holds `Σ(minted Q) − Σ(claimed)`. Rollover is a deferred-but-covered claim; per-round mint never exceeds `Q`; floor-division dust only ever *under*-pays. `payout_vault` can never be over-drawn.

---

## 5. State changes

**`Config`** (`state/config.rs`):
- **ADD** `rollover_jackpot: u64`.
- **REPURPOSE** `mult_min_bps` / `mult_max_bps` as the return band; set `mult_min_bps = 0`, `mult_max_bps = 5000` at initialize (kept admin-tunable). Names retained to minimize rename churn; semantics are now "per-square return fraction".
- **REMOVE** `small_jackpot_odds`, `small_jackpot_bps`, `big_jackpot_odds`, `big_jackpot_bps`, `small_jackpot_auth_bump`, `big_jackpot_auth_bump`.

**`Round`** (`state/round.rs`):
- **ADD** `jackpot_square: u8`, `jackpot_pool: u64` (frozen at swap).
- **REMOVE** `small_jackpot_hit`, `small_jackpot_block`, `small_jackpot_pool`, `big_jackpot_hit`, `big_jackpot_block`, `big_jackpot_pool`.
- **KEEP** `round_id`, `deadline_ts`, `block_sol`, `pot`, `state`, `randomness`, `swap_proceeds`, `bump`.

> **Migration:** these struct-layout changes make the existing devnet `Config`/`Round` accounts binary-incompatible with the upgraded program. Devnet holds no real funds, so the redeploy re-initializes fresh (documented in the plan). Not an in-place migration.

---

## 6. Handler / math changes

- **`math.rs`:** keep `multiplier_bps` (reused for `f_j`) and `jackpot_block` (single domain now). **Add** `return_weight(block_stake, R, jackpot_square, min_bps, max_bps) = Σ_{j≠J} stake[j] × f_j`, plus a `nonjackpot_payout(weight, pot, Q)` helper and the jackpot pro-rata split. **Remove** `jackpot_hit` and the two-tier `jackpot_block` domain separation.
- **`settle.rs` / `vrf_settle.rs`:** store `R` (unchanged). **Add** `round.jackpot_square = jackpot_block(R)`. **Remove** the two-tier hit/block computation.
- **`swap.rs` (execute_swap_mock):** unchanged SOL→treasury transfer + mint `Q`. **Then** compute `NJ_total`, set `round.jackpot_pool`, update `Config.rollover_jackpot` per §4. **Remove** the small/big jackpot vault accounts + pool snapshots.
- **`claim.rs`:** compute `NJ_player + JP_player` per §3, both paid from `payout_vault`. **Remove** the small/big jackpot vault accounts + transfers.
- **`initialize.rs`:** remove reserve jackpot vault/authority creation; set the return band; init `rollover_jackpot = 0`.
- **`commit_miner` (delegation.rs) — deadline-gate fold-in:** change the §3A gate from `round.state != STATE_OPEN` to `now >= round.deadline_ts` (via `Clock::get()`), keeping the `round_id` match. Reads only immutable fields → robust to ER clone staleness → keeps natural commit-then-settle ordering in every ER-based suite. Same security (staking requires `now < deadline`, so past-deadline ⟺ staking closed) and liveness (keeper commits post-deadline). Account shape unchanged.
- **`constants.rs`:** add `RETURN_MAX_BPS = 5000` (and `RETURN_MIN_BPS = 0`).
- **`admin.rs` — live return-band knob (required):** add `set_return_band(min_bps, max_bps)` on the existing `SetParams` context (admin-gated), validating `min_bps ≤ max_bps ≤ RETURN_MAX_BPS`. This makes the return range a one-call config change with no redeploy. **`set_return_band(0, 0)` ⇒ every non-jackpot square returns 0% ⇒ the entire pot `Q` (plus rollover) goes to the jackpot square** — the max-variance / all-to-jackpot mode. `initialize` defaults to `(0, RETURN_MAX_BPS)` = 0–50%. To ever allow >50% returns later, raise the single `RETURN_MAX_BPS` constant — no other change. **Also remove** the now-dead admin instructions `set_small_jackpot_odds`, `set_big_jackpot_odds`, `seed_small_jackpot`, `seed_big_jackpot` (and their `SeedSmallJackpot`/`SeedBigJackpot` account structs).

---

## 7. Test changes

- **`invariants.rs` (rewrite):** total payout `= Q` (± floor dust); `0 ≤ jackpot_pool ≤ Q`; `NJ_total ≤ 0.5 × face-value of non-jackpot stakes`; rollover accounting conserved across empty→won sequences; solvency (`payout_vault` never over-drawn); degenerate inputs (empty round, single staker, all-on-jackpot, none-on-jackpot).
- **math unit tests:** return band `[0, 5000]`; one jackpot square in range; split conservation; monotonicity where meaningful.
- **All 5 TS suites** (`ansem-miner`, `-er`, `-session`, `-vrf`, `-devnet`): update `swapAccounts`/`claimAccounts` to drop reserve jackpot vaults/authorities; switch `commit_miner` to `{payer, miner, round}` and ensure it runs **post-deadline** (deadline-gate); update `refund` to `{authority, config, round, escrow, miner}`; rewrite payout assertions for the lottery distribution; add a **rollover regression** (round with no jackpot-square staker → the next round's winner receives the carried rollover).

---

## 8. Sequencing (one combined push)

Batched to avoid fixing the suites twice and double devnet deploys:

1. Program: deadline-gate + economics redesign (state, `settle`/`vrf_settle`/`swap`/`claim`/`initialize`, `math`, `constants`).
2. Rebuild sBPF v3 + regenerate IDL/types.
3. Rewrite `invariants.rs` + math unit tests; update all 5 TS suites.
4. Full local gate: Rust (lib + invariants) + L1 + ER + session + VRF.
5. Single devnet redeploy (fresh `initialize`) + `tests/ansem-miner-devnet.ts` e2e.
6. Finish branch (superpowers:finishing-a-development-branch).

The already-implemented, locally-verified 3A/3B/3C hardening rides along; 3A's `commit_miner` gate becomes the deadline-gate.

---

## 9. Edge cases

- **Nobody staked J** → rollover (§4).
- **Everyone staked J** (no losers) → `NJ_total = 0`, `jackpot_pool = Q + rollover`; winners split it (≈ their money back). Solvent.
- **Floor-division dust** → stays in `payout_vault`, harmless; invariants assert `Σ claimed ≤ Q`.
- **`pot == 0`** (round created, nobody staked) → guard division by zero; `NJ_total = 0`, `jackpot_pool = 0`, nothing to claim.
- **Migration** → Config/Round layout change ⇒ re-initialize on devnet redeploy (no real funds).
