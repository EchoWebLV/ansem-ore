# BEEF Vault Emission Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a second-token ($BEEF) mining layer on top of the direct-stake engine: every round's stakers earn a pro-rata share of a vault emission, unclaimed BEEF compounds a hold-to-grow bonus (4× cap in ~1 week), and the vault can only ever pay players.

**Architecture:** All-new accounts (`BeefConfig`, `BeefMiner`, `BeefRound`) and five new instructions in a new `instructions/beef.rs` — **zero changes to `Config`, `Round`, `MinerPosition`, or any existing handler**, so no migrations and no risk to the battle-tested ANSEM path. Emission is stamped per settled round from the live vault balance (`(vault − total_owed) / divisor`), players roll their share into a persistent per-player balance, and claims pay `unclaimed × (1 + bonus)` from the vault via the existing `vault_authority` PDA. The keeper appends one best-effort stamp call after the swap; SDK gains builders; an ops script creates the (vanity-address) vault.

**Tech Stack:** Anchor 1.0.2 (Rust program), ts-mocha integration tests, vitest (keeper), @solana/spl-token, existing `@ansem/sdk` monorepo package.

---

## Design context (converged 2026-07-09, user-approved)

- **Emission rule:** each round with `pot > 0`, stamp `emission = (vault.amount − total_owed) / divisor`. Default divisor **1_800_000** = 0.2%/day of remaining scaled for an expected ~2.5× average claim multiplier (net ≈ original yearly-halving pace). All knobs admin-tunable via `set_beef_params`.
- **Who earns:** every staker of the round, pro-rata by `sum(block_stake) / round.pot`. Band-agnostic — note the **launch return band is (0,0) winner-take-all** (see `scripts/_config.mjs`), so BEEF is the only loser compensation at launch.
- **Hold-to-grow bonus:** +`tick_bps` (default 3) per `secs_per_tick` (default 60s) while `unclaimed > 0`, **paused** once `now > last_active_ts + activity_window_secs` (default 86_400 — daily-streak gate). Cap `bonus_cap_bps` = 30_000 (+300% → 4× payout, ~7 days of daily play). **Any claim resets bonus to 0.** New shares dilute the bonus by weighted average (`bonus × old/(old+new)`) so late deposits can't ride an old multiplier.
- **Solvency:** `total_owed` on `BeefConfig` tracks all outstanding liability. Stamps add the full emission; bonus ticks add `unclaimed × Δbps / 10_000` at accrual time; claims subtract the payout (saturating). Emission always divides the *free* balance, so the vault can never owe what it doesn't hold. Floor-rounding on stamps leaves a growing free dust buffer that dominates the ≤1-unit-per-accrual rounding deficit on the bonus side. Forfeited/never-rolled shares stay in `total_owed` forever — an accepted conservative soft-burn.
- **Invariant — BEEF never blocks the game:** empty/missing vault stamps emission 0; `roll_beef` no-ops (never errors) on already-rolled or round-mismatch so it can't abort a stake/claim bundle; keeper stamp is best-effort try/catch; ANSEM instructions are untouched.
- **Ordering invariant (SDK-enforced):** `roll_beef` must precede any `block_stake`-zeroing ix in a bundle — i.e. claim bundle = `[roll_beef, claim_direct(, claim_beef)]`, stake bundle = `[roll_beef(prev), stake_direct…]` — because `claim_direct` zeroes stakes and `stake_direct` re-stamps the miner to the new round.
- **Vault:** SPL token account at a **vanity `BEEF…` keypair address** (ops-side cosmetics only — tests use a plain keypair), owner = the existing `vault_authority` PDA, key discarded after creation. Mainnet fill = pump.fun dev-buy transfer (CA provided by user at init time; devnet uses a mock mint).
- **Out of scope (follow-up plans):** app UI (HUD balance, multiplier ring, harvest button), pump.fun launch script, buyback crank.

## File map

| Action | Path | Responsibility |
|---|---|---|
| Modify | `programs/ansem-miner/src/math.rs` | 6 pure BEEF math fns + unit tests |
| Modify | `programs/ansem-miner/src/constants.rs` | seeds + defaults |
| Modify | `programs/ansem-miner/src/error.rs` | `BadBeefVault`, `BadBeefParams` |
| Create | `programs/ansem-miner/src/state/beef.rs` | `BeefConfig`, `BeefMiner`, `BeefRound` |
| Modify | `programs/ansem-miner/src/state/mod.rs` | export beef state |
| Create | `programs/ansem-miner/src/instructions/beef.rs` | 5 instructions |
| Modify | `programs/ansem-miner/src/instructions/mod.rs` | export beef ixs |
| Modify | `programs/ansem-miner/src/lib.rs` | register 5 ixs |
| Create | `tests/direct-beef.ts` | integration suite |
| Modify | `packages/sdk/src/constants.ts`, `pdas.ts`, `accounts.ts`, `instructions/player.ts`, `instructions/keeper.ts` | seeds, PDAs, fetch, builders |
| Modify | `keeper/src/crank/actions.ts`, `keeper/src/service.ts` | best-effort stamp after swap |
| Modify | `keeper/test/actions.test.ts` | stamp ordering/best-effort tests |
| Create | `scripts/beef-init.mjs` | devnet vault create + init + fill |
| Modify | `docs/devnet-runbook.md` | BEEF ops section (grind, init, verify) |

**Test running note:** every suite in `tests/` calls `initialize()` and expects a fresh validator — run suites ONE FILE at a time. Pattern used throughout this plan:

```bash
# terminal 1 (leave running):
anchor localnet          # builds, starts validator, deploys the program
# terminal 2 (per suite):
ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 ANCHOR_WALLET=~/.config/solana/id.json \
  pnpm exec ts-mocha -p ./tsconfig.json -t 1000000 tests/direct-beef.ts
```

Restart `anchor localnet` (fresh validator) between different suite files.

---

### Task 1: Pure BEEF math in `math.rs`

**Files:**
- Modify: `programs/ansem-miner/src/math.rs`

- [ ] **Step 1: Write the failing unit tests**

Append inside the existing `mod tests` block at the bottom of `programs/ansem-miner/src/math.rs`:

```rust
    // ---- BEEF emission/bonus math ----

    #[test]
    fn beef_ticks_respects_activity_window() {
        // active till t=1000+100; last tick at 1000; now way past the window:
        // only the in-window 100s accrue -> 100/60 = 1 tick.
        assert_eq!(beef_ticks(5_000, 1_000, 1_000, 100, 60), 1);
        // gate open (now inside window): 120s -> 2 ticks
        assert_eq!(beef_ticks(1_120, 1_000, 1_100, 86_400, 60), 2);
        // clock going backwards / zero elapsed -> 0
        assert_eq!(beef_ticks(999, 1_000, 1_000, 86_400, 60), 0);
        // degenerate secs_per_tick -> 0 (never panics)
        assert_eq!(beef_ticks(2_000, 1_000, 1_000, 86_400, 0), 0);
    }

    #[test]
    fn beef_bonus_delta_caps() {
        assert_eq!(beef_bonus_delta(10, 3, 0, 30_000), 30);
        assert_eq!(beef_bonus_delta(1_000_000, 3, 0, 30_000), 30_000); // clamps to cap
        assert_eq!(beef_bonus_delta(10, 3, 29_990, 30_000), 10);       // clamps to headroom
        assert_eq!(beef_bonus_delta(0, 3, 100, 30_000), 0);
    }

    #[test]
    fn beef_owed_delta_floors() {
        assert_eq!(beef_owed_delta(1_000_000, 30), 3_000); // 0.3%
        assert_eq!(beef_owed_delta(3, 30), 0);             // floors to zero
    }

    #[test]
    fn beef_dilute_conserves_product() {
        // 4x bonus on 100 units, 300 new units join -> 30_000*100/400 = 7_500
        assert_eq!(beef_dilute(30_000, 100, 300), 7_500);
        assert_eq!(beef_dilute(30_000, 0, 500), 0);   // empty balance -> reset
        assert_eq!(beef_dilute(1_234, 777, 0), 1_234); // no new share -> unchanged
        assert_eq!(beef_dilute(30_000, 0, 0), 0);      // zero/zero -> 0, no panic
    }

    #[test]
    fn beef_share_is_prorata_and_floors() {
        assert_eq!(beef_share(1_000_000, 300_000_000, 400_000_000), 750_000);
        assert_eq!(beef_share(1_000_000, 0, 400_000_000), 0);
        assert_eq!(beef_share(1_000_000, 100, 0), 0); // empty pot -> 0, no panic
    }

    #[test]
    fn beef_payout_applies_bonus() {
        assert_eq!(beef_payout(1_000_000, 0), 1_000_000);
        assert_eq!(beef_payout(1_000_000, 30_000), 4_000_000); // the 4x cap
        assert_eq!(beef_payout(3, 3_333), 3);                  // floors
    }
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cargo test -p ansem-miner beef_ 2>&1 | tail -5
```
Expected: compile error — `beef_ticks` etc. not found.

- [ ] **Step 3: Implement the six functions**

Add above `mod tests` in `programs/ansem-miner/src/math.rs`:

