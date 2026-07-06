# ANSEM Miner — M2a: ER Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delegate the Round and MinerPosition PDAs into a MagicBlock Ephemeral Rollup, move staking onto the ER, relocate the escrow debit to an L1 reconcile-at-commit (with an up-front withdraw-lock), commit state back to L1, and prove the whole loop end-to-end on a two-provider local test stack — with M1's solvency invariant intact.

**Architecture:** M1 runs entirely on L1. M2a splits the hot path: `create_round`/`init_miner` stay L1-init, then a new L1 `delegate_round`/`delegate_miner` hands those PDAs to the delegation program. Players call a new L1 `join_round` (sets `escrow.active_round` — the up-front withdraw-lock — with **no debit**), then `stake` **on the ER** (soft budget check against the read-only escrow clone; writes the delegated `round`/`miner` only). Round-end runs on the ER: `commit_round` (commit **and undelegate** Round → L1 writable) + `commit_miner` (commit-**only**, Miner stays delegated for the next round). Back on L1, a new permissionless `reconcile_miner` debits `escrow.balance`/`config.total_escrow_balance` from the **committed** `miner.block_stake` snapshot; the existing `execute_swap_mock` solvency check (`pot_vault_lamports >= total_escrow_balance`) then gates the swap until every staker is reconciled. Settle stays M1 admin-injected on L1 (real VRF is M2b). Sessions are M2c.

**Tech Stack:** anchor-lang **1.0.2** (done in M2-0), `ephemeral-rollups-sdk` **=0.14.3** (feature `anchor`), `@coral-xyz/anchor` 0.32.1, `@magicblock-labs/ephemeral-rollups-sdk` 0.14.3, `@magicblock-labs/ephemeral-validator` 0.12.0 (npm-global ER validator). All versions **pinned to the installed tooling** per the M2 foundation CORRECTION block — do NOT bump to 0.15.x.

