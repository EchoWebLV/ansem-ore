# ANSEM Miner — M2b (Ephemeral VRF settle) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the *randomness source* at settle with real MagicBlock Ephemeral VRF — add ER `request_settle` (fires a VRF request, sets `VrfPending`) + `settle_callback` (VRF-identity-only, writes randomness + jackpot rolls, sets `Settled`) — while keeping M1's admin `settle` intact as a devnet/test fallback and all existing suites green.

**Architecture:** The M1 settle math (`math::jackpot_hit` / `jackpot_block`) is reused verbatim; only the 32-byte randomness *origin* changes from an admin instruction argument to a VRF oracle callback. VRF runs **inside the ER** against the delegated `Round`; the oracle CPIs `settle_callback` with the drawn randomness, proven by an injected `VRF_PROGRAM_IDENTITY` signer. Downstream `commit_round → execute_swap_mock → claim` are unchanged and don't care which path produced `Settled`.

**Tech stack (ground-truth-verified against `~/spikes/magicblock-engine-examples/rewards-delegated-vrf`, which pins the identical trio):** `ephemeral-rollups-sdk =0.14.3` (feature `anchor`), **new** `ephemeral-vrf-sdk =0.3.0` (feature `anchor`), `anchor-lang =1.0.2`, local `vrf-oracle 0.3.0`. Non-scoped API (`create_request_randomness_ix` + global `VRF_PROGRAM_IDENTITY`), matching the installed 0.3.0 oracle — NOT the scoped 0.4.1 path.

---

## ⚠️ AS-BUILT CORRECTION — VRF settle runs on L1, not in the ER

The plan below (Tasks 3–4) originally requested VRF **inside the ER** (per spec §4). During implementation this proved unworkable on the local stack: an in-ER VRF request must write the oracle **queue**, but the local `ephemeral-validator` does **not delegate that queue to itself**, so the ER's Magic finalizer rejects the write (`InvalidWritableAccount`) regardless of `--lifecycle` (`ephemeral` *or* `replica`) or whether the oracle is running. The queue is owned by the VRF program (`Vrf1RNU…`) on both layers, never the DLP. This is exactly the foundation's unresolved risk §7.4 ("VRF-in-ER composition actually fulfilling locally"), now confirmed — the pins were de-risked by reading sources, never by running VRF-in-ER.