```rust
// ---- BEEF emission/bonus math (all floors; see plan 2026-07-09-beef-vault-emission) ----

/// Bonus ticks accrued over [last_tick_ts, min(now, last_active_ts + window)],
/// one tick per `secs_per_tick`. Time past the activity window is dead (the
/// daily-streak gate); callers set last_tick_ts = now after accruing so a dead
/// gap is skipped, never re-scanned.
pub fn beef_ticks(now: i64, last_tick_ts: i64, last_active_ts: i64, window_secs: i64, secs_per_tick: i64) -> u64 {
    if secs_per_tick <= 0 {
        return 0;
    }
    let window_end = now.min(last_active_ts.saturating_add(window_secs));
    let secs = window_end.saturating_sub(last_tick_ts).max(0);
    (secs / secs_per_tick) as u64
}

/// Capped bonus increment: min(ticks * tick_bps, cap - current).
pub fn beef_bonus_delta(ticks: u64, tick_bps: u16, bonus_bps: u16, cap_bps: u16) -> u16 {
    let head = cap_bps.saturating_sub(bonus_bps) as u128;
    (ticks as u128).saturating_mul(tick_bps as u128).min(head) as u16
}

/// New liability created by a bonus increment on an unclaimed balance. Floors.
pub fn beef_owed_delta(unclaimed: u64, delta_bps: u16) -> u64 {
    ((unclaimed as u128 * delta_bps as u128) / 10_000u128) as u64
}

/// Weighted-average dilution when `share` new units join `unclaimed` held at
/// `bonus`: bonus' = bonus * unclaimed / (unclaimed + share). Conserves the
/// unclaimed*bonus product (floored DOWN — the solvency-safe direction), so a
/// late deposit can never ride an old multiplier.
pub fn beef_dilute(bonus_bps: u16, unclaimed: u64, share: u64) -> u16 {
    let total = unclaimed as u128 + share as u128;
    if total == 0 {
        return 0;
    }
    ((bonus_bps as u128 * unclaimed as u128) / total) as u16
}

/// Player's slice of a round's stamped emission = emission * stake / pot. Floors.
pub fn beef_share(emission: u64, stake_sum: u64, pot: u64) -> u64 {
    if pot == 0 {
        return 0;
    }
    ((emission as u128 * stake_sum as u128) / pot as u128) as u64
}

/// Claim payout = unclaimed * (10_000 + bonus) / 10_000. Floors.
pub fn beef_payout(unclaimed: u64, bonus_bps: u16) -> u64 {
    ((unclaimed as u128 * (10_000u128 + bonus_bps as u128)) / 10_000u128) as u64
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cargo test -p ansem-miner 2>&1 | tail -5
```
Expected: all tests pass (existing 6 + new 6).

- [ ] **Step 5: Commit**

```bash
git add programs/ansem-miner/src/math.rs
git commit -m "feat(program): pure BEEF emission/bonus math (ticks, cap, dilution, owed, share, payout)"
```

---

### Task 2: Constants, errors, and state accounts

**Files:**
- Modify: `programs/ansem-miner/src/constants.rs`
- Modify: `programs/ansem-miner/src/error.rs`
- Create: `programs/ansem-miner/src/state/beef.rs`
- Modify: `programs/ansem-miner/src/state/mod.rs`

- [ ] **Step 1: Add constants**

Append to `programs/ansem-miner/src/constants.rs`:

```rust
// ---- BEEF vault emission layer (plan 2026-07-09-beef-vault-emission) ----
pub const BEEF_CONFIG_SEED: &[u8] = b"beef_config";
pub const BEEF_MINER_SEED: &[u8] = b"beef_miner";
pub const BEEF_ROUND_SEED: &[u8] = b"beef_round";

// Emission divisor: emission_per_round = free_vault / divisor. 720_000 would be
// 0.2%/day (yearly halving) at 60s rounds; 1_800_000 pre-scales for the expected
// ~2.5x average hold-to-grow claim multiplier so NET drain stays on that curve.
pub const DEFAULT_BEEF_DIVISOR: u64 = 1_800_000;
pub const DEFAULT_BEEF_TICK_BPS: u16 = 3; // +0.03% per tick while held
pub const DEFAULT_BEEF_BONUS_CAP_BPS: u16 = 30_000; // +300% -> 4x payout, ~7 days
pub const DEFAULT_BEEF_ACTIVITY_WINDOW_SECS: i64 = 86_400; // daily-streak gate
pub const DEFAULT_BEEF_SECS_PER_TICK: i64 = 60; // one tick per round-length
```

- [ ] **Step 2: Add errors**

Append two variants inside `pub enum AnsemError` in `programs/ansem-miner/src/error.rs`:

```rust
    #[msg("Beef vault token account has wrong owner or mint")] BadBeefVault,
    #[msg("Invalid beef params (divisor and secs_per_tick must be > 0)")] BadBeefParams,
```

- [ ] **Step 3: Create the state file**

Create `programs/ansem-miner/src/state/beef.rs`:

```rust
use anchor_lang::prelude::*;

// BEEF vault emission layer. All-new accounts — Config/Round/MinerPosition are
// deliberately untouched (zero migrations; the ANSEM path cannot be affected).

#[account]
#[derive(InitSpace)]
pub struct BeefConfig {
    pub beef_mint: Pubkey,
    /// SPL token account holding the emission supply. Owner = the existing
    /// vault_authority PDA. Ops-side this sits at a vanity BEEF... address;
    /// the program only cares that this pubkey matches.
    pub beef_vault: Pubkey,
    /// emission_per_round = free_vault / divisor (free = vault - total_owed).
    pub divisor: u64,
    pub tick_bps: u16,
    pub bonus_cap_bps: u16,
    pub activity_window_secs: i64,
    pub secs_per_tick: i64,
    /// Solvency ledger: every stamped emission and accrued bonus is recognized
    /// here the moment it becomes claimable; claims subtract their payout.
    /// free_vault = vault.amount - total_owed can never go negative-spendable.
    pub total_owed: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct BeefMiner {
    pub authority: Pubkey,
    /// Rolled-in, not-yet-claimed BEEF (base units).
    pub unclaimed: u64,
    /// Hold-to-grow bonus in bps (0..=cap). Payout = unclaimed*(10000+bonus)/10000.
    pub bonus_bps: u16,
    /// Accrual cursor: ticks are counted from here; every touch sets it to now
    /// (dead gate-closed gaps are skipped, never re-scanned).
    pub last_tick_ts: i64,
    /// Last stake-accompanied touch (roll_beef). The activity gate: ticks stop
    /// accruing past last_active_ts + activity_window_secs.
    pub last_active_ts: i64,
    /// Monotonic double-roll guard (rounds are strictly increasing and a
    /// MinerPosition only ever holds one round at a time).
    pub last_rolled_round_id: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct BeefRound {
    pub round_id: u64,
    /// Frozen at stamp time (order-independent claims, same pattern as
    /// Round.jackpot_pool). Shares divide this against Round.pot.
    pub emission: u64,
    pub bump: u8,
}
```

- [ ] **Step 4: Export from the state module**

`programs/ansem-miner/src/state/mod.rs` becomes:

```rust
pub mod config;
pub mod round;
pub mod miner;
pub mod escrow;
pub mod beef;

pub use config::*;
pub use round::*;
pub use miner::*;
pub use escrow::*;
pub use beef::*;
```

- [ ] **Step 5: Verify it compiles**

```bash
cargo check -p ansem-miner 2>&1 | tail -3
```
Expected: `Finished` with no errors (warnings about unused types are fine at this stage).

- [ ] **Step 6: Commit**

```bash
git add programs/ansem-miner/src/constants.rs programs/ansem-miner/src/error.rs programs/ansem-miner/src/state/
git commit -m "feat(program): BEEF state accounts (BeefConfig/BeefMiner/BeefRound), seeds, defaults"
```

---

### Task 3: `init_beef` + `set_beef_params` instructions

**Files:**
- Create: `programs/ansem-miner/src/instructions/beef.rs`
- Modify: `programs/ansem-miner/src/instructions/mod.rs`
- Modify: `programs/ansem-miner/src/lib.rs`
- Create: `tests/direct-beef.ts`

- [ ] **Step 1: Create `instructions/beef.rs` with the admin ixs**

Create `programs/ansem-miner/src/instructions/beef.rs`:

```rust
use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer as TokenTransfer};

use crate::constants::*;
use crate::error::AnsemError;
use crate::math;
use crate::state::{BeefConfig, BeefMiner, BeefRound, Config, MinerPosition, Round, STATE_CLAIMABLE};

// BEEF vault emission layer (plan 2026-07-09-beef-vault-emission).
//
// INVARIANT — BEEF never blocks the game: an empty/missing vault stamps
// emission 0; roll_beef no-ops (never errors) on already-rolled / round-
// mismatch so it can't abort a stake or claim bundle; every ANSEM
// instruction is untouched and takes no BEEF accounts.
//
// ORDERING (SDK-enforced): roll_beef must precede any block_stake-zeroing ix
// in a bundle — claim_direct zeroes stakes, stake_direct re-stamps the miner.

fn validate_params(divisor: u64, secs_per_tick: i64) -> Result<()> {
    require!(divisor > 0 && secs_per_tick > 0, AnsemError::BadBeefParams);
    Ok(())
}

#[derive(Accounts)]
pub struct InitBeef<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.config_bump,
        constraint = config.admin == admin.key() @ AnsemError::Unauthorized)]
    pub config: Box<Account<'info, Config>>,

    pub beef_mint: Box<Account<'info, Mint>>,

    /// CHECK: existing payout vault authority PDA — reused as the BEEF vault owner.
    #[account(seeds = [VAULT_AUTH_SEED], bump = config.vault_auth_bump)]
    pub vault_authority: UncheckedAccount<'info>,

    // The (vanity-address) token account that IS the vault. Created off-chain by
    // ops (scripts/beef-init.mjs); the program only pins mint + owner here, then
    // trusts the stored pubkey everywhere else.
    #[account(
        constraint = beef_vault.mint == beef_mint.key() @ AnsemError::BadBeefVault,
        constraint = beef_vault.owner == vault_authority.key() @ AnsemError::BadBeefVault,
    )]
    pub beef_vault: Box<Account<'info, TokenAccount>>,

    #[account(init, payer = admin, space = 8 + BeefConfig::INIT_SPACE,
        seeds = [BEEF_CONFIG_SEED], bump)]
    pub beef_config: Box<Account<'info, BeefConfig>>,

    pub system_program: Program<'info, System>,
}

pub fn init_beef_handler(
    ctx: Context<InitBeef>,
    divisor: u64,
    tick_bps: u16,
    bonus_cap_bps: u16,
    activity_window_secs: i64,
    secs_per_tick: i64,
) -> Result<()> {
    validate_params(divisor, secs_per_tick)?;
    let bc = &mut ctx.accounts.beef_config;
    bc.beef_mint = ctx.accounts.beef_mint.key();
    bc.beef_vault = ctx.accounts.beef_vault.key();
    bc.divisor = divisor;
    bc.tick_bps = tick_bps;
    bc.bonus_cap_bps = bonus_cap_bps;
    bc.activity_window_secs = activity_window_secs;
    bc.secs_per_tick = secs_per_tick;
    bc.total_owed = 0;
    bc.bump = ctx.bumps.beef_config;
    Ok(())
}

#[derive(Accounts)]
pub struct SetBeefParams<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.config_bump,
        constraint = config.admin == admin.key() @ AnsemError::Unauthorized)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [BEEF_CONFIG_SEED], bump = beef_config.bump)]
    pub beef_config: Box<Account<'info, BeefConfig>>,
}

/// The tuning knob promised in the design: launch conservative, adjust with
/// data. Cannot change mint/vault (those are pinned at init).
pub fn set_beef_params_handler(
    ctx: Context<SetBeefParams>,
    divisor: u64,
    tick_bps: u16,
    bonus_cap_bps: u16,
    activity_window_secs: i64,
    secs_per_tick: i64,
) -> Result<()> {
    validate_params(divisor, secs_per_tick)?;
    let bc = &mut ctx.accounts.beef_config;
    bc.divisor = divisor;
    bc.tick_bps = tick_bps;
    bc.bonus_cap_bps = bonus_cap_bps;
    bc.activity_window_secs = activity_window_secs;
    bc.secs_per_tick = secs_per_tick;
    Ok(())
}
```

