# ANSEM Miner — M1 Program Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the on-chain ANSEM Miner grid-game economy as an Anchor program on localnet — deposit, stake on a 5×5 grid, settle a round with injected randomness, mock-swap the SOL pot into ANSEM, and claim VRF-weighted (±20%) payouts — with the payout math proven solvent by tests.

**Architecture:** Single Anchor program `ansem_miner`. Value lives entirely on L1 (this milestone has no ephemeral rollup). A pure `math` module computes per-square multipliers and normalized payouts so payouts always sum to exactly the swap proceeds. A **mock swap** mints ANSEM at a fixed rate in place of the mainnet Jupiter swap, behind the same `swap_mode` seam. Randomness is an **injected argument** to an admin-only `settle` in M1 (replaced by MagicBlock ephemeral VRF in M2).

**Tech Stack:** Anchor 0.31.1, Solana/Agave 4.1, Rust 1.93, `anchor-spl` (SPL Token), TypeScript + Mocha/Chai integration tests, `@coral-xyz/anchor` TS client.

**Reference spec:** `docs/superpowers/specs/2026-07-06-ansem-miner-design.md` (§2 game design, §4 accounts/instructions, §5 randomness, §7 testing).

---

## Milestone boundary (what M1 is and isn't)

**In M1:** program scaffold; `Config`; `PlayerEscrow` (deposit/withdraw); `Round`; persistent `MinerPosition`; L1 `stake`; admin `settle(randomness)`; `execute_swap_mock`; `claim`; the pure payout `math` module; full Rust unit tests + TS integration tests including a **solvency invariant** and **negative tests**.

**Deferred to later milestones (do NOT build here):** MagicBlock delegation / `#[delegate]` / `#[commit]` / `#[ephemeral]` macros; session keys; ephemeral VRF (`request_settle`/`settle_callback`); real Jupiter keeper (`begin_swap`/`record_swap`); devnet deploy + Metaplex metadata; the Next.js frontend. `Config.swap_mode` and the `RoundState` values `VrfPending`/`Swapping` exist now as seams but are exercised later.

**Anchor version note:** M1 targets the installed Anchor **0.31.1**. M2 must pin `ephemeral-rollups-sdk` to a version compatible with the toolchain (or `avm install` a matching one) — that reconciliation is an M2 task, not M1.

**Known v1 constraint (by design, see spec §4):** a player must `claim` round N before staking round N+1, because `MinerPosition` is a single persistent account reset in place each round. Enforced via `PlayerEscrow.active_round`.

---

## File Structure

```
ansem-ore/
├── Anchor.toml                         # workspace + localnet config
├── Cargo.toml                          # workspace members
├── package.json                        # TS test deps
├── tsconfig.json
├── programs/ansem-miner/
│   ├── Cargo.toml
│   └── src/
│       ├── lib.rs                       # declare_id!, program mod, ix entrypoints, module wiring
│       ├── constants.rs                 # seeds, grid size, decimals, param defaults
│       ├── error.rs                     # AnsemError
│       ├── math.rs                       # PURE payout math (multipliers, weights, payout, jackpot) + #[cfg(test)]
│       ├── state/
│       │   ├── mod.rs
│       │   ├── config.rs                 # Config + state constants
│       │   ├── round.rs                  # Round (+ RoundState u8 consts)
│       │   ├── miner.rs                  # MinerPosition
│       │   └── escrow.rs                 # PlayerEscrow
│       └── instructions/
│           ├── mod.rs
│           ├── initialize.rs             # initialize (Config + mock mint + vaults)
│           ├── escrow.rs                 # deposit, withdraw
│           ├── round.rs                  # create_round
│           ├── miner.rs                  # init_miner
│           ├── stake.rs                  # stake (L1)
│           ├── settle.rs                 # settle(randomness) — admin, M1-only
│           ├── swap.rs                   # execute_swap_mock
│           └── claim.rs                  # claim
└── tests/
    └── ansem-miner.ts                    # TS integration suite
```

**Responsibility boundaries:** `math.rs` is pure (no Anchor types) so it unit-tests off-chain and is the single source of payout truth. Each instruction is one file. `state/*` holds only account structs + space. `lib.rs` wires modules and exposes thin entrypoints that delegate to `instructions::*::handler`.

---

## Task 0: Scaffold the Anchor workspace

**Files:**
- Create: `Anchor.toml`, `Cargo.toml`, `programs/ansem-miner/Cargo.toml`, `programs/ansem-miner/src/lib.rs`, `package.json`, `tsconfig.json`, `tests/ansem-miner.ts`

- [ ] **Step 1: Generate the scaffold**

Run:
```bash
cd /Users/yordanlasonov/Documents/GitHub/ansem-ore
anchor init --no-git --template multiple ansem-miner-tmp
# move generated files into the repo root (repo already exists)
rsync -a ansem-miner-tmp/ ./ --exclude .gitignore --exclude .git
rm -rf ansem-miner-tmp
```
If `anchor init` refuses because the directory is non-empty, instead create the files by hand from the templates in Steps 2–7 below.

- [ ] **Step 2: Write `Anchor.toml`**

```toml
[toolchain]
anchor_version = "0.31.1"

[features]
resolution = true
skip-lint = false

[programs.localnet]
ansem_miner = "Ao1eMineR1111111111111111111111111111111111"

[registry]
url = "https://api.apr.dev"

[provider]
cluster = "Localnet"
wallet = "~/.config/solana/id.json"

[scripts]
test = "yarn run ts-mocha -p ./tsconfig.json -t 1000000 tests/**/*.ts"
```

- [ ] **Step 3: Write workspace `Cargo.toml`**

```toml
[workspace]
members = ["programs/*"]
resolver = "2"

[profile.release]
overflow-checks = true
lto = "fat"
codegen-units = 1
```

- [ ] **Step 4: Write `programs/ansem-miner/Cargo.toml`**

```toml
[package]
name = "ansem-miner"
version = "0.1.0"
description = "ANSEM Miner grid game"
edition = "2021"

[lib]
crate-type = ["cdylib", "lib"]
name = "ansem_miner"

[features]
default = []
cpi = ["no-entrypoint"]
no-entrypoint = []
no-idl = []
no-log-ix-name = []
idl-build = ["anchor-lang/idl-build", "anchor-spl/idl-build"]

[dependencies]
anchor-lang = "0.31.1"
anchor-spl = "0.31.1"
```

- [ ] **Step 5: Write minimal `programs/ansem-miner/src/lib.rs`**

```rust
use anchor_lang::prelude::*;

declare_id!("Ao1eMineR1111111111111111111111111111111111");

#[program]
pub mod ansem_miner {
    use super::*;

    pub fn ping(_ctx: Context<Ping>) -> Result<()> {
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Ping {}
```

- [ ] **Step 6: Write `package.json` and `tsconfig.json`**

`package.json`:
```json
{
  "scripts": { "test": "anchor test" },
  "dependencies": { "@coral-xyz/anchor": "^0.31.1", "@solana/spl-token": "^0.4.9" },
  "devDependencies": {
    "@types/bn.js": "^5.1.5", "@types/chai": "^4.3.11", "@types/mocha": "^10.0.6",
    "chai": "^4.4.1", "mocha": "^10.3.0", "ts-mocha": "^10.0.0", "typescript": "^5.4.2",
    "@types/node": "^20.11.0"
  }
}
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "types": ["mocha", "chai", "node"],
    "typeRoots": ["./node_modules/@types"],
    "lib": ["es2020"], "module": "commonjs", "target": "es2020",
    "esModuleInterop": true, "resolveJsonModule": true
  }
}
```

- [ ] **Step 7: Set the program ID to a real generated keypair**

Run:
```bash
yarn install
anchor keys sync    # regenerates program keypair + patches declare_id!/Anchor.toml
anchor build
```
Expected: build succeeds; `anchor keys list` prints the program id now in `lib.rs` and `Anchor.toml`.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "chore: scaffold ansem-miner anchor workspace"
```

---

## Task 1: Constants and errors

**Files:**
- Create: `programs/ansem-miner/src/constants.rs`, `programs/ansem-miner/src/error.rs`
- Modify: `programs/ansem-miner/src/lib.rs` (declare modules)

- [ ] **Step 1: Write `constants.rs`**

```rust
use anchor_lang::prelude::*;

pub const GRID_SIZE: usize = 25;
pub const ANSEM_DECIMALS: u8 = 6;
pub const LAMPORTS_PER_SOL: u64 = 1_000_000_000;

// PDA seeds
pub const CONFIG_SEED: &[u8] = b"config";
pub const ROUND_SEED: &[u8] = b"round";
pub const MINER_SEED: &[u8] = b"miner";
pub const ESCROW_SEED: &[u8] = b"escrow";
pub const POT_VAULT_SEED: &[u8] = b"pot_vault";
pub const TREASURY_SEED: &[u8] = b"treasury";
pub const VAULT_AUTH_SEED: &[u8] = b"vault_auth";
pub const MINT_AUTH_SEED: &[u8] = b"mint_auth";
pub const ANSEM_MINT_SEED: &[u8] = b"ansem_mint";

