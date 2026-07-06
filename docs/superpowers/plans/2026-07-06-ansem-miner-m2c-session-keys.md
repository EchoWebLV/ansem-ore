# ANSEM Miner — M2c: Session-Keys Implementation Plan

> **For agentic workers:** Implemented inline with per-task commits (tightly-coupled milestone; one instruction + one test suite). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add gasless, popup-free ER staking: a browser signs a burst of `stake` calls with an ephemeral session key instead of a wallet popup per tile, while a leaked key can never move value out of escrow.

**Architecture:** Add a `SessionTokenV2` gate to the existing ER `stake` instruction via the `session-keys 3.1.1` `#[derive(Accounts, Session)]` + `#[session_auth_or(...)]` macros. The session token is minted **once on L1** (via the bundled gum program `KeyspM2ss…`, one wallet popup), then read as a **read-only cloned account** by the ER `stake` handler. All other instructions (`deposit`/`withdraw`/`claim`) keep requiring the real wallet — the session key's blast radius is exactly one round's `max_stake_per_round`, and it expires ≤ 7 days.

**Tech Stack:** `session-keys =3.1.1` (feature `no-entrypoint`) + `anchor-lang 1.0.2` + `ephemeral-rollups-sdk 0.14.3`; TS `@magicblock-labs/gum-sdk ^3.0.10` (`SessionTokenManager.createSessionV2`). Reference: `~/spikes/magicblock-engine-examples/session-keys` (our exact stack).

**De-risk (DONE, GREEN):**
- `session-keys 3.1.1` cached; wants `anchor-lang ">=0.28, <2.0"` → our `=1.0.2` satisfies. NOT yanked (normal resolve; no lock-seeding, unlike ephemeral-vrf-sdk).
- Gum program `KeyspM2ssCJbqUhQ4k7sveSiY4WjnYsrXkC8oDbwde5` is **bundled by `mb-test-validator` at genesis** (verified empirically alongside DLP + VRF) → `createSessionV2` works against local base with zero extra preload/clone.
- `SessionTokenV2` layout: `{ authority, target_program, session_signer, fee_payer, valid_until }`, seed `"session_token_v2"`, `validate()` = PDA-bind(target_program, session_signer, authority) + `now < valid_until`, create cap `valid_until ≤ now + 7d`.

**Residual integration risks (test-time tuning, not blockers):** (1) ER cloning the freshly-minted L1 token in time for the stake — use the tolerant-retry pattern; (2) a 0-lamport session key as gasless-ER fee payer with `top_up=false` — if it fails, fall back to a tiny top-up.

---

### Task 1: Add dependencies

**Files:**
- Modify: `programs/ansem-miner/Cargo.toml`
- Modify: `package.json`

- [ ] **Step 1:** Add to `[dependencies]` in `programs/ansem-miner/Cargo.toml`:

```toml
# M2c: Gum session keys. Gates the ER `stake` so a browser signs a burst of
# stakes with an ephemeral key (no wallet popup per tile). "no-entrypoint" gates
# the macro re-export (Session / SessionTokenV2 / session_auth_or). anchor-lang
# ">=0.28,<2.0" → our 1.0.2 satisfies; NOT yanked → normal resolve.
session-keys = { version = "=3.1.1", features = ["no-entrypoint"] }
```

- [ ] **Step 2:** Add to `package.json` `"dependencies"`: `"@magicblock-labs/gum-sdk": "^3.0.10"`, then `yarn install` (fallback: copy from reference repo `node_modules` if offline).

- [ ] **Step 3:** `anchor build` → compiles + links `session-keys 3.1.1`. Commit.

---

### Task 2: Session-gate the `stake` instruction

**Files:**
- Modify: `programs/ansem-miner/src/instructions/stake.rs`

**Key change:** the `miner`/`escrow` PDAs must be seeded on `miner.authority` (the *wallet*), NOT on `authority.key()` (the *signer*, which is the session key when session-signed). The signer↔wallet identity is enforced by the session gate, not the seeds.