- [ ] **Step 2: Export the module and register the ixs**

In `programs/ansem-miner/src/instructions/mod.rs`, add (matching the existing `pub mod` / `pub use` lines):

```rust
pub mod beef;
pub use beef::*;
```

In `programs/ansem-miner/src/lib.rs`, add inside `pub mod ansem_miner` after the direct-stake block:

```rust
    // ---- BEEF vault emission layer: per-round vault emission to all stakers,
    // hold-to-grow bonus. All-new accounts; the ANSEM path takes no BEEF
    // accounts and cannot be blocked by this layer. ----
    pub fn init_beef(
        ctx: Context<InitBeef>, divisor: u64, tick_bps: u16, bonus_cap_bps: u16,
        activity_window_secs: i64, secs_per_tick: i64,
    ) -> Result<()> {
        instructions::beef::init_beef_handler(ctx, divisor, tick_bps, bonus_cap_bps, activity_window_secs, secs_per_tick)
    }

    pub fn set_beef_params(
        ctx: Context<SetBeefParams>, divisor: u64, tick_bps: u16, bonus_cap_bps: u16,
        activity_window_secs: i64, secs_per_tick: i64,
    ) -> Result<()> {
        instructions::beef::set_beef_params_handler(ctx, divisor, tick_bps, bonus_cap_bps, activity_window_secs, secs_per_tick)
    }
```

- [ ] **Step 3: Build**

```bash
anchor build 2>&1 | tail -3
```
Expected: success. (Gotcha from project memory: if building in a fresh worktree and artifacts are missing with exit 0, copy the canonical program keypair — see `anchor-solana-gotchas` memory.)

- [ ] **Step 4: Write the failing integration test (suite bootstrap + init)**

Create `tests/direct-beef.ts`:

```typescript
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { AnsemMiner } from "../target/types/ansem_miner";
import { PublicKey, Keypair, Transaction } from "@solana/web3.js";
import { assert } from "chai";
import { createMint, createAccount, mintTo, getAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";

const enc = (s: string) => Buffer.from(s);
const u64le = (n: number) => new anchor.BN(n).toArrayLike(Buffer, "le", 8);

// BEEF vault emission layer suite. Fresh local validator; tolerant initialize
// so it can share a validator with another suite if needed. FAST bonus params
// (secs_per_tick = 1) so hold-to-grow is testable in wall-clock seconds.
describe("beef vault emission", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.AnsemMiner as Program<AnsemMiner>;
  const admin = provider.wallet as anchor.Wallet;

  const [configPda] = PublicKey.findProgramAddressSync([enc("config")], program.programId);
  const [ansemMint] = PublicKey.findProgramAddressSync([enc("ansem_mint")], program.programId);
  const [potVault] = PublicKey.findProgramAddressSync([enc("pot_vault")], program.programId);
  const [vaultAuth] = PublicKey.findProgramAddressSync([enc("vault_auth")], program.programId);
  const [mintAuth] = PublicKey.findProgramAddressSync([enc("mint_auth")], program.programId);
  const [treasury] = PublicKey.findProgramAddressSync([enc("treasury")], program.programId);
  const [beefConfigPda] = PublicKey.findProgramAddressSync([enc("beef_config")], program.programId);
  const payoutVault = getAssociatedTokenAddressSync(ansemMint, vaultAuth, true);
  const minerOf = (pk: PublicKey) =>
    PublicKey.findProgramAddressSync([enc("miner"), pk.toBuffer()], program.programId)[0];
  const beefMinerOf = (pk: PublicKey) =>
    PublicKey.findProgramAddressSync([enc("beef_miner"), pk.toBuffer()], program.programId)[0];
  const beefRoundOf = (id: number) =>
    PublicKey.findProgramAddressSync([enc("beef_round"), u64le(id)], program.programId)[0];

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const STAKE_WINDOW = 15;

  let beefMint: PublicKey;
  const beefVaultKp = Keypair.generate(); // vanity grinding is ops-side cosmetics only
  let beefVault: PublicKey;

  // Test params: 1s ticks so bonuses accrue in-test. tick=1000bps/s, cap 30_000.
  const DIVISOR = 1000;
  const TICK_BPS = 1000;
  const CAP_BPS = 30_000;
  const WINDOW = 86_400;
  const SECS_PER_TICK = 1;
  const VAULT_FILL = 1_000_000_000; // 1000 BEEF @6dp -> first emission = 1_000_000

  async function freshRound(durationSecs = 0): Promise<{ id: number; pda: PublicKey }> {
    await program.methods.setRoundDuration(new anchor.BN(durationSecs)).accounts({ admin: admin.publicKey }).rpc();
    const before = await program.account.config.fetch(configPda);
    const nextId = before.currentRoundId.toNumber() + 1;
    const [pda] = PublicKey.findProgramAddressSync([enc("round"), u64le(nextId)], program.programId);
    await program.methods.createRound().accounts({ payer: admin.publicKey, round: pda }).rpc();
    return { id: nextId, pda };
  }

  async function settleAfterDeadline(roundPda: PublicKey, rnd: Buffer) {
    for (let i = 0; i < 40; i++) {
      try {
        await program.methods.settle([...rnd]).accounts({ admin: admin.publicKey, round: roundPda }).rpc();
        return;
      } catch (e: any) {
        if (!e.toString().includes("RoundNotEnded")) throw e;
        await sleep(1000);
      }
    }
    throw new Error("round never became settleable");
  }

  const swapAccounts = (roundPda: PublicKey) => ({
    payer: admin.publicKey, round: roundPda, ansemMint,
    mintAuthority: mintAuth, vaultAuthority: vaultAuth, payoutVault, potVault, treasury,
  });
  const stakeDirectAccts = (pk: PublicKey, roundPda: PublicKey) => ({
    authority: pk, config: configPda, round: roundPda, miner: minerOf(pk), potVault,
  });
  async function fundedPlayer(sol = 3): Promise<Keypair> {
    const kp = Keypair.generate();
    const sig = await provider.connection.requestAirdrop(kp.publicKey, sol * anchor.web3.LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(sig);
    return kp;
  }

  it("bootstraps: initialize (tolerant) + mock BEEF mint + vault owned by vault_authority", async () => {
    try {
      await program.methods.initialize().accounts({ admin: admin.publicKey }).rpc();
    } catch (e: any) {
      if (!/already in use/.test(e.toString())) throw e;
    }
    beefMint = await createMint(provider.connection, admin.payer, admin.publicKey, null, 6);
    beefVault = await createAccount(provider.connection, admin.payer, beefMint, vaultAuth, beefVaultKp);
    await mintTo(provider.connection, admin.payer, beefMint, beefVault, admin.payer, VAULT_FILL);
    const v = await getAccount(provider.connection, beefVault);
    assert.equal(v.owner.toBase58(), vaultAuth.toBase58());
    assert.equal(Number(v.amount), VAULT_FILL);
  });

  it("init_beef pins mint+vault and stores params; wrong-owner vault is rejected", async () => {
    // wrong owner -> BadBeefVault
    const bogus = await createAccount(provider.connection, admin.payer, beefMint, admin.publicKey, Keypair.generate());
    try {
      await program.methods.initBeef(new anchor.BN(DIVISOR), TICK_BPS, CAP_BPS, new anchor.BN(WINDOW), new anchor.BN(SECS_PER_TICK))
        .accounts({ admin: admin.publicKey, beefMint, vaultAuthority: vaultAuth, beefVault: bogus }).rpc();
      assert.fail("should reject vault not owned by vault_authority");
    } catch (e: any) { assert.include(e.toString(), "BadBeefVault"); }

    await program.methods.initBeef(new anchor.BN(DIVISOR), TICK_BPS, CAP_BPS, new anchor.BN(WINDOW), new anchor.BN(SECS_PER_TICK))
      .accounts({ admin: admin.publicKey, beefMint, vaultAuthority: vaultAuth, beefVault }).rpc();
    const bc = await program.account.beefConfig.fetch(beefConfigPda);
    assert.equal(bc.beefVault.toBase58(), beefVault.toBase58());
    assert.equal(bc.divisor.toNumber(), DIVISOR);
    assert.equal(bc.totalOwed.toNumber(), 0);
  });

  it("set_beef_params tunes knobs (admin-gated)", async () => {
    await program.methods.setBeefParams(new anchor.BN(DIVISOR), TICK_BPS, CAP_BPS, new anchor.BN(WINDOW), new anchor.BN(SECS_PER_TICK))
      .accounts({ admin: admin.publicKey, config: configPda, beefConfig: beefConfigPda }).rpc();
    const outsider = await fundedPlayer(1);
    try {
      await program.methods.setBeefParams(new anchor.BN(1), 1, 1, new anchor.BN(1), new anchor.BN(1))
        .accounts({ admin: outsider.publicKey, config: configPda, beefConfig: beefConfigPda })
        .signers([outsider]).rpc();
      assert.fail("non-admin must not set params");
    } catch (e: any) { assert.include(e.toString(), "Unauthorized"); }
  });
});
```