**Resolution (implemented + green): settle on L1 after commit.** Settle is a once-per-round event — it does not need the ER hot path. The flow is `stake (ER) → commit_round/commit_miner (undelegate) → request_settle (L1) → base oracle callback → settle_callback (L1, Settled) → reconcile → swap → claim`. On L1 the VRF queue is an ordinary writable account and the **base** oracle fulfills the request (the standard, proven VRF path — what roll-dice's non-delegated `roll_dice` uses). **The program code (`request_settle`/`settle_callback`) is unchanged** — only *where* it is invoked (base program, post-commit, base queue `GKE6d7…`) moved. The ER still owns the staking hot path.

Consequent deltas to the tasks below:
- **Task 3** (oracle in stack): the **VRF suite owns the oracle lifecycle** (spawns the BASE oracle from the test, up only for the request→callback window). Running any oracle during ER staking starves the single machine and flakes cold-account clones, so it stays down for the ER phase. `test-er.sh` only verifies `vrf-oracle` is installed.
- **Task 4** (test): standalone `tests/ansem-miner-vrf.ts` (own round 1, fresh player). ER txs use idempotent tolerant sends (the cold ER stake clone-lags on a loaded machine → mangled confirm errors even though it lands). The same hardening was applied to M2a's task-5 stake. Run: `TEST_FILE=tests/ansem-miner-vrf.ts bash scripts/test-er.sh`.
- **Follow-up (mainnet):** revisit in-ER VRF on managed MagicBlock infra (devnet/mainnet), where the ER's VRF queue *is* delegated to the validator, if in-ER settle is ever wanted. Not needed for the mechanic.

---

## Key decisions (locked before coding)

1. **Keep admin `settle`; add VRF alongside.** Do NOT delete `Settle`/`settle_handler`. The entire M1 base-only suite (19 tests) and the M2a ER e2e settle-tail use admin `settle`; VRF settle *requires* the ER + oracle stack, so forcing every test onto VRF would drag the base-only suite onto the ER. Both paths write the same `Round` fields → `STATE_SETTLED`. Mainnet (M5) gates/removes admin `settle`; tracked as a follow-up, not M2b.
2. **`request_settle` stays admin-gated for M2b** (`config.admin == payer`), exactly inheriting M1's settle trust boundary (spec §6.5). This also neutralizes oracle-queue griefing: a permissionless crank could post a `VrfPending` request to a bogus queue and strand the round; an admin-gated request cannot. A permissionless crank + "VRF never called back" refund is a deferred liveness follow-up.
3. **Oracle queue is client/env-supplied, not hardcoded.** The local oracle services `Sc9MJUngNbQXSXGP3F67KvKwVnhaYn6kcioxXNVowYT` (the ER test queue), not the SDK default `5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc`. So `oracle_queue` is a `#[account(mut)]` UncheckedAccount with **no address constraint** (integrity lives entirely on the callback's `VRF_PROGRAM_IDENTITY` guard, not on which queue the request is posted to). Tests pass `VRF_EPHEMERAL_QUEUE`; mainnet passes the canonical queue. Hardening (pin the queue in `Config`) is a follow-up.
4. **Callback is a plain `#[derive(Accounts)]`** (no `#[vrf_callback]`, no `#[commit]`). The rewards example uses `#[commit]` only because its callback schedules a Magic transfer; ours does a pure state write to the already-delegated `Round`, so no Magic CPI, no `magic_fee_vault`/`MAGIC_PROGRAM_ID`/`MAGIC_CONTEXT_ID` metas.

---

## File structure

- **Create** `programs/ansem-miner/src/instructions/vrf_settle.rs` — `RequestSettle` + `SettleCallback` structs and handlers. (Keep `settle.rs` untouched.)
- **Modify** `programs/ansem-miner/Cargo.toml` — add `ephemeral-vrf-sdk =0.3.0`.
- **Modify** `programs/ansem-miner/src/instructions/mod.rs` — `pub mod vrf_settle; pub use vrf_settle::*;`.
- **Modify** `programs/ansem-miner/src/lib.rs` — two new instruction entries `request_settle` / `settle_callback`.
- **Modify** `scripts/test-er.sh` — launch two `vrf-oracle` instances (base + ER) with a `SKIP_VRF=1` escape hatch; export `VRF_EPHEMERAL_QUEUE`.
- **Modify** `tests/ansem-miner-er.ts` — one new test: delegate → `request_settle` (ER) → await callback → assert `Settled` + randomness → commit → swap → claim.
- **Modify** README + design spec + memory.

---

### Task 1: Add the `ephemeral-vrf-sdk 0.3.0` dependency and prove it links

**Files:**
- Modify: `programs/ansem-miner/Cargo.toml`

**Risk this de-risks first:** 0.3.0 source is not in the local cargo cache (only 0.4.1 is). It resolves from crates.io with checksum `3f6f6d796808e62cac2734c58731e8f7a43a7b9725587c0ceb2f94ab8b0a1421` (verified in both example lockfiles). If `cargo`/`anchor build` refuses it as yanked, seed `Cargo.lock` with the exact entry from `~/spikes/magicblock-engine-examples/roll-dice/Cargo.lock`.

- [ ] **Step 1: Add the dependency** under the existing `ephemeral-rollups-sdk` line in `[dependencies]`:

```toml
# M2b: Ephemeral VRF. Standalone crate PINNED to =0.3.0 to match the installed
# vrf-oracle 0.3.0 (the 0.4.1 scoped-identity path would hang in VrfPending against
# a 0.3.0 oracle). Non-scoped create_request_randomness_ix + global VRF_PROGRAM_IDENTITY.
ephemeral-vrf-sdk = { version = "=0.3.0", features = ["anchor"] }
```

- [ ] **Step 2: Build** — `bash scripts/test-er.sh` is heavy; just compile the program.

Run: `anchor build 2>&1 | tail -20`
Expected: builds clean, `target/deploy/ansem_miner.so` refreshed, NO sBPF frame-overflow, NO "failed to select a version … yanked".
If yanked-rejected: `cargo` will name the crate; copy the 4-line `[[package]] name = "ephemeral-vrf-sdk" version = "0.3.0" …` block (incl. `source`, `checksum`, `dependencies`) from the example lockfile into ours and rebuild.

- [ ] **Step 3: Commit**

```bash
git add programs/ansem-miner/Cargo.toml Cargo.lock
git commit -m "M2b task 1: add ephemeral-vrf-sdk =0.3.0 (matches installed oracle)"
```

---

### Task 2: `request_settle` + `settle_callback` instructions

**Files:**
- Create: `programs/ansem-miner/src/instructions/vrf_settle.rs`
- Modify: `programs/ansem-miner/src/instructions/mod.rs`
- Modify: `programs/ansem-miner/src/lib.rs`

- [ ] **Step 1: Write `vrf_settle.rs`.** Ground truth = `rewards-delegated-vrf/src/{lib.rs,instructions/{request_random_reward,consume_random_reward}.rs}`. Our callback is simpler (no Magic CPI).

```rust
use anchor_lang::prelude::*;
use ephemeral_vrf_sdk::anchor::vrf;
use ephemeral_vrf_sdk::instructions::{create_request_randomness_ix, RequestRandomnessParams};
use ephemeral_vrf_sdk::types::SerializableAccountMeta;

use crate::constants::*;
use crate::error::AnsemError;
use crate::instruction;
use crate::math;
use crate::state::{Config, Round, STATE_OPEN, STATE_SETTLED, STATE_VRF_PENDING};

// ---- request (ER, admin-gated crank) ----
#[vrf] // injects program_identity, vrf_program, slot_hashes, system_program + invoke_signed_vrf()
#[derive(Accounts)]
pub struct RequestSettle<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(mut, seeds = [ROUND_SEED, round.round_id.to_le_bytes().as_ref()], bump = round.bump)]
    pub round: Account<'info, Round>,

    #[account(seeds = [CONFIG_SEED], bump = config.config_bump,
        constraint = config.admin == payer.key() @ AnsemError::Unauthorized)]
    pub config: Account<'info, Config>,

    /// CHECK: VRF queue the ER oracle services. Client/env-supplied (local test queue
    /// != SDK default). Integrity is enforced by the callback's VRF_PROGRAM_IDENTITY
    /// signer, not by which queue the request is posted to. Wrong queue => no callback
    /// => round recoverable via cancel_round; it cannot forge randomness.
    #[account(mut)]
    pub oracle_queue: UncheckedAccount<'info>,
}

pub fn request_settle_handler(ctx: Context<RequestSettle>, client_seed: u8) -> Result<()> {
    let round = &mut ctx.accounts.round;
    require!(round.state == STATE_OPEN, AnsemError::BadRoundState);
    let now = Clock::get()?.unix_timestamp;
    require!(now >= round.deadline_ts, AnsemError::RoundNotEnded);

    // Mix round_id into the caller seed so distinct rounds request distinct draws.
    let mut caller_seed = [client_seed; 32];
    caller_seed[..8].copy_from_slice(&round.round_id.to_le_bytes());

    let round_key = round.key();
    let config_key = ctx.accounts.config.key();
    round.state = STATE_VRF_PENDING;

    let ix = create_request_randomness_ix(RequestRandomnessParams {
        payer: ctx.accounts.payer.key(),
        oracle_queue: ctx.accounts.oracle_queue.key(),
        callback_program_id: crate::ID,
        callback_discriminator: instruction::SettleCallback::DISCRIMINATOR.to_vec(),
        caller_seed,
        // Order MUST match SettleCallback fields AFTER vrf_program_identity.
        accounts_metas: Some(vec![
            SerializableAccountMeta { pubkey: round_key,  is_signer: false, is_writable: true },
            SerializableAccountMeta { pubkey: config_key, is_signer: false, is_writable: false },
        ]),
        ..Default::default()
    });
    ctx.accounts
        .invoke_signed_vrf(&ctx.accounts.payer.to_account_info(), &ix)?;
    Ok(())
}

// ---- callback (ER, VRF identity only) ----
#[derive(Accounts)]
pub struct SettleCallback<'info> {
    /// The oracle CPIs here with this PDA as an injected signer; the address
    /// constraint is the ONLY thing that authorizes writing randomness.
    #[account(address = ephemeral_vrf_sdk::consts::VRF_PROGRAM_IDENTITY)]
    pub vrf_program_identity: Signer<'info>,

    #[account(mut, seeds = [ROUND_SEED, round.round_id.to_le_bytes().as_ref()], bump = round.bump)]
    pub round: Account<'info, Round>,

    #[account(seeds = [CONFIG_SEED], bump = config.config_bump)]
    pub config: Account<'info, Config>,
}

pub fn settle_callback_handler(ctx: Context<SettleCallback>, randomness: [u8; 32]) -> Result<()> {
    let cfg = &ctx.accounts.config;
    let round = &mut ctx.accounts.round;
    // One-shot guard: only a VrfPending round accepts randomness. Blocks replay/double-fire.
    require!(round.state == STATE_VRF_PENDING, AnsemError::BadRoundState);

    round.randomness = randomness;
    round.small_jackpot_hit   = math::jackpot_hit(&randomness, cfg.small_jackpot_odds, b"jackpot_sm");
    round.small_jackpot_block = math::jackpot_block(&randomness, b"jkblock_sm");
    round.big_jackpot_hit     = math::jackpot_hit(&randomness, cfg.big_jackpot_odds, b"jackpot_big");
    round.big_jackpot_block   = math::jackpot_block(&randomness, b"jkblock_big");
    round.state = STATE_SETTLED;
    Ok(())
}
```

- [ ] **Step 2: Register the module** — add to `instructions/mod.rs`:

```rust
pub mod vrf_settle;
pub use vrf_settle::*;
```

- [ ] **Step 3: Wire into `lib.rs`** — add two entries in `pub mod ansem_miner` (leave `settle` in place):

```rust
    // ---- M2b: Ephemeral VRF settle (admin-gated request + VRF-identity callback) ----
    pub fn request_settle(ctx: Context<RequestSettle>, client_seed: u8) -> Result<()> {
        instructions::vrf_settle::request_settle_handler(ctx, client_seed)
    }

    pub fn settle_callback(ctx: Context<SettleCallback>, randomness: [u8; 32]) -> Result<()> {
        instructions::vrf_settle::settle_callback_handler(ctx, randomness)
    }
```

- [ ] **Step 4: Build.** Run: `anchor build 2>&1 | tail -20`. Expected: clean, no frame overflow. Confirm the IDL gained `requestSettle`/`settleCallback`: `grep -c "requestSettle\|settleCallback" target/idl/ansem_miner.json` → ≥2.

- [ ] **Step 5: Rust unit tests still green** (the settle math is untouched but confirm no module break).

Run: `cargo test -p ansem-miner 2>&1 | tail -15`
Expected: 9 passed.

- [ ] **Step 6: Commit**

```bash
git add programs/ansem-miner/src/instructions/vrf_settle.rs programs/ansem-miner/src/instructions/mod.rs programs/ansem-miner/src/lib.rs
git commit -m "M2b task 2: request_settle + settle_callback (ephemeral VRF)"
```

---

### Task 3: Add the VRF oracle to the local test stack

**Files:**
- Modify: `scripts/test-er.sh`

- [ ] **Step 1: Launch two oracle instances** (base + ER) after the ER-ready gate, before the env-export block. Mirror `~/spikes/magicblock-engine-examples/test-locally.sh:414-457`. Gate on `SKIP_VRF=1`. Add `VRF_PID`/`VRF_ER_PID` to the `cleanup()` kill list and the pkill-by-name fallback (the script already pkills `vrf-oracle`).

```bash
# ---- VRF oracles (M2b). Two instances: one watching base, one watching the ER.
# The ER-side oracle is the one that fulfills our in-ER request_settle. ----
if [ "${SKIP_VRF:-0}" = "1" ]; then
  echo "Skipping VRF oracles (SKIP_VRF=1)."
else
  command -v vrf-oracle >/dev/null 2>&1 || { echo "ERROR: vrf-oracle not on PATH (npm i -g @magicblock-labs/ephemeral-validator) — or set SKIP_VRF=1"; exit 1; }
  echo "Starting base VRF oracle..."
  VRF_ORACLE_SKIP_PREFLIGHT=true RPC_URL=http://127.0.0.1:8899 WEBSOCKET_URL=ws://127.0.0.1:8900 RUST_LOG=info \
    vrf-oracle > "$LOG_DIR/vrf-base.log" 2>&1 < /dev/null &
  VRF_PID=$!
  sleep 2
  kill -0 $VRF_PID 2>/dev/null || { echo "base VRF oracle died:"; tail -40 "$LOG_DIR/vrf-base.log"; exit 1; }
  echo "Starting ER VRF oracle..."
  VRF_ORACLE_SKIP_PREFLIGHT=true RPC_URL=http://127.0.0.1:7799 WEBSOCKET_URL=ws://127.0.0.1:7800 RUST_LOG=info \
    vrf-oracle > "$LOG_DIR/vrf-er.log" 2>&1 < /dev/null &
  VRF_ER_PID=$!
  sleep 2
  kill -0 $VRF_ER_PID 2>/dev/null || { echo "ER VRF oracle died:"; tail -40 "$LOG_DIR/vrf-er.log"; exit 1; }
  echo "VRF oracles running (base $VRF_PID, ER $VRF_ER_PID)."
fi
```

- [ ] **Step 2: Export the test queue** in the env block: `export VRF_EPHEMERAL_QUEUE=Sc9MJUngNbQXSXGP3F67KvKwVnhaYn6kcioxXNVowYT`.

- [ ] **Step 3: Add `$VRF_PID $VRF_ER_PID`** to the two kill loops in `cleanup()`.

- [ ] **Step 4: Commit** (validated by Task 4's run).

```bash
git add scripts/test-er.sh
git commit -m "M2b task 3: launch base+ER vrf-oracle in test stack (SKIP_VRF escape hatch)"
```

---

### Task 4: Two-provider VRF end-to-end test

**Files:**
- Modify: `tests/ansem-miner-er.ts`

- [ ] **Step 1: Add a queue constant + a callback-awaiter helper** near the other ER helpers:

```ts
const VRF_EPHEMERAL_QUEUE = new anchor.web3.PublicKey(
  process.env.VRF_EPHEMERAL_QUEUE || "Sc9MJUngNbQXSXGP3F67KvKwVnhaYn6kcioxXNVowYT",
);

// Poll the (delegated) round on the ER until the VRF callback flips it to Settled(2).
async function awaitSettled(roundPda: anchor.web3.PublicKey, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const acct = await erProgram.account.round.fetchNullable(roundPda);
    if (acct && acct.state === 2) return acct;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("VRF callback never settled the round within timeout");
}
```

- [ ] **Step 2: Write the test** — a fresh round, delegated, past deadline, settled *by VRF* (not admin), then the L1 tail. Reuse existing helpers (`joinOnce`, delegate, `awaitEr`, `reconcile`, swap, claim) exactly as the Task 8 e2e does; the ONLY substitution is `request_settle` (ER) + `awaitSettled` in place of `settleAfterDeadline` (admin L1).

```ts
it("settles a round via ephemeral VRF (request_settle -> oracle callback)", async function () {
  this.timeout(120000);
  // create round on L1, init+delegate miner, join, delegate round, stake on ER
  // (identical setup to the Task 8 e2e — factor via the shared helper if present)
  const { roundId, roundPda } = await freshDelegatedStakedRound(); // existing helper/inline

  // wait out the deadline on the ER clock
  await awaitEr(roundPda, (r) => Date.now() / 1000 >= Number(r.deadlineTs));

  // fire the VRF request on the ER (admin pays)
  await erProgram.methods
    .requestSettle(7)
    .accounts({
      payer: provider.wallet.publicKey,
      round: roundPda,
      config: configPda,
      oracleQueue: VRF_EPHEMERAL_QUEUE,
    })
    .rpc();

  // the ER-side oracle fulfills -> settle_callback flips state to Settled
  const settled = await awaitSettled(roundPda);
  assert.notDeepEqual([...settled.randomness], new Array(32).fill(0), "randomness must be nonzero");

  // L1 tail is unchanged: commit -> reconcile -> swap -> claim
  await commitRoundAndMiner(roundId);       // existing helper
  await reconcile(player);
  await program.methods.executeSwapMock()... // existing
  await program.methods.claim(new BN(roundId))... // existing
});
```

- [ ] **Step 3: Run the full ER suite** with oracles up.

Run: `bash scripts/test-er.sh 2>&1 | tail -40`
Expected: **9/9** (the 8 M2a tests + this VRF test). If the callback times out: `tail -40 .er-logs/vrf-er.log` — confirm the ER oracle logged a request pickup for our queue; verify `VRF_EPHEMERAL_QUEUE` matches what the test passes.

- [ ] **Step 4: Commit**

```bash
git add tests/ansem-miner-er.ts
git commit -m "M2b task 4: two-provider ephemeral-VRF settle e2e (ER 9/9)"
```

---

### Task 5: Verify M1 base suite untouched, then docs + memory + finish

**Files:**
- Modify: `README.md`, `docs/superpowers/specs/2026-07-06-ansem-miner-design.md`, memory files.

- [ ] **Step 1: M1 base suite green** (admin `settle` preserved).

Run: `SKIP_VRF=1 TEST_FILE=tests/ansem-miner.ts bash scripts/test-er.sh 2>&1 | tail -20` (or the M1 base runner) — Expected: **19 passing**.

- [ ] **Step 2: Docs.** README: add an "M2b: ephemeral VRF (implemented)" note (request→callback flow, admin-gated request, VRF_PROGRAM_IDENTITY integrity guard, `bash scripts/test-er.sh` runs oracles, `SKIP_VRF=1` skips). Design spec §5: mark VRF as-built; note the two follow-ups (permissionless crank + VRF-timeout refund; pin queue in Config + gate admin-settle for mainnet).

- [ ] **Step 3: Update memory** `ansem-miner-project.md` (M2b DONE + commits) and `anchor-solana-gotchas.md` if any new trap surfaced (0.3.0 lockfile fetch, oracle queue mismatch).

- [ ] **Step 4: Final review + finish-branch** — adversarial pass over the VRF integrity boundary (can anyone but the oracle call `settle_callback`? can a wrong queue strand funds? is the one-shot guard sound?), then `superpowers:finishing-a-development-branch`.