**Grounding references (read the exact patterns, don't invent):**
- `~/spikes/magicblock-engine-examples/roll-dice/programs/roll-dice-delegated/src/lib.rs` — `#[ephemeral]`, `#[delegate]`, `MagicIntentBundleBuilder::new(...).commit_and_undelegate(...)`.
- `~/spikes/magicblock-engine-examples/session-keys/programs/anchor-counter-session/src/lib.rs:79-104` — commit-**only** (`.commit(&[...])`) vs commit-and-undelegate side-by-side, and the `counter.exit(&crate::ID)?` serialize-before-commit call (needed **only** when an ix mutates *and* commits in the same tx).
- `~/spikes/magicblock-engine-examples/roll-dice/tests/roll-dice-delegated.ts` and `rewards-delegated-vrf/tests/*.ts` — two-provider harness, delegate-on-base, ER-ix send, `GetCommitmentSignature`.
- `~/spikes/magicblock-engine-examples/test-locally.sh` — the process orchestration to mirror (base validator + ephemeral-validator + queue-filtering + oracle).
- M2 foundation: `docs/superpowers/specs/2026-07-06-ansem-miner-m2-foundation.md` (READ the top CORRECTION block first — §1/§2c/§4 code below it is superseded).

**Key constants (grounded):**
- Delegation program (DLP) id: `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh`.
- Delegation record PDA: seeds `[b"delegation", delegated_account]` under DLP.
- Local ER validator identity pubkey: `mAGicPQYBMvcYveUZA5F5UNNwyHvfYh5xkLS2Fr1mev`.
- Ports: base `http://127.0.0.1:8899` / ws `:8900`; ER `http://127.0.0.1:7799` / ws `:7800`.
- Our program id (sBPF v3 → preload at genesis, never `anchor deploy`): `8Q9EnK7ydn6ywo7ZxeqhubqYybf7FFNNwnz8JzJjXZjz`, upgrade auth = provider wallet `HKVgAYCTKDdtLyN4hGmBC49Psfb9yxsFWQk3jnBEXnhL`.

**Lifecycle (M2a):**
```
L1:  create_round → delegate_round                     (admin, once per round)
L1:  init_miner → delegate_miner                       (per player, once ever)
L1:  join_round(round_id)                              (per player: sets active_round lock, NO debit)
ER:  stake(block, amount)                              (per player, N times; soft check, no escrow write)
ER:  commit_round()          [commit_and_undelegate]   (round back to L1, writable)
ER:  commit_miner()          [commit only]             (miner snapshot to L1, stays delegated)
L1:  reconcile_miner(round_id)                         (permissionless: debit escrow from committed block_stake)
L1:  settle(randomness)       [M1 admin, unchanged]
L1:  execute_swap_mock()      [M1, unchanged — solvency gate refuses until all reconciled]
L1:  claim(round_id)          [M1, unchanged]
```

**Invariant proof (why reconcile-at-commit is safe):** During ER staking no lamports move (the SOL is already in `pot_vault` from `deposit`); `stake` only mutates delegated `round.pot`/`round.block_sol`/`miner.block_stake`. On L1 before `reconcile_miner`, `total_escrow_balance` still counts the staked lamports as idle **and** the committed `round.pot` counts them as staked → `available = pot_vault - total_escrow_balance = 0 < round.pot` → `execute_swap_mock` returns `Insolvent`. Only after **every** staker's `reconcile_miner` debits `total_escrow_balance` down to true idle does `available >= round.pot` hold and the swap succeed. An un-reconciled staker makes the check **stricter**, never unsafe. Withdrawal is blocked the entire round by `escrow.active_round != 0`.

---

## File Structure

- **Create** `programs/ansem-miner/src/instructions/delegation.rs` — `delegate_round`, `delegate_miner`, `commit_round`, `commit_miner` (all ER-lifecycle CPIs, grouped).
- **Create** `programs/ansem-miner/src/instructions/round_entry.rs` — `join_round` (L1 lock) + `reconcile_miner` (L1 debit).
- **Modify** `programs/ansem-miner/src/instructions/stake.rs` — escrow relocation (soft check, drop debit/`active_round` write).
- **Modify** `programs/ansem-miner/src/instructions/mod.rs` — add the two new modules to the glob re-exports.
- **Modify** `programs/ansem-miner/src/lib.rs` — `#[ephemeral]` + six new instruction entries.
- **Modify** `programs/ansem-miner/src/constants.rs` — no new seeds needed (reuse ROUND/MINER/ESCROW/CONFIG); add `DLP` note only if referenced.
- **Modify** `programs/ansem-miner/src/error.rs` — new error variants (`RoundAlreadyJoined`, `AlreadyReconciled`, `NotCurrentRound`).
- **Modify** `programs/ansem-miner/src/state/miner.rs` — add `reconciled: bool` (per-round, reset on new round).
- **Modify** `programs/ansem-miner/Cargo.toml`, `package.json`, `Anchor.toml` — deps + genesis fixtures.
- **Create** `scripts/test-er.sh` — local two-provider stack orchestration (mirrors `test-locally.sh`).
- **Modify/Create** `tests/ansem-miner-er.ts` — two-provider ER integration suite (keep M1 `tests/ansem-miner.ts` unchanged; it runs base-only).

---

## Task 0: Dependencies + local ER test stack

**Files:**
- Modify: `programs/ansem-miner/Cargo.toml`
- Modify: `package.json`
- Modify: `Anchor.toml`
- Create: `scripts/test-er.sh`

- [ ] **Step 1: Add the ER SDK to Cargo.toml**

Append to `[dependencies]` (keep the M2-0 anchor 1.0.2 + solana-keccak-hasher lines exactly as-is):

```toml
# MagicBlock Ephemeral Rollups: delegation + commit/undelegate + #[ephemeral].
# Pinned to the INSTALLED tooling (vrf-oracle/ephemeral-validator 0.12.0 era),
# NOT crates.io-latest — see the M2 foundation CORRECTION block. No "vrf"
# feature in M2a; VRF is M2b (and comes via standalone ephemeral-vrf-sdk 0.3.0).
ephemeral-rollups-sdk = { version = "=0.14.3", features = ["anchor"] }
```

- [ ] **Step 2: Verify the workspace still builds and M1 is green**

Run: `anchor build 2>&1 | grep -iE "overflows the maximum allowed frame" || echo "no frame overflow"`
Expected: `no frame overflow`, build finishes (adding the crate but not using it yet must not break the build).

Then re-run the M1 regression gate (the existing base-only suite, unchanged):
```bash
pkill -f solana-test-validator 2>/dev/null; sleep 1; rm -rf test-ledger
solana-test-validator --reset --upgradeable-program \
  8Q9EnK7ydn6ywo7ZxeqhubqYybf7FFNNwnz8JzJjXZjz target/deploy/ansem_miner.so \
  HKVgAYCTKDdtLyN4hGmBC49Psfb9yxsFWQk3jnBEXnhL > /tmp/val.log 2>&1 &
until solana cluster-version >/dev/null 2>&1; do sleep 1; done
solana airdrop 100 HKVgAYCTKDdtLyN4hGmBC49Psfb9yxsFWQk3jnBEXnhL
yarn run ts-mocha -p ./tsconfig.json -t 1000000 tests/ansem-miner.ts
pkill -f solana-test-validator
```
Expected: **19 passing** (M1 unaffected). 9 unit tests: `cargo test -p ansem-miner --lib` → **9 passed**.

- [ ] **Step 3: Add TS deps to package.json**

Add to `dependencies` (match the Rust 0.14.3):
```jsonc
"@magicblock-labs/ephemeral-rollups-sdk": "0.14.3"
```
Run `yarn install`. Confirm `node_modules/@magicblock-labs/ephemeral-rollups-sdk/package.json` reports `0.14.3` and that `@magicblock-labs/ephemeral-validator` is installed globally (`vrf-oracle --version` → `vrf-oracle 0.3.0`, `ephemeral-validator --version`). If the ER validator is missing: `npm i -g @magicblock-labs/ephemeral-validator@0.12.0`.

- [ ] **Step 4: Write `scripts/test-er.sh` (mirror the examples' orchestration)**

Read `~/spikes/magicblock-engine-examples/test-locally.sh` first, then adapt it to our sBPF-v3 genesis-preload. The script MUST:
1. `pkill -f solana-test-validator; pkill -f ephemeral-validator; rm -rf test-ledger`.
2. Start the **base** validator with our program preloaded at genesis AND the DLP + MagicBlock programs cloned from devnet (or loaded from local fixtures). Base validator invocation:
   ```bash
   solana-test-validator --reset \
     --upgradeable-program 8Q9EnK7ydn6ywo7ZxeqhubqYybf7FFNNwnz8JzJjXZjz \
        target/deploy/ansem_miner.so HKVgAYCTKDdtLyN4hGmBC49Psfb9yxsFWQk3jnBEXnhL \
     --clone-upgradeable-program DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh \
     --url https://api.devnet.solana.com \
     # (clone any additional magic-program/magic-context accounts the examples clone)
     > /tmp/base-validator.log 2>&1 &
   ```
   **Determine the exact clone list** from `test-locally.sh` (DLP + the magic program/context ids `MagicIntentBundleBuilder` targets). If cloning from devnet is undesirable offline, dump the fixtures once with `solana account -o fixtures/<id>.json --output json <id>` and load with `--account`.
3. Wait for base readiness (`until solana cluster-version …`), airdrop the provider wallet ~1000 SOL (the ER cloner needs a well-funded base per foundation §7.5).
4. Start the **ephemeral-validator** (ER) pointed at the base RPC, serving `:7799`/`:7800`, using the local validator identity `mAGicPQYBMvcYveUZA5F5UNNwyHvfYh5xkLS2Fr1mev`. Mirror the flags from `test-locally.sh`.
5. Wait for ER readiness (poll `curl -s http://127.0.0.1:7799 -X POST … getHealth`).
6. `exec` the test runner: `EPHEMERAL_PROVIDER_ENDPOINT=http://127.0.0.1:7799 EPHEMERAL_WS_ENDPOINT=ws://127.0.0.1:7800 VALIDATOR=mAGicPQYBMvcYveUZA5F5UNNwyHvfYh5xkLS2Fr1mev yarn run ts-mocha -p ./tsconfig.json -t 1000000 tests/ansem-miner-er.ts`.
7. On exit/trap: kill both validators.

- [ ] **Step 5: Verify the stack comes up (no app code yet)**

Run: `bash scripts/test-er.sh` with `tests/ansem-miner-er.ts` containing a single smoke test that (a) both providers connect, (b) `solana program show DELeGG…` (base) succeeds, (c) our program is present on base at slot 0.
Expected: base + ER up; smoke test passes; script tears both down cleanly on exit.

- [ ] **Step 6: Commit**

```bash
git add programs/ansem-miner/Cargo.toml package.json Anchor.toml scripts/test-er.sh tests/ansem-miner-er.ts
git commit -m "feat(m2a-0): add ER SDK 0.14.3 + local two-provider test stack"
```

---

## Task 1: `#[ephemeral]` program macro + new state field + instruction wiring

**Files:**
- Modify: `programs/ansem-miner/src/state/miner.rs`
- Modify: `programs/ansem-miner/src/error.rs`
- Modify: `programs/ansem-miner/src/instructions/mod.rs`
- Modify: `programs/ansem-miner/src/lib.rs`
- Create (stubs): `programs/ansem-miner/src/instructions/delegation.rs`, `programs/ansem-miner/src/instructions/round_entry.rs`

- [ ] **Step 1: Add `reconciled` to MinerPosition**

In `state/miner.rs`, add a field to the `#[account] #[derive(InitSpace)]` struct:
```rust
    /// Per-round flag: set true by reconcile_miner (L1) after this round's
    /// block_stake has been debited from escrow. Reset to false when the ER
    /// stake handler starts a new round (miner.round_id != round.round_id).
    /// Prevents double-debiting escrow for the same round.
    pub reconciled: bool,
```
(No seed/space migration concern on localnet — `init_miner` reinits fresh accounts each test run.)

- [ ] **Step 2: Add error variants**

In `error.rs` add to `AnsemError`:
```rust
    #[msg("Round id is not the current round")]
    NotCurrentRound,
    #[msg("Escrow already joined to a round")]
    RoundAlreadyJoined,
    #[msg("Miner already reconciled for this round")]
    AlreadyReconciled,
```

- [ ] **Step 3: Create empty module files + register them**

Create `instructions/delegation.rs` and `instructions/round_entry.rs` each with `use anchor_lang::prelude::*;` and (for now) nothing else. In `instructions/mod.rs` add (keep the existing glob-export style — Anchor codegen needs the `__client_accounts_*` globs, per the M1 lesson):
```rust
pub mod delegation;
pub mod round_entry;
pub use delegation::*;
pub use round_entry::*;
```

- [ ] **Step 4: Add `#[ephemeral]` to the program module**

In `lib.rs`, above `#[program]`:
```rust
use ephemeral_rollups_sdk::anchor::ephemeral;

#[ephemeral]
#[program]
pub mod ansem_miner {
```
`#[ephemeral]` auto-injects `process_undelegation` + `InitializeAfterUndelegation` (do not write them yourself).

- [ ] **Step 5: Verify build + M1 regression still green**

Run: `anchor build 2>&1 | grep -iE "overflows the maximum allowed frame|error\[" || echo OK` → `OK`.
Run the M1 base-only suite (Task 0 Step 2 block) → **19 passing**, and `cargo test -p ansem-miner --lib` → **9 passed**. `#[ephemeral]` + an unused field must not change M1 behavior.

- [ ] **Step 6: Commit**

```bash
git add programs/ansem-miner/src
git commit -m "feat(m2a-1): #[ephemeral] macro + miner.reconciled + module scaffolding"
```

---

## Task 2: `delegate_round` (L1)

**Files:**
- Modify: `programs/ansem-miner/src/instructions/delegation.rs`
- Modify: `programs/ansem-miner/src/lib.rs`
- Test: `tests/ansem-miner-er.ts`

- [ ] **Step 1: Write the failing test (delegation flips owner to DLP)**

In `tests/ansem-miner-er.ts`, add (base provider):
```ts
it("delegates round 1 into the ER (owner -> DLP)", async () => {
  // assumes initialize + create_round already ran in earlier `it`s
  await program.methods.delegateRound(new anchor.BN(roundId))
    .accounts({ payer: provider.wallet.publicKey, round: roundPda })
    .rpc({ commitment: "confirmed" });
  const acc = await provider.connection.getAccountInfo(roundPda, "confirmed");
  expect(acc!.owner.toBase58()).to.equal("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `bash scripts/test-er.sh` (filtered to this test). Expected: FAIL — `delegateRound` not a function / method missing.

- [ ] **Step 3: Implement `delegate_round`**

In `delegation.rs`:
```rust
use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::{commit, delegate};
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::ephem::MagicIntentBundleBuilder;

use crate::constants::*;

#[delegate]
#[derive(Accounts)]
#[instruction(round_id: u64)]
pub struct DelegateRound<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: delegated via the DLP CPI; UncheckedAccount avoids Anchor
    /// re-serializing after ownership transfers to the delegation program.
    #[account(mut, del, seeds = [ROUND_SEED, round_id.to_le_bytes().as_ref()], bump)]
    pub round: UncheckedAccount<'info>,
}

pub fn delegate_round_handler(ctx: Context<DelegateRound>, round_id: u64) -> Result<()> {
    ctx.accounts.delegate_round(
        &ctx.accounts.payer,
        &[ROUND_SEED, &round_id.to_le_bytes()],
        DelegateConfig {
            // Optional: pin a specific ER validator from the first remaining acct
            validator: ctx.remaining_accounts.first().map(|a| a.key()),
            ..Default::default()
        },
    )?;
    Ok(())
}
```
Add to `lib.rs`:
```rust
    pub fn delegate_round(ctx: Context<DelegateRound>, round_id: u64) -> Result<()> {
        instructions::delegation::delegate_round_handler(ctx, round_id)
    }
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `bash scripts/test-er.sh`. Expected: PASS — round owner is the DLP. (Client passes the local ER validator pubkey in `remainingAccounts`, matching `roll-dice-delegated.ts`.)

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(m2a-2): delegate_round (L1) into the ER"
```

---

## Task 3: `delegate_miner` (L1)

**Files:**
- Modify: `programs/ansem-miner/src/instructions/delegation.rs`
- Modify: `programs/ansem-miner/src/lib.rs`
- Test: `tests/ansem-miner-er.ts`

- [ ] **Step 1: Write the failing test**

```ts
it("delegates the miner (owner -> DLP)", async () => {
  await program.methods.delegateMiner()
    .accounts({ payer: player.publicKey, miner: minerPda })
    .signers([player])
    .rpc({ commitment: "confirmed" });
  const acc = await provider.connection.getAccountInfo(minerPda, "confirmed");
  expect(acc!.owner.toBase58()).to.equal("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
});
```

- [ ] **Step 2: Run it, verify it fails** — Expected: FAIL (`delegateMiner` missing).

- [ ] **Step 3: Implement `delegate_miner`** (miner is delegated ONCE, persists across rounds)

In `delegation.rs`:
```rust
#[delegate]
#[derive(Accounts)]
pub struct DelegateMiner<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: delegated via the DLP CPI.
    #[account(mut, del, seeds = [MINER_SEED, payer.key().as_ref()], bump)]
    pub miner: UncheckedAccount<'info>,
}

pub fn delegate_miner_handler(ctx: Context<DelegateMiner>) -> Result<()> {
    let payer_key = ctx.accounts.payer.key();
    ctx.accounts.delegate_miner(
        &ctx.accounts.payer,
        &[MINER_SEED, payer_key.as_ref()],
        DelegateConfig {
            validator: ctx.remaining_accounts.first().map(|a| a.key()),
            ..Default::default()
        },
    )?;
    Ok(())
}
```
Wire into `lib.rs`:
```rust
    pub fn delegate_miner(ctx: Context<DelegateMiner>) -> Result<()> {
        instructions::delegation::delegate_miner_handler(ctx)
    }
```

- [ ] **Step 4: Run the test, verify it passes** — Expected: PASS (miner owner = DLP).

- [ ] **Step 5: Commit** — `git commit -m "feat(m2a-3): delegate_miner (L1, once, persistent)"`

---

## Task 4: `join_round` (L1) — up-front withdraw-lock, no debit

**Files:**
- Modify: `programs/ansem-miner/src/instructions/round_entry.rs`
- Modify: `programs/ansem-miner/src/lib.rs`
- Test: `tests/ansem-miner-er.ts`

**Design:** `join_round` runs on L1 while `round` is delegated, so it must NOT touch the `round` account (reading a delegated account on L1 is unreliable). It validates `round_id == config.current_round_id`, requires `escrow.active_round == 0` (prior round fully claimed — the M1 "must have claimed prior" guard), sets `escrow.active_round = round_id` (the withdraw-lock), and does **no** balance change. `withdraw` already refuses when `active_round != 0`, so this closes the withdraw-mid-round hole. **The lock is released by `reconcile_miner` (Task 7), not `claim`** — reconcile is the single release point and handles both stakers and join-without-stake players, so no joiner can get permanently locked. (M1 `claim` still sets `active_round = 0`; that's now redundant-but-harmless since reconcile ran first.)

- [ ] **Step 1: Write the failing test**

```ts
it("join_round locks the escrow against withdrawal (no debit)", async () => {
  const before = await program.account.playerEscrow.fetch(escrowPda);
  await program.methods.joinRound(new anchor.BN(roundId))
    .accounts({ authority: player.publicKey, config: configPda, escrow: escrowPda })
    .signers([player]).rpc();
  const after = await program.account.playerEscrow.fetch(escrowPda);
  expect(after.activeRound.toNumber()).to.equal(roundId);
  expect(after.balance.toString()).to.equal(before.balance.toString()); // NO debit
  // withdraw now locked:
  let failed = false;
  try {
    await program.methods.withdraw(new anchor.BN(1))
      .accounts({ authority: player.publicKey, config: configPda, escrow: escrowPda, potVault: potVaultPda })
      .signers([player]).rpc();
  } catch { failed = true; }
  expect(failed).to.equal(true);
});
```

- [ ] **Step 2: Run it, verify it fails** — Expected: FAIL (`joinRound` missing).

- [ ] **Step 3: Implement `join_round`**

In `round_entry.rs`:
```rust
use anchor_lang::prelude::*;
use crate::constants::*;
use crate::error::AnsemError;
use crate::state::{Config, PlayerEscrow};

#[derive(Accounts)]
#[instruction(round_id: u64)]
pub struct JoinRound<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.config_bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [ESCROW_SEED, authority.key().as_ref()], bump = escrow.bump,
        constraint = escrow.authority == authority.key() @ AnsemError::Unauthorized)]
    pub escrow: Account<'info, PlayerEscrow>,
}