- [ ] **Step 5: Run — all three tests green**

Restart `anchor localnet` (fresh validator with the new build), then:

```bash
ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 ANCHOR_WALLET=~/.config/solana/id.json \
  pnpm exec ts-mocha -p ./tsconfig.json -t 1000000 tests/direct-beef.ts
```
Expected: 3 passing. (Per-instruction test helpers — `stampAccts`, `rollAccts`, `claimBeefAccts`, `playRound` — are introduced in Tasks 4–6 alongside the instructions they exercise, so every task checkpoint compiles green.)

- [ ] **Step 6: Commit**

```bash
git add programs/ansem-miner/src/instructions/beef.rs programs/ansem-miner/src/instructions/mod.rs programs/ansem-miner/src/lib.rs tests/direct-beef.ts
git commit -m "feat(program): init_beef + set_beef_params (vault pinning, tunable knobs) + suite bootstrap"
```

---

### Task 4: `stamp_beef` — freeze a round's emission

**Files:**
- Modify: `programs/ansem-miner/src/instructions/beef.rs`
- Modify: `programs/ansem-miner/src/lib.rs`
- Modify: `tests/direct-beef.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/direct-beef.ts` inside the describe block — first the stamp helper this task's ix needs, then the tests:

```typescript
  const stampAccts = (roundId: number, roundPda: PublicKey) => ({
    payer: admin.publicKey, config: configPda, round: roundPda,
    beefConfig: beefConfigPda, beefVault, beefRound: beefRoundOf(roundId),
  });

  let p1: Keypair, p2: Keypair;
  let round1: { id: number; pda: PublicKey };
  const P1_STAKE = 300_000_000;
  const P2_STAKE = 100_000_000;

  it("stamp_beef freezes emission = free_vault/divisor and recognizes the liability", async () => {
    p1 = await fundedPlayer();
    p2 = await fundedPlayer();
    round1 = await freshRound(STAKE_WINDOW);
    await program.methods.stakeDirect(new anchor.BN(round1.id), 3, new anchor.BN(P1_STAKE))
      .accounts(stakeDirectAccts(p1.publicKey, round1.pda)).signers([p1]).rpc();
    await program.methods.stakeDirect(new anchor.BN(round1.id), 7, new anchor.BN(P2_STAKE))
      .accounts(stakeDirectAccts(p2.publicKey, round1.pda)).signers([p2]).rpc();

    // pre-CLAIMABLE stamp must fail
    try {
      await program.methods.stampBeef(new anchor.BN(round1.id)).accounts(stampAccts(round1.id, round1.pda)).rpc();
      assert.fail("stamp before swap must fail");
    } catch (e: any) { assert.include(e.toString(), "BadRoundState"); }

    await settleAfterDeadline(round1.pda, Buffer.alloc(32, 7));
    await program.methods.executeSwapMock().accounts(swapAccounts(round1.pda)).rpc();
    await program.methods.stampBeef(new anchor.BN(round1.id)).accounts(stampAccts(round1.id, round1.pda)).rpc();

    const br = await program.account.beefRound.fetch(beefRoundOf(round1.id));
    assert.equal(br.emission.toNumber(), VAULT_FILL / DIVISOR); // 1_000_000
    const bc = await program.account.beefConfig.fetch(beefConfigPda);
    assert.equal(bc.totalOwed.toNumber(), VAULT_FILL / DIVISOR);

    // double-stamp: BeefRound is `init` -> second call fails at account level
    try {
      await program.methods.stampBeef(new anchor.BN(round1.id)).accounts(stampAccts(round1.id, round1.pda)).rpc();
      assert.fail("double stamp must fail");
    } catch (e: any) { assert.include(e.toString(), "already in use"); }
  });

  it("stamp_beef rejects a non-current round (anti retro-stamp grief)", async () => {
    // round1 is claimable but a NEWER round must exist for this test; open one,
    // then try stamping round1 again under a fresh BeefRound id — blocked by
    // the current_round_id gate before the init even matters.
    const r2 = await freshRound(STAKE_WINDOW);
    // (round1 already has a BeefRound; use a synthetic old id that never existed)
    const ghostId = round1.id - 1 > 0 ? round1.id - 1 : round1.id; // guaranteed < r2.id
    const [ghostPda] = PublicKey.findProgramAddressSync([enc("round"), u64le(ghostId)], program.programId);
    const ghostInfo = await provider.connection.getAccountInfo(ghostPda);
    if (ghostInfo) {
      try {
        await program.methods.stampBeef(new anchor.BN(ghostId)).accounts(stampAccts(ghostId, ghostPda)).rpc();
        assert.fail("stamping an old round must fail");
      } catch (e: any) { assert.include(e.toString(), "NotCurrentRound"); }
    }
    // leave r2 open for the roll tests? No — finish it clean with zero stakes:
    await settleAfterDeadline(r2.pda, Buffer.alloc(32, 3));
    await program.methods.executeSwapMock().accounts(swapAccounts(r2.pda)).rpc();
    await program.methods.stampBeef(new anchor.BN(r2.id)).accounts(stampAccts(r2.id, r2.pda)).rpc();
    // empty pot -> emission 0, owed unchanged
    const br = await program.account.beefRound.fetch(beefRoundOf(r2.id));
    assert.equal(br.emission.toNumber(), 0);
  });
```

> Caveat for the executor: this zero-stake leg assumes `executeSwapMock` accepts a `pot == 0` round (fee 0, proceeds 0). If `swap.rs` rejects empty rounds, an empty pot can never reach CLAIMABLE — the `round.pot == 0` branch in `stamp_beef` is then unreachable belt-and-braces: keep the branch, but replace this test leg with a dust-stake round asserting `emission > 0` and delete the `emission == 0` assertion.

- [ ] **Step 2: Run to verify failure**

```bash
ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 ANCHOR_WALLET=~/.config/solana/id.json \
  pnpm exec ts-mocha -p ./tsconfig.json -t 1000000 tests/direct-beef.ts
```
Expected: TS compile failure (`stampBeef` missing).

- [ ] **Step 3: Implement the instruction**

Append to `programs/ansem-miner/src/instructions/beef.rs`:

```rust
#[derive(Accounts)]
#[instruction(round_id: u64)]
pub struct StampBeef<'info> {
    // Permissionless: the payer just funds BeefRound rent. Emission math is
    // deterministic from frozen round + live vault state; a griefing deposit
    // into the vault only ever RAISES the players' emission.
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.config_bump)]
    pub config: Box<Account<'info, Config>>,

    #[account(seeds = [ROUND_SEED, round_id.to_le_bytes().as_ref()], bump = round.bump,
        constraint = round.round_id == round_id @ AnsemError::MinerRoundMismatch)]
    pub round: Box<Account<'info, Round>>,

    #[account(mut, seeds = [BEEF_CONFIG_SEED], bump = beef_config.bump)]
    pub beef_config: Box<Account<'info, BeefConfig>>,

    #[account(address = beef_config.beef_vault @ AnsemError::BadBeefVault)]
    pub beef_vault: Box<Account<'info, TokenAccount>>,

    // `init` (not init_if_needed) = the once-only stamp guard.
    #[account(init, payer = payer, space = 8 + BeefRound::INIT_SPACE,
        seeds = [BEEF_ROUND_SEED, round_id.to_le_bytes().as_ref()], bump)]
    pub beef_round: Box<Account<'info, BeefRound>>,

    pub system_program: Program<'info, System>,
}

pub fn stamp_beef_handler(ctx: Context<StampBeef>, round_id: u64) -> Result<()> {
    let round = &ctx.accounts.round;
    require!(round.state == STATE_CLAIMABLE, AnsemError::BadRoundState);
    // Only the newest round is stampable: an abandoned old round can never be
    // retro-stamped into a permanent total_owed leak (its shares would be
    // unrollable — every MinerPosition has moved on).
    require!(
        round_id == ctx.accounts.config.current_round_id,
        AnsemError::NotCurrentRound
    );

    let bc = &mut ctx.accounts.beef_config;
    let free = ctx.accounts.beef_vault.amount.saturating_sub(bc.total_owed);
    // Empty rounds emit nothing (a quiet night never drains the vault).
    let emission = if round.pot == 0 { 0 } else { free / bc.divisor };

    let br = &mut ctx.accounts.beef_round;
    br.round_id = round_id;
    br.emission = emission;
    br.bump = ctx.bumps.beef_round;

    bc.total_owed = bc.total_owed.checked_add(emission).ok_or(AnsemError::Overflow)?;
    Ok(())
}
```

Register in `programs/ansem-miner/src/lib.rs` (after `set_beef_params`):

```rust
    pub fn stamp_beef(ctx: Context<StampBeef>, round_id: u64) -> Result<()> {
        instructions::beef::stamp_beef_handler(ctx, round_id)
    }
```

- [ ] **Step 4: Build, redeploy, run the suite**

```bash
anchor build 2>&1 | tail -3
# restart `anchor localnet` in terminal 1 (fresh validator + deploy), then:
ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 ANCHOR_WALLET=~/.config/solana/id.json \
  pnpm exec ts-mocha -p ./tsconfig.json -t 1000000 tests/direct-beef.ts
```
Expected: all tests so far PASS.

- [ ] **Step 5: Commit**

```bash
git add programs/ansem-miner/src/instructions/beef.rs programs/ansem-miner/src/lib.rs tests/direct-beef.ts
git commit -m "feat(program): stamp_beef — once-only per-round emission freeze with total_owed solvency ledger"
```

---

### Task 5: `roll_beef` — pro-rata share into the persistent miner

**Files:**
- Modify: `programs/ansem-miner/src/instructions/beef.rs`
- Modify: `programs/ansem-miner/src/lib.rs`
- Modify: `tests/direct-beef.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/direct-beef.ts` — the roll helper, the full-lifecycle helper, then the tests:

```typescript
  const rollAccts = (pk: PublicKey, roundId: number, roundPda: PublicKey) => ({
    authority: pk, round: roundPda, miner: minerOf(pk), beefRound: beefRoundOf(roundId),
    beefConfig: beefConfigPda, beefMiner: beefMinerOf(pk),
  });

  // Full stake -> settle -> swap -> stamp lifecycle used by later tests.
  async function playRound(stakes: Array<{ kp: Keypair; square: number; amount: number }>) {
    const round = await freshRound(STAKE_WINDOW);
    for (const s of stakes) {
      await program.methods.stakeDirect(new anchor.BN(round.id), s.square, new anchor.BN(s.amount))
        .accounts(stakeDirectAccts(s.kp.publicKey, round.pda)).signers([s.kp]).rpc();
    }
    await settleAfterDeadline(round.pda, Buffer.alloc(32, 9));
    await program.methods.executeSwapMock().accounts(swapAccounts(round.pda)).rpc();
    await program.methods.stampBeef(new anchor.BN(round.id)).accounts(stampAccts(round.id, round.pda)).rpc();
    return round;
  }

  it("roll_beef credits pro-rata shares; second roll is a no-op (never an error)", async () => {
    await program.methods.rollBeef(new anchor.BN(round1.id))
      .accounts(rollAccts(p1.publicKey, round1.id, round1.pda)).signers([p1]).rpc();
    await program.methods.rollBeef(new anchor.BN(round1.id))
      .accounts(rollAccts(p2.publicKey, round1.id, round1.pda)).signers([p2]).rpc();

    const emission = VAULT_FILL / DIVISOR; // 1_000_000
    const bm1 = await program.account.beefMiner.fetch(beefMinerOf(p1.publicKey));
    const bm2 = await program.account.beefMiner.fetch(beefMinerOf(p2.publicKey));
    assert.equal(bm1.unclaimed.toNumber(), (emission * P1_STAKE) / (P1_STAKE + P2_STAKE)); // 750_000
    assert.equal(bm2.unclaimed.toNumber(), (emission * P2_STAKE) / (P1_STAKE + P2_STAKE)); // 250_000
    assert.equal(bm1.lastRolledRoundId.toNumber(), round1.id);

    // idempotent: second roll changes nothing and does NOT throw (bundle safety)
    await program.methods.rollBeef(new anchor.BN(round1.id))
      .accounts(rollAccts(p1.publicKey, round1.id, round1.pda)).signers([p1]).rpc();
    const again = await program.account.beefMiner.fetch(beefMinerOf(p1.publicKey));
    assert.equal(again.unclaimed.toNumber(), bm1.unclaimed.toNumber());
  });

  it("bundle order [roll_beef, claim_direct] in ONE tx preserves the BEEF share", async () => {
    const p3 = await fundedPlayer();
    const r = await playRound([{ kp: p3, square: 5, amount: 200_000_000 }]);
    const p3Ata = getAssociatedTokenAddressSync(ansemMint, p3.publicKey);

    const rollIx = await program.methods.rollBeef(new anchor.BN(r.id))
      .accounts(rollAccts(p3.publicKey, r.id, r.pda)).instruction();
    const claimIx = await program.methods.claimDirect(new anchor.BN(r.id))
      .accounts({ authority: p3.publicKey, config: configPda, round: r.pda, miner: minerOf(p3.publicKey),
        ansemMint, vaultAuthority: vaultAuth, payoutVault, playerAta: p3Ata }).instruction();
    await provider.sendAndConfirm(new Transaction().add(rollIx, claimIx), [p3]);

    const bm = await program.account.beefMiner.fetch(beefMinerOf(p3.publicKey));
    assert.isAbove(bm.unclaimed.toNumber(), 0); // share survived the zeroing claim
    // and the miner's stakes are zeroed by claim_direct as before
    const m = await program.account.minerPosition.fetch(minerOf(p3.publicKey));
    assert.equal(m.blockStake.reduce((a: number, b: any) => a + b.toNumber(), 0), 0);
  });

  it("roll after ANSEM-claim-first rolls ZERO (stakes gone) — documented forfeit, still no error", async () => {
    const p4 = await fundedPlayer();
    const r = await playRound([{ kp: p4, square: 1, amount: 150_000_000 }]);
    const p4Ata = getAssociatedTokenAddressSync(ansemMint, p4.publicKey);
    await program.methods.claimDirect(new anchor.BN(r.id))
      .accounts({ authority: p4.publicKey, config: configPda, round: r.pda, miner: minerOf(p4.publicKey),
        ansemMint, vaultAuthority: vaultAuth, payoutVault, playerAta: p4Ata }).signers([p4]).rpc();
    await program.methods.rollBeef(new anchor.BN(r.id))
      .accounts(rollAccts(p4.publicKey, r.id, r.pda)).signers([p4]).rpc();
    const bm = await program.account.beefMiner.fetch(beefMinerOf(p4.publicKey));
    assert.equal(bm.unclaimed.toNumber(), 0);
  });
```

- [ ] **Step 2: Run to verify failure**

Same ts-mocha command. Expected: TS compile failure (`rollBeef` missing).

- [ ] **Step 3: Implement**

Append to `programs/ansem-miner/src/instructions/beef.rs`:

```rust
#[derive(Accounts)]
#[instruction(round_id: u64)]
pub struct RollBeef<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(seeds = [ROUND_SEED, round_id.to_le_bytes().as_ref()], bump = round.bump,
        constraint = round.round_id == round_id @ AnsemError::MinerRoundMismatch)]
    pub round: Box<Account<'info, Round>>,

    // READ-ONLY: roll never mutates the ANSEM-path position.
    #[account(seeds = [MINER_SEED, authority.key().as_ref()], bump = miner.bump,
        constraint = miner.authority == authority.key() @ AnsemError::Unauthorized)]
    pub miner: Box<Account<'info, MinerPosition>>,

    #[account(seeds = [BEEF_ROUND_SEED, round_id.to_le_bytes().as_ref()], bump = beef_round.bump)]
    pub beef_round: Box<Account<'info, BeefRound>>,

    #[account(mut, seeds = [BEEF_CONFIG_SEED], bump = beef_config.bump)]
    pub beef_config: Box<Account<'info, BeefConfig>>,

    #[account(init_if_needed, payer = authority, space = 8 + BeefMiner::INIT_SPACE,
        seeds = [BEEF_MINER_SEED, authority.key().as_ref()], bump)]
    pub beef_miner: Box<Account<'info, BeefMiner>>,

    pub system_program: Program<'info, System>,
}

/// Accrue the hold-to-grow bonus up to `now`, recognizing the new liability.
/// Shared by roll (before dilution) and claim (before payout). Always sets
/// last_tick_ts = now so gate-closed dead time is skipped, never re-scanned.
fn accrue_bonus(bm: &mut BeefMiner, bc: &mut BeefConfig, now: i64) -> Result<()> {
    let ticks = math::beef_ticks(now, bm.last_tick_ts, bm.last_active_ts, bc.activity_window_secs, bc.secs_per_tick);
    let delta = math::beef_bonus_delta(ticks, bc.tick_bps, bm.bonus_bps, bc.bonus_cap_bps);
    if delta > 0 {
        let owed = math::beef_owed_delta(bm.unclaimed, delta);
        bm.bonus_bps += delta; // safe: beef_bonus_delta clamps to cap headroom
        bc.total_owed = bc.total_owed.checked_add(owed).ok_or(AnsemError::Overflow)?;
    }
    bm.last_tick_ts = now;
    Ok(())
}

pub fn roll_beef_handler(ctx: Context<RollBeef>, round_id: u64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let bm = &mut ctx.accounts.beef_miner;
    if bm.authority == Pubkey::default() {
        bm.authority = ctx.accounts.authority.key();
        bm.bump = ctx.bumps.beef_miner;
        bm.last_tick_ts = now;
        bm.last_active_ts = now;
    }

    // INVARIANT: roll never errors on game-state grounds — a failed roll would
    // abort the whole [roll, stake]/[roll, claim] bundle and block the player
    // from the ANSEM game. Already-rolled and moved-on positions are no-ops.
    if bm.last_rolled_round_id >= round_id || ctx.accounts.miner.round_id != round_id {
        return Ok(());
    }

    let bc = &mut ctx.accounts.beef_config;
    // 1. accrue the existing balance's bonus BEFORE the new share dilutes it
    accrue_bonus(bm, bc, now)?;

    // 2. pro-rata share of the frozen emission, then weighted-average dilution
    let stake_sum: u64 = ctx.accounts.miner.block_stake.iter().sum();
    let share = math::beef_share(ctx.accounts.beef_round.emission, stake_sum, ctx.accounts.round.pot);
    bm.bonus_bps = math::beef_dilute(bm.bonus_bps, bm.unclaimed, share);
    bm.unclaimed = bm.unclaimed.checked_add(share).ok_or(AnsemError::Overflow)?;

    // 3. this touch accompanies a played round -> keeps the daily streak alive
    bm.last_rolled_round_id = round_id;
    bm.last_active_ts = now;
    Ok(())
}
```

Register in `lib.rs`:

```rust
    pub fn roll_beef(ctx: Context<RollBeef>, round_id: u64) -> Result<()> {
        instructions::beef::roll_beef_handler(ctx, round_id)
    }
```

- [ ] **Step 4: Build, restart localnet, run suite — all green**

