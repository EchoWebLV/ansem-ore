# $BEEF Mined-Token Launch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the spec at `docs/superpowers/specs/2026-07-14-beef-on-ansem-design.md` — BEEF mints per round (pot-scaled, 21M cap, 80/20 players/treasury), jackpot becomes random-trigger + bet-scaled-cap, fee 5% with a dial, keeper auto-refreshes the ANSEM floor, app gets the liveness package. Mine-first launch; Meteora BEEF/ANSEM listing is a later ops script.

**Architecture:** The dormant BEEF vault layer (`instructions/beef.rs`, `state/beef.rs`) stays structurally intact — `roll_beef`/`claim_beef`/hold-to-grow are UNTOUCHED. Only `stamp_beef` changes funding: instead of draining a pre-funded vault, it MINTS the round's emission (players' share into the existing vault, treasury cut to a pinned ATA). Jackpot params live in a NEW `JackpotConfig` PDA (the live mainnet `Config` account must not change size — no migration). All new knobs are admin ixs.

**Tech Stack:** Anchor 1.0.2 (`~/.avm/bin/anchor-1.0.2`; the 0.31.1 on PATH shadows it), Solana CLI 4.1.0-beta.2, `cargo build-sbf --arch v3 --tools-version v1.54`, ts-mocha integration suites against a fresh `solana-test-validator` per suite, pnpm workspaces (sdk/keeper/app).

**Build gotchas (read first):**
- Any `anchor build` clobbers the `.so` with non-v3 arch. Always finish with: `touch programs/ansem-miner/src/lib.rs && cargo build-sbf --arch v3 --tools-version v1.54 -- --features devnet` (local/test) or without `--features devnet` (mainnet artifact).
- Tests: per-suite fresh validator, e.g. `solana-test-validator -r --bpf-program <PROGRAM_ID> target/deploy/ansem_miner.so -q &` then `pnpm exec ts-mocha -p tsconfig.json -t 120000 tests/<suite>.ts`; kill the validator between suites. Follow the exact invocations already used by the repo's test docs/scripts.
- Mainnet ansem flows are feature-gated: mock instructions exist only with `--features devnet`. Keep both builds compiling.
- Commit after each green step. Never estimate durations anywhere.

---

## Task 1: Emission + trigger math (pure functions, Rust unit tests)

**Files:**
- Modify: `programs/ansem-miner/src/math.rs` (BEEF section starts ~line 57; tests module ~line 170)
- Modify: `programs/ansem-miner/src/constants.rs` (BEEF section ~line 41)

- [ ] **Step 1: Write failing Rust unit tests** in the existing `#[cfg(test)]` module of `math.rs`:

```rust
#[test]
fn emission_zero_pot_is_zero() {
    assert_eq!(beef_emission(0, 210_000_000, 1_000_000_000), 0);
}
#[test]
fn emission_half_max_at_saturation_pot() {
    // pot == S -> MAX/2
    assert_eq!(beef_emission(1_000_000_000, 210_000_000, 1_000_000_000), 105_000_000);
}
#[test]
fn emission_approaches_max() {
    let e = beef_emission(100_000_000_000, 210_000_000, 1_000_000_000);
    assert!(e > 207_000_000 && e < 210_000_000);
}
#[test]
fn emission_dust_pot_mints_dust() {
    // 0.01 SOL pot -> ~1% of half... exact: 210e6 * 1e7 / (1e7 + 1e9) = 2_079_207
    assert_eq!(beef_emission(10_000_000, 210_000_000, 1_000_000_000), 2_079_207);
}
#[test]
fn emission_no_overflow_at_extremes() {
    assert!(beef_emission(u64::MAX, u64::MAX, 1) <= u64::MAX);
}
#[test]
fn trigger_odds_one_always_fires() {
    assert!(jackpot_triggered(&[0u8; 32], 1));
    assert!(jackpot_triggered(&[7u8; 32], 0)); // 0 treated as always (disabled gate)
}
#[test]
fn trigger_uses_bytes_16_24_le() {
    let mut r = [0u8; 32];
    // draw = 25 -> 25 % 25 == 0 -> fires at odds 25
    r[16] = 25;
    assert!(jackpot_triggered(&r, 25));
    r[16] = 26; // 26 % 25 == 1 -> no fire
    assert!(!jackpot_triggered(&r, 25));
}
```

