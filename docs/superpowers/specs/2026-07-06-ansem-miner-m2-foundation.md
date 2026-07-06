# ANSEM Miner — M2 Foundation (grounded)

**Date:** 2026-07-06  
**Status:** Research complete — input to the M2 implementation plan  
**Grounded against:** exact cached SDK sources (ephemeral-rollups-sdk 0.15.5, ephemeral-vrf-sdk 0.4.1, session-keys 3.1.1, gpl-session 2.0.0; tooling vrf-oracle 0.3.0, magicblock-config 0.12.0) + the live magicblock-engine-examples repo.

> Produced by the m2-magicblock-grounding workflow (4 parallel source readers + synthesis). The lead-in paragraph below is the architect summary.

---

> ## ⚠️ CORRECTION (M2 task-0 de-risk, 2026-07-06) — READ FIRST, SUPERSEDES §1, §2c, §4
>
> The original grounding was against **crates.io-latest sources (ER SDK 0.15.5, vrf-sdk 0.4.1)**, but the **actually-installed tooling and the working reference examples use older, version-matched pins.** Verified on this machine:
> - **Installed oracle:** `vrf-oracle 0.3.0` (`ephemeral-validator@0.12.0` pins every `@magicblock-labs/vrf-oracle-*` to **0.3.0**; `vrf-oracle --version` → `vrf-oracle 0.3.0`).
> - **Every VRF example** (`roll-dice/roll-dice-delegated`, `rewards-delegated-vrf`) pins **`ephemeral-rollups-sdk = "0.14.3"` (feature `anchor` only) + standalone `ephemeral-vrf-sdk = "0.3.0"` (feature `anchor`) + `anchor-lang = "1.0.2"`** — resolved & checksummed in their `Cargo.lock`.
>
> **Decision — pin M2 to the example versions, NOT the crates.io-latest ones:**
> ```toml
> anchor-lang = { version = "=1.0.2", features = ["init-if-needed"] }   # already done (task-0)
> anchor-spl  = "=1.0.2"
> solana-keccak-hasher = { version = "3", features = ["sha3"] }         # M1 keccak, keep
> ephemeral-rollups-sdk = { version = "=0.14.3", features = ["anchor"] }         # delegate/commit/ephemeral — NO "vrf" feature
> ephemeral-vrf-sdk     = { version = "=0.3.0",  features = ["anchor"] }         # standalone, matches oracle 0.3.0
> session-keys          = { version = "=3.1.1",  features = ["no-entrypoint"] }  # unchanged (verify separately)
> ```
> **Why this resolves §7.2's HIGH risk:** vrf-sdk **0.4.1 deprecates the global `VRF_PROGRAM_IDENTITY` in favor of a *scoped* identity** (`scoped_vrf_identity(&crate::ID)`) and the scoped `create_request_scoped_randomness_ix`/`#[vrf_callback]` path — which a **0.3.0 oracle does not fulfill** (rounds would hang in `STATE_VRF_PENDING`). Matching vrf-sdk to the oracle at **0.3.0** removes the skew entirely.
>
> **Corrected APIs (supersede the code in §2c and §4):**
> - **VRF request (§4a):** use `ephemeral_vrf_sdk::instructions::create_request_randomness_ix(RequestRandomnessParams { payer, oracle_queue, callback_program_id: ID, callback_discriminator: instruction::<Callback>::DISCRIMINATOR.to_vec(), caller_seed: [seed;32], accounts_metas: Some(vec![SerializableAccountMeta{..}]), callback_args: Some(vec![..]), ..Default::default() })` then `ctx.accounts.invoke_signed_vrf(&payer.to_account_info(), &ix)?;`. Request-side Accounts struct carries `#[vrf]` + a `#[account(mut)] oracle_queue: UncheckedAccount`. **NOT** `create_request_scoped_randomness_ix`.
> - **VRF callback (§4b):** a **plain `#[derive(Accounts)]`** (no `#[vrf_callback]`) whose auth guard is the **global** injected-signer check `#[account(address = ephemeral_vrf_sdk::consts::VRF_PROGRAM_IDENTITY)] pub vrf_program_identity: Signer<'info>`. Callback fn signature: `(ctx, randomness: [u8;32], <trailing callback_args…>)`.
> - **Commit/undelegate (§2c):** 0.14.3 uses the **builder**, not the 5-arg free fn:
>   `MagicIntentBundleBuilder::new(payer_ai, magic_context_ai, magic_program_ai).commit_and_undelegate(&[account_info, …]).build_and_invoke()?;` (import `ephemeral_rollups_sdk::ephem::MagicIntentBundleBuilder`; `#[commit]` injects `magic_context` + `magic_program`). For commit-only (MinerPosition), use the builder's commit-only method.
> - **Delegate (§2b):** unchanged in shape — `#[delegate]`, field `#[account(mut, del, seeds=[…], bump)] pub <x>: UncheckedAccount`, handler `ctx.accounts.delegate_<field>(&signer, &[seeds], DelegateConfig{ validator: …, ..Default::default() })?;`.
> - **package.json (§1b):** keep `@coral-xyz/anchor@^0.32.1`; the TS `@magicblock-labs/ephemeral-rollups-sdk` should track **0.14.x** to match the Rust 0.14.3 (not ^0.15.5).
>
> Everything else in the doc (lifecycle, ER/L1 split rule §2d, session design §3, escrow relocation §6, test-stack §5) stands. The **plan is written against THIS correction block.**