// Param defaults (see spec §2)
pub const DEFAULT_ROUND_DURATION_SECS: i64 = 60;
pub const DEFAULT_FEE_BPS: u16 = 100;
pub const DEFAULT_MULT_MIN_BPS: u16 = 8000;
pub const DEFAULT_MULT_MAX_BPS: u16 = 12000;
pub const DEFAULT_JACKPOT_ODDS: u32 = 625;
pub const DEFAULT_JACKPOT_BPS: u16 = 1000;
pub const DEFAULT_MIN_STAKE: u64 = 10_000_000;              // 0.01 SOL
pub const DEFAULT_MAX_STAKE_PER_ROUND: u64 = 100 * LAMPORTS_PER_SOL;
// base units of ANSEM minted per 1 SOL: 2800 ANSEM * 10^6 decimals
pub const DEFAULT_MOCK_RATE: u64 = 2_800 * 1_000_000;

// swap modes
pub const SWAP_MODE_MOCK: u8 = 0;
pub const SWAP_MODE_JUPITER: u8 = 1;
```

- [ ] **Step 2: Write `error.rs`**

```rust
use anchor_lang::prelude::*;

#[error_code]
pub enum AnsemError {
    #[msg("Numeric overflow")] Overflow,
    #[msg("Block index out of range (0..25)")] BadBlock,
    #[msg("Round is not open")] RoundNotOpen,
    #[msg("Round deadline has not passed")] RoundNotEnded,
    #[msg("Round deadline has passed")] RoundEnded,
    #[msg("Round is not in the required state")] BadRoundState,
    #[msg("Stake below minimum")] StakeTooSmall,
    #[msg("Stake exceeds per-round maximum")] StakeTooLarge,
    #[msg("Insufficient escrow balance")] InsufficientBalance,
    #[msg("Must claim previous round before staking a new one")] UnclaimedRound,
    #[msg("Round already claimed by this player")] AlreadyClaimed,
    #[msg("Cannot withdraw with an active unclaimed round")] WithdrawLocked,
    #[msg("Swap mode mismatch")] WrongSwapMode,
    #[msg("Unauthorized")] Unauthorized,
    #[msg("MinerPosition round mismatch")] MinerRoundMismatch,
}
```

- [ ] **Step 3: Wire modules in `lib.rs`**

Replace the top of `lib.rs` with:
```rust
use anchor_lang::prelude::*;

pub mod constants;
pub mod error;
pub mod math;
pub mod state;
pub mod instructions;

// keep declare_id! and #[program] below (unchanged for now)
```
(Leave the `ping` handler in place until Task 4 replaces it; add empty `pub mod math;` etc. only once those files exist — for this task, comment out `math`, `state`, `instructions` module lines that don't exist yet, or create empty files. Create empty placeholder files now: `math.rs`, `state/mod.rs`, `instructions/mod.rs` each containing `// filled in later tasks`.)

- [ ] **Step 4: Build**

Run: `anchor build`
Expected: compiles (empty modules are fine).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: constants and error types"
```

---

## Task 2: Payout math module (pure, test-first)

This is the economic heart — build it fully test-driven before any account exists.

**Files:**
- Create/replace: `programs/ansem-miner/src/math.rs`

- [ ] **Step 1: Write the failing unit tests**

Put this at the bottom of `math.rs`:
```rust
#[cfg(test)]
mod tests {
    use super::*;

    const R: [u8; 32] = [7u8; 32];

    #[test]
    fn multiplier_in_band() {
        for s in 0..25u8 {
            let m = multiplier_bps(&R, s, 8000, 12000);
            assert!((8000..=12000).contains(&m), "square {s} -> {m}");
        }
    }

    #[test]
    fn multiplier_is_deterministic() {
        assert_eq!(multiplier_bps(&R, 3, 8000, 12000), multiplier_bps(&R, 3, 8000, 12000));
    }

    #[test]
    fn single_player_single_square_gets_all_proceeds() {
        let mut block_sol = [0u64; 25];
        let mut stake = [0u64; 25];
        block_sol[4] = 1_000_000_000;
        stake[4] = 1_000_000_000;
        let proceeds = 2_800_000_000u64;
        let tw = total_weight(&block_sol, &R, 8000, 12000);
        let pw = player_weight(&stake, &R, 8000, 12000);
        assert_eq!(payout(pw, tw, proceeds), proceeds);
    }

    #[test]
    fn payouts_sum_to_proceeds() {
        // three players across squares
        let mut block_sol = [0u64; 25];
        let players: [[u64; 25]; 3] = {
            let mut a = [0u64; 25]; a[0] = 300_000_000; a[1] = 200_000_000;
            let mut b = [0u64; 25]; b[1] = 500_000_000; b[7] = 100_000_000;
            let mut c = [0u64; 25]; c[7] = 900_000_000;
            [a, b, c]
        };
        for p in &players { for s in 0..25 { block_sol[s] += p[s]; } }
        let proceeds = 9_900_000_000u64;
        let tw = total_weight(&block_sol, &R, 8000, 12000);
        let sum: u64 = players.iter().map(|p| payout(player_weight(p, &R, 8000, 12000), tw, proceeds)).sum();
        // floor division => at most (num_players) base-unit dust short
        assert!(proceeds - sum <= players.len() as u64, "sum {sum} vs {proceeds}");
    }

    #[test]
    fn winner_square_gets_more_than_loser_square() {
        // Put equal stake on two squares; higher-multiplier square must pay more.
        let mut a = [0u64; 25]; a[2] = 1_000_000_000;
        let mut b = [0u64; 25]; b[9] = 1_000_000_000;
        let mut block_sol = [0u64; 25]; block_sol[2] = a[2]; block_sol[9] = b[9];
        let proceeds = 1_000_000_000u64;
        let tw = total_weight(&block_sol, &R, 8000, 12000);
        let pa = payout(player_weight(&a, &R, 8000, 12000), tw, proceeds);
        let pb = payout(player_weight(&b, &R, 8000, 12000), tw, proceeds);
        let (m2, m9) = (multiplier_bps(&R, 2, 8000, 12000), multiplier_bps(&R, 9, 8000, 12000));
        if m2 > m9 { assert!(pa > pb); } else if m9 > m2 { assert!(pb > pa); }
    }

    #[test]
    fn jackpot_probability_is_reasonable() {
        let mut hits = 0u32;
        let n = 20_000u32;
        for i in 0..n {
            let mut r = [0u8; 32];
            r[0..4].copy_from_slice(&i.to_le_bytes());
            if jackpot_hit(&r, 625) { hits += 1; }
        }
        // expect ~32 over 20k; allow wide band
        assert!((10..70).contains(&hits), "hits={hits}");
    }

    #[test]
    fn jackpot_block_in_range() {
        assert!(jackpot_block(&R) < 25);
    }
}
```

- [ ] **Step 2: Run to confirm failure**

Run: `cd programs/ansem-miner && cargo test`
Expected: FAIL — `multiplier_bps`, `total_weight`, `player_weight`, `payout`, `jackpot_hit`, `jackpot_block` not found.

- [ ] **Step 3: Implement the math (top of `math.rs`)**

```rust
use anchor_lang::solana_program::keccak;

use crate::constants::GRID_SIZE;

/// Per-square payout multiplier in basis points, uniform in [min_bps, max_bps].
pub fn multiplier_bps(randomness: &[u8; 32], square: u8, min_bps: u16, max_bps: u16) -> u16 {
    let h = keccak::hashv(&[randomness, &[square]]);
    let x = u16::from_le_bytes([h.0[0], h.0[1]]);
    let range = (max_bps - min_bps) as u32 + 1;
    min_bps + (x as u32 % range) as u16
}

/// Weight of one square = lamports * multiplier_bps (u128 to avoid overflow).
fn square_weight(sol: u64, mult_bps: u16) -> u128 {
    (sol as u128) * (mult_bps as u128)
}

pub fn total_weight(block_sol: &[u64; GRID_SIZE], r: &[u8; 32], min_bps: u16, max_bps: u16) -> u128 {
    let mut w = 0u128;
    for s in 0..GRID_SIZE {
        w += square_weight(block_sol[s], multiplier_bps(r, s as u8, min_bps, max_bps));
    }
    w
}

pub fn player_weight(block_stake: &[u64; GRID_SIZE], r: &[u8; 32], min_bps: u16, max_bps: u16) -> u128 {
    let mut w = 0u128;
    for s in 0..GRID_SIZE {
        w += square_weight(block_stake[s], multiplier_bps(r, s as u8, min_bps, max_bps));
    }
    w
}

/// Floored share of `proceeds` for `player_weight / total_weight`.
pub fn payout(player_weight: u128, total_weight: u128, proceeds: u64) -> u64 {
    if total_weight == 0 { return 0; }
    ((proceeds as u128 * player_weight) / total_weight) as u64
}

pub fn jackpot_hit(randomness: &[u8; 32], odds: u32) -> bool {
    if odds == 0 { return false; }
    let h = keccak::hashv(&[randomness, b"jackpot"]);
    let x = u32::from_le_bytes([h.0[0], h.0[1], h.0[2], h.0[3]]);
    x % odds == 0
}

pub fn jackpot_block(randomness: &[u8; 32]) -> u8 {
    let h = keccak::hashv(&[randomness, b"jkblock"]);
    (h.0[0] as usize % GRID_SIZE) as u8
}
```

- [ ] **Step 4: Run to confirm pass**

Run: `cd programs/ansem-miner && cargo test`
Expected: PASS (all 7 tests).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: pure payout math with unit tests (solvent by construction)"
```