- [ ] **Step 1:** Rewrite `Stake` accounts:
  - `use session_keys::{session_auth_or, Session, SessionError, SessionTokenV2};`
  - `#[derive(Accounts, Session)]`
  - `pub authority: Signer<'info>` — the signer (session key **or** wallet), non-mut (matches proven M2a ER pattern; signer is the gasless fee payer).
  - `config`: unchanged (read-only clone).
  - `round`: unchanged (`mut`, delegated).
  - `miner`: `seeds = [MINER_SEED, miner.authority.as_ref()], bump = miner.bump` — **remove** the `constraint = miner.authority == authority.key()` (moved to the `session_auth_or` fallback).
  - `escrow`: `seeds = [ESCROW_SEED, miner.authority.as_ref()], bump = escrow.bump, constraint = escrow.authority == miner.authority @ AnsemError::Unauthorized`.
  - Add: `#[session(signer = authority, authority = miner.authority.key())] pub session_token: Option<Account<'info, SessionTokenV2>>`.

- [ ] **Step 2:** Gate the handler (ctx **must** be named `ctx` — macro hardcodes it):

```rust
#[session_auth_or(
    ctx.accounts.miner.authority.key() == ctx.accounts.authority.key(),
    SessionError::InvalidToken
)]
pub fn stake_handler(ctx: Context<Stake>, block: u8, amount: u64) -> Result<()> {
    // ... existing M2a body, UNCHANGED ...
}
```

The handler body is unchanged: `miner.authority` still identifies the player, `escrow.active_round == round.round_id`, per-round cap, soft budget vs read-only escrow clone, no escrow debit (L1 reconcile owns that). The gate means: session-signed ⇒ token PDA-binds (our program, this signer, this wallet) + not expired; wallet-signed ⇒ fallback `miner.authority == authority`.

- [ ] **Step 3:** `anchor build`; `cargo test` (units 9/9 — no unit touches the session path). Commit.

---

### Task 3: TS session-key test suite

**Files:**
- Create: `tests/ansem-miner-session.ts`

Self-contained suite (own round), modeled on `tests/ansem-miner-vrf.ts`. Uses **admin `settle`** (not VRF) — this suite isolates the session boundary. Session token minted on L1 via `SessionTokenManager.createSessionV2`; PDA seeds `["session_token_v2", ourProgramId, sessionSigner, wallet]` under the gum program id.

- [ ] **Test 1 — happy path (session-signed stake mines ANSEM):** init/reuse → deposit → createRound → delegate round+miner → join → `createSessionV2(topUp=false, validUntil=now+900)` on L1 (one wallet sig) → **stake in ER signed by the ephemeral session key** (tolerant-retry for clone-lag; if 0-lamport payer rejected, retry with a small `topUp`) → assert `miner.block_stake`/`round.block_sol` moved → commit round+miner → reconcile → settle(admin) → swap → claim. Asserts ANSEM received.

- [ ] **Test 2 — security boundary:**
  - wallet-signed stake still passes (fallback path).
  - session-signed `withdraw` / `claim` **fail** (they require `authority == escrow/last-claim owner`; the session key is not the wallet → constraint fails).
  - **expired token fails:** `createSessionV2` with `validUntil = now - 60` (create only caps the upper bound `≤ now+7d`; a past value is allowed) → session-signed stake fails (`is_expired`).
  - **foreign-program token fails:** `createSessionV2(targetProgram = SystemProgram.programId)` → its PDA differs from what our `#[session]` expects (target = our program) → passing it fails (`InvalidToken`).

- [ ] **Step:** run `TEST_FILE=tests/ansem-miner-session.ts bash scripts/test-er.sh`. Commit.

---

### Task 4: test-er.sh + docs

**Files:**
- Modify: `scripts/test-er.sh` (add a `*session*)` case: no oracle needed; verify the gum program `KeyspM2ss…` is present on base — a cheap guard).
- Modify: `README.md`, `docs/superpowers/specs/2026-07-06-ansem-miner-design.md` (M2c as-built).
- Modify (outside repo): memory `ansem-miner-project.md`, `anchor-solana-gotchas.md`.

- [ ] Add the session run command to README (`TEST_FILE=tests/ansem-miner-session.ts bash scripts/test-er.sh`), document the as-built (top_up decision, bundled gum program, seed-on-`miner.authority`). Commit.

---

### Task 5: Adversarial security review

Session keys are a value-delegation boundary — the exact [[avoid-rug-vector-test-seams]] concern. Run a multi-lens adversarial review (workflow) of the session gate: can a leaked/forged/expired/foreign token move value, exceed the per-round cap, or bypass the wallet-only instructions? Fix anything CONFIRMED, then finish the branch.

**Verify before merge:** session 2/2, M2b VRF 2/2, M2a ER 8/8, M1 19/19, units 9/9.