pub fn join_round_handler(ctx: Context<JoinRound>, round_id: u64) -> Result<()> {
    let cfg = &ctx.accounts.config;
    require!(round_id == cfg.current_round_id, AnsemError::NotCurrentRound);
    let escrow = &mut ctx.accounts.escrow;
    // Prior round must be fully claimed before joining a new one (M1 invariant).
    require!(escrow.active_round == 0, AnsemError::RoundAlreadyJoined);
    require!(escrow.balance >= cfg.min_stake, AnsemError::InsufficientBalance);
    // Up-front withdraw-lock; NO debit (the debit happens on L1 reconcile_miner
    // after the ER round commits, from the committed block_stake snapshot).
    escrow.active_round = round_id;
    Ok(())
}
```
Wire into `lib.rs`:
```rust
    pub fn join_round(ctx: Context<JoinRound>, round_id: u64) -> Result<()> {
        instructions::round_entry::join_round_handler(ctx, round_id)
    }
```

- [ ] **Step 4: Run the test, verify it passes** — Expected: PASS (locked, no debit).

- [ ] **Step 5: Commit** — `git commit -m "feat(m2a-4): join_round (L1) up-front withdraw-lock"`

---

## Task 5: Move `stake` onto the ER (escrow relocation)

**Files:**
- Modify: `programs/ansem-miner/src/instructions/stake.rs`
- Test: `tests/ansem-miner-er.ts` (ER provider)

**Change summary:** `escrow`/`config` are read-only clones in the ER, so `stake` must not write them. Remove both decrement lines and the `active_round` read/write; keep the block_stake reset, cap checks, and distribution. Add a **soft** budget check `prior + amount <= escrow.balance` (against the clone). Reset `miner.reconciled = false` on new-round entry.

- [ ] **Step 1: Write the failing ER test (stake writes delegated state, escrow untouched)**

```ts
it("stakes on the ER (delegated round/miner updated; L1 escrow untouched)", async () => {
  const escrowBefore = await program.account.playerEscrow.fetch(escrowPda); // L1
  // ER-side stake (ephemeralProgram, session-less in M2a — player signs directly)
  await ephemeralProgram.methods.stake(0, new anchor.BN(stakeAmt))
    .accounts({ authority: player.publicKey, config: configPda, round: roundPda, miner: minerPda, escrow: escrowPda })
    .signers([player]).rpc({ skipPreflight: true, commitment: "confirmed" });
  const miner = await ephemeralProgram.account.minerPosition.fetch(minerPda, "processed"); // ER read
  expect(miner.blockStake[0].toString()).to.equal(stakeAmt.toString());
  const escrowAfter = await program.account.playerEscrow.fetch(escrowPda); // L1 unchanged
  expect(escrowAfter.balance.toString()).to.equal(escrowBefore.balance.toString());
});
```

- [ ] **Step 2: Run it, verify it fails** — Expected: FAIL (old handler tries to write escrow/config → the ER rejects the write on read-only clones, or the balances change on L1).

- [ ] **Step 3: Rewrite `stake_handler` + `Stake` accounts**

Replace `stake.rs` with (escrow read-only; no L1 writes):
```rust
use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::AnsemError;
use crate::state::{Config, MinerPosition, PlayerEscrow, Round, STATE_OPEN};

