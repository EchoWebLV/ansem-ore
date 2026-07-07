# M4a Program Hardening (§3 bundle) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the three on-chain changes in spec §3 (3A keeper-drivable `commit_miner`, 3B keeper-gated `delegate_round`, 3C credit-back `refund`), re-verify locally + on devnet, and regenerate the IDL — so the SDK/keeper/read-layer (next plan) build on a hardened program.

**Architecture:** One Anchor program upgrade to `ansem-miner` (program id `8Q9EnK7ydn6ywo7ZxeqhubqYybf7FFNNwnz8JzJjXZjz`). Changes are confined to `instructions/delegation.rs` (3A commit_miner + 3B delegate_round), `instructions/recovery.rs` (3C refund), and `error.rs` (one new variant). Regression tests split by cluster: deterministic **L1-only** tests (`tests/ansem-miner.ts`) cover 3B negatives + the 3C credit-back round-trip; the **ER suite** (`tests/ansem-miner-er.ts`) covers 3A (keeper-signed commit, settle-before-commit ordering). Rebuild sBPF v3, run the full local gate, redeploy the upgrade to devnet, re-run `tests/ansem-miner-devnet.ts`, regenerate types.

**Tech Stack:** Anchor 1.0.2 (avm), Agave/solana-cli 4.1, sBPF v3 (`cargo build-sbf --arch v3 --tools-version v1.54`), ts-mocha, `@coral-xyz/anchor`, MagicBlock ER SDK, ephemeral-vrf, gum session-keys.

---

## Orientation (read before starting)

- **Spec:** `docs/superpowers/specs/2026-07-07-ansem-miner-m4-frontend-design.md` §3 (3A/3B/3C fix designs), §9 (testing).
- **The two bugs** (from the pre-M4 stress test): #1 `delegate_round` is permissionless with a caller-chosen validator → freeze any round; #2 reconcile-then-cancel strands a reconciled staker's SOL (`refund` gives no credit). Both are HIGH fund-safety, both fixed here.
- **Two interactions this plan MUST handle (do not skip):**
  1. **3C removes** the `escrow.last_claimed_round = round_id` write from `refund`. The existing M1 test asserts `lastClaimedRound == 1` at `tests/ansem-miner.ts:284` — that assertion must change to `0`.
  2. **3A's `state != OPEN` gate** forces **settle-before-commit** ordering. The current ER suite commits the miner while the round is still OPEN and pre-deadline (`tests/ansem-miner-er.ts` "task 6" runs before "task 8" `settleAfterDeadline`). The ER test flow must be reordered to settle on the ER first, then `commit_miner`, then `commit_round`.
- **State/field names (exact):** `PlayerEscrow { authority, balance, deposited_total, withdrawn_total, last_claimed_round, active_round, reconciled_round, bump }`; `MinerPosition { authority, round_id, block_stake:[u64;25], bump }`; `Config { admin, …, current_round_id, total_escrow_balance, current_round_finalized, config_bump, … }`. States: `STATE_OPEN=0, STATE_VRF_PENDING=1, STATE_SETTLED=2, STATE_CLAIMABLE=4, STATE_CLOSED=5`.
- **Constants/seeds** (in `constants.rs`, imported via `crate::constants::*`): `CONFIG_SEED`, `ROUND_SEED`, `MINER_SEED`, `ESCROW_SEED`, `GRID_SIZE=25`.
- **Anchor TS note:** `.accounts()` maps by name and ignores keys not in the instruction's IDL, so passing a superset is safe; PDA accounts auto-resolve under `resolution = true` when derivable from provided accounts + args.

---

## Task 1: Add the `CommitTooEarly` error

**Files:**
- Modify: `programs/ansem-miner/src/error.rs`

- [ ] **Step 1: Add the variant**

In `programs/ansem-miner/src/error.rs`, add one variant to the `AnsemError` enum (after `AlreadyReconciled`):

```rust
    #[msg("Miner already reconciled for this round")] AlreadyReconciled,
    #[msg("Cannot commit a miner while its round is still open (staking not closed)")] CommitTooEarly,
}
```

- [ ] **Step 2: Compile-check**

Run: `cargo check -p ansem-miner`
Expected: compiles (the new variant is unused until Task 2 — a dead-code warning is fine).

- [ ] **Step 3: Commit**