Same commands as Task 4 Step 4. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add programs/ansem-miner/src/instructions/beef.rs programs/ansem-miner/src/lib.rs tests/direct-beef.ts
git commit -m "feat(program): roll_beef — pro-rata emission share, bonus accrual+dilution, bundle-safe no-ops"
```

---

### Task 6: `claim_beef` — payout with bonus, full reset

**Files:**
- Modify: `programs/ansem-miner/src/instructions/beef.rs`
- Modify: `programs/ansem-miner/src/lib.rs`
- Modify: `tests/direct-beef.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/direct-beef.ts` — the claim helper, then the tests:

```typescript
  const claimBeefAccts = (pk: PublicKey) => ({
    authority: pk, beefConfig: beefConfigPda, beefMiner: beefMinerOf(pk),
    beefMint, vaultAuthority: vaultAuth, beefVault,
    playerBeefAta: getAssociatedTokenAddressSync(beefMint, pk),
  });

  it("claim_beef pays unclaimed*(1+bonus), decrements owed, resets; double-claim pays zero", async () => {
    // p1 holds 750_000 from round1; secs_per_tick=1 & tick=1000bps mean real
    // seconds have been accruing bonus since the roll. Claim and check bounds.
    const bcBefore = await program.account.beefConfig.fetch(beefConfigPda);
    const bmBefore = await program.account.beefMiner.fetch(beefMinerOf(p1.publicKey));
    const base = bmBefore.unclaimed.toNumber();

    await program.methods.claimBeef().accounts(claimBeefAccts(p1.publicKey)).signers([p1]).rpc();

    const ata = getAssociatedTokenAddressSync(beefMint, p1.publicKey);
    const got = Number((await getAccount(provider.connection, ata)).amount);
    assert.isAtLeast(got, base);            // at least the base
    assert.isAtMost(got, base * 4);         // never beyond the 4x cap

    const bm = await program.account.beefMiner.fetch(beefMinerOf(p1.publicKey));
    assert.equal(bm.unclaimed.toNumber(), 0);  // full reset
    assert.equal(bm.bonusBps, 0);
    const bc = await program.account.beefConfig.fetch(beefConfigPda);
    assert.isBelow(bc.totalOwed.toNumber(), bcBefore.totalOwed.toNumber()); // owed shrank

    // double claim: nothing moves
    await program.methods.claimBeef().accounts(claimBeefAccts(p1.publicKey)).signers([p1]).rpc();
    const got2 = Number((await getAccount(provider.connection, ata)).amount);
    assert.equal(got2, got);
  });

  it("hold-to-grow: bonus caps at 4x and dilution waters a new share down", async () => {
    // crank ticks way up so p2's held balance pins the cap in seconds
    await program.methods.setBeefParams(new anchor.BN(DIVISOR), 30_000, CAP_BPS, new anchor.BN(WINDOW), new anchor.BN(1))
      .accounts({ admin: admin.publicKey, config: configPda, beefConfig: beefConfigPda }).rpc();
    await sleep(3000); // >=1 tick at 30_000bps -> instantly capped

    // p2 rolls a NEW round's share on top of the capped balance -> dilution
    const r = await playRound([{ kp: p2, square: 9, amount: 100_000_000 }]);
    await program.methods.rollBeef(new anchor.BN(r.id))
      .accounts(rollAccts(p2.publicKey, r.id, r.pda)).signers([p2]).rpc();
    const bm = await program.account.beefMiner.fetch(beefMinerOf(p2.publicKey));
    assert.isBelow(bm.bonusBps, CAP_BPS); // new share diluted the capped bonus
    assert.isAbove(bm.bonusBps, 0);

    // claim: payout is (1+bonus)x of the combined balance, bounded by 4x
    const base = bm.unclaimed.toNumber();
    await program.methods.claimBeef().accounts(claimBeefAccts(p2.publicKey)).signers([p2]).rpc();
    const ata = getAssociatedTokenAddressSync(beefMint, p2.publicKey);
    const got = Number((await getAccount(provider.connection, ata)).amount);
    assert.isAtLeast(got, base);
    assert.isAtMost(got, base * 4);
    // restore fast-but-sane params for later tests
    await program.methods.setBeefParams(new anchor.BN(DIVISOR), TICK_BPS, CAP_BPS, new anchor.BN(WINDOW), new anchor.BN(1))
      .accounts({ admin: admin.publicKey, config: configPda, beefConfig: beefConfigPda }).rpc();
  });
```

- [ ] **Step 2: Run to verify failure**

Expected: TS compile failure (`claimBeef` missing).

- [ ] **Step 3: Implement**

Append to `programs/ansem-miner/src/instructions/beef.rs`:

```rust
#[derive(Accounts)]
pub struct ClaimBeef<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(mut, seeds = [BEEF_CONFIG_SEED], bump = beef_config.bump)]
    pub beef_config: Box<Account<'info, BeefConfig>>,

    #[account(mut, seeds = [BEEF_MINER_SEED, authority.key().as_ref()], bump = beef_miner.bump,
        constraint = beef_miner.authority == authority.key() @ AnsemError::Unauthorized)]
    pub beef_miner: Box<Account<'info, BeefMiner>>,

    #[account(address = beef_config.beef_mint @ AnsemError::BadBeefVault)]
    pub beef_mint: Box<Account<'info, Mint>>,

    /// CHECK: same vault authority PDA that signs ANSEM payouts.
    #[account(seeds = [VAULT_AUTH_SEED], bump)]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(mut, address = beef_config.beef_vault @ AnsemError::BadBeefVault)]
    pub beef_vault: Box<Account<'info, TokenAccount>>,

    #[account(init_if_needed, payer = authority,
        associated_token::mint = beef_mint, associated_token::authority = authority)]
    pub player_beef_ata: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn claim_beef_handler(ctx: Context<ClaimBeef>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let bm = &mut ctx.accounts.beef_miner;
    let bc = &mut ctx.accounts.beef_config;

    // final accrual, then pay unclaimed * (1 + bonus)
    accrue_bonus(bm, bc, now)?;
    let payout = math::beef_payout(bm.unclaimed, bm.bonus_bps);

    if payout > 0 {
        // ctx.bumps carries the verified bump for any seeds-checked account —
        // no find_program_address re-derivation needed.
        let va_seeds: &[&[u8]] = &[VAULT_AUTH_SEED, &[ctx.bumps.vault_authority]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                TokenTransfer {
                    from: ctx.accounts.beef_vault.to_account_info(),
                    to: ctx.accounts.player_beef_ata.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                },
                &[va_seeds],
            ),
            payout,
        )?;
    }

    // saturating: floor-rounding interplay can leave dust either side; the
    // stamp-side floors leave a permanently growing free buffer that dominates.
    bc.total_owed = bc.total_owed.saturating_sub(payout);

    // THE reset: any claim restarts the hold-to-grow ramp from 1x.
    bm.unclaimed = 0;
    bm.bonus_bps = 0;
    bm.last_tick_ts = now;
    Ok(())
}
```

Register in `lib.rs`:

```rust
    pub fn claim_beef(ctx: Context<ClaimBeef>) -> Result<()> {
        instructions::beef::claim_beef_handler(ctx)
    }
```

- [ ] **Step 4: Build, restart localnet, run suite — all green**

Same commands. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add programs/ansem-miner/src/instructions/beef.rs programs/ansem-miner/src/lib.rs tests/direct-beef.ts
git commit -m "feat(program): claim_beef — bonus payout from vault, total_owed release, any-claim reset"
```

---

### Task 7: Invariant tests — empty vault never blocks the game; solvency

**Files:**
- Modify: `tests/direct-beef.ts`

- [ ] **Step 1: Write the tests**

Append to `tests/direct-beef.ts`:

```typescript
  it("INVARIANT: a drained vault stamps emission 0 and the ANSEM game is untouched", async () => {
    // Drain the vault to (approximately) its owed floor by pointing divisor at 1
    // and claiming everything claimable? Simpler: fetch free = amount - owed and
    // assert stamp math directly on a fresh round with near-zero free balance.
    const bc = await program.account.beefConfig.fetch(beefConfigPda);
    const v = await getAccount(provider.connection, beefVault);
    const free = Number(v.amount) - bc.totalOwed.toNumber();
    // crank divisor so emission floors to 0 even with free balance remaining:
    await program.methods.setBeefParams(new anchor.BN("18446744073709551615"), TICK_BPS, CAP_BPS, new anchor.BN(WINDOW), new anchor.BN(1))
      .accounts({ admin: admin.publicKey, config: configPda, beefConfig: beefConfigPda }).rpc();

    const p5 = await fundedPlayer();
    const r = await playRound([{ kp: p5, square: 2, amount: 120_000_000 }]);
    const br = await program.account.beefRound.fetch(beefRoundOf(r.id));
    assert.equal(br.emission.toNumber(), 0); // "empty" vault -> zero emission
    assert.isAtLeast(free, 0);

    // roll + claim still succeed as no-ops...
    await program.methods.rollBeef(new anchor.BN(r.id))
      .accounts(rollAccts(p5.publicKey, r.id, r.pda)).signers([p5]).rpc();
    await program.methods.claimBeef().accounts(claimBeefAccts(p5.publicKey)).signers([p5]).rpc();

    // ...and the ANSEM claim works exactly as in the no-BEEF world.
    const p5Ata = getAssociatedTokenAddressSync(ansemMint, p5.publicKey);
    await program.methods.claimDirect(new anchor.BN(r.id))
      .accounts({ authority: p5.publicKey, config: configPda, round: r.pda, miner: minerOf(p5.publicKey),
        ansemMint, vaultAuthority: vaultAuth, payoutVault, playerAta: p5Ata }).signers([p5]).rpc();
    const won = Number((await getAccount(provider.connection, p5Ata)).amount);
    assert.isAbove(won, 0); // sole staker -> wins the jackpot regardless of BEEF

    // restore params
    await program.methods.setBeefParams(new anchor.BN(DIVISOR), TICK_BPS, CAP_BPS, new anchor.BN(WINDOW), new anchor.BN(1))
      .accounts({ admin: admin.publicKey, config: configPda, beefConfig: beefConfigPda }).rpc();
  });

  it("SOLVENCY: total BEEF paid out never exceeds the vault fill", async () => {
    const v = await getAccount(provider.connection, beefVault);
    const stillVaulted = Number(v.amount);
    assert.isAtLeast(stillVaulted, 0);
    assert.isAtMost(VAULT_FILL - stillVaulted, VAULT_FILL); // paid <= filled
    const bc = await program.account.beefConfig.fetch(beefConfigPda);
    assert.isAtMost(bc.totalOwed.toNumber(), stillVaulted); // owed always covered
  });
```

- [ ] **Step 2: Run the suite — all green**

Same ts-mocha command against a fresh `anchor localnet`. Expected: PASS (full file).

- [ ] **Step 3: Regression — the existing direct suite is untouched**

Restart `anchor localnet` (fresh validator), then:

```bash
ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 ANCHOR_WALLET=~/.config/solana/id.json \
  pnpm exec ts-mocha -p ./tsconfig.json -t 1000000 tests/direct-stake.ts
```
Expected: 7/7 PASS with zero modifications to that file — the machine-checkable proof that the BEEF layer didn't touch the ANSEM path.

- [ ] **Step 4: Commit**

```bash
git add tests/direct-beef.ts
git commit -m "test(program): BEEF invariants — zero-emission no-ops, ANSEM path untouched, vault solvency"
```

---

### Task 8: SDK — seeds, PDAs, fetch, builders

**Files:**
- Modify: `packages/sdk/src/constants.ts`
- Modify: `packages/sdk/src/pdas.ts`
- Modify: `packages/sdk/src/accounts.ts`
- Modify: `packages/sdk/src/instructions/player.ts`
- Modify: `packages/sdk/src/instructions/keeper.ts`

- [ ] **Step 1: Regenerate the IDL types into the SDK**

The SDK vendors the IDL under `packages/sdk/src/idl/`. After `anchor build`, refresh it the same way the direct-stake work did — copy the built IDL/types over the vendored ones:

```bash
cp target/idl/ansem_miner.json packages/sdk/src/idl/ansem_miner.json 2>/dev/null || true
cp target/types/ansem_miner.ts packages/sdk/src/idl/ansem_miner.ts
```
(Check `packages/sdk/src/idl/` for the exact vendored filenames and match them; the `.ts` types file is the one the builders import.)

- [ ] **Step 2: Constants**

In `packages/sdk/src/constants.ts`, extend `SEED` and scalars:

```typescript
  beefConfig: "beef_config",
  beefMiner: "beef_miner",
  beefRound: "beef_round",
```
(inside the `SEED` object, before `sessionTokenV2`), and append after the scalars:

```typescript
// BEEF vault emission layer defaults (mirror programs/.../constants.rs)
export const DEFAULT_BEEF_DIVISOR = 1_800_000;
export const DEFAULT_BEEF_TICK_BPS = 3;
export const DEFAULT_BEEF_BONUS_CAP_BPS = 30_000;
export const DEFAULT_BEEF_ACTIVITY_WINDOW_SECS = 86_400;
export const DEFAULT_BEEF_SECS_PER_TICK = 60;
```

- [ ] **Step 3: PDAs**

Append to `packages/sdk/src/pdas.ts`:

```typescript
export const beefConfigPda = () => pda([enc(SEED.beefConfig)]);
export const beefMinerPda = (wallet: PublicKey) => pda([enc(SEED.beefMiner), wallet.toBuffer()]);
export const beefRoundPda = (roundId: number | bigint) => pda([enc(SEED.beefRound), u64le(roundId)]);
/** Player's BEEF ATA (mint comes from BeefConfig, passed by the caller). */
export const playerBeefAta = (beefMint: PublicKey, wallet: PublicKey) =>
  getAssociatedTokenAddressSync(beefMint, wallet);
```

- [ ] **Step 4: Account fetch helper**

`packages/sdk/src/accounts.ts` follows a fetch-helper pattern (`fetchMiner`, `fetchConfig` are exported — match the exact style in that file). Add:

```typescript
export const fetchBeefConfig = (p: Program<AnsemMiner>, pda: PublicKey) =>
  p.account.beefConfig.fetch(pda);
```

- [ ] **Step 5: Player builders + the ordering-invariant doc**

Append to `packages/sdk/src/instructions/player.ts`:

```typescript
// ---- BEEF vault emission layer ----
// ORDERING INVARIANT: rollBeef must run BEFORE any block_stake-zeroing ix in
// the same bundle — claimDirect zeroes stakes and stakeDirect re-stamps the
// miner to a new round, either of which forfeits the un-rolled BEEF share.
//   harvest bundle:  [rollBeef(r), claimDirect(r), claimBeef]
//   restake bundle:  [rollBeef(prevR), stakeDirect(newR)...]
// rollBeef is a no-op (never an error) when already rolled / nothing to roll,
// so including it defensively can never block the ANSEM game.

import { beefConfigPda, beefMinerPda, beefRoundPda, playerBeefAta } from "../pdas.js";

export const rollBeefIx = (p: Program<AnsemMiner>, wallet: PublicKey, roundId: number) =>
  p.methods.rollBeef(new BN(roundId)).accountsPartial({
    authority: wallet, round: roundPda(roundId), miner: minerPda(wallet),
    beefRound: beefRoundPda(roundId), beefConfig: beefConfigPda(), beefMiner: beefMinerPda(wallet),
  });

export const claimBeefIx = (p: Program<AnsemMiner>, wallet: PublicKey, beefMint: PublicKey, beefVault: PublicKey) =>
  p.methods.claimBeef().accountsPartial({
    authority: wallet, beefConfig: beefConfigPda(), beefMiner: beefMinerPda(wallet),
    beefMint, vaultAuthority: vaultAuthPda(), beefVault,
    playerBeefAta: playerBeefAta(beefMint, wallet),
  });
```

(Adjust the import line to merge with the existing `../pdas.js` import at the top of the file rather than adding a second import statement.)

- [ ] **Step 6: Keeper/admin builders**

Append to `packages/sdk/src/instructions/keeper.ts` (match its existing import style for `configPda`, `roundPda`, `BN`, `Program`, `AnsemMiner`, `PublicKey`):

```typescript
// ---- BEEF vault emission layer (admin/keeper) ----

export const initBeefIx = (
  p: Program<AnsemMiner>, admin: PublicKey, beefMint: PublicKey, beefVault: PublicKey,
  divisor: BN, tickBps: number, bonusCapBps: number, activityWindowSecs: BN, secsPerTick: BN,
) => p.methods.initBeef(divisor, tickBps, bonusCapBps, activityWindowSecs, secsPerTick)
  .accountsPartial({ admin, beefMint, vaultAuthority: vaultAuthPda(), beefVault });

export const setBeefParamsIx = (
  p: Program<AnsemMiner>, admin: PublicKey,
  divisor: BN, tickBps: number, bonusCapBps: number, activityWindowSecs: BN, secsPerTick: BN,
) => p.methods.setBeefParams(divisor, tickBps, bonusCapBps, activityWindowSecs, secsPerTick)
  .accountsPartial({ admin, config: configPda(), beefConfig: beefConfigPda() });

export const stampBeefIx = (p: Program<AnsemMiner>, payer: PublicKey, roundId: number, beefVault: PublicKey) =>
  p.methods.stampBeef(new BN(roundId)).accountsPartial({
    payer, config: configPda(), round: roundPda(roundId),
    beefConfig: beefConfigPda(), beefVault, beefRound: beefRoundPda(roundId),
  });
```

- [ ] **Step 7: Rebuild the SDK dist (project-memory gotcha: stale dist bites)**