---

---

# ANSEM Miner — M2 Foundation (Ephemeral Rollups + VRF + Sessions)

Lead architect deliverable. Grounded against M1 on `main` (verified: `programs/ansem-miner/src/{lib.rs,state/round.rs,state/miner.rs,instructions/{round,stake,settle,swap,claim}.rs,constants.rs}`, `Cargo.toml` anchor 0.31.1, `Anchor.toml`, `package.json`) and the four verified SDK reports (er-sdk, vrf-sdk, session, examples).

> **⚠️ The one blocking finding, stated up front.** M1 compiles on **`anchor-lang = "0.31.1"`**. Every SDK we must pull targets **anchor-lang 1.0** (er-sdk report: `anchor` → `anchor-modern` → `anchor-lang-current` = anchor-lang 1.0; vrf-sdk report: `anchor` → `anchor-modern` = anchor-lang 1.0 + solana-program 3.0; examples report: all four examples run `anchor-lang = "1.0.2"`, `anchor_version = "1.0.2"`). There is an `anchor-compat` feature path (anchor `>=0.28,<1.0`) on both SDKs, but the er-sdk report shows a hard `compile_error!` guard: `anchor-modern ⊕ anchor-compat`, and the VRF macro is pulled transitively under `anchor-modern` by the rollups SDK. **Mixing 0.31.1 with the `anchor-modern` default is not viable.** M2 must make a decision (see §1 and §6). The recommended path is **upgrade the program to anchor-lang 1.0.2** to match the examples exactly; the fallback is to pin every SDK to its `anchor-compat` feature and stay on 0.31.x. Everything below assumes the **upgrade-to-1.0.2** path unless noted.

---

## 1. Exact dependencies

### 1a. `programs/ansem-miner/Cargo.toml`

Replace the `[dependencies]` block. Two decisions are baked in: (a) upgrade anchor to 1.0.2 to match the pinned SDKs; (b) get VRF **through the ER SDK's `vrf` feature**, not a standalone `ephemeral-vrf-sdk` crate — this is the examples report's explicit recommendation (roll-dice-delegated does exactly this) and avoids a second, version-skewed VRF dependency.

```toml
[dependencies]
anchor-lang = { version = "=1.0.2", features = ["init-if-needed"] }
anchor-spl  = "=1.0.2"

# Delegation + commit/undelegate + VRF, all from one crate.
# "anchor" == "anchor-modern" (anchor-lang 1.0). "vrf" adds ephemeral-vrf-sdk-vrf-macro/rollups.
# er-sdk report: no compile_error! guard between "vrf" and "anchor" — they coexist.
ephemeral-rollups-sdk = { version = "=0.15.5", features = ["anchor", "vrf"] }

# Session keys. "no-entrypoint" is REQUIRED — it gates the macro re-export
# (Session / SessionV2 / session_auth_or). session report §Cargo line.
session-keys = { version = "=3.1.1", features = ["no-entrypoint"] }
```

**Do NOT add a standalone `ephemeral-vrf-sdk` dependency.** With `ephemeral-rollups-sdk … features=["vrf"]`, the VRF SDK is re-exported as `ephemeral_rollups_sdk::vrf` and the macro's `rollups` feature makes `#[vrf]`/`#[vrf_callback]` emit that re-export path (vrf-sdk report §Cargo; examples report decision 2). If you ever needed it standalone, the pin is `ephemeral-vrf-sdk = { version = "=0.4.1", features = ["anchor"] }` (0.3.x/0.4.0 are **yanked** — examples report version table).

**Feature-conflict callouts (from the reports):**
- `anchor-modern ⊕ anchor-compat` and `anchor-modern ✗ backward-compat` are the **only** `compile_error!` guards in er-sdk (er-sdk report §3). We use plain `anchor` (= `anchor-modern`), so we avoid both.
- **`vrf` + `anchor` is safe** — no guard exists between them (er-sdk report §3, "vrf + delegation coexistence"). This is the load-bearing compatibility answer for our design.
- The `idl-build` feature in M1's `[features]` must keep working: leave `idl-build = ["anchor-lang/idl-build", "anchor-spl/idl-build"]` as-is (still valid on anchor 1.0.2).

### 1b. `package.json`

Bump TS SDK to match the Rust 0.15.5 (examples report decision 3), add the session-key client and the ER connection helpers. `@coral-xyz/anchor` goes to 0.32.1 to match all four examples.

```jsonc
{
  "dependencies": {
    "@coral-xyz/anchor": "^0.32.1",
    "@solana/spl-token": "^0.4.14",
    "@magicblock-labs/ephemeral-rollups-sdk": "^0.15.5",   // GetCommitmentSignature, delegation helpers
    "@magicblock-labs/gum-sdk": "^3.0.10"                    // SessionTokenManager: createSessionV2 / revokeSessionV2
  },
  "devDependencies": {
    // unchanged M1 devDeps, plus:
    "ts-mocha": "^11.1.0",
    "typescript": "^5.8.3"
  }
}
```