```bash
git add programs/ansem-miner/src/error.rs
git commit -m "M4a: add CommitTooEarly error for the commit_miner gate"
```

---

## Task 2: 3A — keeper-drivable `commit_miner`

Make `commit_miner` signable by anyone (the keeper), gated so it can only run once staking is closed (`round.state != OPEN`). This removes the "one offline staker stalls every round" liveness hole.

**Files:**
- Modify: `programs/ansem-miner/src/instructions/delegation.rs:106-138` (the `CommitMiner` struct + handler)

- [ ] **Step 1: Update imports**

At the top of `delegation.rs`, extend the state import to include `STATE_OPEN`:

```rust
use crate::state::{Config, MinerPosition, Round, STATE_OPEN};
```

- [ ] **Step 2: Rewrite the `CommitMiner` account struct**

Replace the current `CommitMiner` struct (the `#[commit] #[derive(Accounts)] pub struct CommitMiner …` block) with:

```rust
// ---- commit_miner (ER) — commit AND undelegate, keeper-drivable ----
// AUTHORIZATION (§3A): permissionless like `reconcile_miner` — any `payer`
// (the keeper) can commit ANY miner, but ONLY once the round has left OPEN, so
// staking is closed and the block_stake snapshot is final. This removes the
// old owner-signature requirement (a single offline staker could stall the
// whole round, blocking all future rounds via the create_round gate). The
// mid-round griefing the owner-sig used to block is now blocked by the state
// gate instead: you cannot commit a miner while its round is still OPEN.
#[commit]
#[derive(Accounts)]
pub struct CommitMiner<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    // Self-referential seeds (like reconcile_miner): the miner PDA is derived
    // from its own stored authority, so no owner signature is needed.
    #[account(mut, seeds = [MINER_SEED, miner.authority.as_ref()], bump = miner.bump)]
    pub miner: Account<'info, MinerPosition>,
    // Read-only gate account: the round the miner staked. Available on the ER
    // because commit_miner runs BEFORE commit_round (the Round is still
    // delegated here). Used only to prove staking is closed.
    #[account(seeds = [ROUND_SEED, miner.round_id.to_le_bytes().as_ref()], bump = round.bump)]
    pub round: Account<'info, Round>,
}
```

- [ ] **Step 3: Add the gate to the handler**

At the top of `commit_miner_handler`, before the `MagicIntentBundleBuilder` call, add:

```rust
pub fn commit_miner_handler(ctx: Context<CommitMiner>) -> Result<()> {
    // Gate: staking must be closed. `stake` requires STATE_OPEN && now < deadline,
    // so a non-OPEN round guarantees the block_stake snapshot is final. This also
    // blocks the mid-round force-commit the removed owner-signature used to block.
    require!(ctx.accounts.round.round_id == ctx.accounts.miner.round_id, crate::error::AnsemError::MinerRoundMismatch);
    require!(ctx.accounts.round.state != STATE_OPEN, crate::error::AnsemError::CommitTooEarly);

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

(If `crate::error::AnsemError` is not already imported in this file, it is — `use crate::error::AnsemError;` is at the top; you may use `AnsemError::…` directly.)

- [ ] **Step 4: Compile-check**

Run: `cargo check -p ansem-miner`
Expected: compiles. `CommitTooEarly` is now used.

- [ ] **Step 5: Commit**

```bash
git add programs/ansem-miner/src/instructions/delegation.rs
git commit -m "M4a(3A): keeper-drivable commit_miner gated to round.state != OPEN"
```

---

## Task 3: 3B — keeper-gate `delegate_round`

Add the missing authorization to `delegate_round`: keeper-only, current-round-only, OPEN-only. This closes the permissionless-freeze bug.

**Files:**
- Modify: `programs/ansem-miner/src/instructions/delegation.rs:19-41` (the `DelegateRound` struct + handler)

- [ ] **Step 1: Ensure imports**

`delegation.rs` already imports `Config`, `Round`, `crate::constants::*`, `crate::error::AnsemError`, and (after Task 2) `STATE_OPEN`. No new imports needed. Confirm `anchor_lang::prelude::*` is present (it is).

- [ ] **Step 2: Add the `config` account (admin gate) to `DelegateRound`**

Replace the `DelegateRound` struct with:

```rust
#[delegate]
#[derive(Accounts)]
#[instruction(round_id: u64)]
pub struct DelegateRound<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    // AUTHORIZATION (§3B): keeper-only. Without this, delegate_round is
    // permissionless and anyone can transfer the Round PDA to the DLP pinned to
    // a validator they choose, freezing every L1 instruction on it (settle,
    // swap, cancel, claim) — for the current round OR any past CLAIMABLE round.
    #[account(seeds = [CONFIG_SEED], bump = config.config_bump,
        constraint = config.admin == payer.key() @ AnsemError::Unauthorized)]
    pub config: Account<'info, Config>,
    /// CHECK: delegated via the DLP CPI; UncheckedAccount avoids Anchor
    /// re-serializing after ownership transfers to the delegation program.
    #[account(mut, del, seeds = [ROUND_SEED, round_id.to_le_bytes().as_ref()], bump)]
    pub round: UncheckedAccount<'info>,
}
```

- [ ] **Step 3: Add the state/round-id defense-in-depth check in the handler**

Replace `delegate_round_handler` with:

```rust
pub fn delegate_round_handler(ctx: Context<DelegateRound>, round_id: u64) -> Result<()> {
    // Defense-in-depth: only the CURRENT, still-OPEN round may be delegated — a
    // stale/past/already-settled round can never be handed to the DLP. The Round
    // is still program-owned here (pre-delegation), so we can read it. The borrow
    // is scoped so it is dropped before the delegate CPI touches the account.
    {
        let data = ctx.accounts.round.try_borrow_data()?;
        let r = Round::try_deserialize(&mut &data[..])?;
        require!(r.state == STATE_OPEN, AnsemError::BadRoundState);
        require!(r.round_id == ctx.accounts.config.current_round_id, AnsemError::NotCurrentRound);
    }

    ctx.accounts.delegate_round(
        &ctx.accounts.payer,
        &[ROUND_SEED, &round_id.to_le_bytes()],
        DelegateConfig {
            validator: ctx.remaining_accounts.first().map(|a| a.key()),
            ..Default::default()
        },
    )?;
    Ok(())
}
```

- [ ] **Step 4: Compile-check**

Run: `cargo check -p ansem-miner`
Expected: compiles.

- [ ] **Step 5: Commit**

```bash
git add programs/ansem-miner/src/instructions/delegation.rs
git commit -m "M4a(3B): keeper-gate delegate_round (admin + OPEN + current-round)"
```

---

## Task 4: 3C — credit-back `refund`

Make `refund` reverse the reconcile debit when the player was reconciled, so a reconciled staker on a cancelled round recovers their SOL. Also drop the `last_claimed_round` write (fixes the earlier-round-claim clobber).

**Files:**
- Modify: `programs/ansem-miner/src/instructions/recovery.rs:80-108` (the `Refund` struct + handler)

- [ ] **Step 1: Ensure imports**

`recovery.rs` currently imports `use crate::state::{Config, PlayerEscrow, Round, STATE_CLOSED, STATE_OPEN, STATE_SETTLED, STATE_VRF_PENDING};`. Add `MinerPosition`:

```rust
use crate::state::{Config, MinerPosition, PlayerEscrow, Round, STATE_CLOSED, STATE_OPEN, STATE_SETTLED, STATE_VRF_PENDING};
```

- [ ] **Step 2: Rewrite the `Refund` account struct**

Replace the `Refund` struct with (adds `config` mut + `miner` read-only):

```rust
#[derive(Accounts)]
#[instruction(round_id: u64)]
pub struct Refund<'info> {
    pub authority: Signer<'info>,

    #[account(mut, seeds = [CONFIG_SEED], bump = config.config_bump)]
    pub config: Account<'info, Config>,

    #[account(seeds = [ROUND_SEED, round_id.to_le_bytes().as_ref()], bump = round.bump,
        constraint = round.round_id == round_id @ AnsemError::MinerRoundMismatch)]
    pub round: Account<'info, Round>,

    #[account(mut, seeds = [ESCROW_SEED, authority.key().as_ref()], bump = escrow.bump,
        constraint = escrow.authority == authority.key() @ AnsemError::Unauthorized)]
    pub escrow: Account<'info, PlayerEscrow>,

    // Committed block_stake snapshot — read only in the reconciled branch to
    // learn how much to credit back. Seeded on the caller's wallet.
    #[account(seeds = [MINER_SEED, authority.key().as_ref()], bump = miner.bump)]
    pub miner: Account<'info, MinerPosition>,
}
```

- [ ] **Step 3: Rewrite `refund_handler`**

Replace `refund_handler` with:

```rust
pub fn refund_handler(ctx: Context<Refund>, round_id: u64) -> Result<()> {
    require!(ctx.accounts.round.state == STATE_CLOSED, AnsemError::RoundNotClosed);

    // A genuine participant of THIS round is either still locked (joined, not yet
    // reconciled) or already reconciled (the debit ran) — the (active_round,
    // reconciled_round) pair also double-serves as the replay guard.
    let joined = ctx.accounts.escrow.active_round == round_id;
    let reconciled = ctx.accounts.escrow.reconciled_round == round_id;
    require!(joined || reconciled, AnsemError::NothingToRefund);

    if reconciled {
        // reconcile_miner already debited escrow from block_stake, but this round
        // never swapped — the lamports are still idle in pot_vault. Reverse the
        // debit so the player can withdraw. Consume reconciled_round to prevent a
        // second credit.
        require!(ctx.accounts.miner.round_id == round_id, AnsemError::MinerRoundMismatch);
        let staked: u64 = ctx.accounts.miner.block_stake.iter().sum();
        let escrow = &mut ctx.accounts.escrow;
        escrow.balance = escrow.balance.checked_add(staked).ok_or(AnsemError::Overflow)?;
        escrow.reconciled_round = 0;
        let cfg = &mut ctx.accounts.config;
        cfg.total_escrow_balance =
            cfg.total_escrow_balance.checked_add(staked).ok_or(AnsemError::Overflow)?;
    }

    // Release the withdraw-lock. Do NOT write last_claimed_round: the
    // (active_round, reconciled_round) guards already block a second refund, and
    // leaving last_claimed_round untouched preserves the player's ability to
    // claim an earlier, still-unclaimed round.
    ctx.accounts.escrow.active_round = 0;
    Ok(())
}
```

- [ ] **Step 4: Compile-check**

Run: `cargo check -p ansem-miner`
Expected: compiles. (`STATE_OPEN`/`STATE_SETTLED`/`STATE_VRF_PENDING` remain used by `cancel_round` in the same file.)

- [ ] **Step 5: Commit**

```bash
git add programs/ansem-miner/src/instructions/recovery.rs
git commit -m "M4a(3C): refund credits back reconciled stake; drop last_claimed_round write"
```

---

## Task 5: L1 regression tests (3B negatives + 3C credit-back) + fix the stale assertion

Deterministic base-cluster tests. No ER/validator infra needed — `stake`, `settle`, `reconcile_miner`, `cancel_round`, `refund` all run directly on L1 in this suite.

**Files:**
- Modify: `tests/ansem-miner.ts` (fix line ~284; add the new `it(...)` blocks **at the end of the `describe("ansem-miner", …)` block**, after all existing swap/claim tests, so the round-id sequencing the existing tests rely on is undisturbed)

- [ ] **Step 1: Fix the now-stale assertion**

In `tests/ansem-miner.ts`, in the test "cancels an abandoned round 1 and refunds the staker (escape hatch)", change the `lastClaimedRound` assertion (currently `assert.equal(eAfter.lastClaimedRound.toNumber(), 1);` at ~line 284) to:

```js
    assert.equal(eAfter.lastClaimedRound.toNumber(), 0); // refund no longer writes last_claimed_round (§3C)