```bash
pnpm --filter @ansem/sdk run build
```
Expected: clean tsc build. If `index.ts` uses explicit re-exports, confirm the new symbols are exported (builders live in already-re-exported files; `fetchBeefConfig` and the new pdas ride the existing `export *` if that's the pattern — check `packages/sdk/src/index.ts` and add explicit exports only if it enumerates symbols).

- [ ] **Step 8: Commit**

```bash
git add packages/sdk/src
git commit -m "feat(sdk): BEEF pdas, fetchBeefConfig, roll/claim/stamp/init builders + ordering-invariant doc"
```

---

### Task 9: Keeper — best-effort stamp after every swap

**Files:**
- Modify: `keeper/src/crank/actions.ts`
- Modify: `keeper/src/service.ts`
- Modify: `keeper/test/actions.test.ts`

- [ ] **Step 1: Write the failing keeper unit tests**

In `keeper/test/actions.test.ts`, add (match the file's existing imports of `finalizeSettled` and vitest globals):

```typescript
describe("finalizeSettled + BEEF stamp", () => {
  it("stamps AFTER the swap", async () => {
    const calls: string[] = [];
    await finalizeSettled(7, {
      joinedWallets: async () => [],
      reconcileMiner: async () => { calls.push("rec"); },
      executeSwap: async () => { calls.push("swap"); },
      stampBeef: async () => { calls.push("stamp"); },
    });
    expect(calls).toEqual(["swap", "stamp"]);
  });

  it("a throwing stamp is swallowed — BEEF never blocks finalize", async () => {
    const calls: string[] = [];
    await finalizeSettled(7, {
      joinedWallets: async () => [],
      reconcileMiner: async () => {},
      executeSwap: async () => { calls.push("swap"); },
      stampBeef: async () => { throw new Error("vault missing"); },
    });
    expect(calls).toEqual(["swap"]); // finalize completed despite the throw
  });

  it("no stampBeef dep (BEEF disabled) -> finalize unchanged", async () => {
    const calls: string[] = [];
    await finalizeSettled(7, {
      joinedWallets: async () => [],
      reconcileMiner: async () => {},
      executeSwap: async () => { calls.push("swap"); },
    });
    expect(calls).toEqual(["swap"]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm --filter keeper test 2>&1 | tail -6
```
Expected: FAIL — `stampBeef` not a known dep / ordering assertions fail.

- [ ] **Step 3: Implement in `actions.ts`**

In `keeper/src/crank/actions.ts`:

1. Extend `ActionCtx` (after `directMode?: boolean;`):

```typescript
  /** BEEF emission layer: set at startup if BeefConfig exists on-chain. */
  beefEnabled?: boolean;
  beefVault?: PublicKey;
```

2. Extend `FinalizeDeps`:

```typescript
export interface FinalizeDeps {
  joinedWallets: () => Promise<PublicKey[]>;
  reconcileMiner: (wallet: PublicKey) => Promise<void>;
  executeSwap: () => Promise<void>;
  /** BEEF emission stamp — best-effort, always after the swap. Optional: absent
   *  when BEEF isn't initialized. A throw here must never block finalize. */
  stampBeef?: () => Promise<void>;
}
```

3. Extend `finalizeSettled` (after `await deps.executeSwap();`):

```typescript
  if (deps.stampBeef) {
    try { await deps.stampBeef(); }
    catch { /* best-effort: BEEF never blocks the game (invariant) */ }
  }
```

4. Extend `liveFinalizeDeps`'s returned object (after `executeSwap`), and add `stampBeefIx` to the `@ansem/sdk` import list at the top:

```typescript
    stampBeef: ctx.beefEnabled && ctx.beefVault ? async () => {
      await l1Send(() => stampBeefIx(ctx.program, ctx.keeper, roundId, ctx.beefVault!).rpc());
      ctx.log.info("beef emission stamped", { roundId });
    } : undefined,
```

- [ ] **Step 4: Wire startup detection in `service.ts`**

Where the `ActionCtx` object is constructed (around `keeper/src/service.ts:24` — the object with `keeper: cfg.adminKeypair.publicKey, ...`), add a startup probe right after the ctx is built. Import `fetchBeefConfig, beefConfigPda` from `@ansem/sdk`:

```typescript
  // BEEF emission layer: enabled iff BeefConfig exists on-chain at startup.
  try {
    const bc = await fetchBeefConfig(ctx.program, beefConfigPda());
    ctx.beefEnabled = true;
    ctx.beefVault = bc.beefVault;
    ctx.log.info("BEEF emission enabled", { vault: bc.beefVault.toBase58() });
  } catch {
    ctx.log.info("BEEF not initialized — emission stamping disabled");
  }
```

(If the ctx is built inside a non-async scope, hoist this probe to the nearest async startup path that owns the ctx — `service.ts` starts the tick loop, so run it once before the first tick.)

- [ ] **Step 5: Run keeper tests — green**

```bash
pnpm --filter keeper test 2>&1 | tail -6
```
Expected: PASS including the three new tests and all pre-existing ones.

- [ ] **Step 6: Commit**

```bash
git add keeper/src keeper/test
git commit -m "feat(keeper): best-effort BEEF emission stamp after each swap (auto-enabled when BeefConfig exists)"
```

---

### Task 10: Ops script — create the (vanity) vault + init on devnet

**Files:**
- Create: `scripts/beef-init.mjs`
- Modify: `docs/devnet-runbook.md`

- [ ] **Step 1: Write the script**

Create `scripts/beef-init.mjs` (conventions copied from `scripts/_config.mjs`: env `RPC`, admin keypair at `~/.config/solana/ansem-devnet.json`, `@ansem/sdk` imports):

```javascript
// Ops tool: create the BEEF vault token account + init_beef on the live cluster.
//
//   RPC=<url> node scripts/beef-init.mjs [--vault-keypair <path>] [--beef-mint <CA>] [--fill <uiAmount>]
//
// - --vault-keypair: keypair whose PUBKEY becomes the vault address. Grind a
//   vanity one first:  solana-keygen grind --starts-with BEEF:1
//   (ops cosmetics only — the program pins whatever pubkey is used at init).
//   Omit to use a throwaway keypair (fine for devnet rehearsals).
// - --beef-mint: existing mint CA (MAINNET: the pump.fun $BEEF CA, provided at
//   launch). Omit on devnet to create a fresh 6dp mock mint.
// - --fill: devnet-only convenience — mint <uiAmount> BEEF into the vault
//   (mock mint only; a real CA can't be minted, fill it by transfer instead).
//
// After creation the vault keypair has ZERO power (SPL token accounts obey the
// stored owner = vault_authority PDA, not the address's key) — discard it.
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { Wallet, BN } from "@coral-xyz/anchor";
import { createMint, createAccount, mintTo, getAccount } from "@solana/spl-token";
import { readFileSync } from "node:fs";
import {
  createProgram, configPda, beefConfigPda, vaultAuthPda, initBeefIx, fetchBeefConfig,
  DEFAULT_BEEF_DIVISOR, DEFAULT_BEEF_TICK_BPS, DEFAULT_BEEF_BONUS_CAP_BPS,
  DEFAULT_BEEF_ACTIVITY_WINDOW_SECS, DEFAULT_BEEF_SECS_PER_TICK,
} from "@ansem/sdk";

const arg = (name) => { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : undefined; };
const RPC = process.env.RPC || "https://api.devnet.solana.com";
const conn = new Connection(RPC, "confirmed");
const admin = Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(`${process.env.HOME}/.config/solana/ansem-devnet.json`, "utf8"))));
const program = createProgram(conn, new Wallet(admin));

const vaultKp = arg("--vault-keypair")
  ? Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(arg("--vault-keypair"), "utf8"))))
  : Keypair.generate();

let beefMint = arg("--beef-mint") ? new PublicKey(arg("--beef-mint")) : null;
if (!beefMint) {
  beefMint = await createMint(conn, admin, admin.publicKey, null, 6);
  console.log("created MOCK beef mint:", beefMint.toBase58());
}

const vault = await createAccount(conn, admin, beefMint, vaultAuthPda(), vaultKp);
console.log("vault token account:", vault.toBase58(), "(owner = vault_authority PDA — keypair now powerless)");

const fill = arg("--fill");
if (fill) {
  await mintTo(conn, admin, beefMint, vault, admin, BigInt(Math.round(Number(fill) * 1e6)));
  console.log(`filled vault with ${fill} mock BEEF`);
}

await initBeefIx(
  program, admin.publicKey, beefMint, vault,
  new BN(DEFAULT_BEEF_DIVISOR), DEFAULT_BEEF_TICK_BPS, DEFAULT_BEEF_BONUS_CAP_BPS,
  new BN(DEFAULT_BEEF_ACTIVITY_WINDOW_SECS), new BN(DEFAULT_BEEF_SECS_PER_TICK),
).rpc({ commitment: "confirmed" });

const bc = await fetchBeefConfig(program, beefConfigPda());
const v = await getAccount(conn, vault);
console.log("BEEF INITIALIZED:", JSON.stringify({
  mint: bc.beefMint.toBase58(), vault: bc.beefVault.toBase58(),
  divisor: bc.divisor.toString(), vaultBalance: v.amount.toString(), totalOwed: bc.totalOwed.toString(),
}, null, 2));
```

- [ ] **Step 2: Rehearse on localnet**

With `anchor localnet` running and the SDK dist rebuilt:

```bash
RPC=http://127.0.0.1:8899 node scripts/beef-init.mjs --fill 500000000
```
Expected: prints mock mint, vault address, `BEEF INITIALIZED` with `vaultBalance: "500000000000000"`. (Requires `~/.config/solana/ansem-devnet.json` to be the localnet admin — for a pure-local rehearsal, temporarily point the script's keypair path at `~/.config/solana/id.json` or fund the devnet keypair via airdrop; note which you did.)

- [ ] **Step 3: Add the runbook section**

Append to `docs/devnet-runbook.md`:

```markdown
## BEEF emission layer (post-launch add-on)

1. Grind the vanity vault address (ops cosmetics; each extra exact char ×58 cost):
   `solana-keygen grind --starts-with BEEF:1` → move the JSON to a safe path.
2. Create vault + init (devnet, with mock mint + fill):
   `RPC=$DEVNET_RPC node scripts/beef-init.mjs --vault-keypair <ground.json> --fill 500000000`
   Mainnet (real CA from the pump.fun launch, fill by transfer from the dev-buy):
   `RPC=$MAINNET_RPC node scripts/beef-init.mjs --vault-keypair <ground.json> --beef-mint <CA>`
3. DELETE the ground keypair file — the address key is powerless post-creation.
4. Restart the keeper — it auto-detects BeefConfig and logs "BEEF emission enabled".
5. Verify: next settled round with a pot logs "beef emission stamped"; check
   `BeefRound.emission ≈ vault/divisor` and `BeefConfig.total_owed` grew by it.
6. Tuning: `set_beef_params` (divisor/tick/cap/window) — loosen with data, never
   tighten a promised schedule.
```

- [ ] **Step 4: Commit**

```bash
git add scripts/beef-init.mjs docs/devnet-runbook.md
git commit -m "feat(ops): beef-init.mjs — vanity vault creation + init_beef + runbook section"
```

---

### Task 11: Full regression + wrap-up

- [ ] **Step 1: Program unit tests**

```bash
cargo test -p ansem-miner 2>&1 | tail -3
```
Expected: all pass.

- [ ] **Step 2: Per-suite integration regression (fresh `anchor localnet` per file)**

```bash
# fresh validator, then each on its own validator restart:
ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 ANCHOR_WALLET=~/.config/solana/id.json pnpm exec ts-mocha -p ./tsconfig.json -t 1000000 tests/direct-beef.ts
ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 ANCHOR_WALLET=~/.config/solana/id.json pnpm exec ts-mocha -p ./tsconfig.json -t 1000000 tests/direct-stake.ts
```
Expected: both fully green. Run the escrow regression suite too if touching shared files beyond this plan's list.

- [ ] **Step 3: Keeper + app workspace tests**

```bash
pnpm --filter keeper test 2>&1 | tail -3
pnpm --filter @ansem/sdk run build 2>&1 | tail -3
```
Expected: keeper green; SDK dist builds clean.

- [ ] **Step 4: Final commit if anything moved, and update the memory pointer**

```bash
git add -A && git status --short
git commit -m "chore(beef): plan 2026-07-09-beef-vault-emission executed — program+sdk+keeper+ops" || true
```

Update `~/.claude/.../memory/beef-vault-tokenomics.md`: mark implementation status DONE-pending-deploy and reference this plan file.

---

## Deferred (explicitly NOT in this plan)

- **App UI** (HUD BEEF balance, multiplier ring, single "harvest" button bundling `[rollBeef, claimDirect, claimBeef]`, auto-`rollBeef` prepended to stake txs) — separate plan; touches `app/` only, consumes the SDK builders from Task 8.
- **Pump.fun launch ops** (create $BEEF with dev-buy at creation block, transfer 50% to the vault in the same bundle) — blocked on user's launch decision + real CA; mainnet `beef-init.mjs --beef-mint <CA>` path already supports it.
- **Buyback crank** (rake → market-buy BEEF → permissionless transfer into vault) — pure ops, zero program work (deposits are plain SPL transfers).
- **Devnet deploy** of this program change — after Friday's beta is stable (user's sequencing call: branch now, merge after soak).