- [ ] **Step 2: Run to verify failure**: `cargo test -p ansem-miner beef_emission -- --nocapture` → compile error (functions undefined).

- [ ] **Step 3: Implement** in `math.rs` BEEF section:

```rust
/// Pot-scaled saturating emission: MAX * pot / (pot + S). Floors. 0 at pot 0.
pub fn beef_emission(pot_lamports: u64, max_round_mint: u64, sat_lamports: u64) -> u64 {
    if pot_lamports == 0 || max_round_mint == 0 {
        return 0;
    }
    ((max_round_mint as u128 * pot_lamports as u128)
        / (pot_lamports as u128 + sat_lamports as u128)) as u64
}

/// Jackpot-round draw from the round's frozen randomness. Bytes 16..24 LE —
/// MUST stay disjoint from the winning-square draw bytes (see Task 3 step 1
/// verification). odds semantics: 0 or 1 = every winner round pays (legacy
/// behavior); N>1 = 1-in-N rounds.
pub fn jackpot_triggered(randomness: &[u8; 32], odds: u16) -> bool {
    if odds <= 1 {
        return true;
    }
    let draw = u64::from_le_bytes(randomness[16..24].try_into().unwrap());
    draw % odds as u64 == 0
}
```

In `constants.rs`, replace the divisor-era defaults (keep the seeds; delete `DEFAULT_BEEF_DIVISOR`, keep tick/bonus/activity/secs constants):

```rust
// Mint-on-emission (spec 2026-07-14-beef-on-ansem-design): per-round mint =
// MAX_ROUND_MINT * pot/(pot + SAT). 6-decimal base units.
pub const BEEF_MAX_ROUND_MINT: u64 = 210_000_000; // 210 BEEF
pub const BEEF_SAT_LAMPORTS: u64 = 1_000_000_000; // half-max at 1 SOL pot
pub const BEEF_HARD_CAP: u64 = 21_000_000_000_000; // 21,000,000 BEEF
pub const BEEF_TREASURY_BPS: u16 = 2_000; // 20% continuous treasury cut
pub const JACKPOT_CONFIG_SEED: &[u8] = b"jackpot_config";
pub const DEFAULT_JACKPOT_TRIGGER_ODDS: u16 = 25; // 1-in-25 winner rounds
pub const DEFAULT_JACKPOT_CAP_MULT: u16 = 100; // bite <= 100x winning-square stake value
```