```

Run: `yarn run ts-mocha -p ./tsconfig.json -t 1000000 tests/ansem-miner.ts` (needs a local validator — see Task 7 for how the full gate runs it; for now this step just records the change).

- [ ] **Step 2: Add the 3B negative tests**

Add at the end of the describe block. A 0-duration round is still `STATE_OPEN` (settle hasn't run) but immediately past its deadline, so it satisfies `delegate_round`'s `state == OPEN` check and can be cancelled right after — no waiting:

```js
  it("§3B: delegate_round rejects a non-admin caller", async () => {
    const attacker = anchor.web3.Keypair.generate();
    const sig = await provider.connection.requestAirdrop(attacker.publicKey, anchor.web3.LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(sig);
    const { pda, id } = await freshInstantRound(0); // OPEN, already past deadline
    try {
      await program.methods.delegateRound(new anchor.BN(id))
        .accounts({ payer: attacker.publicKey, config: configPda, round: pda })
        .signers([attacker]).rpc();
      assert.fail("non-admin delegate_round must be rejected");
    } catch (e: any) { assert.include(e.toString(), "Unauthorized"); }
    // Finalize this OPEN round so the create_round gate re-arms (cancel = OPEN+past-deadline -> CLOSED).
    await program.methods.cancelRound().accounts({ admin: admin.publicKey, round: pda }).rpc();
    assert.equal((await program.account.round.fetch(pda)).state, 5); // STATE_CLOSED
  });
```

`freshInstantRound(durationSecs = 0)` returns `{ id, pda }` (confirm the exact shape in the file). If the on-chain clock lags so the immediate `cancelRound` throws `RoundNotCancelable`, wrap it in the poll-retry loop used by the escape-hatch test (~line 256). **Do not leave an un-finalized round open.**

- [ ] **Step 3: Add the 3B stale/past-round negative**

```js
  it("§3B: delegate_round rejects a stale (non-current / non-OPEN) round", async () => {
    // Use a settled-then-closed round id from earlier in the suite (already
    // finalized). Delegating it must fail BadRoundState or NotCurrentRound —
    // the admin gate passes but the defense-in-depth state/round-id check trips.
    const staleId = 1; // round 1 was closed by the escape-hatch test
    const [stalePda] = PublicKey.findProgramAddressSync(
      [enc("round"), new anchor.BN(staleId).toArrayLike(Buffer, "le", 8)], program.programId);
    try {
      await program.methods.delegateRound(new anchor.BN(staleId))
        .accounts({ payer: admin.publicKey, config: configPda, round: stalePda }).rpc();
      assert.fail("delegating a stale round must be rejected");
    } catch (e: any) {
      assert.isTrue(/BadRoundState|NotCurrentRound/.test(e.toString()), e.toString());
    }
  });
```

- [ ] **Step 4: Add the 3C credit-back round-trip test**

This is the core fund-safety regression. A player stakes, is reconciled, the round is cancelled, and `refund` must restore their balance.

```js
  it("§3C: reconcile -> cancel -> refund restores the staker's balance", async () => {
    // Fresh player with a clean escrow.
    const p = anchor.web3.Keypair.generate();
    const air = await provider.connection.requestAirdrop(p.publicKey, 3 * anchor.web3.LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(air);
    await program.methods.deposit(new anchor.BN(2 * anchor.web3.LAMPORTS_PER_SOL))
      .accounts({ authority: p.publicKey }).signers([p]).rpc();
    await program.methods.initMiner().accounts({ authority: p.publicKey }).signers([p]).rpc();

    // Open a short round, join, stake 0.5 SOL (L1-direct, as this suite does).
    const { pda: rPda, id: rId } = await freshInstantRound(15);
    await program.methods.joinRound(new anchor.BN(rId))
      .accounts({ authority: p.publicKey, config: configPda, escrow: escrowOf(p.publicKey) })
      .signers([p]).rpc();
    const STAKE = new anchor.BN(0.5 * anchor.web3.LAMPORTS_PER_SOL);
    await program.methods.stake(4, STAKE)
      .accounts(stakeAccts(p.publicKey, rPda)).signers([p]).rpc();

    // Reconcile (permissionless): debits escrow from the block_stake snapshot and
    // clears the lock. This is the step whose debit refund must later reverse.
    await program.methods.reconcileMiner(new anchor.BN(rId))
      .accounts({ config: configPda, escrow: escrowOf(p.publicKey), miner: minerOf(p.publicKey) }).rpc();
    const eStaked = await program.account.playerEscrow.fetch(escrowOf(p.publicKey));
    assert.equal(eStaked.balance.toNumber(), 1.5 * anchor.web3.LAMPORTS_PER_SOL, "debited by reconcile");
    assert.equal(eStaked.activeRound.toNumber(), 0, "reconcile released the lock");
    assert.equal(eStaked.reconciledRound.toNumber(), rId);
    const teBefore = (await program.account.config.fetch(configPda)).totalEscrowBalance.toNumber();

    // Cancel the round after its deadline (poll for on-chain clock lag).
    let canceled = false;
    for (let i = 0; i < 30 && !canceled; i++) {
      await sleep(1500);
      try {
        await program.methods.cancelRound().accounts({ admin: admin.publicKey, round: rPda }).rpc();
        canceled = true;
      } catch (e: any) { if (!e.toString().includes("RoundNotCancelable")) throw e; }
    }
    assert.isTrue(canceled);

    // Refund must CREDIT BACK the 0.5 SOL and clear the lock.
    await program.methods.refund(new anchor.BN(rId))
      .accounts({ authority: p.publicKey, config: configPda, round: rPda,
        escrow: escrowOf(p.publicKey), miner: minerOf(p.publicKey) })
      .signers([p]).rpc();
    const eRef = await program.account.playerEscrow.fetch(escrowOf(p.publicKey));
    assert.equal(eRef.balance.toNumber(), 2 * anchor.web3.LAMPORTS_PER_SOL, "stake credited back");
    assert.equal(eRef.activeRound.toNumber(), 0, "lock released");
    assert.equal(eRef.reconciledRound.toNumber(), 0, "reconciled_round consumed");
    const teAfter = (await program.account.config.fetch(configPda)).totalEscrowBalance.toNumber();
    assert.equal(teAfter - teBefore, 0.5 * anchor.web3.LAMPORTS_PER_SOL, "total_escrow_balance restored");

    // A second refund now no-ops (nothing to refund).
    try {
      await program.methods.refund(new anchor.BN(rId))
        .accounts({ authority: p.publicKey, config: configPda, round: rPda,
          escrow: escrowOf(p.publicKey), miner: minerOf(p.publicKey) })
        .signers([p]).rpc();
      assert.fail("double refund must be rejected");
    } catch (e: any) { assert.include(e.toString(), "NothingToRefund"); }

    // And the credited balance is now withdrawable (lock released).
    await program.methods.withdraw(new anchor.BN(0.5 * anchor.web3.LAMPORTS_PER_SOL))
      .accounts({ authority: p.publicKey }).signers([p]).rpc();
  });
```

Note on helpers: this suite already defines `sleep`, `freshInstantRound`, `stakeAccts`, `minerOf`, `escrowOf`, `configPda`, `escrowPda`. Confirm `freshInstantRound(durationSecs)` returns `{ id, pda }` and re-arms the gate (it settles/cancels leftover rounds as needed). If `freshInstantRound`'s exact return differs, adapt the destructuring — do not invent new helpers.

- [ ] **Step 5: Commit**

```bash
git add tests/ansem-miner.ts
git commit -m "M4a: L1 regressions for 3B (delegate_round auth) + 3C (refund credit-back)"
```

---

## Task 6: ER suite — 3A keeper-signed commit + settle-before-commit ordering

The ER suite must (a) drive `commit_miner` with the keeper as payer and NO owner signature, (b) reorder so settle happens on the ER (round SETTLED) **before** `commit_miner`, which runs **before** `commit_round`, and (c) replace the old attacker-authority negative with a "commit while OPEN → CommitTooEarly" negative.

> This is the ER-dependent task: it requires the local ephemeral validator (`scripts/test-er.sh`) and may need the M3 ER hardening (clock-lag retries, regional endpoint for writes). Iterate against the live validator.

**Files:**
- Modify: `tests/ansem-miner-er.ts` ("task 6" block ~line 305 and "task 8" ~line 350; the `refund` call ~line 449)

- [ ] **Step 1: Reorder — settle on the ER before committing**

The current flow is: task 6 (`commit_round` → `commit_miner`, round OPEN) then task 8 (`settleAfterDeadline` on L1 → reconcile → swap). Change to: **wait out the deadline → settle the still-delegated round on the ER → `commit_miner` (keeper) → `commit_round` → reconcile → swap.** Concretely, before any commit, settle on the ER:

```js
    // Settle on the ER while the Round is still delegated (production ordering).
    // Round must be past its deadline first (stake gate already closed).
    await sleepUntilDeadline(round1Pda); // poll ER clock vs round.deadline_ts
    await ephemeralProgram.methods.settle([...Buffer.alloc(32, 7)])
      .accounts({ admin: admin.publicKey, round: round1Pda })
      .rpc({ skipPreflight: true, commitment: "confirmed" });
    const rSettled = await ephemeralProgram.account.round.fetch(round1Pda);
    assert.equal(rSettled.state, 2, "round SETTLED on the ER");
```

If `settle` on the ER is problematic against the local ER build, use the VRF path (`request_settle` + await `settle_callback`) exactly as `tests/ansem-miner-vrf.ts` does — either way the goal is `round.state == SETTLED` while still delegated. Reuse/port the deadline-poll helper from `settleAfterDeadline`.

- [ ] **Step 2: Replace the attacker-authority negative with a CommitTooEarly negative**

The old negative (commit a victim's miner with a wrong `authority` signer) no longer applies — there is no `authority` field. Instead, assert `commit_miner` is rejected **while the round is still OPEN**. Place this BEFORE Step 1's settle (while OPEN), then the positive commit AFTER settle. Replace the `attacker`/`griefBlocked` block (~lines 322-330) with:

```js
    // §3A gate: committing a miner while the round is still OPEN must fail
    // (staking not closed). Run this BEFORE settle.
    let tooEarlyBlocked = false;
    try {
      await ephemeralProgram.methods.commitMiner()
        .accounts({ payer: admin.publicKey, miner: minerPda, round: round1Pda })
        .rpc({ skipPreflight: true, commitment: "confirmed" });
    } catch { tooEarlyBlocked = true; }
    assert.isTrue(tooEarlyBlocked, "commit_miner must be rejected while round is OPEN");
```

- [ ] **Step 3: Positive keeper-signed commit (new account shape, after settle, before commit_round)**

Replace the old positive `commitMiner` call (~lines 336-339, with `authority: player`) with a keeper-signed call using the new shape, and ensure it runs **before** `commit_round`:

```js
    // Keeper commits the miner — no owner signature, round is SETTLED.
    const sigM = await ephemeralProgram.methods.commitMiner()
      .accounts({ payer: admin.publicKey, miner: minerPda, round: round1Pda })
      .rpc({ skipPreflight: true, commitment: "confirmed" });
    await GetCommitmentSignature(sigM, erConnection);
    await awaitOwnerIs(provider.connection, minerPda, program.programId.toBase58());

    // THEN commit_round (undelegates the Round; must come after commit_miner so
    // the miner's read-only round gate account was still delegated/available).
    const sigR = await ephemeralProgram.methods.commitRound()
      .accounts({ payer: admin.publicKey, config: configPda, round: round1Pda })
      .rpc({ skipPreflight: true, commitment: "confirmed" });
    await GetCommitmentSignature(sigR, erConnection);
    await awaitOwnerIs(provider.connection, round1Pda, program.programId.toBase58());
```

Remove the now-duplicated `commit_round` call that previously ran first (~lines 309-316); keep its post-commit L1 pot assertion after this reordered commit.

- [ ] **Step 4: Update the `refund` call site for the new account shape**

At the round-2 cancel/refund (~line 449), pass the full accounts (or rely on resolution). Make it explicit:

```js
    await program.methods.refund(new anchor.BN(ROUND2))
      .accounts({ authority: player.publicKey, config: configPda, round: round2Pda,
        escrow: escrowPda, miner: minerPda }).signers([player]).rpc();
```

If that round-2 player was reconciled before the cancel, assert the credit-back (balance restored); if not, assert the balance is unchanged (lock-release only) — match the assertion to whether `reconcile` ran in that scenario.

- [ ] **Step 5: Run the ER suite**

Run: `bash scripts/test-er.sh` (spins up the local base + ephemeral validators and runs `tests/ansem-miner-er.ts`).
Expected: the reordered hands-off round goes stake → settle(ER) → commit_miner(keeper) → commit_round → reconcile → swap → claim green; the OPEN-commit negative and round-2 refund pass. Iterate on ER-clock-lag / propagation retries as in M3 if needed.

- [ ] **Step 6: Commit**

```bash
git add tests/ansem-miner-er.ts
git commit -m "M4a(3A): ER suite — keeper-signed commit_miner + settle-before-commit ordering"
```

---

## Task 7: Rebuild v3 + full local gate

- [ ] **Step 1: Build sBPF v3**

Run: `cargo build-sbf --arch v3 --tools-version v1.54`
Then verify the ELF flags: `llvm-readelf -h target/deploy/ansem_miner.so | grep -i flags` → expect `Flags: 0x3`.

- [ ] **Step 2: Regenerate the IDL/types**

Run: `anchor build` (or the project's IDL step) so `target/idl/ansem_miner.json` and `target/types/ansem_miner.ts` reflect the new `commit_miner`/`delegate_round`/`refund` account shapes + the `CommitTooEarly` error.

- [ ] **Step 3: Rust unit + invariants**

Run: `cargo test --manifest-path programs/ansem-miner/Cargo.toml --lib --test invariants`
Expected: 9 lib math tests + 7 invariant stress tests pass.

- [ ] **Step 4: Full TS gate**

Run the M1, session, and VRF suites on a local validator (per the project's `anchor test` / `scripts/test-er.sh` setup), plus the ER suite from Task 6. Expected: all green (the same 40/40+ gate, now including the new L1 regressions).

- [ ] **Step 5: Commit any regenerated artifacts**

```bash
git add target/idl/ansem_miner.json target/types/ansem_miner.ts
git commit -m "M4a: regenerate IDL/types for the §3 program changes"
```

(If `target/` is gitignored, skip — the SDK plan will consume the freshly built types from disk.)

---

## Task 8: Redeploy to devnet + re-verify

- [ ] **Step 1: Deploy the upgrade**

Run: `bash scripts/deploy-devnet.sh` (loader-v3, resumable — reuses the funded deploy wallet + Helius RPC from `.env`). This upgrades the existing program id in place.
Expected: upgrade succeeds; `solana program show 8Q9EnK7ydn6ywo7ZxeqhubqYybf7FFNNwnz8JzJjXZjz --url <devnet>` shows the new data length / slot.

- [ ] **Step 2: Re-run the devnet e2e**

Run: `yarn run ts-mocha -p ./tsconfig.json -t 1000000 tests/ansem-miner-devnet.ts`
Expected: the full gasless devnet round is green against the upgraded program (settle-before-commit ordering, keeper-signed commit).

- [ ] **Step 3: Adversarial review before finishing**

Dispatch a fresh reviewer over the three changed handlers (`commit_miner`, `delegate_round`, `refund`) confirming: no new value-movement path; the gates are correct; `refund` credit-back is solvency-neutral; the ER ordering holds. (M2/M3 rigor.)

- [ ] **Step 4: Commit the run-book note**

```bash
git commit --allow-empty -m "M4a: §3 hardening deployed to devnet; devnet e2e green"
```

---

## Self-Review checklist (run after implementation)

- **Spec coverage:** 3A (Task 2 + Task 6), 3B (Task 3 + Task 5 negatives), 3C (Task 4 + Task 5 round-trip), verification (Tasks 7–8). ✎ confirm each maps.
- **The two flagged interactions:** line-284 assertion fixed (Task 5 Step 1); ER reordered settle→commit_miner→commit_round (Task 6). ✎ confirm both done.
- **Types match:** `CommitMiner` = {payer, miner, round}; `DelegateRound` = {payer, config, round}; `Refund` = {authority, config, round, escrow, miner}. ✎ confirm every test call site matches.
- **No stranded rounds in tests:** every new test that opens a round finalizes it (swap or cancel) so the `create_round` gate re-arms. ✎ confirm.

## Risks / notes for the implementer

- **Reading `round` on the ER in `commit_miner`:** the Round must still be delegated when `commit_miner` runs (hence commit_miner BEFORE commit_round). If the ER build rejects the read-only delegated round account, fall back to a deadline-based gate (`require!(now >= round.deadline_ts, CommitTooEarly)` using `Clock::get()`), which needs the same account but not its delegation-state — but prefer the state gate as specified.
- **`Round::try_deserialize` in `delegate_round`:** ensure the borrow is dropped (scoped block) before the delegate CPI. If the delegate macro needs exclusive access earlier, move the check to read the raw `state`/`round_id` bytes at fixed offsets instead of full deserialize.
- **ER settle path:** if admin `settle` won't run cleanly on the local ER, use the VRF `request_settle`/`settle_callback` path (see `tests/ansem-miner-vrf.ts`) to reach SETTLED while delegated.

---

## Execution Handoff

**Plan complete.** Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, two-stage review between tasks.
2. **Inline Execution** — execute tasks in this session with checkpoints (executing-plans).

The program-change tasks (1–4) are mechanical given the exact code; Tasks 6–8 (ER + deploy) need live-validator/devnet iteration and judgment.