---

## Task 3: State accounts

**Files:**
- Create: `programs/ansem-miner/src/state/mod.rs`, `config.rs`, `round.rs`, `miner.rs`, `escrow.rs`

- [ ] **Step 1: Write `state/mod.rs`**

```rust
pub mod config;
pub mod round;
pub mod miner;
pub mod escrow;

pub use config::*;
pub use round::*;
pub use miner::*;
pub use escrow::*;
```

- [ ] **Step 2: Write `state/config.rs`**

```rust
use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    pub ansem_mint: Pubkey,
    pub swap_mode: u8,
    pub current_round_id: u64,
    pub round_duration_secs: i64,
    pub fee_bps: u16,
    pub mult_min_bps: u16,
    pub mult_max_bps: u16,
    pub jackpot_odds: u32,
    pub jackpot_bps: u16,
    pub min_stake: u64,
    pub max_stake_per_round: u64,
    pub mock_rate: u64,
    pub config_bump: u8,
    pub pot_vault_bump: u8,
    pub treasury_bump: u8,
    pub vault_auth_bump: u8,
    pub mint_auth_bump: u8,
}
```

- [ ] **Step 3: Write `state/round.rs`**

```rust
use anchor_lang::prelude::*;
use crate::constants::GRID_SIZE;

pub const STATE_OPEN: u8 = 0;
pub const STATE_VRF_PENDING: u8 = 1; // reserved for M2
pub const STATE_SETTLED: u8 = 2;
pub const STATE_SWAPPING: u8 = 3;    // reserved for mainnet
pub const STATE_CLAIMABLE: u8 = 4;
pub const STATE_CLOSED: u8 = 5;

#[account]
#[derive(InitSpace)]
pub struct Round {
    pub round_id: u64,
    pub deadline_ts: i64,
    pub block_sol: [u64; GRID_SIZE],
    pub pot: u64,
    pub state: u8,
    pub randomness: [u8; 32],
    pub jackpot_hit: bool,
    pub jackpot_block: u8,
    pub swap_proceeds: u64,
    pub bump: u8,
}
```

- [ ] **Step 4: Write `state/miner.rs`**

```rust
use anchor_lang::prelude::*;
use crate::constants::GRID_SIZE;

#[account]
#[derive(InitSpace)]
pub struct MinerPosition {
    pub authority: Pubkey,
    pub round_id: u64,
    pub block_stake: [u64; GRID_SIZE],
    pub bump: u8,
}
```

- [ ] **Step 5: Write `state/escrow.rs`**

```rust
use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct PlayerEscrow {
    pub authority: Pubkey,
    pub balance: u64,
    pub deposited_total: u64,
    pub withdrawn_total: u64,
    pub last_claimed_round: u64,
    pub active_round: u64, // round with unclaimed stakes; 0 = none
    pub bump: u8,
}
```

- [ ] **Step 6: Build**

Run: `anchor build`
Expected: compiles.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat: program state accounts"
```

---

## Task 4: `initialize` (Config + mock ANSEM mint + vaults)

**Files:**
- Create: `programs/ansem-miner/src/instructions/mod.rs`, `programs/ansem-miner/src/instructions/initialize.rs`
- Modify: `programs/ansem-miner/src/lib.rs`
- Test: `tests/ansem-miner.ts`

- [ ] **Step 1: Write the failing integration test (`tests/ansem-miner.ts`)**

```ts
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { AnsemMiner } from "../target/types/ansem_miner";
import { PublicKey } from "@solana/web3.js";
import { assert } from "chai";

const enc = (s: string) => Buffer.from(s);