- [ ] **Step 4: Run**: `cargo test -p ansem-miner -- --nocapture` → all green (fix any const references that still mention the divisor; `beef.rs` still compiles because it's edited in Task 2 — if it breaks on the deleted const, leave `DEFAULT_BEEF_DIVISOR` in place until Task 2 and note it).

- [ ] **Step 5: Commit** `feat(program): beef emission curve + jackpot trigger math`

---

## Task 2: Mint-on-emission conversion (BeefConfig + InitBeef + StampBeef)

**Files:**
- Modify: `programs/ansem-miner/src/state/beef.rs` (BeefConfig struct, lines 8–25)
- Modify: `programs/ansem-miner/src/instructions/beef.rs` (InitBeef 27–78, SetBeefParams 80–108, StampBeef 110–163; stale "pump.fun (Token-2022) mint" comment lines 3–5)
- Modify: `programs/ansem-miner/src/lib.rs` (handler signatures)

BeefConfig is NOT initialized on mainnet (verified 2026-07-14) — the struct may change freely, no migration.

- [ ] **Step 1: Rewrite BeefConfig** (replace `divisor`; add mint-model fields):

```rust
#[account]
#[derive(InitSpace)]
pub struct BeefConfig {
    pub beef_mint: Pubkey,
    /// Player-emission buffer. Owner = vault_authority PDA, which is ALSO the
    /// beef mint authority — stamp mints into here, claims transfer out.
    pub beef_vault: Pubkey,
    /// Treasury ATA (20% cut minted straight here). Pinned at init.
    pub beef_treasury: Pubkey,
    /// emission_total_per_round = max_round_mint * pot/(pot + sat_lamports)
    pub max_round_mint: u64,
    pub sat_lamports: u64,
    /// Emission stops forever at the cap. minted_total counts BOTH shares.
    pub hard_cap: u64,
    pub minted_total: u64,
    pub treasury_bps: u16,
    pub tick_bps: u16,
    pub bonus_cap_bps: u16,
    pub activity_window_secs: i64,
    pub secs_per_tick: i64,
    pub total_owed: u64,
    pub bump: u8,
}
```

- [ ] **Step 2: InitBeef** — add `beef_treasury` account (constraint: `beef_treasury.mint == beef_mint.key()`), require the mint authority to be the vault_authority PDA (`beef_mint.mint_authority == COption::Some(vault_authority.key())` — in anchor: `constraint = beef_mint.mint_authority.contains(&vault_authority.key()) @ AnsemError::BadBeefParams`), new handler args `(max_round_mint, sat_lamports, hard_cap, treasury_bps, tick_bps, bonus_cap_bps, activity_window_secs, secs_per_tick)`, validate `treasury_bps <= 5_000 && sat_lamports > 0 && hard_cap > 0`. Same arg surface on `set_beef_params` MINUS hard_cap/treasury pins (tuning must not touch cap, mint, vault, treasury: cap raises would break the trust page).

- [ ] **Step 3: StampBeef mint conversion.** Add accounts: `beef_mint` (mut, `address = beef_config.beef_mint`), `vault_authority` (PDA seeds `VAULT_AUTH_SEED`), `beef_vault` becomes `mut` + `address = beef_config.beef_vault`, `beef_treasury` (mut, `address = beef_config.beef_treasury`), `token_program: Interface<TokenInterface>`. Handler core replaces lines 151–162:

```rust
let bc = &mut ctx.accounts.beef_config;
let total = math::beef_emission(round.pot, bc.max_round_mint, bc.sat_lamports)
    .min(bc.hard_cap.saturating_sub(bc.minted_total));
let treasury_cut = (total as u128 * bc.treasury_bps as u128 / 10_000u128) as u64;
let players = total - treasury_cut;

let va_seeds: &[&[u8]] = &[VAULT_AUTH_SEED, &[ctx.accounts.config.vault_auth_bump]];
if players > 0 {
    token_interface::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            token_interface::MintTo {
                mint: ctx.accounts.beef_mint.to_account_info(),
                to: ctx.accounts.beef_vault.to_account_info(),
                authority: ctx.accounts.vault_authority.to_account_info(),
            },
            &[va_seeds],
        ),
        players,
    )?;
}
if treasury_cut > 0 {
    token_interface::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            token_interface::MintTo {
                mint: ctx.accounts.beef_mint.to_account_info(),
                to: ctx.accounts.beef_treasury.to_account_info(),
                authority: ctx.accounts.vault_authority.to_account_info(),
            },
            &[va_seeds],
        ),
        treasury_cut,
    )?;
}

let br = &mut ctx.accounts.beef_round;
br.round_id = round_id;
br.emission = players; // roll_beef splits only the players' share
br.bump = ctx.bumps.beef_round;

bc.minted_total = bc.minted_total.checked_add(total).ok_or(AnsemError::Overflow)?;
bc.total_owed = bc.total_owed.checked_add(players).ok_or(AnsemError::Overflow)?;
```

Note: `mint_to` import joins the existing `token_interface::{...}` use. The stamp stays permissionless — emission is deterministic from frozen round + config; nothing an attacker controls. `sweep_beef_excess` (instructions/sweep.rs): change its excess base to `vault.amount - total_owed` unchanged semantics BUT document that in the minted model excess only exists from external donations; keep the ix (harmless, still admin-gated).

- [ ] **Step 4: Fix the stale header comment** in `beef.rs` lines 3–5: BEEF is now the program's OWN classic-SPL mint (authority = vault_authority PDA); interface layer retained for generality.

- [ ] **Step 5: Compile both builds**:
`touch programs/ansem-miner/src/lib.rs && cargo build-sbf --arch v3 --tools-version v1.54 -- --features devnet` then without the feature flag. Both must succeed.

- [ ] **Step 6: Commit** `feat(program): stamp_beef mints per-round emission (80/20, on-chain cap)`

---

## Task 3: JackpotConfig PDA + trigger/cap in settlement + set_fee_bps

**Files:**
- Create: `programs/ansem-miner/src/state/jackpot.rs` (+ export in `state/mod.rs`)
- Modify: `programs/ansem-miner/src/instructions/swap.rs` (finalize_swap_accounting lines 22–78 + both call sites ~130/256 + both Accounts contexts)
- Modify: `programs/ansem-miner/src/instructions/admin.rs` (new setters next to set_return_band line 24)
- Modify: `programs/ansem-miner/src/lib.rs`

**Config account must NOT change size** — it is live on mainnet with real obligations. Jackpot params live in a new PDA.

- [ ] **Step 1 (VERIFICATION, report in commit message):** Find where `round.jackpot_square` and `round.randomness` are set (settle/VRF instruction). Confirm (a) the winning-square draw does NOT consume randomness bytes 16..24 — if it does, move `jackpot_triggered` to bytes 24..32 and update the Task 1 test; (b) exactly ONE randomness request/consume per round is possible (state-machine gate). Record findings as code comments on `jackpot_triggered`.

- [ ] **Step 2: New state** `state/jackpot.rs`:

```rust
use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct JackpotConfig {
    /// 0|1 = every winner round pays the rollover (legacy). N>1 = 1-in-N.
    pub trigger_odds: u16,
    /// Bite ceiling = cap_mult x winning-square stake's ANSEM value. 0 = uncapped.
    pub cap_mult: u16,
    pub bump: u8,
}
```

- [ ] **Step 3: Thread it into settlement.** Add to BOTH swap Accounts contexts: `#[account(seeds = [JACKPOT_CONFIG_SEED], bump = jackpot_config.bump)] pub jackpot_config: Box<Account<'info, JackpotConfig>>`. Change `finalize_swap_accounting` signature to take `trigger_odds: u16, cap_mult: u16` and replace the winner branch (lines 45–59):

```rust
let new_rollover: u64 = if round.block_sol[jsq] > 0 {
    let triggered = math::jackpot_triggered(&round.randomness, trigger_odds);
    // UNIT BRIDGE: rollover is ANSEM base units; stakes are lamports. Convert the
    // winning-square stake to ANSEM at THIS round's realized rate (ansem_out/pot).
    let bite = if !triggered {
        0
    } else if cap_mult == 0 {
        rollover_in
    } else {
        let stake_value_ansem =
            (round.block_sol[jsq] as u128 * ansem_out as u128) / round.pot.max(1) as u128;
        (cap_mult as u128 * stake_value_ansem).min(rollover_in as u128) as u64
    };
    round.jackpot_pool = round_leftover.checked_add(bite).ok_or(AnsemError::Overflow)?;
    rollover_in - bite
} else {
    round.jackpot_pool = 0;
    rollover_in.checked_add(round_leftover).ok_or(AnsemError::Overflow)?
};
```

`round.randomness` type must match `math::jackpot_triggered(&[u8;32], ..)` — adjust the borrow to the actual field type found in Step 1.

- [ ] **Step 4: Admin ixs** in `admin.rs` (mirror `set_return_band`'s `SetParams` context):

```rust
pub fn set_fee_bps(ctx: Context<SetParams>, fee_bps: u16) -> Result<()> {
    require!(fee_bps <= 2_000, AnsemError::BadParams); // hard ceiling 20%
    ctx.accounts.config.fee_bps = fee_bps;
    Ok(())
}
```

Plus `init_jackpot_config` (admin-gated, `init` PDA with `DEFAULT_JACKPOT_TRIGGER_ODDS`/`DEFAULT_JACKPOT_CAP_MULT`) and `set_jackpot_params(trigger_odds, cap_mult)` (admin-gated, mutates the PDA). Use the existing error variant closest to `BadParams` — check `error.rs` and reuse (add a variant only if none fits).

- [ ] **Step 5: Compile both builds** (same commands as Task 2 Step 5). **ORDERING NOTE for deploy (Task 8):** swaps fail until `init_jackpot_config` runs — the launch script must upgrade + init in one sitting.

- [ ] **Step 6: Commit** `feat(program): jackpot random trigger + bet-scaled cap; set_fee_bps dial`

---

## Task 4: Integration tests (TS, fresh validator)

**Files:**
- Modify: existing BEEF suite (find via `ls tests/ | grep -i beef`) — rewrite for the minted model
- Create: `tests/jackpot-trigger.ts`
- Modify: whichever admin-params suite covers setters — add `set_fee_bps` + `set_jackpot_params` cases

Follow the repo's existing test harness exactly (fresh `solana-test-validator -r --bpf-program ... -q`, ts-mocha, devnet-feature build, mock settle flow that injects deterministic randomness — copy the pattern from the existing direct-stake/mock suites).

- [ ] **Step 1: Rewrite the BEEF suite** to the minted model. Must assert:
  - init_beef pins mint/vault/treasury and rejects a mint whose authority ≠ vault_authority PDA
  - stamp on a 1 SOL pot mints exactly 105_000_000 total → 84_000_000 vault (`emission` on BeefRound) + 21_000_000 treasury ATA; `minted_total` and `total_owed` advance to match
  - stamp on an empty round mints 0; double-stamp fails (init guard — existing behavior)
  - roll → claim pays from the vault with the hold-to-grow bonus (existing assertions carry over)
  - cap exhaustion: set `hard_cap` low via a re-init or direct test config, stamp mints only the remainder, then 0
- [ ] **Step 2: `tests/jackpot-trigger.ts`.** Using mock-settle's deterministic randomness: craft randomness where bytes 16..24 make `draw % 25 == 0` (triggered) and `!= 0` (not). Assert:
  - non-trigger winner round: `round.jackpotPool == leftover` and `config.rolloverJackpot` unchanged
  - trigger round: bite = `min(rollover, 100 * blockSol[jsq] * ansemOut / pot)`; rollover decremented by exactly the bite
  - no-winner round: rollover grows by leftover (regression guard)
  - `set_jackpot_params(1, 0)` restores legacy full-drain behavior
- [ ] **Step 3: Fee setter test:** `set_fee_bps(500)` reflected in config; 2001 rejected; non-admin rejected.
- [ ] **Step 4: Run EVERY suite** in the repo's documented order, one validator per suite. All green, including the untouched ANSEM-path suites (the swap context change touches them — their fixtures now need `init_jackpot_config` in setup; update fixtures, not assertions).
- [ ] **Step 5: Commit** `test: minted BEEF emission + jackpot trigger/cap + fee dial`

---

## Task 5: IDL + SDK

**Files:**
- Regenerate: `packages/sdk/src/idl/ansem_miner.ts` (repo's existing IDL regen flow — find the script used by the Token-2022 conversion commit `1ab3f46`)
- Modify: `packages/sdk/src/pdas.ts` (add `jackpotConfigPda()`)
- Modify: `packages/sdk/src/instructions/admin.ts` (or wherever setters live): `setFeeBpsIx`, `initJackpotConfigIx`, `setJackpotParamsIx`, updated `initBeefIx` args
- Modify: `packages/sdk/src/instructions/player.ts` lines 92–104: `stampBeefIx` (if present here or in keeper helpers) gains `beefMint/vaultAuthority/beefTreasury/tokenProgram` accounts; `claimBeefIx` unchanged
- Modify: config/read decoders to expose `feeBps` (already), `mintedTotal`, `hardCap`, jackpot params

- [ ] **Step 1:** Regenerate IDL from the devnet-feature build; `pnpm -r build` to catch type breaks.
- [ ] **Step 2:** Add/extend builders above; keep the documented roll-ordering comment block (player.ts lines 83–91) accurate.
- [ ] **Step 3:** Run SDK unit tests if present + `pnpm -r build` green.
- [ ] **Step 4: Commit** `feat(sdk): minted-beef + jackpot + fee-dial builders, fresh IDL`

---

## Task 6: Keeper — floor auto-refresh + BEEF stamp crank + snapshot

**Files:**
- Create: `keeper/src/floor.ts`
- Modify: keeper round loop (find the settle/advance driver — likely `keeper/src/round.ts` or `index.ts`) to stamp BEEF after each settle
- Modify: `keeper/src/read/snapshot.ts` + `keeper/src/read/server.ts` consumers: add `beefPerRound` (last stamped emission), `jackpotTriggerOdds`, `jackpotCapMult`, `listingTs` (env `LISTING_TS`, optional)
- Reuse: `keeper/src/jupiter.ts` quote helper

- [ ] **Step 1: `floor.ts`** — exported `startFloorRefresh(deps)` interval loop (default every 300s, env `FLOOR_REFRESH_SECS`):

```ts
// Target: keep config.min_swap_rate at FLOOR_TARGET_BPS (default 9200 = 92%)
// of the live Jupiter ANSEM-per-SOL rate. Update only when the stored floor
// drifts outside FLOOR_DRIFT_BPS (default 500 = 5%) of target — avoids
// spamming admin txs. Rate units: ANSEM base units per 1 SOL (matches
// scripts/_mainnet-init.mjs MIN_SWAP_RATE).
export function computeFloorUpdate(marketRate: bigint, storedFloor: bigint,
  targetBps = 9200n, driftBps = 500n): bigint | null {
  const target = (marketRate * targetBps) / 10_000n;
  const lo = (target * (10_000n - driftBps)) / 10_000n;
  const hi = (target * (10_000n + driftBps)) / 10_000n;
  return storedFloor >= lo && storedFloor <= hi ? null : target;
}
```

Loop: quote 1 SOL → ANSEM via the existing jupiter module → `computeFloorUpdate` → if non-null, send `setMinSwapRate` signed by the keeper (it IS config.admin) → log old/new. Unit-test `computeFloorUpdate` (pure) in the keeper's existing test setup; if the keeper has no test rig, add a minimal `node --test` file and wire `pnpm -F keeper test`.

- [ ] **Step 2: Stamp crank.** After each round finalizes (same place the keeper already advances rounds), send `stampBeef(roundId)` for the just-settled round; swallow-and-log failures (INVARIANT: BEEF never blocks the game). Skip when BEEF config is uninitialized (probe once at boot, re-probe on failure).
- [ ] **Step 3: Snapshot fields** + serialize through `server.ts` (bigint-safe encode already exists).
- [ ] **Step 4:** Keeper builds + tests green; `docker build -f keeper/Dockerfile .` succeeds.
- [ ] **Step 5: Commit** `feat(keeper): ANSEM floor auto-refresh + beef stamp crank + snapshot fields`

---

## Task 7: App — BEEF UI + liveness + copy fix

**Files:**
- Modify: `app/src/components/VerifyPanel.tsx` — replace the "public devnet transaction" copy with network-neutral wording ("on-chain transaction")
- Modify: `app/src/components/PlayControls.tsx` — harvest bundle ordering: when claiming a round, send `[rollBeef(rid), claimDirect(rid)]` in ONE tx (rollBeef FIRST — zeroing stakes forfeits the un-rolled share; see sdk player.ts lines 83–91); same for new-round staking: `[rollBeef(prevRound), stakeDirect(...)]`
- Create: `app/src/components/BeefChip.tsx` — BEEF balance chip: `BeefMiner.unclaimed × (1 + bonusBps/10000)` live-computed, claim button sending `[rollBeef(currentStakedRound), claimBeef]`
- Create: `app/src/components/JackpotMeter.tsx` — odometer: snapshot `rolloverJackpot` (ANSEM base units) formatted + USD via a cached SOL/ANSEM rate from the keeper snapshot; "1-in-25 jackpot round" subtitle from snapshot odds
- Modify: the main HUD/page composition to mount BeefChip + JackpotMeter + 60s round countdown (deadlineTs already in snapshot) + recent-events ticker (snapshot `recentEvents`) + optional listing-countdown banner (`NEXT_PUBLIC_LISTING_TS`)

- [ ] **Step 1:** Copy fix + countdown + ticker + jackpot meter (all data already in the snapshot; no SDK dependency).
- [ ] **Step 2:** BEEF chip + claim/stake bundle ordering (needs Task 5 SDK).
- [ ] **Step 3:** `pnpm -F app build` green; verify in the browser per repo preview workflow (localhost against mainnet RPC read-only is fine for rendering).
- [ ] **Step 4: Commit** `feat(app): beef chip, jackpot meter, 60s countdown, ticker, neutral verify copy`

---

## Task 8: Ops scripts (mint, launch params, seed, listing skeleton)

**Files:**
- Create: `scripts/beef-mint-create.mjs` — classic SPL mint, 6 decimals, then `setAuthority(mint, MintTokens -> vault_authority PDA)` and `setAuthority(mint, FreezeAccount -> null)`; create the vault token account (owner = vault_authority PDA) + treasury ATA (owner = operator treasury wallet); Metaplex `createV1` metadata with name/symbol/URI from env (`BEEF_NAME`, `BEEF_SYMBOL`, `BEEF_META_URI`). Print every address.
- Create: `scripts/_beef-launch.mjs` — one-shot idempotent (mirrors `scripts/_mainnet-init.mjs` style): `initBeef(210_000_000, 1_000_000_000, 21_000_000_000_000, 2000, 3, 30000, 86400, 60)` → `initJackpotConfig()` → `setJackpotParams(25, 100)` → `setFeeBps(500)` → `setRoundDuration(60)`; prints final config.
- Create: `scripts/seed-jackpot-roll.mjs` — stake-and-roll seeding: loop N rounds staking `SEED_LAMPORTS_PER_ROUND` on one square; misses roll into the jackpot (~96% expected transfer); stops when `config.rolloverJackpot` value ≥ target. Env-driven, dry-run flag.
- Create: `scripts/meteora-list.mjs` — LIST-DAY skeleton with `--dry-run` default: create DAMM v2 custom-quote pool (base BEEF, quote ANSEM) via `@meteora-ag/cp-amm-sdk`, single-sided BEEF deposit from treasury, fee-scheduler config (verify exact SDK surface against docs.meteora.ag at build — record findings as comments), permanent-lock/burn position. MUST refuse to run without `--i-know-what-i-am-doing` when not dry-run.

- [ ] Each script: build against `@ansem/sdk`, env-validated like `_mainnet-init.mjs` (lines 15–20 pattern), commit separately: `ops: beef mint + launch + seed + listing scripts`

---

## Task 9: Ship (operator + orchestrator — NOT a worker task)

- [ ] Full test sweep green → mainnet artifact build (no devnet feature, arch v3) → `solana program deploy` upgrade → OtterSec re-verify (base image `solanafoundation/solana-verifiable-build:3.1.14`)
- [ ] Run `beef-mint-create.mjs` → `_beef-launch.mjs` (upgrade + init same sitting — swaps fail until JackpotConfig exists)
- [ ] Keeper redeploy (Railway `railway up`), app redeploy (Vercel prebuilt flow)
- [ ] Mainnet dust-round E2E: stake 0.01 → settle → BeefRound stamped → roll+claim lands BEEF in wallet; fee 5% visible in accounting
- [ ] `seed-jackpot-roll.mjs` to ~2 SOL equivalent
- [ ] Announce; LIST DAY runs `meteora-list.mjs` after operator picks the date

---

## Self-review (done at write time)

- Spec coverage: D1–D9 → Tasks 1–7; D10 → Task 8 (meteora script) + launch checklist; D11 LATER items deliberately absent; D12 partially structural (no yield code touches prize vaults — nothing to build).
- The two known traps are called out where workers will hit them: Config account size freeze (Task 3 preamble), lamports→ANSEM unit bridge (Task 3 Step 3 comment).
- Existing-suite breakage from the swap-context change is explicitly Task 4 Step 4.