#[derive(Accounts)]
pub struct Stake<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    // Read-only clone in the ER — used only to read caps/budget, never written.
    #[account(seeds = [CONFIG_SEED], bump = config.config_bump)]
    pub config: Account<'info, Config>,

    // Delegated in the ER (writable there).
    #[account(mut, seeds = [ROUND_SEED, round.round_id.to_le_bytes().as_ref()], bump = round.bump)]
    pub round: Account<'info, Round>,

    // Delegated in the ER (writable there).
    #[account(mut, seeds = [MINER_SEED, authority.key().as_ref()], bump = miner.bump,
        constraint = miner.authority == authority.key() @ AnsemError::Unauthorized)]
    pub miner: Account<'info, MinerPosition>,

    // Read-only clone — soft budget check only (drop `mut`; no debit here).
    #[account(seeds = [ESCROW_SEED, authority.key().as_ref()], bump = escrow.bump,
        constraint = escrow.authority == authority.key() @ AnsemError::Unauthorized)]
    pub escrow: Account<'info, PlayerEscrow>,
}

pub fn stake_handler(ctx: Context<Stake>, block: u8, amount: u64) -> Result<()> {
    require!((block as usize) < GRID_SIZE, AnsemError::BadBlock);

    let min_stake = ctx.accounts.config.min_stake;
    let max_stake_per_round = ctx.accounts.config.max_stake_per_round;
    let escrow_balance = ctx.accounts.escrow.balance;

    let round = &mut ctx.accounts.round;
    let miner = &mut ctx.accounts.miner;

    require!(round.state == STATE_OPEN, AnsemError::RoundNotOpen);
    let now = Clock::get()?.unix_timestamp;
    require!(now < round.deadline_ts, AnsemError::RoundEnded);
    require!(amount >= min_stake, AnsemError::StakeTooSmall);

    // New-round entry: reset the persistent miner. The L1 `join_round`
    // already set escrow.active_round and enforced "prior round claimed",
    // so the ER path does NOT read/write escrow.active_round.
    if miner.round_id != round.round_id {
        miner.block_stake = [0u64; GRID_SIZE];
        miner.round_id = round.round_id;
        miner.reconciled = false;
    }

    // Per-round cap AND soft budget check against the (read-only) escrow clone.
    // The clone can be slightly stale, but escrow.balance only decreases via
    // withdraw — which is locked all round by active_round — so it is a safe
    // upper bound. The HARD accounting is L1 reconcile_miner.
    let prior: u64 = miner.block_stake.iter().sum();
    let new_total = prior.checked_add(amount).ok_or(AnsemError::Overflow)?;
    require!(new_total <= max_stake_per_round, AnsemError::StakeTooLarge);
    require!(new_total <= escrow_balance, AnsemError::InsufficientBalance);

    miner.block_stake[block as usize] =
        miner.block_stake[block as usize].checked_add(amount).ok_or(AnsemError::Overflow)?;
    round.block_sol[block as usize] =
        round.block_sol[block as usize].checked_add(amount).ok_or(AnsemError::Overflow)?;
    round.pot = round.pot.checked_add(amount).ok_or(AnsemError::Overflow)?;
    // NOTE: escrow debit + total_escrow_balance decrement intentionally removed —
    // relocated to L1 reconcile_miner (see round_entry.rs).
    Ok(())
}
```

- [ ] **Step 4: Run the test, verify it passes** — Expected: PASS (ER `miner.block_stake[0] == stakeAmt`; L1 escrow unchanged).

- [ ] **Step 5: Commit** — `git commit -m "feat(m2a-5): move stake onto the ER (escrow debit relocated to L1)"`

---

## Task 6: `commit_round` + `commit_miner` (ER)

**Files:**
- Modify: `programs/ansem-miner/src/instructions/delegation.rs`
- Modify: `programs/ansem-miner/src/lib.rs`
- Test: `tests/ansem-miner-er.ts`

**Design:** `commit_round` = `commit_and_undelegate` (Round returns to L1 program-writable so `settle`/`swap`/`claim` can mutate it). `commit_miner` = `commit` only (Miner flushes its `block_stake` snapshot to L1 for `reconcile_miner`/`claim` to read, but STAYS delegated for the next round's ER stake). Neither ix mutates the account, so **no `.exit()` is needed** (that's only for mutate-then-commit-in-one-ix, per anchor-counter-session:115).

- [ ] **Step 1: Write the failing test (state lands on L1 after commit)**

```ts
it("commits round (undelegate) + miner (commit-only) back to L1", async () => {
  // commit round -> undelegate
  const sigR = await ephemeralProgram.methods.commitRound()
    .accounts({ payer: player.publicKey, round: roundPda })
    .signers([player]).rpc({ skipPreflight: true, commitment: "confirmed" });
  await GetCommitmentSignature(sigR, ephemeralProgram.provider.connection);
  const roundAcc = await provider.connection.getAccountInfo(roundPda, "confirmed"); // L1
  expect(roundAcc!.owner.toBase58()).to.equal(program.programId.toBase58()); // back to us

  // commit miner -> stays delegated but snapshot visible on L1
  const sigM = await ephemeralProgram.methods.commitMiner()
    .accounts({ payer: player.publicKey, miner: minerPda })
    .signers([player]).rpc({ skipPreflight: true, commitment: "confirmed" });
  await GetCommitmentSignature(sigM, ephemeralProgram.provider.connection);
  const miner = await program.account.minerPosition.fetch(minerPda); // L1 read of committed snapshot
  expect(miner.blockStake[0].toString()).to.equal(stakeAmt.toString());
  const minerAcc = await provider.connection.getAccountInfo(minerPda, "confirmed");
  expect(minerAcc!.owner.toBase58()).to.equal("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh"); // still delegated
});
```
(Import `GetCommitmentSignature` from `@magicblock-labs/ephemeral-rollups-sdk`.)

- [ ] **Step 2: Run it, verify it fails** — Expected: FAIL (`commitRound`/`commitMiner` missing).

- [ ] **Step 3: Implement both commits**

Append to `delegation.rs`:
```rust
#[commit]
#[derive(Accounts)]
pub struct CommitRound<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut)]
    pub round: Account<'info, crate::state::Round>,
}