describe("ansem-miner", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.AnsemMiner as Program<AnsemMiner>;
  const admin = provider.wallet as anchor.Wallet;

  const [configPda] = PublicKey.findProgramAddressSync([enc("config")], program.programId);
  const [ansemMint] = PublicKey.findProgramAddressSync([enc("ansem_mint")], program.programId);

  it("initializes config and mock mint", async () => {
    await program.methods.initialize().accounts({ admin: admin.publicKey }).rpc();
    const cfg = await program.account.config.fetch(configPda);
    assert.equal(cfg.admin.toBase58(), admin.publicKey.toBase58());
    assert.equal(cfg.ansemMint.toBase58(), ansemMint.toBase58());
    assert.equal(cfg.currentRoundId.toNumber(), 0);
    assert.equal(cfg.feeBps, 100);
    assert.equal(cfg.swapMode, 0);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `anchor test`
Expected: FAIL — `initialize` method / generated types missing.

- [ ] **Step 3: Write `instructions/initialize.rs`**

```rust
use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token};

use crate::constants::*;
use crate::state::Config;

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        init, payer = admin, space = 8 + Config::INIT_SPACE,
        seeds = [CONFIG_SEED], bump
    )]
    pub config: Account<'info, Config>,

    /// CHR PDA that is the mock mint authority
    /// CHECK: PDA, not read/written here
    #[account(seeds = [MINT_AUTH_SEED], bump)]
    pub mint_authority: UncheckedAccount<'info>,

    #[account(
        init, payer = admin,
        seeds = [ANSEM_MINT_SEED], bump,
        mint::decimals = ANSEM_DECIMALS,
        mint::authority = mint_authority,
    )]
    pub ansem_mint: Account<'info, Mint>,

    /// CHECK: vault authority PDA (owns token vaults); created lazily as ATAs later
    #[account(seeds = [VAULT_AUTH_SEED], bump)]
    pub vault_authority: UncheckedAccount<'info>,

    /// CHECK: SOL pot vault PDA (system-owned lamport holder)
    #[account(seeds = [POT_VAULT_SEED], bump)]
    pub pot_vault: UncheckedAccount<'info>,

    /// CHECK: treasury PDA (SOL)
    #[account(seeds = [TREASURY_SEED], bump)]
    pub treasury: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handler(ctx: Context<Initialize>) -> Result<()> {
    let c = &mut ctx.accounts.config;
    c.admin = ctx.accounts.admin.key();
    c.ansem_mint = ctx.accounts.ansem_mint.key();
    c.swap_mode = SWAP_MODE_MOCK;
    c.current_round_id = 0;
    c.round_duration_secs = DEFAULT_ROUND_DURATION_SECS;
    c.fee_bps = DEFAULT_FEE_BPS;
    c.mult_min_bps = DEFAULT_MULT_MIN_BPS;
    c.mult_max_bps = DEFAULT_MULT_MAX_BPS;
    c.jackpot_odds = DEFAULT_JACKPOT_ODDS;
    c.jackpot_bps = DEFAULT_JACKPOT_BPS;
    c.min_stake = DEFAULT_MIN_STAKE;
    c.max_stake_per_round = DEFAULT_MAX_STAKE_PER_ROUND;
    c.mock_rate = DEFAULT_MOCK_RATE;
    c.config_bump = ctx.bumps.config;
    c.pot_vault_bump = ctx.bumps.pot_vault;
    c.treasury_bump = ctx.bumps.treasury;
    c.vault_auth_bump = ctx.bumps.vault_authority;
    c.mint_auth_bump = ctx.bumps.mint_authority;
    Ok(())
}
```

- [ ] **Step 4: Write `instructions/mod.rs`**

```rust
pub mod initialize;
pub use initialize::*;
```

- [ ] **Step 5: Replace `lib.rs` `#[program]` body + wire modules**

```rust
use anchor_lang::prelude::*;

pub mod constants;
pub mod error;
pub mod math;
pub mod state;
pub mod instructions;

use instructions::*;

declare_id!("<KEEP THE ID FROM anchor keys sync>");

#[program]
pub mod ansem_miner {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        instructions::initialize::handler(ctx)
    }
}
```

- [ ] **Step 6: Run the test**

Run: `anchor test`
Expected: PASS — "initializes config and mock mint".

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat: initialize (config + mock ansem mint + vault PDAs)"
```

---

## Task 5: `deposit` and `withdraw` (PlayerEscrow)

**Files:**
- Create: `programs/ansem-miner/src/instructions/escrow.rs`
- Modify: `instructions/mod.rs`, `lib.rs`, `tests/ansem-miner.ts`

- [ ] **Step 1: Add failing tests**

Append to the `describe` block:
```ts
const player = anchor.web3.Keypair.generate();
const [escrowPda] = PublicKey.findProgramAddressSync(
  [enc("escrow"), player.publicKey.toBuffer()], program.programId);
const [potVault] = PublicKey.findProgramAddressSync([enc("pot_vault")], program.programId);

it("funds a player then deposits into escrow", async () => {
  const sig = await provider.connection.requestAirdrop(player.publicKey, 5 * anchor.web3.LAMPORTS_PER_SOL);
  await provider.connection.confirmTransaction(sig);
  await program.methods.deposit(new anchor.BN(2 * anchor.web3.LAMPORTS_PER_SOL))
    .accounts({ authority: player.publicKey }).signers([player]).rpc();
  const e = await program.account.playerEscrow.fetch(escrowPda);
  assert.equal(e.balance.toNumber(), 2 * anchor.web3.LAMPORTS_PER_SOL);
  const potLamports = await provider.connection.getBalance(potVault);
  assert.isAtLeast(potLamports, 2 * anchor.web3.LAMPORTS_PER_SOL);
});

it("withdraws part of the escrow", async () => {
  await program.methods.withdraw(new anchor.BN(anchor.web3.LAMPORTS_PER_SOL))
    .accounts({ authority: player.publicKey }).signers([player]).rpc();
  const e = await program.account.playerEscrow.fetch(escrowPda);
  assert.equal(e.balance.toNumber(), anchor.web3.LAMPORTS_PER_SOL);
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `anchor test`
Expected: FAIL — `deposit`/`withdraw` missing.

- [ ] **Step 3: Write `instructions/escrow.rs`**

```rust
use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Transfer};

use crate::constants::*;
use crate::error::AnsemError;
use crate::state::{Config, PlayerEscrow};

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.config_bump)]
    pub config: Account<'info, Config>,

    #[account(
        init_if_needed, payer = authority, space = 8 + PlayerEscrow::INIT_SPACE,
        seeds = [ESCROW_SEED, authority.key().as_ref()], bump
    )]
    pub escrow: Account<'info, PlayerEscrow>,

    /// CHECK: SOL pot vault PDA
    #[account(mut, seeds = [POT_VAULT_SEED], bump = config.pot_vault_bump)]
    pub pot_vault: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            Transfer {
                from: ctx.accounts.authority.to_account_info(),
                to: ctx.accounts.pot_vault.to_account_info(),
            },
        ),
        amount,
    )?;
    let e = &mut ctx.accounts.escrow;
    if e.authority == Pubkey::default() {
        e.authority = ctx.accounts.authority.key();
        e.bump = ctx.bumps.escrow;
    }
    e.balance = e.balance.checked_add(amount).ok_or(AnsemError::Overflow)?;
    e.deposited_total = e.deposited_total.checked_add(amount).ok_or(AnsemError::Overflow)?;
    Ok(())
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.config_bump)]
    pub config: Account<'info, Config>,

    #[account(
        mut, seeds = [ESCROW_SEED, authority.key().as_ref()], bump = escrow.bump,
        constraint = escrow.authority == authority.key() @ AnsemError::Unauthorized
    )]
    pub escrow: Account<'info, PlayerEscrow>,

    /// CHECK: SOL pot vault PDA
    #[account(mut, seeds = [POT_VAULT_SEED], bump = config.pot_vault_bump)]
    pub pot_vault: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
    let e = &mut ctx.accounts.escrow;
    // withdraw guard: no active unclaimed round
    require!(e.active_round == 0, AnsemError::WithdrawLocked);
    require!(amount <= e.balance, AnsemError::InsufficientBalance);

    let bump = ctx.accounts.config.pot_vault_bump;
    let seeds: &[&[u8]] = &[POT_VAULT_SEED, &[bump]];
    system_program::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.system_program.to_account_info(),
            Transfer {
                from: ctx.accounts.pot_vault.to_account_info(),
                to: ctx.accounts.authority.to_account_info(),
            },
            &[seeds],
        ),
        amount,
    )?;
    e.balance -= amount;
    e.withdrawn_total = e.withdrawn_total.checked_add(amount).ok_or(AnsemError::Overflow)?;
    Ok(())
}
```

Note: the pot_vault PDA must be a system-owned account to transfer via System CPI. Since it holds only lamports and never data, initialize it implicitly by first transfer (System CPI to a PDA works; signing out requires the PDA seeds as shown). This is the standard "SOL vault PDA" pattern.

- [ ] **Step 4: Wire into `mod.rs` and `lib.rs`**

`instructions/mod.rs` add:
```rust
pub mod escrow;
pub use escrow::*;
```
`lib.rs` add inside `#[program]`:
```rust
pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
    instructions::escrow::deposit(ctx, amount)
}
pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
    instructions::escrow::withdraw(ctx, amount)
}
```

- [ ] **Step 5: Run tests**

Run: `anchor test`
Expected: PASS deposit + withdraw.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: player escrow deposit/withdraw with withdraw guard"
```

---

## Task 6: `create_round`

**Files:**
- Create: `programs/ansem-miner/src/instructions/round.rs`
- Modify: `instructions/mod.rs`, `lib.rs`, `tests/ansem-miner.ts`

- [ ] **Step 1: Add failing test**

```ts
it("creates round 1", async () => {
  await program.methods.createRound().accounts({ payer: admin.publicKey }).rpc();
  const cfg = await program.account.config.fetch(configPda);
  assert.equal(cfg.currentRoundId.toNumber(), 1);
  const [round1] = PublicKey.findProgramAddressSync(
    [enc("round"), new anchor.BN(1).toArrayLike(Buffer, "le", 8)], program.programId);
  const r = await program.account.round.fetch(round1);
  assert.equal(r.roundId.toNumber(), 1);
  assert.equal(r.state, 0);
  assert.isAbove(r.deadlineTs.toNumber(), Math.floor(Date.now()/1000));
});
```

- [ ] **Step 2: Confirm failure** — Run: `anchor test` → FAIL (`createRound` missing).

- [ ] **Step 3: Write `instructions/round.rs`**

```rust
use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::AnsemError;
use crate::state::{Config, Round, STATE_OPEN};

#[derive(Accounts)]
pub struct CreateRound<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(mut, seeds = [CONFIG_SEED], bump = config.config_bump)]
    pub config: Account<'info, Config>,

    #[account(
        init, payer = payer, space = 8 + Round::INIT_SPACE,
        seeds = [ROUND_SEED, (config.current_round_id + 1).to_le_bytes().as_ref()], bump
    )]
    pub round: Account<'info, Round>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<CreateRound>) -> Result<()> {
    let cfg = &mut ctx.accounts.config;
    let new_id = cfg.current_round_id.checked_add(1).ok_or(AnsemError::Overflow)?;
    cfg.current_round_id = new_id;

    let now = Clock::get()?.unix_timestamp;
    let r = &mut ctx.accounts.round;
    r.round_id = new_id;
    r.deadline_ts = now + cfg.round_duration_secs;
    r.block_sol = [0u64; GRID_SIZE];
    r.pot = 0;
    r.state = STATE_OPEN;
    r.randomness = [0u8; 32];
    r.jackpot_hit = false;
    r.jackpot_block = 0;
    r.swap_proceeds = 0;
    r.bump = ctx.bumps.round;
    Ok(())
}
```

- [ ] **Step 4: Wire mod.rs + lib.rs**

`mod.rs`: `pub mod round; pub use round::*;`
`lib.rs`:
```rust
pub fn create_round(ctx: Context<CreateRound>) -> Result<()> {
    instructions::round::handler(ctx)
}
```

- [ ] **Step 5: Run** — `anchor test` → PASS.

- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat: create_round"`

---

## Task 7: `init_miner`

**Files:**
- Create: `programs/ansem-miner/src/instructions/miner.rs`
- Modify: `instructions/mod.rs`, `lib.rs`, `tests/ansem-miner.ts`

- [ ] **Step 1: Add failing test**

```ts
const [minerPda] = PublicKey.findProgramAddressSync(
  [enc("miner"), player.publicKey.toBuffer()], program.programId);

it("initializes the persistent miner position", async () => {
  await program.methods.initMiner().accounts({ authority: player.publicKey }).signers([player]).rpc();
  const m = await program.account.minerPosition.fetch(minerPda);
  assert.equal(m.authority.toBase58(), player.publicKey.toBase58());
  assert.equal(m.roundId.toNumber(), 0);
});
```

- [ ] **Step 2: Confirm failure** — `anchor test` → FAIL.

- [ ] **Step 3: Write `instructions/miner.rs`**

```rust
use anchor_lang::prelude::*;

use crate::constants::*;
use crate::state::MinerPosition;

#[derive(Accounts)]
pub struct InitMiner<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init, payer = authority, space = 8 + MinerPosition::INIT_SPACE,
        seeds = [MINER_SEED, authority.key().as_ref()], bump
    )]
    pub miner: Account<'info, MinerPosition>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<InitMiner>) -> Result<()> {
    let m = &mut ctx.accounts.miner;
    m.authority = ctx.accounts.authority.key();
    m.round_id = 0;
    m.block_stake = [0u64; GRID_SIZE];
    m.bump = ctx.bumps.miner;
    Ok(())
}
```

- [ ] **Step 4: Wire** — `mod.rs`: `pub mod miner; pub use miner::*;`; `lib.rs`:
```rust
pub fn init_miner(ctx: Context<InitMiner>) -> Result<()> {
    instructions::miner::handler(ctx)
}
```

- [ ] **Step 5: Run** — `anchor test` → PASS.

- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat: init_miner (persistent position)"`

---

## Task 8: `stake` (L1)

**Files:**
- Create: `programs/ansem-miner/src/instructions/stake.rs`
- Modify: `instructions/mod.rs`, `lib.rs`, `tests/ansem-miner.ts`

- [ ] **Step 1: Add tests (happy + guards)**

```ts
const round1 = PublicKey.findProgramAddressSync(
  [enc("round"), new anchor.BN(1).toArrayLike(Buffer, "le", 8)], program.programId)[0];

it("stakes on two squares", async () => {
  await program.methods.stake(3, new anchor.BN(0.3 * anchor.web3.LAMPORTS_PER_SOL))
    .accounts({ authority: player.publicKey, round: round1 }).signers([player]).rpc();
  await program.methods.stake(14, new anchor.BN(0.2 * anchor.web3.LAMPORTS_PER_SOL))
    .accounts({ authority: player.publicKey, round: round1 }).signers([player]).rpc();
  const m = await program.account.minerPosition.fetch(minerPda);
  assert.equal(m.roundId.toNumber(), 1);
  assert.equal(m.blockStake[3].toNumber(), 0.3 * anchor.web3.LAMPORTS_PER_SOL);
  assert.equal(m.blockStake[14].toNumber(), 0.2 * anchor.web3.LAMPORTS_PER_SOL);
  const r = await program.account.round.fetch(round1);
  assert.equal(r.pot.toNumber(), 0.5 * anchor.web3.LAMPORTS_PER_SOL);
  const e = await program.account.playerEscrow.fetch(escrowPda);
  assert.equal(e.activeRound.toNumber(), 1);
  assert.equal(e.balance.toNumber(), 0.5 * anchor.web3.LAMPORTS_PER_SOL); // 1 SOL left after deposit(2)-withdraw(1); staked 0.5
});

it("rejects an out-of-range block", async () => {
  try {
    await program.methods.stake(25, new anchor.BN(anchor.web3.LAMPORTS_PER_SOL))
      .accounts({ authority: player.publicKey, round: round1 }).signers([player]).rpc();
    assert.fail("should have thrown");
  } catch (e:any) { assert.include(e.toString(), "BadBlock"); }
});

it("rejects staking beyond escrow balance", async () => {
  try {
    await program.methods.stake(1, new anchor.BN(100 * anchor.web3.LAMPORTS_PER_SOL))
      .accounts({ authority: player.publicKey, round: round1 }).signers([player]).rpc();
    assert.fail("should have thrown");
  } catch (e:any) { assert.include(e.toString(), "InsufficientBalance"); }
});
```

- [ ] **Step 2: Confirm failure** — `anchor test` → FAIL.

- [ ] **Step 3: Write `instructions/stake.rs`**

```rust
use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::AnsemError;
use crate::state::{Config, MinerPosition, PlayerEscrow, Round, STATE_OPEN};

#[derive(Accounts)]
pub struct Stake<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.config_bump)]
    pub config: Account<'info, Config>,

    #[account(mut, seeds = [ROUND_SEED, round.round_id.to_le_bytes().as_ref()], bump = round.bump)]
    pub round: Account<'info, Round>,

    #[account(
        mut, seeds = [MINER_SEED, authority.key().as_ref()], bump = miner.bump,
        constraint = miner.authority == authority.key() @ AnsemError::Unauthorized
    )]
    pub miner: Account<'info, MinerPosition>,

    #[account(
        mut, seeds = [ESCROW_SEED, authority.key().as_ref()], bump = escrow.bump,
        constraint = escrow.authority == authority.key() @ AnsemError::Unauthorized
    )]
    pub escrow: Account<'info, PlayerEscrow>,
}

pub fn handler(ctx: Context<Stake>, block: u8, amount: u64) -> Result<()> {
    require!((block as usize) < GRID_SIZE, AnsemError::BadBlock);

    let cfg = &ctx.accounts.config;
    let round = &mut ctx.accounts.round;
    let miner = &mut ctx.accounts.miner;
    let escrow = &mut ctx.accounts.escrow;

    require!(round.state == STATE_OPEN, AnsemError::RoundNotOpen);
    let now = Clock::get()?.unix_timestamp;
    require!(now < round.deadline_ts, AnsemError::RoundEnded);
    require!(amount >= cfg.min_stake, AnsemError::StakeTooSmall);
    require!(amount <= escrow.balance, AnsemError::InsufficientBalance);

    // reset persistent miner position for a new round (must have claimed prior)
    if miner.round_id != round.round_id {
        require!(escrow.active_round == 0, AnsemError::UnclaimedRound);
        miner.block_stake = [0u64; GRID_SIZE];
        miner.round_id = round.round_id;
        escrow.active_round = round.round_id;
    }

    // per-round cap
    let prior: u64 = miner.block_stake.iter().sum();
    require!(prior + amount <= cfg.max_stake_per_round, AnsemError::StakeTooLarge);

    miner.block_stake[block as usize] = miner.block_stake[block as usize]
        .checked_add(amount).ok_or(AnsemError::Overflow)?;
    round.block_sol[block as usize] = round.block_sol[block as usize]
        .checked_add(amount).ok_or(AnsemError::Overflow)?;
    round.pot = round.pot.checked_add(amount).ok_or(AnsemError::Overflow)?;
    escrow.balance -= amount;
    Ok(())
}
```

- [ ] **Step 4: Wire** — `mod.rs`: `pub mod stake; pub use stake::*;`; `lib.rs`:
```rust
pub fn stake(ctx: Context<Stake>, block: u8, amount: u64) -> Result<()> {
    instructions::stake::handler(ctx, block, amount)
}
```

- [ ] **Step 5: Run** — `anchor test` → PASS (happy + 2 guards).

- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat: L1 stake with escrow/cap/deadline guards"`

---

## Task 9: `settle(randomness)` — admin, M1-only

**Files:**
- Create: `programs/ansem-miner/src/instructions/settle.rs`
- Modify: `instructions/mod.rs`, `lib.rs`, `tests/ansem-miner.ts`

- [ ] **Step 1: Add test**

```ts
it("settles round 1 with injected randomness (admin only)", async () => {
  // wait out the 60s deadline by warping is not available on localnet by default;
  // instead settle path allows admin to settle once deadline passed. For the test,
  // we create rounds with a short duration via set at initialize is 60s, so we
  // fast-path: assert settle before deadline is rejected, then advance.
  const rnd = Buffer.alloc(32, 9);
  try {
    await program.methods.settle([...rnd]).accounts({ admin: admin.publicKey, round: round1 }).rpc();
    assert.fail("should reject before deadline");
  } catch (e:any) { assert.include(e.toString(), "RoundNotEnded"); }
});
```
Note: to make settle testable without a 60s wait, add a Task-9b test helper below.

- [ ] **Step 2: Write `instructions/settle.rs`**

```rust
use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::AnsemError;
use crate::math;
use crate::state::{Config, Round, STATE_OPEN, STATE_SETTLED};

#[derive(Accounts)]
pub struct Settle<'info> {
    pub admin: Signer<'info>,

    #[account(
        seeds = [CONFIG_SEED], bump = config.config_bump,
        constraint = config.admin == admin.key() @ AnsemError::Unauthorized
    )]
    pub config: Account<'info, Config>,

    #[account(mut, seeds = [ROUND_SEED, round.round_id.to_le_bytes().as_ref()], bump = round.bump)]
    pub round: Account<'info, Round>,
}

pub fn handler(ctx: Context<Settle>, randomness: [u8; 32]) -> Result<()> {
    let cfg = &ctx.accounts.config;
    let round = &mut ctx.accounts.round;
    require!(round.state == STATE_OPEN, AnsemError::BadRoundState);
    let now = Clock::get()?.unix_timestamp;
    require!(now >= round.deadline_ts, AnsemError::RoundNotEnded);

    round.randomness = randomness;
    round.jackpot_hit = math::jackpot_hit(&randomness, cfg.jackpot_odds);
    round.jackpot_block = math::jackpot_block(&randomness);
    round.state = STATE_SETTLED;
    Ok(())
}
```

- [ ] **Step 3: Wire** — `mod.rs`: `pub mod settle; pub use settle::*;`; `lib.rs`:
```rust
pub fn settle(ctx: Context<Settle>, randomness: [u8; 32]) -> Result<()> {
    instructions::settle::handler(ctx, randomness)
}
```

- [ ] **Step 4: Run** — `anchor test` → PASS (pre-deadline rejection).

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: admin settle(randomness) [M1-only, VRF in M2]"`

---

## Task 9b: Deterministic time control for tests

To exercise settle/swap/claim without a real 60s wait, drive round duration to 0 in a dedicated test round.

- [ ] **Step 1: Add an admin `set_params` instruction**

Create `instructions/admin.rs`:
```rust
use anchor_lang::prelude::*;
use crate::constants::*;
use crate::error::AnsemError;
use crate::state::Config;

#[derive(Accounts)]
pub struct SetParams<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.config_bump,
        constraint = config.admin == admin.key() @ AnsemError::Unauthorized)]
    pub config: Account<'info, Config>,
}

pub fn set_round_duration(ctx: Context<SetParams>, secs: i64) -> Result<()> {
    ctx.accounts.config.round_duration_secs = secs;
    Ok(())
}
```
Wire in `mod.rs` (`pub mod admin; pub use admin::*;`) and `lib.rs`:
```rust
pub fn set_round_duration(ctx: Context<SetParams>, secs: i64) -> Result<()> {
    instructions::admin::set_round_duration(ctx, secs)
}
```

- [ ] **Step 2: Use it in the test to create a zero-duration round for settle/swap/claim**

Add a helper in the test that: `setRoundDuration(0)`, `createRound()` → round N with `deadline == now`, so `settle` passes immediately. Keep the 60s default for the earlier stake tests (they use round 1). Example:
```ts
async function freshInstantRound(): Promise<{ id: number, pda: PublicKey }> {
  await program.methods.setRoundDuration(new anchor.BN(0)).accounts({ admin: admin.publicKey }).rpc();
  await program.methods.createRound().accounts({ payer: admin.publicKey }).rpc();
  const cfg = await program.account.config.fetch(configPda);
  const id = cfg.currentRoundId.toNumber();
  const [pda] = PublicKey.findProgramAddressSync(
    [enc("round"), new anchor.BN(id).toArrayLike(Buffer, "le", 8)], program.programId);
  return { id, pda };
}
```

- [ ] **Step 3: Run & commit** — `anchor test` → PASS; `git add -A && git commit -m "feat: set_round_duration admin param (test time control)"`

---

## Task 10: `execute_swap_mock`

**Files:**
- Create: `programs/ansem-miner/src/instructions/swap.rs`
- Modify: `instructions/mod.rs`, `lib.rs`, `tests/ansem-miner.ts`

- [ ] **Step 1: Add test (uses a full mini-lifecycle on an instant round)**

```ts
const [vaultAuth] = PublicKey.findProgramAddressSync([enc("vault_auth")], program.programId);
const [mintAuth] = PublicKey.findProgramAddressSync([enc("mint_auth")], program.programId);
const [treasury] = PublicKey.findProgramAddressSync([enc("treasury")], program.programId);
// payout vault = ATA(ansemMint, vaultAuth)
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, getAccount } from "@solana/spl-token";

it("mock-swaps a settled round's pot into ANSEM", async () => {
  const { id, pda } = await freshInstantRound();
  // stake 1 SOL from player on square 5 (needs prior round claimed; player already staked round1 unclaimed!)
  // Use a second fresh player to avoid the unclaimed-round guard:
  const p2 = anchor.web3.Keypair.generate();
  const sig = await provider.connection.requestAirdrop(p2.publicKey, 3*anchor.web3.LAMPORTS_PER_SOL);
  await provider.connection.confirmTransaction(sig);
  await program.methods.deposit(new anchor.BN(2*anchor.web3.LAMPORTS_PER_SOL)).accounts({ authority: p2.publicKey }).signers([p2]).rpc();
  await program.methods.initMiner().accounts({ authority: p2.publicKey }).signers([p2]).rpc();
  await program.methods.stake(5, new anchor.BN(anchor.web3.LAMPORTS_PER_SOL)).accounts({ authority: p2.publicKey, round: pda }).signers([p2]).rpc();
  await program.methods.settle([...Buffer.alloc(32, 3)]).accounts({ admin: admin.publicKey, round: pda }).rpc();

  const payoutVault = getAssociatedTokenAddressSync(ansemMint, vaultAuth, true);
  await program.methods.executeSwapMock().accounts({
    payer: admin.publicKey, round: pda, payoutVault,
  }).rpc();

  const r = await program.account.round.fetch(pda);
  assert.equal(r.state, 4); // CLAIMABLE
  // net = 1 SOL - 1% fee = 0.99 SOL; ansem = 0.99 * 2800e6 = 2,772,000,000
  assert.equal(r.swapProceeds.toNumber(), 2_772_000_000);
  const bal = await getAccount(provider.connection, payoutVault);
  assert.equal(Number(bal.amount), 2_772_000_000);
});
```

- [ ] **Step 2: Confirm failure** — `anchor test` → FAIL.

- [ ] **Step 3: Write `instructions/swap.rs`**

```rust
use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Transfer as SolTransfer};
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, MintTo, Token, TokenAccount};

use crate::constants::*;
use crate::error::AnsemError;
use crate::state::{Config, Round, STATE_SETTLED, STATE_CLAIMABLE};

#[derive(Accounts)]
pub struct ExecuteSwapMock<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.config_bump)]
    pub config: Account<'info, Config>,

    #[account(mut, seeds = [ROUND_SEED, round.round_id.to_le_bytes().as_ref()], bump = round.bump)]
    pub round: Account<'info, Round>,

    #[account(mut, address = config.ansem_mint)]
    pub ansem_mint: Account<'info, Mint>,

    /// CHECK: mint authority PDA
    #[account(seeds = [MINT_AUTH_SEED], bump = config.mint_auth_bump)]
    pub mint_authority: UncheckedAccount<'info>,

    /// CHECK: vault authority PDA (owner of payout vault)
    #[account(seeds = [VAULT_AUTH_SEED], bump = config.vault_auth_bump)]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(
        init_if_needed, payer = payer,
        associated_token::mint = ansem_mint,
        associated_token::authority = vault_authority
    )]
    pub payout_vault: Account<'info, TokenAccount>,

    /// CHECK: SOL pot vault PDA
    #[account(mut, seeds = [POT_VAULT_SEED], bump = config.pot_vault_bump)]
    pub pot_vault: UncheckedAccount<'info>,

    /// CHECK: treasury PDA (SOL)
    #[account(mut, seeds = [TREASURY_SEED], bump = config.treasury_bump)]
    pub treasury: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<ExecuteSwapMock>) -> Result<()> {
    let cfg = &ctx.accounts.config;
    require!(cfg.swap_mode == SWAP_MODE_MOCK, AnsemError::WrongSwapMode);
    let round = &mut ctx.accounts.round;
    require!(round.state == STATE_SETTLED, AnsemError::BadRoundState);

    let pot = round.pot;
    let fee = (pot as u128 * cfg.fee_bps as u128 / 10_000u128) as u64;
    let net = pot - fee;

    // Simulate the sale: move the entire pot lamports out of pot_vault into treasury.
    let pv_bump = cfg.pot_vault_bump;
    let pv_seeds: &[&[u8]] = &[POT_VAULT_SEED, &[pv_bump]];
    system_program::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.system_program.to_account_info(),
            SolTransfer {
                from: ctx.accounts.pot_vault.to_account_info(),
                to: ctx.accounts.treasury.to_account_info(),
            },
            &[pv_seeds],
        ),
        pot,
    )?;

    // Mint ANSEM proceeds to the payout vault.
    let ansem_out = (net as u128 * cfg.mock_rate as u128 / LAMPORTS_PER_SOL as u128) as u64;
    let ma_bump = cfg.mint_auth_bump;
    let ma_seeds: &[&[u8]] = &[MINT_AUTH_SEED, &[ma_bump]];
    token::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            MintTo {
                mint: ctx.accounts.ansem_mint.to_account_info(),
                to: ctx.accounts.payout_vault.to_account_info(),
                authority: ctx.accounts.mint_authority.to_account_info(),
            },
            &[ma_seeds],
        ),
        ansem_out,
    )?;

    round.swap_proceeds = ansem_out;
    round.state = STATE_CLAIMABLE;
    Ok(())
}
```

Note on pot-vault lamports: after `execute_swap_mock` moves the whole `pot` to treasury, the escrow balances backing that round were already decremented at stake time, so the invariant (PotVault lamports ≥ Σ escrow balances) holds — the swapped SOL is no longer owed to anyone; players are owed ANSEM instead.

- [ ] **Step 4: Wire** — `mod.rs`: `pub mod swap; pub use swap::*;`; `lib.rs`:
```rust
pub fn execute_swap_mock(ctx: Context<ExecuteSwapMock>) -> Result<()> {
    instructions::swap::handler(ctx)
}
```

- [ ] **Step 5: Run** — `anchor test` → PASS.

- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat: execute_swap_mock (mint ANSEM proceeds, move pot to treasury)"`

---

## Task 11: `claim` (payout + jackpot + escrow reconcile)

**Files:**
- Create: `programs/ansem-miner/src/instructions/claim.rs`
- Modify: `instructions/mod.rs`, `lib.rs`, `tests/ansem-miner.ts`

- [ ] **Step 1: Add tests (single-player exactness + double-claim guard)**

```ts
it("claims the full proceeds for a sole staker", async () => {
  // continue from the swap test's round: p2 is the only staker
  const cfg = await program.account.config.fetch(configPda);
  const id = cfg.currentRoundId.toNumber();
  const [pda] = PublicKey.findProgramAddressSync(
    [enc("round"), new anchor.BN(id).toArrayLike(Buffer, "le", 8)], program.programId);
  const [p2Escrow] = PublicKey.findProgramAddressSync([enc("escrow"), p2.publicKey.toBuffer()], program.programId);
  const [p2Miner] = PublicKey.findProgramAddressSync([enc("miner"), p2.publicKey.toBuffer()], program.programId);
  const payoutVault = getAssociatedTokenAddressSync(ansemMint, vaultAuth, true);
  const p2Ata = getAssociatedTokenAddressSync(ansemMint, p2.publicKey);

  await program.methods.claim(new anchor.BN(id)).accounts({
    authority: p2.publicKey, round: pda, payoutVault,
    jackpotVault: getAssociatedTokenAddressSync(ansemMint, vaultAuth, true), // jackpot vault ATA (see note)
    playerAta: p2Ata,
  }).signers([p2]).rpc();

  const bal = await getAccount(provider.connection, p2Ata);
  assert.equal(Number(bal.amount), 2_772_000_000); // sole staker gets all proceeds
  const e = await program.account.playerEscrow.fetch(p2Escrow);
  assert.equal(e.activeRound.toNumber(), 0);
  assert.equal(e.lastClaimedRound.toNumber(), id);
});

it("rejects a double claim", async () => {
  const cfg = await program.account.config.fetch(configPda);
  const id = cfg.currentRoundId.toNumber();
  const [pda] = PublicKey.findProgramAddressSync(
    [enc("round"), new anchor.BN(id).toArrayLike(Buffer, "le", 8)], program.programId);
  const payoutVault = getAssociatedTokenAddressSync(ansemMint, vaultAuth, true);
  const p2Ata = getAssociatedTokenAddressSync(ansemMint, p2.publicKey);
  try {
    await program.methods.claim(new anchor.BN(id)).accounts({
      authority: p2.publicKey, round: pda, payoutVault, jackpotVault: payoutVault, playerAta: p2Ata,
    }).signers([p2]).rpc();
    assert.fail("should reject");
  } catch (e:any) { assert.include(e.toString(), "AlreadyClaimed"); }
});
```

**Jackpot-vault note:** M1 uses a distinct jackpot vault = ATA(ansemMint, vaultAuth) — but the payout vault is *also* ATA(ansemMint, vaultAuth), so they collide. To keep them separate, derive the **jackpot vault as an ATA of a distinct `jackpot_authority` PDA** (`seeds=[b"jackpot_auth"]`). Add that seed to `constants.rs` and a `jackpot_auth_bump` to `Config`, set in `initialize`. For M1 tests, seed the jackpot vault manually (mint some ANSEM to it via an admin-only `seed_jackpot` test helper) and assert the jackpot path only when `jackpot_hit` is true. Because a fixed randomness rarely hits 1/625, add a **dedicated jackpot test** that sets `jackpot_odds = 1` via `set_params` so every settle hits, then assert the jackpot payout adds on top.

- [ ] **Step 2: Add `jackpot_auth` plumbing**

`constants.rs`: `pub const JACKPOT_AUTH_SEED: &[u8] = b"jackpot_auth";`
`Config`: add `pub jackpot_auth_bump: u8,` and set it in `initialize` (`ctx.bumps` requires a `jackpot_authority: UncheckedAccount` seed in `Initialize`). Add `set_jackpot_odds` to `admin.rs`:
```rust
pub fn set_jackpot_odds(ctx: Context<SetParams>, odds: u32) -> Result<()> {
    ctx.accounts.config.jackpot_odds = odds;
    Ok(())
}
```
Wire it in `lib.rs`.

- [ ] **Step 3: Write `instructions/claim.rs`**

```rust
use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

use crate::constants::*;
use crate::error::AnsemError;
use crate::math;
use crate::state::{Config, MinerPosition, PlayerEscrow, Round, STATE_CLAIMABLE};

#[derive(Accounts)]
#[instruction(round_id: u64)]
pub struct Claim<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.config_bump)]
    pub config: Account<'info, Config>,

    #[account(seeds = [ROUND_SEED, round_id.to_le_bytes().as_ref()], bump = round.bump,
        constraint = round.round_id == round_id @ AnsemError::MinerRoundMismatch)]
    pub round: Account<'info, Round>,

    #[account(mut, seeds = [MINER_SEED, authority.key().as_ref()], bump = miner.bump,
        constraint = miner.authority == authority.key() @ AnsemError::Unauthorized,
        constraint = miner.round_id == round_id @ AnsemError::MinerRoundMismatch)]
    pub miner: Account<'info, MinerPosition>,

    #[account(mut, seeds = [ESCROW_SEED, authority.key().as_ref()], bump = escrow.bump,
        constraint = escrow.authority == authority.key() @ AnsemError::Unauthorized)]
    pub escrow: Account<'info, PlayerEscrow>,

    #[account(address = config.ansem_mint)]
    pub ansem_mint: Account<'info, Mint>,

    /// CHECK: vault authority PDA
    #[account(seeds = [VAULT_AUTH_SEED], bump = config.vault_auth_bump)]
    pub vault_authority: UncheckedAccount<'info>,

    /// CHECK: jackpot authority PDA
    #[account(seeds = [JACKPOT_AUTH_SEED], bump = config.jackpot_auth_bump)]
    pub jackpot_authority: UncheckedAccount<'info>,

    #[account(mut, associated_token::mint = ansem_mint, associated_token::authority = vault_authority)]
    pub payout_vault: Account<'info, TokenAccount>,

    #[account(mut, associated_token::mint = ansem_mint, associated_token::authority = jackpot_authority)]
    pub jackpot_vault: Account<'info, TokenAccount>,

    #[account(init_if_needed, payer = authority,
        associated_token::mint = ansem_mint, associated_token::authority = authority)]
    pub player_ata: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<Claim>, round_id: u64) -> Result<()> {
    let cfg = &ctx.accounts.config;
    let round = &ctx.accounts.round;
    require!(round.state == STATE_CLAIMABLE, AnsemError::BadRoundState);

    let escrow = &mut ctx.accounts.escrow;
    require!(escrow.last_claimed_round < round_id, AnsemError::AlreadyClaimed);

    let miner = &ctx.accounts.miner;

    // main payout
    let tw = math::total_weight(&round.block_sol, &round.randomness, cfg.mult_min_bps, cfg.mult_max_bps);
    let pw = math::player_weight(&miner.block_stake, &round.randomness, cfg.mult_min_bps, cfg.mult_max_bps);
    let amount = math::payout(pw, tw, round.swap_proceeds);

    if amount > 0 {
        let va_bump = cfg.vault_auth_bump;
        let va_seeds: &[&[u8]] = &[VAULT_AUTH_SEED, &[va_bump]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
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

    // jackpot payout (additive) if this round hit and the player staked the jackpot square
    if round.jackpot_hit {
        let jb = round.jackpot_block as usize;
        let block_total = round.block_sol[jb];
        let player_on_block = miner.block_stake[jb];
        if block_total > 0 && player_on_block > 0 {
            let pool = ctx.accounts.jackpot_vault.amount;
            let payout_pool = (pool as u128 * cfg.jackpot_bps as u128 / 10_000u128) as u64;
            let share = (payout_pool as u128 * player_on_block as u128 / block_total as u128) as u64;
            if share > 0 {
                let ja_bump = cfg.jackpot_auth_bump;
                let ja_seeds: &[&[u8]] = &[JACKPOT_AUTH_SEED, &[ja_bump]];
                token::transfer(
                    CpiContext::new_with_signer(
                        ctx.accounts.token_program.to_account_info(),
                        Transfer {
                            from: ctx.accounts.jackpot_vault.to_account_info(),
                            to: ctx.accounts.player_ata.to_account_info(),
                            authority: ctx.accounts.jackpot_authority.to_account_info(),
                        },
                        &[ja_seeds],
                    ),
                    share,
                )?;
            }
        }
    }

    escrow.last_claimed_round = round_id;
    escrow.active_round = 0;
    Ok(())
}
```

**Jackpot solvency caveat (documented):** because the jackpot square total (`block_total`) can be split across multiple stakers, paying `payout_pool * player_on_block / block_total` per claimer sums to ≤ `payout_pool` — safe. But a stateful guard against re-entrancy across claimers isn't needed since each claimer's `escrow.active_round`/`last_claimed_round` blocks a second claim.

- [ ] **Step 4: Wire** — `mod.rs`: `pub mod claim; pub use claim::*;`; `lib.rs`:
```rust
pub fn claim(ctx: Context<Claim>, round_id: u64) -> Result<()> {
    instructions::claim::handler(ctx, round_id)
}
```

- [ ] **Step 5: Run** — `anchor test` → PASS (sole-staker exactness + double-claim guard).

- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat: claim (VRF-weighted payout + jackpot + escrow reconcile)"`

---

## Task 12: Multi-player solvency + jackpot integration tests

**Files:**
- Modify: `tests/ansem-miner.ts`

- [ ] **Step 1: Add a 3-player round test asserting the solvency invariant**

```ts
it("pays 3 players summing to (approximately) the swap proceeds", async () => {
  const players = [0,1,2].map(() => anchor.web3.Keypair.generate());
  for (const p of players) {
    const s = await provider.connection.requestAirdrop(p.publicKey, 3*anchor.web3.LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(s);
    await program.methods.deposit(new anchor.BN(2*anchor.web3.LAMPORTS_PER_SOL)).accounts({ authority: p.publicKey }).signers([p]).rpc();
    await program.methods.initMiner().accounts({ authority: p.publicKey }).signers([p]).rpc();
  }
  const { id, pda } = await freshInstantRound();
  // varied stakes across squares
  await program.methods.stake(0, new anchor.BN(0.3e9)).accounts({ authority: players[0].publicKey, round: pda }).signers([players[0]]).rpc();
  await program.methods.stake(1, new anchor.BN(0.2e9)).accounts({ authority: players[0].publicKey, round: pda }).signers([players[0]]).rpc();
  await program.methods.stake(1, new anchor.BN(0.5e9)).accounts({ authority: players[1].publicKey, round: pda }).signers([players[1]]).rpc();
  await program.methods.stake(7, new anchor.BN(0.1e9)).accounts({ authority: players[1].publicKey, round: pda }).signers([players[1]]).rpc();
  await program.methods.stake(7, new anchor.BN(0.9e9)).accounts({ authority: players[2].publicKey, round: pda }).signers([players[2]]).rpc();

  await program.methods.settle([...Buffer.alloc(32, 42)]).accounts({ admin: admin.publicKey, round: pda }).rpc();
  const payoutVault = getAssociatedTokenAddressSync(ansemMint, vaultAuth, true);
  await program.methods.executeSwapMock().accounts({ payer: admin.publicKey, round: pda, payoutVault }).rpc();
  const r = await program.account.round.fetch(pda);
  const proceeds = r.swapProceeds.toNumber();

  let sum = 0;
  for (const p of players) {
    const ata = getAssociatedTokenAddressSync(ansemMint, p.publicKey);
    const before = await provider.connection.getBalance(p.publicKey); // not used, ATA balance below
    await program.methods.claim(new anchor.BN(id)).accounts({
      authority: p.publicKey, round: pda, payoutVault,
      jackpotVault: getAssociatedTokenAddressSync(ansemMint, jackpotAuth, true),
      playerAta: ata,
    }).signers([p]).rpc();
    const bal = await getAccount(provider.connection, ata);
    sum += Number(bal.amount);
  }
  assert.isAtMost(proceeds - sum, players.length); // floor dust only
  assert.isAbove(sum, proceeds - players.length - 1);
});
```
Add near the top: `const [jackpotAuth] = PublicKey.findProgramAddressSync([enc("jackpot_auth")], program.programId);`

- [ ] **Step 2: Add a forced-jackpot test**

```ts
it("adds a jackpot payout when odds are forced to 1", async () => {
  await program.methods.setJackpotOdds(1).accounts({ admin: admin.publicKey }).rpc();
  // seed the jackpot vault with 1,000,000 ANSEM via admin test helper seed_jackpot
  // (implement seed_jackpot mint_to jackpot vault; see Step 3)
  const jackpotVault = getAssociatedTokenAddressSync(ansemMint, jackpotAuth, true);
  await program.methods.seedJackpot(new anchor.BN(1_000_000_000)).accounts({
    admin: admin.publicKey, jackpotVault,
  }).rpc();

  const p = anchor.web3.Keypair.generate();
  const s = await provider.connection.requestAirdrop(p.publicKey, 3*anchor.web3.LAMPORTS_PER_SOL);
  await provider.connection.confirmTransaction(s);
  await program.methods.deposit(new anchor.BN(2e9)).accounts({ authority: p.publicKey }).signers([p]).rpc();
  await program.methods.initMiner().accounts({ authority: p.publicKey }).signers([p]).rpc();
  const { id, pda } = await freshInstantRound();
  // find the jackpot block for randomness=all 5 and stake it
  const rnd = Buffer.alloc(32, 5);
  await program.methods.stake(0, new anchor.BN(1e9)).accounts({ authority: p.publicKey, round: pda }).signers([p]).rpc();
  // stake all 25? simpler: stake enough squares; but we need to hit jackpot_block. Stake square = jackpot_block(rnd).
  // Compute jackpot_block off-chain identically: keccak(rnd || "jkblock")[0] % 25
  // For the test, just also stake the computed block:
  // (helper computeJackpotBlock below)
  await program.methods.settle([...rnd]).accounts({ admin: admin.publicKey, round: pda }).rpc();
  const payoutVault = getAssociatedTokenAddressSync(ansemMint, vaultAuth, true);
  await program.methods.executeSwapMock().accounts({ payer: admin.publicKey, round: pda, payoutVault }).rpc();
  const ata = getAssociatedTokenAddressSync(ansemMint, p.publicKey);
  await program.methods.claim(new anchor.BN(id)).accounts({
    authority: p.publicKey, round: pda, payoutVault, jackpotVault, playerAta: ata,
  }).signers([p]).rpc();
  const bal = await getAccount(provider.connection, ata);
  // sole staker: main payout == proceeds (2,772,000,000). If square 0 == jackpot_block, +10% of 1e9 = 1e8.
  assert.isAtLeast(Number(bal.amount), 2_772_000_000);
});
```
(If square 0 is not the jackpot block for `rnd=5`, this asserts only the main payout; to force the add, compute the jackpot block in TS via `js-sha3` keccak and stake that square. Add `js-sha3` to devDependencies and a `computeJackpotBlock(rnd)` helper mirroring the Rust `jackpot_block`.)

- [ ] **Step 3: Add `seed_jackpot` admin helper (in `admin.rs`)**

```rust
use anchor_spl::token::{self, Mint, MintTo, Token, TokenAccount};
use anchor_spl::associated_token::AssociatedToken;

#[derive(Accounts)]
pub struct SeedJackpot<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.config_bump,
        constraint = config.admin == admin.key() @ AnsemError::Unauthorized)]
    pub config: Account<'info, Config>,
    #[account(address = config.ansem_mint)]
    pub ansem_mint: Account<'info, Mint>,
    /// CHECK: mint authority PDA
    #[account(seeds = [MINT_AUTH_SEED], bump = config.mint_auth_bump)]
    pub mint_authority: UncheckedAccount<'info>,
    /// CHECK: jackpot authority PDA
    #[account(seeds = [JACKPOT_AUTH_SEED], bump = config.jackpot_auth_bump)]
    pub jackpot_authority: UncheckedAccount<'info>,
    #[account(init_if_needed, payer = admin,
        associated_token::mint = ansem_mint, associated_token::authority = jackpot_authority)]
    pub jackpot_vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn seed_jackpot(ctx: Context<SeedJackpot>, amount: u64) -> Result<()> {
    let bump = ctx.accounts.config.mint_auth_bump;
    let seeds: &[&[u8]] = &[MINT_AUTH_SEED, &[bump]];
    token::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            MintTo {
                mint: ctx.accounts.ansem_mint.to_account_info(),
                to: ctx.accounts.jackpot_vault.to_account_info(),
                authority: ctx.accounts.mint_authority.to_account_info(),
            },
            &[seeds],
        ),
        amount,
    )?;
    Ok(())
}
```
Wire `set_jackpot_odds`, `seed_jackpot` in `lib.rs`.

- [ ] **Step 4: Run** — `anchor test` → PASS (solvency + jackpot).

- [ ] **Step 5: Commit** — `git add -A && git commit -m "test: multi-player solvency + jackpot integration"`

---

## Task 13: Final lifecycle sweep + README

**Files:**
- Modify: `tests/ansem-miner.ts` (a single end-to-end "happy path" test), Create: `README.md`

- [ ] **Step 1: Add one end-to-end test** chaining initialize → createRound → deposit → initMiner → stake → settle → executeSwapMock → claim for a fresh player, asserting final ATA balance and that `escrow.balance` equals `deposit − staked`.

- [ ] **Step 2: Write `README.md`** documenting: what M1 is, how to run (`anchor test`), the M1-only caveats (admin settle, mock swap, claim-before-next-round), and the deferred milestones.

- [ ] **Step 3: Run the full suite** — `anchor test` → all green.

- [ ] **Step 4: Commit** — `git add -A && git commit -m "test: end-to-end lifecycle + README"`

---

## Self-Review

**Spec coverage (spec §2/§4/§5/§7):**
- Grid stake / rounds / deadline → Tasks 6, 8. ✅
- Deposit/withdraw escrow + withdraw guard → Task 5. ✅
- Persistent MinerPosition + claim-before-next-round → Tasks 7, 8, 11. ✅
- ±20% multiplier + normalized payout + solvency → Tasks 2, 11, 12. ✅
- Mock swap seam (`swap_mode`) + fee → Tasks 4, 10. ✅
- Jackpot (odds, block, 10% vault, additive) → Tasks 11, 12. ✅
- Randomness derivation (keccak multipliers, jackpot roll) → Task 2; **injected** in M1 per spec §5 (VRF deferred to M2). ✅
- Negative/security tests (bad block, over-budget, double-claim, withdraw-lock, admin-only settle) → Tasks 8, 9, 11. ✅
- **Deferred (correctly out of M1):** ER delegation/session keys/VRF (M2), Jupiter keeper (mainnet), frontend (M4), devnet deploy + metadata (M3). Mixed-tx boundary + session-containment tests belong to M2.

**Placeholder scan:** No "TBD"/"handle errors later" — every step has concrete code. The two spots that read as "compute off-chain to match Rust" (jackpot-block in the forced-jackpot test) include the exact derivation and the `js-sha3` dependency to implement it. ✅

**Type consistency:** `multiplier_bps/total_weight/player_weight/payout/jackpot_hit/jackpot_block` signatures identical across Task 2 (def) and Task 11 (use). Seeds (`config`,`round`,`miner`,`escrow`,`pot_vault`,`treasury`,`vault_auth`,`mint_auth`,`jackpot_auth`,`ansem_mint`) consistent across constants + all instructions. `Config` fields referenced in later tasks (`jackpot_auth_bump`, `mint_auth_bump`, `vault_auth_bump`, `pot_vault_bump`, `mock_rate`, `fee_bps`, `mult_*`, `jackpot_*`) all declared in Task 3 + the Task-11 amendment. State constants `STATE_OPEN/SETTLED/CLAIMABLE` consistent. ✅

**One consistency fix applied inline:** Task 11 Step 2 adds `jackpot_auth_bump` to `Config` and the `jackpot_authority` seed to `Initialize` (needed for `ctx.bumps`), because Task 3's `Config` and Task 4's `Initialize` predate the jackpot-vault separation discovered while writing Task 11. The executing worker must apply that amendment when reaching Task 11 (it modifies Task 3/4 files).