Notes: `@magicblock-labs/gum-sdk` is the real package the examples use for session tokens (session report §4 could only cite the crate's README pointer; the examples report confirms the concrete npm name and `SessionTokenManager` / `createSessionV2` / `revokeSessionV2`, PDA seed `"session_token_v2"`). The ER validator + oracle are **npm-global CLIs**, not project deps (`npm i -g @magicblock-labs/ephemeral-validator`; see §5).

---

## 2. Delegation lifecycle (Round + MinerPosition)

### 2a. New instructions

Six new instructions, plus `#[ephemeral]` on the `#[program] mod` (auto-injects `process_undelegation` + `InitializeAfterUndelegation` — er-sdk report §2). Add to `lib.rs`:

| New ix | Runs on | Purpose | Macro on Accounts |
|---|---|---|---|
| `delegate_round(round_id)` | **L1** | Delegate the (already-inited) Round PDA into the ER | `#[delegate]`, field `#[account(mut, del)]` round |
| `delegate_miner()` | **L1** | Delegate the persistent MinerPosition PDA | `#[delegate]`, field `#[account(mut, del)]` miner |
| `stake(block, amount)` | **ER** | (existing, moved to ER; session-gated — §3) | `#[derive(Accounts, Session)]` |
| `request_settle(client_seed)` | **ER** | Request VRF randomness for the round (§4) | `#[vrf]` |
| `settle_callback(randomness)` | **ER** | VRF oracle CPIs here; writes randomness + jackpots (§4) | `#[vrf_callback]` |
| `commit_round()` | **ER** | `commit_and_undelegate` Round back to L1 after settle | `#[commit]` |
| `commit_miner()` | **ER** | `commit` MinerPosition (commit-only, NOT undelegate — §6) | `#[commit]` |

Mapping onto M1 verbs:
- `create_round` (unchanged, **L1**) → now immediately followed by a new **L1** `delegate_round`. Round MUST be inited on L1 first (Anchor `init` can't run on a delegated account; er-sdk delegate macro strips `del` but still expects the PDA to exist and be owned by our program). See §6.
- `init_miner` (unchanged, **L1**) → followed once by **L1** `delegate_miner`. MinerPosition is persistent, so it is delegated once and stays delegated across rounds (committed each round, never undelegated — §6).
- `stake` (M1 **L1** → M2 **ER**) — writes delegated `round` + delegated `miner`. Both are ER-resident, so this is a legal all-delegated tx (see split rule below). **`escrow` becomes a read-only clone in the ER** (§3, §6).
- `settle` (M1 admin-injected → M2 VRF) → split into `request_settle` (**ER**) + `settle_callback` (**ER**). Replaces `Settle`/`settle_handler` entirely (§4).
- `execute_swap_mock`, `claim` (both stay **pure L1**, §6) run only after `commit_round` lands the settled Round snapshot back on L1.

### 2b. `#[delegate]` shape for Round (per er-sdk report §1)

```rust
use ephemeral_rollups_sdk::anchor::{commit, delegate, ephemeral};
use ephemeral_rollups_sdk::cpi::DelegateConfig;

#[delegate]
#[derive(Accounts)]
#[instruction(round_id: u64)]
pub struct DelegateRound<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    // `del` is a BARE TOKEN inside #[account(...)], not a separate #[del] attr.
    #[account(mut, del, seeds = [ROUND_SEED, round_id.to_le_bytes().as_ref()], bump)]
    pub round: Account<'info, Round>,
    // #[delegate] auto-injects: buffer_round, delegation_record_round,
    // delegation_metadata_round, owner_program, delegation_program, system_program
}

pub fn delegate_round(ctx: Context<DelegateRound>, round_id: u64) -> Result<()> {
    let seeds: &[&[u8]] = &[ROUND_SEED, &round_id.to_le_bytes()];
    ctx.accounts.delegate_round(          // generated method name = delegate_<fieldname>
        &ctx.accounts.payer,
        seeds,
        DelegateConfig::default(),        // { commit_frequency_ms, validator: None }
    )?;
    Ok(())
}
```

`delegate_miner` is identical with `seeds = [MINER_SEED, authority.key().as_ref()]`.

### 2c. Commit / commit_and_undelegate (er-sdk report §2 — 5-arg signatures)

Use the classic free functions (simplest; the report's recommendation). **Note the 5th `magic_fee_vault: Option<_>` arg** — a 4-arg call will not compile; pass `None` because our payer is not a delegated ephemeral-balance account.

```rust
use ephemeral_rollups_sdk::cpi::{commit_accounts, commit_and_undelegate_accounts};

#[commit]                       // auto-injects magic_program + magic_context
#[derive(Accounts)]
pub struct CommitRound<'info> {
    #[account(mut)] pub payer: Signer<'info>,
    #[account(mut)] pub round: Account<'info, Round>,
}
pub fn commit_round(ctx: Context<CommitRound>) -> Result<()> {
    commit_and_undelegate_accounts(
        &ctx.accounts.payer,
        vec![&ctx.accounts.round.to_account_info()],
        &ctx.accounts.magic_context,
        &ctx.accounts.magic_program,
        None,
    )
}
```

`commit_miner` is identical but calls **`commit_accounts`** (commit-only, keep delegated — §6).

### 2d. The hard ER-vs-L1 account-split rule

**No single transaction may write both a delegated account and an undelegated account.** Once a PDA is delegated, its owner in the base layer is the delegation program; only the ER validator can produce a valid write. Concretely for us:

- **Legal (ER tx):** `stake` writes delegated `round` + delegated `miner`. `escrow` is present but **read-only** (a cloned snapshot) — a read-only delegated-or-cloned account is fine; the rule only forbids mixing *writable* delegated + *writable* undelegated. ✅
- **Legal (ER tx):** `request_settle`/`settle_callback` write delegated `round` only. ✅
- **Illegal:** any tx that tries to write delegated `round` **and** writable L1 `config`/`escrow`/`pot_vault` in the same instruction. This is why the escrow-budget mutation cannot happen inside the ER `stake` (see §3/§6) and why `execute_swap_mock`/`claim` (which write L1 `config`, `escrow`, vaults) must run **after** `commit_round` undelegates Round back to L1.
- **Ordering constraint:** `claim` reads `round.state == STATE_CLAIMABLE`. That state is produced on L1 by `execute_swap_mock`, which requires `STATE_SETTLED`, which is written in the ER by `settle_callback` and only visible on L1 after `commit_round`. So the strict chain is: `settle_callback` (ER) → `commit_round` (ER, undelegates) → `execute_swap_mock` (L1) → `claim` (L1).

---

## 3. Session-gated stake

### 3a. Accounts + macro (session report §1, examples `binary-prediction`)

`stake` moves to the ER and gains a session gate so a browser can sign a burst of stakes with an ephemeral key instead of prompting the wallet each time. Rewrite `Stake` (from `instructions/stake.rs`):

```rust
use session_keys::{session_auth_or, Session, SessionError, SessionTokenV2};

#[derive(Accounts, Session)]
pub struct Stake<'info> {
    // The ephemeral session key OR the real player wallet signs here.
    // MUST be Signer<'info> (the derive generates session_signer(&self) -> Signer).
    #[account(mut)]
    pub authority: Signer<'info>,

    // round + miner are DELEGATED (ER-resident, writable). escrow is a
    // READ-ONLY clone in the ER (see §3c / §6) — note: NOT mut here.
    #[account(mut, seeds = [ROUND_SEED, round.round_id.to_le_bytes().as_ref()], bump = round.bump)]
    pub round: Account<'info, Round>,

    #[account(mut, seeds = [MINER_SEED, miner.authority.as_ref()], bump = miner.bump,
        constraint = miner.authority == authority.key() @ AnsemError::Unauthorized)]
    pub miner: Account<'info, MinerPosition>,

    #[session(
        signer = authority,                    // must point at a Signer<'info> field
        authority = miner.authority.key()      // the real wallet that created the session
    )]
    pub session_token: Option<Account<'info, SessionTokenV2>>,

    // escrow: read-only clone; budget is checked but NOT decremented in the ER (§3c).
    #[account(seeds = [ESCROW_SEED, miner.authority.as_ref()], bump = escrow.bump,
        constraint = escrow.authority == miner.authority @ AnsemError::Unauthorized)]
    pub escrow: Account<'info, PlayerEscrow>,
}

// ctx MUST be named `ctx` — the macro hardcodes that identifier (session report §1).
#[session_auth_or(
    ctx.accounts.miner.authority.key() == ctx.accounts.authority.key(),
    SessionError::InvalidToken
)]
pub fn stake_handler(ctx: Context<Stake>, block: u8, amount: u64) -> Result<()> {
    // ... existing M1 body, MINUS the escrow.balance -= amount and
    //     config.total_escrow_balance -= amount lines (moved off the ER path, §3c)
}
```

The macro injects, at the top of the handler: if `session_token` is `Some`, `require!(is_valid()?)` (PDA + expiry) **and** `require_eq!(session_authority(), token.authority)`; else it requires the fallback (`miner.authority == authority`) — session report §1. Use **`SessionTokenV2`**, not V1: V1's `is_expired` is inverted-named and the V2 create cap is 7 days vs V1's 1 day (session report §3).

### 3b. Client-side one-time setup

Separate tx against the session-keys program `KeyspM2ssCJbqUhQ4k7sveSiY4WjnYsrXkC8oDbwde5`: `create_session_v2(top_up: Some(true), valid_until: Some(now + N≤7d), lamports: None)` with `target_program = <our program id>` (session report §4). TS: `@magicblock-labs/gum-sdk` `SessionTokenManager.createSessionV2` / `revokeSessionV2`, PDA seed `"session_token_v2"`.

### 3c. Why a leaked session key stays contained to the escrow budget

The threat model: an ephemeral session key lives in the browser and can be exfiltrated. Containment has three independent walls:

1. **`target_program` scoping** — the `SessionTokenV2` PDA is seeded on `[«session_token_v2», our_program_id, session_signer, authority]` and the token stores `target_program`. It only authorizes instructions on **our** program; it can't touch the wallet, other programs, or move raw SOL.
2. **Per-round budget cap** — `stake_handler` still enforces `prior + amount <= max_stake_per_round` against the delegated `miner.block_stake`. A leaked key can at most redistribute the player's own already-committed round budget across blocks; it cannot exceed the cap.
3. **The escrow decrement is NOT on the ER path.** In M1, `stake` did `escrow.balance -= amount` and `config.total_escrow_balance -= amount`. In M2 the ER can't write L1 `escrow`/`config` (the split rule, §2d). So the escrow budget is **debited on L1 at delegation/commit boundaries, not per-stake in the ER** (see §6 for the exact mechanism). The key consequence for containment: **a leaked session key can never withdraw from escrow or reduce the escrow liability** — it can only shuffle a pre-authorized, already-fenced round budget. The maximum blast radius is exactly one round's `max_stake_per_round`, and the session itself expires ≤ 7 days. Revoke via `revoke_session_v2` (requires `authority.is_signer` while unexpired; anyone may revoke after expiry — session report §3).

---

## 4. VRF settle (replaces admin-injected randomness)

Delete `Settle`/`settle_handler`'s admin-randomness parameter. Two ER instructions replace it, both writing only the delegated `round`.

### 4a. Request (vrf-sdk report §1/§2, examples roll-dice-delegated)

```rust
use ephemeral_rollups_sdk::vrf::anchor::{vrf, vrf_callback};   // re-exported via "vrf" feature
use ephemeral_rollups_sdk::vrf::instructions::{create_request_scoped_randomness_ix, RequestRandomnessParams};
use ephemeral_rollups_sdk::vrf::types::SerializableAccountMeta;
use ephemeral_rollups_sdk::vrf::consts::DEFAULT_EPHEMERAL_QUEUE;
use ephemeral_rollups_sdk::vrf::rnd::random_u8_with_range;

#[vrf]     // injects program_identity, vrf_program, slot_hashes, system_program + invoke_signed_vrf
#[derive(Accounts)]
pub struct RequestSettle<'info> {
    #[account(mut)] pub payer: Signer<'info>,
    #[account(mut, seeds = [ROUND_SEED, round.round_id.to_le_bytes().as_ref()], bump = round.bump)]
    pub round: Account<'info, Round>,
    #[account(seeds = [CONFIG_SEED], bump = config.config_bump,
        constraint = config.admin == payer.key() @ AnsemError::Unauthorized)]  // keep admin gate
    pub config: Account<'info, Config>,
    /// CHECK: ephemeral queue serviced by the ER oracle. MUST declare it yourself —
    /// #[vrf] injects everything EXCEPT oracle_queue (vrf-sdk report §1 gotcha).
    #[account(mut, address = DEFAULT_EPHEMERAL_QUEUE)]
    pub oracle_queue: AccountInfo<'info>,
}

pub fn request_settle(ctx: Context<RequestSettle>, client_seed: u8) -> Result<()> {
    let round = &mut ctx.accounts.round;
    require!(round.state == STATE_OPEN, AnsemError::BadRoundState);
    let now = Clock::get()?.unix_timestamp;
    require!(now >= round.deadline_ts, AnsemError::RoundNotEnded);
    round.state = STATE_VRF_PENDING;   // M1 already reserved this constant (state/round.rs:5)

    let ix = create_request_scoped_randomness_ix(RequestRandomnessParams {
        payer: ctx.accounts.payer.key(),
        oracle_queue: ctx.accounts.oracle_queue.key(),
        callback_program_id: crate::ID,
        callback_discriminator: instruction::SettleCallback::DISCRIMINATOR.to_vec(),
        caller_seed: [client_seed; 32],
        accounts_metas: Some(vec![SerializableAccountMeta {
            pubkey: ctx.accounts.round.key(), is_signer: false, is_writable: true,
        }]),
        ..Default::default()
    });
    ctx.accounts.invoke_signed_vrf(&ctx.accounts.payer.to_account_info(), &ix)?;
    Ok(())
}
```

### 4b. Callback (vrf-sdk report §3; state guard is the injected scoped signer)

```rust
#[vrf_callback]   // injects vrf_program_identity: Signer @ scoped_vrf_identity(&crate::ID)
#[derive(Accounts)]
pub struct SettleCallback<'info> {
    #[account(mut, seeds = [ROUND_SEED, round.round_id.to_le_bytes().as_ref()], bump = round.bump)]
    pub round: Account<'info, Round>,
    pub config: Account<'info, Config>,   // read-only, for odds
}

pub fn settle_callback(ctx: Context<SettleCallback>, randomness: [u8; 32]) -> Result<()> {
    let cfg = &ctx.accounts.config;
    let round = &mut ctx.accounts.round;
    require!(round.state == STATE_VRF_PENDING, AnsemError::BadRoundState);   // guard: only once
    round.randomness = randomness;
    round.small_jackpot_hit   = math::jackpot_hit(&randomness, cfg.small_jackpot_odds, b"jackpot_sm");
    round.small_jackpot_block = math::jackpot_block(&randomness, b"jkblock_sm");
    round.big_jackpot_hit     = math::jackpot_hit(&randomness, cfg.big_jackpot_odds, b"jackpot_big");
    round.big_jackpot_block   = math::jackpot_block(&randomness, b"jkblock_big");
    round.state = STATE_SETTLED;
    Ok(())
}
```

The M1 `settle_handler` math (`math::jackpot_hit` / `jackpot_block`) is reused verbatim — only the randomness *source* changes.

### 4c. Constants & guards

- **Queue:** `DEFAULT_EPHEMERAL_QUEUE = 5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc` for the delegated-ER path (vrf-sdk report §4). **In local tests, override to the ER test queue** `DEFAULT_EPHEMERAL_TEST_QUEUE = Sc9MJUngNbQXSXGP3F67KvKwVnhaYn6kcioxXNVowYT` (examples report: `VRF_EPHEMERAL_QUEUE=Sc9MJU…`). Make the queue address env-driven, not a hard constant, so tests can point at the test queue the local oracle services.
- **VRF program:** `VRF_PROGRAM_ID = Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz`.
- **State guard chain:** `STATE_OPEN → (request_settle) → STATE_VRF_PENDING → (settle_callback) → STATE_SETTLED`. `STATE_VRF_PENDING` was already reserved in M1 (`state/round.rs:5`). The `require!(state == STATE_VRF_PENDING)` in the callback makes it idempotent/one-shot.
- **Auth guard:** the `#[vrf_callback]`-injected `vrf_program_identity: Signer @ scoped_vrf_identity(&crate::ID)` proves the callback genuinely came from the VRF program *for our program* (vrf-sdk report §1/§3). Do not declare our own `vrf_program_identity`.
- **⚠️ Oracle-version risk (vrf-sdk report §"Version coupling"):** our tooling is **vrf-oracle 0.3.0**, but `#[vrf]` emits **scoped** discriminators `10`/`11` by default. If the 0.3.0 oracle only understands legacy `3`/`8` (global-identity), the scoped request won't be fulfilled. Verify the 0.3.0 oracle recognizes `10`/`11` before relying on the scoped default; if not, upgrade the oracle (preferred) or fall back to the deprecated `create_request_randomness_ix` + global `VRF_PROGRAM_IDENTITY` guard. This is the single most likely 0.3.0 ↔ 0.4.1 incompatibility — see §7.

---

## 5. Local test stack

### 5a. Processes (examples report §c — start in order, each with a readiness gate)

```bash
# 1. Base validator (RPC 8899 / ws 8900). Pre-clones MB programs; injects our .so.
mb-test-validator --reset \
  --upgradeable-program <program-keypair.json> target/deploy/ansem_miner.so ~/.config/solana/id.json
# wait: getSlot > 0. Also drain fee-payer to ~1000 SOL for the ER cloner faucet.

# 2. Ephemeral validator (ER 7799 / ws 7800). npm i -g @magicblock-labs/ephemeral-validator
ephemeral-validator --no-tui --lifecycle ephemeral \
  --remotes http://127.0.0.1:8899 --remotes ws://127.0.0.1:8900 \
  --listen 127.0.0.1:7799 --reset
# wait: ER RPC responds.

# 3. Query-filtering-service (QFS 6699/6700) — tests point their ER endpoint HERE.
query-filtering-service --listen-addr 127.0.0.1:6699 --listen-addr-ws 127.0.0.1:6700 \
  --ephemeral-url http://127.0.0.1:7799 --ephemeral-url-ws ws://127.0.0.1:7800 \
  --token-expiry-days 180 --add-cors-headers
# flow: client → QFS(6699) → ER(7799) → base(8899)

# 4. vrf-oracle TWICE (skip with SKIP_VRF_TESTS=1). ER-side one fulfills in-ER requests.
RPC_URL=http://localhost:8899 WEBSOCKET_URL=ws://localhost:8900 VRF_ORACLE_SKIP_PREFLIGHT=true vrf-oracle &
RPC_URL=http://localhost:7799 WEBSOCKET_URL=ws://localhost:7800 VRF_ORACLE_SKIP_PREFLIGHT=true vrf-oracle &
```

Reuse the examples' `scripts/{test-locally.sh,local-env.sh,projects.sh}` orchestration pattern (clone lives at the scratchpad path in the examples report). `local-env.sh` endpoints: base `8899/8900`, ER `7799/7800`, QFS `6699/6700`, `VALIDATOR=mAGicPQYBMvcYveUZA5F5UNNwyHvfYh5xkLS2Fr1mev`, `VRF_EPHEMERAL_QUEUE=Sc9MJUngNbQXSXGP3F67KvKwVnhaYn6kcioxXNVowYT`.

### 5b. Two-provider harness (examples report §c, `roll-dice-delegated.ts`)

M1's single-suite tests keep their base provider; ER-touching tests add a second provider:

```ts
const provider = anchor.AnchorProvider.env();            // base RPC (ANCHOR_PROVIDER_URL / ANCHOR_WALLET)
anchor.setProvider(provider);
const providerER = new anchor.AnchorProvider(
  new anchor.web3.Connection(
    process.env.EPHEMERAL_PROVIDER_ENDPOINT || "http://127.0.0.1:6699",   // → QFS
    { wsEndpoint: process.env.EPHEMERAL_WS_ENDPOINT || "ws://127.0.0.1:6700", commitment: "confirmed" }),
  anchor.Wallet.local());
const erProgram = new anchor.Program(program.idl, providerER);
```

- **L1 ixs** (`initialize`, `create_round`, `delegate_round`, `init_miner`, `delegate_miner`, `execute_swap_mock`, `claim`) → `program` (base provider).
- **ER ixs** (`stake`, `request_settle`, `commit_round`, `commit_miner`) → `erProgram`.
- Delegation validator identity: pass `mAGic…` as the first remaining account (or `VALIDATOR` env).
- VRF callback: await via `providerER.connection.onLogs(programId, …)`.
- Commit confirmation on L1: `GetCommitmentSignature(txHash, erConnection)` from `@magicblock-labs/ephemeral-rollups-sdk`.
- Sessions: `SessionTokenManager` (`@magicblock-labs/gum-sdk`) `createSessionV2` / `revokeSessionV2`.

### 5c. `Anchor.toml` / env changes

```toml
[toolchain]
anchor_version = "1.0.2"          # was 0.31.1 — matches the anchor-lang bump (§1, §6)

[features]
resolution = true                 # unchanged

[provider]
cluster = "localnet"
wallet = "~/.config/solana/id.json"

# Add genesis fixtures for the ER/DLP/oracle programs (mirror binary-prediction/Anchor.toml):
[[test.genesis]]                  # Delegation program (DLP), Ephemeral oracle, session-keys program
# address = "DELeGG…", program = "…"   etc.
```

Env: `EPHEMERAL_PROVIDER_ENDPOINT`, `EPHEMERAL_WS_ENDPOINT`, `VALIDATOR`, `VRF_EPHEMERAL_QUEUE`, `SKIP_VRF_TESTS`. Bump `[scripts] test` to the `ts-mocha … -t 1000000` form the examples use.

---

## 6. M1 compatibility assessment (concrete changes)

Ranked by blast radius.

**(0) anchor-lang 0.31.1 → 1.0.2 — the gating change.** All four SDKs target anchor-lang 1.0 (`anchor`/`anchor-modern`), and `anchor-modern ⊕ anchor-compat` is a `compile_error!` (er-sdk report §3). M1 on 0.31.1 cannot use the default feature set. **Change:** bump `anchor-lang`/`anchor-spl` to `=1.0.2`, `anchor_version` in `Anchor.toml` to `1.0.2`, `@coral-xyz/anchor` to 0.32.1. Expect the usual 0.31→1.0 surface churn (account macros, `Result` imports, `InitSpace`); the M1 code shapes (`#[account]`, `#[derive(InitSpace)]`, `CpiContext::new_with_signer`, `associated_token::…`) are all still valid in 1.0.2 (the examples use them), so this is a version bump, not a rewrite. *Fallback if the bump is too costly:* pin every SDK to `anchor-compat` and stay on 0.31.x — but this fights the mutual-exclusion guard the moment the VRF macro is pulled under `anchor-modern`, so it is not recommended.

**(1) Round must be inited on L1 before delegation.** `create_round` (`instructions/round.rs`) already inits Round on L1 via Anchor `init` — **keep it exactly as-is**. Add a *separate* L1 `delegate_round` immediately after. Do **not** try to `init` inside a `#[delegate]` context. The `#[delegate]` macro strips the `del` token and expects the PDA to already exist, program-owned (er-sdk report §1). No change to `create_round`'s body; only a new sibling instruction and a client-side two-tx sequence (create → delegate).

**(2) MinerPosition: committed, not undelegated.** Per the task spec, MinerPosition is persistent and must survive across rounds, and L1 `claim` reads a committed snapshot of it. **Change:** `delegate_miner` runs once (after `init_miner`); each round ends with **`commit_accounts`** (commit-only) on the miner, never `commit_and_undelegate`. This flushes `miner.block_stake` to L1 so `claim` (pure L1) reads a fresh committed snapshot, while the account stays delegated for the next round's ER `stake`. Contrast with Round, which uses `commit_and_undelegate` so `execute_swap_mock`/`claim` can *write* it on L1.

**(3) The escrow-budget check when escrow is a read-only ER clone.** This is the subtlest change. In M1 `stake_handler` mutates two L1-owned accounts: `escrow.balance -= amount` and `config.total_escrow_balance -= amount`. In the ER, `escrow`/`config` are **not delegated** — they are read-only clones, and the split rule (§2d) forbids writing them alongside the delegated `round`/`miner`. Concrete change:
   - In the ER `stake_handler`, **remove** the two decrement lines (`escrow.balance -= amount`, `config.total_escrow_balance -= amount`). `escrow` becomes a read-only account (drop `mut`), used only to *read* the available budget for the `amount <= escrow.balance` check against the cloned snapshot.
   - Move the actual escrow debit to an **L1 boundary**. Two viable designs (pick during the M2 plan): **(a)** debit escrow up-front on L1 at `delegate_round`/round-entry time by the player's committed round budget, so the ER only redistributes an already-fenced amount; or **(b)** reconcile on L1 at `commit_round`/settle time by reading the committed `round.block_sol` + `miner.block_stake` snapshots and debiting `escrow`/`total_escrow_balance` in a pure-L1 instruction. Design (b) keeps the ER `stake` purely about block distribution and is the cleaner fit with the "MinerPosition committed snapshot" model — the L1 reconciler reads exactly what `claim` will read. Either way, the read-only clone check in the ER is a *soft* budget guard (can be slightly stale); the *hard* accounting happens on L1 where `escrow` is writable.
   - Solvency invariant preserved: because escrow is debited on L1 and `execute_swap_mock`'s `pot_vault_lamports >= total_escrow_balance` check (`instructions/swap.rs:103`) runs on L1 after `commit_round`, the commingled-pot solvency guarantee is unchanged.

**(4) `execute_swap_mock` and `claim` stay pure L1 — no change to their bodies.** Both write L1 `config`, `escrow`, vaults, `pot_vault`, `treasury` (all undelegated). They must run **after** `commit_round` has undelegated Round back to L1 (so `round.state == STATE_SETTLED` is visible and Round is program-writable again). `claim` reading `STATE_CLAIMABLE` (`instructions/claim.rs:73`) and `execute_swap_mock` reading `STATE_SETTLED` (`instructions/swap.rs:86`) both work unchanged once the commit lands. The only thing that changes is *when* they can be called (ordering, §2d), not their logic. Keep the `Box<Account>` stack-frame mitigation in `claim` — it's still needed on 1.0.2.

**(5) `settle` deletion.** Remove `Settle`/`settle_handler` and the `settle(randomness)` entry in `lib.rs`; replace with `request_settle` + `settle_callback` (§4). The M1 admin gate migrates onto `request_settle` (config.admin == payer). The jackpot math is reused verbatim.

**(6) `lib.rs` module gets `#[ephemeral]`.** Add `#[ephemeral]` above `#[program] pub mod ansem_miner` to auto-generate `process_undelegation` + `InitializeAfterUndelegation` (er-sdk report §2). Add the seven new instruction entries (§2a).

---

## 7. Open questions / risks (ranked)

1. **[BLOCKER] anchor-lang 0.31.1 → 1.0.2 migration cost.** Everything downstream assumes the bump. Must be resolved *first*. Risk: 0.31→1.0 account-macro / error-type churn across all M1 instruction files. Mitigation: the examples run identical shapes on 1.0.2, so it's a version bump not a redesign — but budget a full compile-and-fix pass and re-run the M1 test suite before any M2 code lands. *Decision needed:* upgrade (recommended) vs. `anchor-compat` pinning (fights the `anchor-modern` guard — discouraged).

2. **[RESOLVED — task-0 de-risk] vrf-oracle 0.3.0 vs scoped discriminators.** ✅ **Resolved by pinning vrf-sdk to `=0.3.0` (matching the installed `vrf-oracle 0.3.0`) and using the non-scoped `create_request_randomness_ix` + global `VRF_PROGRAM_IDENTITY` guard** — the exact path both reference examples use against this oracle. The scoped `0.4.1` path (which the original §4 code assumed) is what would have hung in `STATE_VRF_PENDING`; we do not use it. See the CORRECTION block at the top of this doc.

3. **[HIGH] Escrow-debit relocation correctness (§6.3).** Moving the escrow decrement off the ER `stake` path to an L1 boundary is the highest-risk *logic* change — get the accounting wrong and either players over-stake (escrow under-debited) or the solvency check false-trips. Needs a dedicated design decision (up-front debit vs. L1 reconcile-at-commit) and its own test coverage on both providers. Recommend design (b) reconcile-at-commit for symmetry with the committed-snapshot model.

4. **[MED] VRF-in-ER composition actually fulfilling locally.** The design is intended (dedicated `DEFAULT_EPHEMERAL_QUEUE`, rollups re-export — vrf-sdk report §Composition), but requires the *ER-side* oracle to watch the *exact* queue the ER validator services (`Sc9MJU…` test queue). Misconfigured queue = silent no-fulfillment. Mitigation: env-drive the queue address; assert the oracle logs a pickup in tests before asserting `STATE_SETTLED`.

5. **[MED] Test-stack flakiness / readiness gates.** Four+ processes (base, ER, QFS, two oracles) with ordering and faucet dependencies (examples report §c: base must drain to ~1000 SOL for the ER cloner). Flaky readiness → intermittent CI. Mitigation: reuse the examples' `test-locally.sh` gating verbatim; add explicit `getSlot`/RPC polls; keep `SKIP_VRF_TESTS` escape hatch for non-VRF suites.

6. **[MED] Session TS package identity.** The Rust session crate is verified (3.1.1), but the exact npm client is cited only indirectly by the crate README (session report §4). The examples report pins it concretely as `@magicblock-labs/gum-sdk ^3.0.10` (`SessionTokenManager`). Low code risk, but confirm the package resolves and `createSessionV2` matches the on-chain `create_session_v2` signature (`top_up`, `valid_until`, `lamports`) before writing session tests.

7. **[LOW] Round `commit_and_undelegate` vs MinerPosition `commit`-only interaction.** In the same round-end flow we `commit_and_undelegate` Round but only `commit` Miner. Confirm ordering (both in the ER, before L1 swap/claim) and that a per-round `commit_round` + `commit_miner` can be batched or must be sequential. Verify against `roll-dice-delegated` (commit_and_undelegate) + `anchor-counter-session` (which does both `commit` and `commit_and_undelegate`) — the split-primitive pattern exists in the examples.

8. **[LOW] `#[vrf]` does not inject `oracle_queue`.** Easy to miss — you must declare `oracle_queue` yourself or `invoke_signed_vrf` fails to resolve `self.oracle_queue` (vrf-sdk report §1 gotcha). Called out in §4a; flagging so it survives into the implementation checklist.

---

**Key M1 file references** (all absolute): `/Users/yordanlasonov/Documents/GitHub/ansem-ore/programs/ansem-miner/src/lib.rs`, `…/src/instructions/{round.rs,stake.rs,settle.rs,swap.rs,claim.rs}`, `…/src/state/{round.rs,miner.rs,config.rs}`, `…/src/constants.rs`, `…/programs/ansem-miner/Cargo.toml`, `…/Anchor.toml`, `…/package.json`.