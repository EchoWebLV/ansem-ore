# ANSEM Miner — Payout Redesign (lottery model) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. The Rust portion (Tasks 1–7) does NOT compile until Task 7 finishes — that is expected; run the single `cargo check` at Task 7.

**Goal:** Replace the −20%/+20% swap payout with a lottery: non-jackpot squares return a VRF-random 0–50% of stake; one VRF-picked jackpot square splits the retained pot (funded from losers' forfeits); unclaimed jackpots roll over. Remove the two pre-seeded reserve jackpots. Fold in the `commit_miner` deadline-gate. Add a live `set_return_band` admin knob (0,0 ⇒ all-to-jackpot).

**Architecture:** One program upgrade to `ansem-miner` (`8Q9EnK7ydn6ywo7ZxeqhubqYybf7FFNNwnz8JzJjXZjz`). Reuses the existing SOL→ANSEM swap pipeline verbatim; only the *distribution of the minted proceeds `Q`* changes, plus a persistent `Config.rollover_jackpot`. Spec: `docs/superpowers/specs/2026-07-07-ansem-miner-payout-redesign-design.md`.

**Tech Stack:** Anchor 1.0.2 (avm), sBPF v3 (`cargo build-sbf --arch v3 --tools-version v1.54`), ts-mocha, MagicBlock ER, ephemeral-vrf, gum session-keys.

---

## Orientation (read before starting)

- **Spec sections:** §3 payout model, §4 rollover, §5 state, §6 handlers, §7 tests. The math (§3) and rollover (§4) are load-bearing.
- **Money flow that is UNCHANGED:** `execute_swap_mock` still moves the whole SOL `pot` → `treasury` and mints `Q = net × mock_rate` ANSEM to `payout_vault` (`net = pot − fee`). SOL solvency (`pot_vault ≥ total_escrow_balance + pot`) unchanged. We only change how `Q` is split at swap (into `round.jackpot_pool` + rollover) and at claim (per-player NJ + jackpot share).
- **Field renames avoided:** `Config.mult_min_bps`/`mult_max_bps` are kept by name but now mean the per-square *return* band; defaults become `0` / `5000`.
- **Order-independence:** every payout derives from frozen `round.{block_sol, randomness, swap_proceeds, pot, jackpot_square, jackpot_pool}` + `miner.block_stake`. No live-balance reads.
- **Compile expectation:** Tasks 1 (state) through 6 leave the crate non-compiling (handlers reference removed fields until updated). The first green `cargo check` is at the END of Task 6; Task 7 adds the deadline-gate and re-checks.

---

## Task 1: constants + error

**Files:** `programs/ansem-miner/src/constants.rs`, `programs/ansem-miner/src/error.rs`

- [ ] **Step 1: Add return-band constants.** In `constants.rs`, add near the other `DEFAULT_*`:

```rust
pub const RETURN_MIN_BPS: u16 = 0;
pub const RETURN_MAX_BPS: u16 = 5_000; // non-jackpot squares return at most 50%
```

Then repoint the existing defaults (find `DEFAULT_MULT_MIN_BPS` / `DEFAULT_MULT_MAX_BPS`):

```rust
pub const DEFAULT_MULT_MIN_BPS: u16 = RETURN_MIN_BPS; // return-band low  (0%)
pub const DEFAULT_MULT_MAX_BPS: u16 = RETURN_MAX_BPS;  // return-band high (50%)
```

- [ ] **Step 2: Add the error variant.** In `error.rs`, after `CommitTooEarly`:

```rust
    #[msg("Invalid return band (require min <= max <= RETURN_MAX_BPS)")] BadReturnBand,
```

- [ ] **Step 3:** (No compile check yet — do it at Task 6.) Do NOT commit alone; commit with Task 6 (the crate won't build until then). If you prefer per-file commits, stage now and commit at Task 6 Step "cargo check".

---

## Task 2: state — Config + Round

**Files:** `programs/ansem-miner/src/state/config.rs`, `programs/ansem-miner/src/state/round.rs`

- [ ] **Step 1: Config.** Replace the reserve-jackpot fields. Remove `small_jackpot_odds`, `small_jackpot_bps`, `big_jackpot_odds`, `big_jackpot_bps`, `small_jackpot_auth_bump`, `big_jackpot_auth_bump`. Add `rollover_jackpot`. Result (keep everything else in order):

```rust
    pub fee_bps: u16,
    pub mult_min_bps: u16,   // return-band low  (bps)
    pub mult_max_bps: u16,   // return-band high (bps)
    pub min_stake: u64,
    pub max_stake_per_round: u64,
    pub mock_rate: u64,
    pub total_escrow_balance: u64,
    // Accumulated ANSEM jackpot carried across rounds where nobody staked the
    // jackpot square. Lives (physically) as unclaimed ANSEM in payout_vault.
    pub rollover_jackpot: u64,
    pub current_round_finalized: bool,
    pub config_bump: u8,
    pub pot_vault_bump: u8,
    pub treasury_bump: u8,
    pub vault_auth_bump: u8,
    pub mint_auth_bump: u8,
```

(Delete the two `*_jackpot_auth_bump` lines and the four `*_jackpot_odds/bps` lines.)

- [ ] **Step 2: Round.** Remove the six reserve-jackpot fields; add `jackpot_square` + `jackpot_pool`:

```rust
    pub state: u8,
    pub randomness: [u8; 32],
    // The one VRF-picked jackpot square (set at settle) and the ANSEM pool its
    // stakers split (frozen at swap: this round's leftover + carried rollover).
    pub jackpot_square: u8,
    pub jackpot_pool: u64,
    pub swap_proceeds: u64,
    pub bump: u8,
```

- [ ] **Step 2b:** No compile yet. Continue.

---

## Task 3: math.rs

**Files:** `programs/ansem-miner/src/math.rs`

- [ ] **Step 1: Add the return/jackpot payout helpers.** Keep `multiplier_bps` (reused as the per-square return fraction) and `jackpot_block`. Add:

```rust
/// Sum over NON-jackpot squares of stake[j] * f_j(bps), f_j = return fraction in
/// [min_bps, max_bps]. Excludes the jackpot square. (multiplier_bps with
/// min==max==0 yields 0 with no div-by-zero: range = (max-min)+1 >= 1.)
pub fn return_weight(
    block_stake: &[u64; GRID_SIZE], r: &[u8; 32], jackpot_square: u8, min_bps: u16, max_bps: u16,
) -> u128 {
    let mut w = 0u128;
    for s in 0..GRID_SIZE {
        if s as u8 == jackpot_square { continue; }
        w += (block_stake[s] as u128) * (multiplier_bps(r, s as u8, min_bps, max_bps) as u128);
    }
    w
}

/// Non-jackpot ANSEM payout = proceeds * weight / (pot * 10_000). Floors.
pub fn nonjackpot_payout(weight: u128, pot: u64, proceeds: u64) -> u64 {
    if pot == 0 { return 0; }
    ((proceeds as u128 * weight) / (pot as u128 * 10_000u128)) as u64
}

/// Pro-rata jackpot share = pool * player_on_jackpot / total_on_jackpot. Floors.
pub fn jackpot_share(pool: u64, player_on_jackpot: u64, total_on_jackpot: u64) -> u64 {
    if total_on_jackpot == 0 { return 0; }
    ((pool as u128 * player_on_jackpot as u128) / total_on_jackpot as u128) as u64
}
```

- [ ] **Step 2: Remove `jackpot_hit`** (no longer used). Keep `jackpot_block` (used with a single domain `b"jackpot"` now).

- [ ] **Step 3: Rewrite the unit tests** (`#[cfg(test)] mod tests`). Replace the multiplier/jackpot-tier tests with the new model. Include at minimum:

```rust
    const R: [u8; 32] = [7u8; 32];

    #[test]
    fn return_fraction_in_0_50_band() {
        for s in 0..25u8 {
            let f = multiplier_bps(&R, s, 0, 5000);
            assert!(f <= 5000, "square {s} -> {f}");
        }
    }

    #[test]
    fn zero_band_returns_all_to_jackpot() {
        // max=0 => every non-jackpot square returns 0 => NJ_total = 0.
        let mut stake = [0u64; 25]; stake[3] = 1_000_000_000; stake[8] = 500_000_000;
        let jsq = jackpot_block(&R, b"jackpot");
        let w = return_weight(&stake, &R, jsq, 0, 0);
        assert_eq!(w, 0);
        assert_eq!(nonjackpot_payout(w, 1_500_000_000, 1_500_000_000), 0);
    }

    #[test]
    fn split_conserves_proceeds() {
        // One round: NJ_total + jackpot_pool == proceeds (± floor dust).
        let mut block_sol = [0u64; 25];
        block_sol[1] = 3_000_000_000; block_sol[4] = 2_000_000_000; // losers
        let jsq = 9u8; block_sol[jsq as usize] = 1_000_000_000;      // jackpot square
        let pot: u64 = block_sol.iter().sum();
        let proceeds = pot; // rate 1:1 for the test
        let njw = return_weight(&block_sol, &R, jsq, 0, 5000);
        let nj = nonjackpot_payout(njw, pot, proceeds);
        let pool = proceeds - nj;                 // this-round leftover (no rollover)
        assert!(nj <= proceeds / 2 + 25, "NJ must be <= ~half: {nj}");
        assert_eq!(nj + pool, proceeds);
    }

    #[test]
    fn jackpot_square_in_range() { assert!(jackpot_block(&R, b"jackpot") < 25); }
```

- [ ] **Step 4:** No lib compile yet (handlers still reference old fields). `cargo test --lib` will fail to build until Task 6 — defer running these to Task 8.

---

## Task 4: settle + vrf_settle

**Files:** `programs/ansem-miner/src/instructions/settle.rs`, `.../vrf_settle.rs`

- [ ] **Step 1: settle_handler.** Replace the four `*_jackpot_*` writes with the single jackpot-square pick. Remove the now-unused `let cfg = ...` if it becomes unused (settle no longer reads config for jackpot odds — check; keep `cfg` only if still used, else drop the binding to avoid a warning):

```rust
    round.randomness = randomness;
    round.jackpot_square = math::jackpot_block(&randomness, b"jackpot");
    round.state = STATE_SETTLED;
```

- [ ] **Step 2: settle_callback_handler** (vrf_settle.rs) — identical replacement:

```rust
    round.randomness = randomness;
    round.jackpot_square = math::jackpot_block(&randomness, b"jackpot");
    round.state = STATE_SETTLED;
```

Drop any now-unused `let cfg = &ctx.accounts.config;` binding (the callback still takes `config` as an account — that's fine; just don't bind it if unused, or prefix `_`).

---

## Task 5: swap.rs — jackpot pool + rollover

**Files:** `programs/ansem-miner/src/instructions/swap.rs`

- [ ] **Step 1: Remove reserve-jackpot accounts.** Delete from `ExecuteSwapMock`: `small_jackpot_authority`, `small_jackpot_vault`, `big_jackpot_authority`, `big_jackpot_vault`. (Keep `payout_vault`, `pot_vault`, `treasury`, mint/vault authorities.)

- [ ] **Step 2: Read the new config scalars up front.** In the handler's "copy config scalars" block, remove `small_jackpot_bps`/`big_jackpot_bps` and the two `*_vault.amount` snapshots; add:

```rust
    let mult_min_bps = ctx.accounts.config.mult_min_bps;
    let mult_max_bps = ctx.accounts.config.mult_max_bps;
    let rollover_in = ctx.accounts.config.rollover_jackpot;
```

- [ ] **Step 3: Replace the jackpot-pool snapshot block.** After `round.swap_proceeds = ansem_out;`, delete the two `if round.small/big_jackpot_hit { ... }` blocks and insert:

```rust
    // Split the minted proceeds into losers' returns + the jackpot pool (spec §3/§4).
    let jsq = round.jackpot_square as usize;
    let nj_weight = math::return_weight(&round.block_sol, &round.randomness, round.jackpot_square, mult_min_bps, mult_max_bps);
    let nj_total = math::nonjackpot_payout(nj_weight, pot, ansem_out);
    let round_leftover = ansem_out.checked_sub(nj_total).ok_or(AnsemError::Overflow)?;
    if round.block_sol[jsq] > 0 {
        // A winner staked the jackpot square: they split this round's leftover
        // PLUS the accumulated rollover; consume the rollover.
        round.jackpot_pool = round_leftover.checked_add(rollover_in).ok_or(AnsemError::Overflow)?;
        ctx.accounts.config.rollover_jackpot = 0;
    } else {
        // No winner: carry this round's leftover forward (it stays as unclaimed
        // ANSEM in payout_vault).
        round.jackpot_pool = 0;
        ctx.accounts.config.rollover_jackpot =
            rollover_in.checked_add(round_leftover).ok_or(AnsemError::Overflow)?;
    }
```

Add `use crate::math;` at the top of swap.rs if not present.

> **Borrow note:** `round` is `&mut ctx.accounts.round`. Writing `ctx.accounts.config.rollover_jackpot` while holding `round` is fine (disjoint accounts), but if the borrow checker complains, compute `nj_total`/`round_leftover` and the winner flag first, then drop the `round` mutable borrow before touching `config` — mirror how the existing code sets `config.current_round_finalized` at the end.

---

## Task 6: claim.rs + initialize.rs + admin.rs + lib.rs → first compile

**Files:** `.../claim.rs`, `.../initialize.rs`, `.../admin.rs`, `src/lib.rs`

- [ ] **Step 1: claim.rs accounts.** Remove `small_jackpot_authority`, `big_jackpot_authority`, `small_jackpot_vault`, `big_jackpot_vault` from `Claim`. Keep `payout_vault`, `vault_authority`, `player_ata`.

- [ ] **Step 2: claim_handler.** Replace the main-payout + two jackpot-transfer blocks with the new NJ + jackpot-share single transfer:

```rust
    let jsq = round.jackpot_square as usize;
    let nj_weight = math::return_weight(&miner.block_stake, &round.randomness, round.jackpot_square, cfg.mult_min_bps, cfg.mult_max_bps);
    let nj_amount = math::nonjackpot_payout(nj_weight, round.pot, round.swap_proceeds);
    let jp_amount = math::jackpot_share(round.jackpot_pool, miner.block_stake[jsq], round.block_sol[jsq]);
    let amount = nj_amount.checked_add(jp_amount).ok_or(AnsemError::Overflow)?;

    if amount > 0 {
        let va_bump = cfg.vault_auth_bump;
        let va_seeds: &[&[u8]] = &[VAULT_AUTH_SEED, &[va_bump]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                Transfer {
                    from: ctx.accounts.payout_vault.to_account_info(),
                    to: ctx.accounts.player_ata.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                },
                &[va_seeds],
            ),
            amount,
        )?;
    }
```

Delete the old `math::total_weight`/`player_weight`/`payout` main-payout block and both `if round.*_jackpot_hit { ... }` transfer blocks. Keep the trailing `escrow.last_claimed_round = round_id; escrow.active_round = 0;`.

- [ ] **Step 3: initialize.rs.** Remove `small_jackpot_authority`, `big_jackpot_authority`, `small_jackpot_vault`, `big_jackpot_vault` accounts. In `initialize_handler`, delete the four `c.small/big_jackpot_odds/bps = ...` lines and the two `c.small/big_jackpot_auth_bump = ...` lines; add `c.rollover_jackpot = 0;`. `mult_min/max_bps` defaults already repoint to the return band (Task 1).

- [ ] **Step 4: admin.rs.** Remove `set_small_jackpot_odds`, `set_big_jackpot_odds`, `seed_small_jackpot`, `seed_big_jackpot` and the `SeedSmallJackpot`/`SeedBigJackpot` structs (and now-unused imports: `anchor_spl` token/ata/Mint/MintTo/TokenAccount if fully unused). Add on the existing `SetParams`:

```rust
pub fn set_return_band(ctx: Context<SetParams>, min_bps: u16, max_bps: u16) -> Result<()> {
    require!(min_bps <= max_bps && max_bps <= RETURN_MAX_BPS, AnsemError::BadReturnBand);
    ctx.accounts.config.mult_min_bps = min_bps;
    ctx.accounts.config.mult_max_bps = max_bps;
    Ok(())
}
```

- [ ] **Step 5: lib.rs.** Remove the `set_small_jackpot_odds`, `set_big_jackpot_odds`, `seed_small_jackpot`, `seed_big_jackpot` entrypoints. Add:

```rust
    pub fn set_return_band(ctx: Context<SetParams>, min_bps: u16, max_bps: u16) -> Result<()> {
        instructions::admin::set_return_band(ctx, min_bps, max_bps)
    }
```

Ensure `instructions::*` still re-exports `SetParams` (it does). Remove `SeedSmallJackpot`/`SeedBigJackpot` from any `pub use` in `instructions/mod.rs` if listed.

- [ ] **Step 6: Constants cleanup (optional).** `JACKPOT_SM_AUTH_SEED`/`JACKPOT_BIG_AUTH_SEED` and `DEFAULT_SMALL/BIG_JACKPOT_*` are now unused — remove them (and any `SEED`s) to kill dead-code warnings, OR leave (harmless). Prefer removing the `DEFAULT_*_JACKPOT_*` consts (they'd otherwise be unused).

- [ ] **Step 7: Compile.** Run: `cargo check -p ansem-miner`. Expected: **compiles clean.** Fix any residual references to removed fields/ixns until green.

- [ ] **Step 8: Commit the whole program change.**

```bash
git add programs/ansem-miner/src
git commit -m "M4b: lottery payout (0-50% returns + one-square jackpot + rollover); drop reserve jackpots; add set_return_band"
```

---

## Task 7: commit_miner deadline-gate

**Files:** `programs/ansem-miner/src/instructions/delegation.rs`

- [ ] **Step 1: Swap the gate.** In `commit_miner_handler`, replace the `round.state != STATE_OPEN` check with a deadline check (keep the `round_id` match):

```rust
pub fn commit_miner_handler(ctx: Context<CommitMiner>) -> Result<()> {
    // Gate (§3A, deadline form): staking is closed once now >= deadline_ts
    // (stake requires now < deadline). deadline_ts is immutable, so this is
    // robust to ER clone staleness and keeps natural commit-then-settle order.
    require!(
        ctx.accounts.round.round_id == ctx.accounts.miner.round_id,
        AnsemError::MinerRoundMismatch
    );
    let now = Clock::get()?.unix_timestamp;
    require!(now >= ctx.accounts.round.deadline_ts, AnsemError::CommitTooEarly);

    MagicIntentBundleBuilder::new(
        ctx.accounts.payer.to_account_info(),
        ctx.accounts.magic_context.to_account_info(),
        ctx.accounts.magic_program.to_account_info(),
    )
    .commit_and_undelegate(&[ctx.accounts.miner.to_account_info()])
    .build_and_invoke()?;
    Ok(())
}
```

- [ ] **Step 2:** Remove the now-unused `STATE_OPEN` import from `delegation.rs` ONLY if `delegate_round_handler` no longer uses it — it DOES (`require!(r.state == STATE_OPEN, ...)`), so keep the import.

- [ ] **Step 3: Compile + commit.**

```bash
cargo check -p ansem-miner
git add programs/ansem-miner/src/instructions/delegation.rs
git commit -m "M4b(3A): commit_miner deadline-gate (now >= deadline_ts) — robust to ER clone staleness"
```

---

## Task 8: rebuild v3 + regen IDL + Rust tests (invariants rewrite)

**Files:** `programs/ansem-miner/tests/invariants.rs`

- [ ] **Step 1: Rewrite `invariants.rs`** for the lottery model. Use the existing splitmix64 `Rng` + `GRID_SIZE` import. Replace the multiplier/jackpot-tier invariants with:
  - `total_payout_equals_proceeds`: for random block_sol + random band, `Σ_players(NJ + jackpot) == proceeds` (± num_squares dust), across many configs.
  - `jackpot_pool_between_zero_and_proceeds`: `0 ≤ round_leftover ≤ proceeds` and `NJ_total ≤ proceeds/2 + dust`.
  - `zero_band_all_to_jackpot`: with band (0,0), `NJ_total == 0` and pool == proceeds.
  - `rollover_conserved`: simulate an empty-jackpot round then a won round; total ANSEM paid across both == sum of both proceeds (± dust); no over-pay.
  - `no_jackpot_staker_rolls_over`: `block_sol[J]==0` ⇒ pool contributed to rollover, nothing paid to J.
  - `degenerate_inputs_pay_zero`: empty round (pot 0) ⇒ all payouts 0, no panic.
  Model the split with the same `math::` functions the program uses (import `ansem_miner::math::{return_weight, nonjackpot_payout, jackpot_share}` and `ansem_miner::constants::{GRID_SIZE, RETURN_MAX_BPS}`). Compute per-player NJ from `return_weight` and jackpot from `jackpot_share(pool, stake[J], block_sol[J])`.

- [ ] **Step 2: Build sBPF v3.**
Run: `cargo build-sbf --arch v3 --tools-version v1.54`
Then: `~/.cache/solana/v1.51/platform-tools/llvm/bin/llvm-readelf -h target/deploy/ansem_miner.so | grep -i flags` → expect `0x3`.

- [ ] **Step 3: Regenerate IDL/types.** `anchor build` (emits v0 + regenerates `target/idl` + `target/types`), then re-run the v3 build to restore the .so:
`rm -rf target/sbf-solana-solana target/deploy/ansem_miner.so && cargo build-sbf --arch v3 --tools-version v1.54` and re-verify `0x3`.

- [ ] **Step 4: Run Rust tests.**
Run: `cargo test --manifest-path programs/ansem-miner/Cargo.toml --lib --test invariants`
Expected: new math unit tests + invariants all pass.

- [ ] **Step 5: Commit.**
```bash
git add programs/ansem-miner/tests/invariants.rs programs/ansem-miner/src/math.rs
git commit -m "M4b: rewrite invariants + math tests for the lottery payout model"
```

---

## Task 9: update the TS suites

**Files:** `tests/ansem-miner.ts`, `tests/ansem-miner-er.ts`, `tests/ansem-miner-session.ts`, `tests/ansem-miner-vrf.ts`, `tests/ansem-miner-devnet.ts`

Mechanical + assertion changes. Work suite-by-suite; run each as you go (Task 10 harness).

- [ ] **Step 1: Purge removed instructions.** `grep -n "seedSmallJackpot\|seedBigJackpot\|setSmallJackpotOdds\|setBigJackpotOdds" tests/*.ts`. Delete those calls and any test blocks whose sole purpose was the reserve jackpots. Rewrite reserve-jackpot payout tests as one-square-jackpot tests.

- [ ] **Step 2: Fix `swapAccounts` / `claimAccounts` helpers.** In every suite, remove `smallJackpotAuthority`, `smallJackpotVault`, `bigJackpotAuthority`, `bigJackpotVault` (and the derived ATAs/PDAs) from the swap/claim account objects. (Anchor ignores unknown keys, but remove for clarity + because the vaults no longer exist.)

- [ ] **Step 3: Fix `commit_miner` call sites (deadline-gate).** New shape `{ payer, miner, round }`, no owner signer. Ensure `commit_miner` runs **after the round deadline** (post-deadline gate): in `-er`, `-session`, `-vrf`, place the wait-for-deadline before `commit_miner`. The `-er` suite's Task-6 already settles-before-commit; under the deadline gate that still passes (settle poll runs past the deadline). For `-session`/`-vrf`, move the existing deadline-wait to before `commit_miner`; keep settle where it is (L1/VRF, after commit).

- [ ] **Step 4: Fix `refund` call sites.** `{ authority, config, round, escrow, miner }` (already done in `-er`; apply to `-vrf` line ~319).

- [ ] **Step 5: Rewrite payout assertions** to the lottery model. A round now pays: non-jackpot stakers get `0..50%` (assert `≤` their stake-value in ANSEM), and the jackpot-square staker(s) get the big pool. For a deterministic assert, set the band to `(0,0)` via `setReturnBand(0,0)` in a dedicated test so the sole jackpot-square staker receives the whole `Q` and everyone else 0 — easy exact assertion. Keep at least one `(0,5000)` test asserting conservation (`Σ ANSEM out ≈ Q`).

- [ ] **Step 6: Add a rollover regression** (L1 suite is fine): round A — nobody stakes the jackpot square (stake only elsewhere, or don't stake at all) → after swap, `config.rolloverJackpot > 0` and `round.jackpotPool == 0`. Round B — someone stakes the jackpot square → after swap, `round.jackpotPool` includes the carried rollover and `config.rolloverJackpot == 0`; the winner's claim reflects it. (Deriving "the jackpot square" ahead of time: it's `jackpot_block(randomness, "jackpot")` — for admin `settle` you inject the randomness, so you can precompute the square with a keccak of `randomness‖"jackpot"` and stake it, or read `round.jackpotSquare` after settle and assert against a staked square.)

- [ ] **Step 7: Commit.**
```bash
git add tests/*.ts
git commit -m "M4b: update all TS suites for the lottery payout (account shapes, deadline-gate commit, rollover regression)"
```

---

## Task 10: full local gate

- [ ] **Step 1: L1 suite.** `SKIP_BUILD=1 TEST_FILE=tests/ansem-miner.ts bash scripts/test-er.sh` → all green.
- [ ] **Step 2: ER suite.** `SKIP_BUILD=1 bash scripts/test-er.sh` → all green.
- [ ] **Step 3: session suite.** `SKIP_BUILD=1 TEST_FILE=tests/ansem-miner-session.ts bash scripts/test-er.sh` → all green.
- [ ] **Step 4: VRF suite.** `SKIP_BUILD=1 TEST_FILE=tests/ansem-miner-vrf.ts bash scripts/test-er.sh` → all green (oracle lifecycle managed by the test).
- [ ] **Step 5:** If any suite reveals a program bug, fix in `src/`, rebuild v3 (Task 8 Step 2–3), re-run. Commit fixes.

**CHECKPOINT: stop here for user go-ahead before the devnet redeploy (Task 11).**

---

## Task 11: devnet redeploy + re-verify

- [ ] **Step 1: Deploy the upgrade.** `bash scripts/deploy-devnet.sh` (loader-v3, reuses funded wallet + Helius RPC from `.env`). Upgrades the program in place.
- [ ] **Step 2: Fresh initialize.** The Config/Round layout changed, so the old on-chain Config is incompatible. Re-initialize on devnet (the devnet suite's setup calls `initialize`; if Config already exists from the prior deploy, this needs a fresh Config PDA — since the PDA seed is constant, the existing account must be closed/migrated OR the suite tolerates an existing-but-new-layout account only after a fresh program. If `initialize` fails on the pre-existing Config account, document the manual step: the account holds no real funds; closing it requires an admin close ix which does not exist → alternative: the devnet e2e asserts against a freshly-initialized state only if the account can be re-created. If blocked, note it and treat the devnet run as best-effort.)
- [ ] **Step 3: Re-run devnet e2e.** `yarn run ts-mocha -p ./tsconfig.json -t 1000000 tests/ansem-miner-devnet.ts` → green against the upgraded program.
- [ ] **Step 4: Adversarial review** of the changed handlers (`swap` rollover, `claim` split, `set_return_band`, `commit_miner` gate): confirm no new value-movement path, solvency-neutral, rollover conserved.
- [ ] **Step 5: Commit note.** `git commit --allow-empty -m "M4b: lottery payout deployed to devnet; e2e green"`.

> **Migration caveat (Step 2):** if the constant-seed Config PDA blocks a clean re-initialize on the already-deployed devnet program, the cleanest path is to deploy under a fresh program id for devnet OR add a tiny admin `close_config` ix. Decide with the user at the Task 10 checkpoint; do not block local completion on it.

---

## Task 12: finish the branch

- [ ] Use superpowers:finishing-a-development-branch: verify the full gate is green, then present merge/PR/keep/discard options.

---

## Self-Review

- **Spec coverage:** §3 model (Tasks 3,5,6), §4 rollover (Task 5), §5 state (Task 2), §6 handlers (Tasks 3–7) + set_return_band knob (Task 6), §7 tests (Tasks 8,9). Deadline-gate (Task 7). ✎ all mapped.
- **Types consistent:** `return_weight(block, r, jackpot_square, min_bps, max_bps)`, `nonjackpot_payout(weight, pot, proceeds)`, `jackpot_share(pool, on_j, total_on_j)` — same signatures used in swap.rs, claim.rs, invariants.rs. `Config.rollover_jackpot`, `Round.jackpot_square`/`jackpot_pool` — same names across state, swap, claim, tests (camelCase in TS).
- **Compile ordering:** flagged (first green check at Task 6 Step 7).
- **Migration risk:** flagged (Task 11 Step 2) — do not block local completion on it.

## Risks / notes

- **Borrow checker in swap.rs** (mut `round` + write `config.rollover_jackpot`): if it complains, compute scalars first and scope the `round` borrow (mirror the existing `current_round_finalized` write at the end).
- **`jackpot_block` domain:** use a single stable domain `b"jackpot"` everywhere (settle, vrf_settle, and any TS precompute).
- **Deadline-gate + `-er` Task 6:** the settle-before-commit ordering still passes under the deadline gate (settle poll outlasts the deadline). No revert needed; the CommitTooEarly-while-OPEN negative still holds (pre-deadline).
- **Devnet Config migration:** the biggest unknown; keep it out of the local-gate critical path.