pub fn commit_round_handler(ctx: Context<CommitRound>) -> Result<()> {
    MagicIntentBundleBuilder::new(
        ctx.accounts.payer.to_account_info(),
        ctx.accounts.magic_context.to_account_info(),
        ctx.accounts.magic_program.to_account_info(),
    )
    .commit_and_undelegate(&[ctx.accounts.round.to_account_info()])
    .build_and_invoke()?;
    Ok(())
}

#[commit]
#[derive(Accounts)]
pub struct CommitMiner<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut)]
    pub miner: Account<'info, crate::state::MinerPosition>,
}

pub fn commit_miner_handler(ctx: Context<CommitMiner>) -> Result<()> {
    MagicIntentBundleBuilder::new(
        ctx.accounts.payer.to_account_info(),
        ctx.accounts.magic_context.to_account_info(),
        ctx.accounts.magic_program.to_account_info(),
    )
    .commit(&[ctx.accounts.miner.to_account_info()]) // commit only, stays delegated
    .build_and_invoke()?;
    Ok(())
}
```
Wire both into `lib.rs`:
```rust
    pub fn commit_round(ctx: Context<CommitRound>) -> Result<()> {
        instructions::delegation::commit_round_handler(ctx)
    }
    pub fn commit_miner(ctx: Context<CommitMiner>) -> Result<()> {
        instructions::delegation::commit_miner_handler(ctx)
    }
```

- [ ] **Step 4: Run the test, verify it passes** — Expected: PASS (round owner back to us; miner snapshot on L1, still DLP-owned).

- [ ] **Step 5: Commit** — `git commit -m "feat(m2a-6): commit_round (undelegate) + commit_miner (commit-only)"`

---

## Task 7: `reconcile_miner` (L1) — debit escrow from the committed snapshot

**Files:**
- Modify: `programs/ansem-miner/src/instructions/round_entry.rs`
- Modify: `programs/ansem-miner/src/lib.rs`
- Test: `tests/ansem-miner-er.ts`

**Design:** Permissionless (anyone can call — pure accounting, mirrors M1 `refund`). It is also the **single lock-release point** (this fixes the join-without-stake dead-lock the self-review found: a player who `join_round`s but never stakes can't `claim` — round_id mismatch — and `refund` only works on *cancelled* rounds, so `reconcile_miner` must clear the lock for them too). Behaviour:
- Requires `escrow.active_round == round_id` (a genuine joiner of this round).
- If the committed `miner.round_id == round_id` and `!miner.reconciled`: debit `escrow.balance`/`config.total_escrow_balance` by `sum(block_stake)` and set `miner.reconciled = true`. Otherwise (joined but never staked this round): debit nothing.
- Always clears `escrow.active_round = 0` at the end → unlocks withdrawal of the (now-idle) remainder.

**Why clearing the lock here is solvency-safe:** after the debit, the staked lamports are removed from `total_escrow_balance` (now backing `round.pot` instead). If the player then withdraws their idle remainder, `pot_vault` and `total_escrow_balance` drop by the *same* amount, so `available = pot_vault - total_escrow_balance` is unchanged and `round.pot`'s backing is untouched — `execute_swap_mock` stays solvent. Ordering (reconcile before swap) is still enforced automatically by the swap's `available >= round.pot` check. `require!(escrow.active_round == round_id)` makes a second call idempotent (active_round is now 0).

- [ ] **Step 1: Write the failing test (debits once, clears the lock; join-without-stake also unlocks)**

```ts
it("reconcile_miner debits escrow from committed block_stake AND clears the lock", async () => {
  const eBefore = await program.account.playerEscrow.fetch(escrowPda);
  const cBefore = await program.account.config.fetch(configPda);
  await program.methods.reconcileMiner(new anchor.BN(roundId))
    .accounts({ config: configPda, miner: minerPda, escrow: escrowPda }).rpc();
  const eAfter = await program.account.playerEscrow.fetch(escrowPda);
  const cAfter = await program.account.config.fetch(configPda);
  expect(eBefore.balance.sub(eAfter.balance).toString()).to.equal(stakeAmt.toString());
  expect(cBefore.totalEscrowBalance.sub(cAfter.totalEscrowBalance).toString()).to.equal(stakeAmt.toString());
  expect(eAfter.activeRound.toNumber()).to.equal(0); // lock released
  // idempotent: second call rejects (active_round now 0 != round_id)
  let failed = false;
  try { await program.methods.reconcileMiner(new anchor.BN(roundId))
    .accounts({ config: configPda, miner: minerPda, escrow: escrowPda }).rpc(); } catch { failed = true; }
  expect(failed).to.equal(true);
});
```
Add a second test: a player who `join_round`s but never stakes (their `miner.round_id != roundId`) can still `reconcile_miner` to unlock — assert no debit and `activeRound == 0`.

- [ ] **Step 2: Run it, verify it fails** — Expected: FAIL (`reconcileMiner` missing).

- [ ] **Step 3: Implement `reconcile_miner`**

Append to `round_entry.rs` (add `Config`, `MinerPosition` to the `use crate::state::{…}`). Note `miner`'s round_id is checked in the **body**, not the macro, so the join-without-stake case is reachable:
```rust
#[derive(Accounts)]
#[instruction(round_id: u64)]
pub struct ReconcileMiner<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.config_bump)]
    pub config: Account<'info, Config>,
    // Committed (post commit_miner) snapshot; belongs to `escrow`'s authority.
    #[account(mut, seeds = [MINER_SEED, escrow.authority.as_ref()], bump = miner.bump)]
    pub miner: Account<'info, MinerPosition>,
    #[account(mut, seeds = [ESCROW_SEED, escrow.authority.as_ref()], bump = escrow.bump)]
    pub escrow: Account<'info, PlayerEscrow>,
}

pub fn reconcile_miner_handler(ctx: Context<ReconcileMiner>, round_id: u64) -> Result<()> {
    // Only a genuine joiner of THIS round; also makes the call idempotent
    // (active_round is set to 0 at the end).
    require!(ctx.accounts.escrow.active_round == round_id, AnsemError::NotCurrentRound);

    let miner = &mut ctx.accounts.miner;
    // Debit only if this player actually staked in this round.
    if miner.round_id == round_id && !miner.reconciled {
        let staked: u64 = miner.block_stake.iter().sum();
        let escrow_bal = ctx.accounts.escrow.balance;
        ctx.accounts.escrow.balance = escrow_bal.checked_sub(staked).ok_or(AnsemError::Overflow)?;
        let cfg = &mut ctx.accounts.config;
        cfg.total_escrow_balance =
            cfg.total_escrow_balance.checked_sub(staked).ok_or(AnsemError::Overflow)?;
        miner.reconciled = true;
    }

    // Single lock-release point: unlock withdrawal of the idle remainder.
    ctx.accounts.escrow.active_round = 0;
    Ok(())
}
```
> **Implementer note:** If Anchor refuses to deserialize `miner` because it is still DLP-owned after `commit`, that is the ordering signal that `reconcile_miner` must read the *committed* L1 copy. Decision rule tied to Task 6: the Task 6 test already does `program.account.minerPosition.fetch(minerPda)` on L1 and asserts the snapshot — **if that fetch passed, `Account<MinerPosition>` here works too.** If it did not, take `miner` as `UncheckedAccount` and `MinerPosition::try_deserialize` manually.

Wire into `lib.rs`:
```rust
    pub fn reconcile_miner(ctx: Context<ReconcileMiner>, round_id: u64) -> Result<()> {
        instructions::round_entry::reconcile_miner_handler(ctx, round_id)
    }
```

- [ ] **Step 4: Run the test, verify it passes** — Expected: PASS (one debit, lock cleared; join-without-stake unlocks with no debit; second call → `NotCurrentRound`).

- [ ] **Step 5: Commit** — `git commit -m "feat(m2a-7): reconcile_miner (L1) debit from committed snapshot"`

---

## Task 8: Full two-provider end-to-end integration test

**Files:**
- Modify: `tests/ansem-miner-er.ts`

**Goal:** One test drives the entire M2a lifecycle for a sole staker and asserts the solvency gate + payout. This is the real verification of the ER path.

- [ ] **Step 1: Write the end-to-end test**

```ts
it("e2e: create->delegate->join->stake(ER)->commit->reconcile->settle->swap->claim", async () => {
  // ... initialize, deposit, create_round, delegate_round (base) ...
  // ... init_miner, delegate_miner (base) ...
  // join_round (base): lock escrow
  // stake on ER (ephemeralProgram)
  // commit_round + commit_miner on ER; await GetCommitmentSignature for both

  // Solvency gate: swap BEFORE reconcile must fail Insolvent
  let preFailed = false;
  try { await program.methods.executeSwapMock().accounts(swapAccounts(roundPda)).rpc(); }
  catch (e) { preFailed = /Insolvent/.test(e.toString()); }
  expect(preFailed).to.equal(true);

  // reconcile_miner (base) -> now swap can proceed
  await program.methods.reconcileMiner(new anchor.BN(roundId))
    .accounts({ config: configPda, miner: minerPda, escrow: escrowPda }).rpc();

  // settle (M1 admin, base) with injected randomness, after deadline
  await settleAfterDeadline(roundPda, rnd); // reuse M1 helper
  // swap (base) now succeeds
  await program.methods.executeSwapMock().accounts(swapAccounts(roundPda)).rpc();
  // claim (base)
  await program.methods.claim(new anchor.BN(roundId)).accounts(claimAccounts(...)).signers([player]).rpc();

  const ata = await getAccount(provider.connection, playerAta);
  expect(Number(ata.amount)).to.be.greaterThan(0); // received ANSEM proceeds
});
```
Port the M1 helpers (`settleAfterDeadline`, `swapAccounts`, `claimAccounts`) into `ansem-miner-er.ts` or import them.

- [ ] **Step 2: Run the full suite** — `bash scripts/test-er.sh`. Expected: **all ER tests pass**, including the pre-reconcile `Insolvent` assertion (proves the solvency gate) and a positive ANSEM payout.

- [ ] **Step 3: Re-run the M1 base-only regression** — `tests/ansem-miner.ts` still **19 passing**, `cargo test --lib` still **9 passed** (M2a must not regress M1).

- [ ] **Step 4: Commit** — `git commit -m "feat(m2a-8): end-to-end two-provider ER lifecycle test"`

---

## Task 9: Robustness — cancelled-round path + docs

**Files:**
- Modify: `programs/ansem-miner/src/instructions/recovery.rs` (only if a delegated round needs handling)
- Modify: `README.md`, `docs/superpowers/specs/2026-07-06-ansem-miner-design.md`
- Test: `tests/ansem-miner-er.ts`

- [ ] **Step 1: Test — cancelling a delegated, abandoned round**

M1 `cancel_round` is L1 and reads `round.state`. If the round is still delegated (nobody committed), L1 cannot act on it. Write a test that a round delegated but never committed can be recovered: the admin must first `commit_round` (undelegate) — but `commit_round` is an ER ix requiring the ER. Assert the intended recovery path: **admin `commit_round` on the ER (force-undelegate) → then L1 `cancel_round` → `refund`.** If the ER is unreachable, document this as a known M2a limitation (a delegated round cannot be cancelled purely from L1; needs the ER to undelegate first). Add the test if the path works; otherwise add a `describe.skip` with a comment referencing this limitation.

- [ ] **Step 2: Confirm `refund` still zeroes `active_round`**

M1 `refund_handler` sets `active_round = 0`. With M2a's `join_round` lock, a cancelled round's staker must be able to `refund` to unlock withdrawal. Verify `refund` path leaves `escrow.active_round == 0` and `reconciled` irrelevant (no debit happened for a cancelled round, so no reconcile needed). Add an assertion.

- [ ] **Step 3: Update docs**

- `README.md`: replace "M2 (planned)" bullet with an "M2a: ER foundation (implemented)" section — the lifecycle diagram above, the two-provider run command (`bash scripts/test-er.sh`), and the note that VRF/sessions are M2b/M2c.
- Design spec: add the escrow-relocation decision (reconcile-at-commit + up-front lock) and the solvency-gate reasoning to the M2 section.

- [ ] **Step 4: Run both suites green, commit**

```bash
bash scripts/test-er.sh          # ER suite green
# M1 base-only suite green (19), cargo --lib green (9)
git commit -m "feat(m2a-9): cancelled-delegated-round path + M2a docs"
```

---

## Final review

After all tasks: dispatch a code-reviewer over the full M2a diff against this plan and the M2 foundation CORRECTION block. Then use **superpowers:finishing-a-development-branch**.

**Watch items (call out in review):**
1. **Escrow double-debit / under-debit** — the single highest-risk logic change. Confirm exactly one `reconcile_miner` per (miner, round) via `reconciled`, and that the debit equals `sum(block_stake)`.
2. **Solvency gate ordering** — confirm the pre-reconcile swap actually returns `Insolvent` (Task 8 Step 2). This is the load-bearing safety property.
3. **`del` token, not `#[del]`** — delegate structs use `#[account(mut, del, …)]` (bare token) on `UncheckedAccount`.
4. **`.exit()` only when mutate+commit in one ix** — our commit ixs are pure, so none is used; flag any future ix that mutates a delegated account and commits in the same tx.
5. **No frame overflow** — `anchor build` must stay clean; if adding accounts to `Claim`/`ExecuteSwapMock`, keep the `Box<Account>` mitigation.
6. **Test-stack hygiene** — `scripts/test-er.sh` must kill BOTH validators on exit; never leave a stray `solana-test-validator`/`ephemeral-validator` (guardrail: validator hygiene).
