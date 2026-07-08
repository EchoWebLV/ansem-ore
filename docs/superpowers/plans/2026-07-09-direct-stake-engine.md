# Direct-Stake Engine (ORE model) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the escrow flow with ORE's direct model for Friday's launch: connect → pick squares → ONE approval (SOL moves wallet→pot in that tx) → VRF reveal → claim. No deposit, no withdraw, no session key, no rollup delegation in the player path.

**Architecture:** Three NEW instructions (`stake_direct`, `claim_direct`, `refund_direct`) alongside the untouched existing ones (escrow rails stay dormant = future ORE-style "automation" mode). Rounds are never delegated — the keeper loop collapses to `create → request_settle(VRF) → swap`. Claim idempotency via block_stake zeroing (double-claim pays 0 by floor math — no new state, no migration). Verified by ORE's own source: manual `Deploy` transfers straight from the signer (`round_info.collect(total_amount, &signer_info)`); winnings are pull-claimed.

**Tech Stack:** unchanged (Anchor 0.31.1 sBPF v3, pnpm monorepo, MagicBlock ephemeral VRF for settle — VRF stays; only player-path delegation goes).

**Why this is safe at this speed:** payout math, VRF settle, swap, solvency gate, cancel/recovery — all untouched and battle-tested this week. The new surface is three small instructions built from existing proven parts (deposit's transfer CPI, claim's payout math, stake's guards).

---

## Task 1: Program — `stake_direct`

**Files:** Create `programs/ansem-miner/src/instructions/direct.rs`; modify `lib.rs`, `instructions/mod.rs`.

- [ ] Context: signer authority (mut), config, round (mut, seeds by round_id, state Open, `now < deadline_ts`), miner (init_if_needed, seeds MINER_SEED+authority — same PDA as today), pot_vault (mut), system_program. Box round/miner (4KB stack gotcha).
- [ ] Handler: guards `round.state == Open`, `now < round.deadline_ts`, `amount >= config.min_stake`, per-round cap: stamp-or-accumulate miner (if `miner.round_id != round_id` → stamp + zero block_stake, also set authority/bump on first init), `sum(miner.block_stake) + amount <= config.max_stake_per_round`; system transfer authority→pot_vault (deposit.rs pattern, NO escrow bookkeeping); `miner.block_stake[sq] += amount; round.block_sol[sq] += amount; round.pot += amount` (checked math).
- [ ] NOTE: does NOT touch `config.total_escrow_balance` — the swap solvency gate `pot_vault >= total_escrow_balance + pot` stays balanced because the lamports and `pot` increment arrive together.

## Task 2: Program — `claim_direct` + `refund_direct`

**Files:** `direct.rs` (same file).

- [ ] `claim_direct(round_id)`: claim.rs context minus escrow (authority, config, round state Claimable, miner keyed to round_id, ansem_mint, vault_authority, payout_vault, player ATA init_if_needed, token+associated_token+system programs — all Box'd). Payout: existing `math::return_weight`/`nonjackpot_payout` + jackpot share (identical call shape to claim.rs). After transfer: `miner.block_stake = [0; GRID]` → a second claim computes weight 0 → pays 0 (idempotent, no new state).
- [ ] `refund_direct(round_id)`: round state Closed; refund = `sum(miner.block_stake)` lamports pot_vault→authority (PDA-signed transfer, mirrors claim's vault transfer but SOL); zero block_stake after. Permissionless-per-player like `refund`.
- [ ] Unit + integration tests (`tests/direct-stake.ts`, fresh local validator): happy path E2E (create→stake_direct×2 players→settle(admin fallback)→swap→claim_direct both, solvency: sum(claims) ≤ proceeds); guards (past deadline, below min, over cap, wrong state); double-claim pays 0; refund path on cancel; ESCROW PATH UNTOUCHED (existing 23/23 suite still green).

## Task 3: Deploy + verify on devnet

- [ ] `anchor build` (IDL) → `pnpm --filter @ansem/sdk sync-idl` → `cargo build-sbf --arch v3 --tools-version v1.54` → `bash scripts/deploy-devnet.sh` (budget: 6.58 SOL ✓) → slot check.
- [ ] Local suites green BEFORE deploy: `pnpm exec ts-mocha ... tests/direct-stake.ts` + existing `tests/ansem-miner.ts` (23/23).

## Task 4: Keeper — direct mode

**Files:** `keeper/src/crank/{decide,loop,actions}.ts`, `keeper/src/env.ts`.

- [ ] `KEEPER_DIRECT_MODE=1`: after `create_round`, do NOT `delegate_round`. decide.ts already routes program-owned + past-deadline → Settle; verify no CommitToL1/reconcile branch fires for an undelegated round (add mode guard where needed). Reconcile skipped entirely (no escrow debits exist).
- [ ] Read-layer: round always read from L1 (owner check already handles this). Leaderboard: miner scan by round_id (exists — 0-stake filter stays).
- [ ] Unit tests for the mode branch; keeper IT variant `DIRECT=1` driving a full round with a scripted direct player.

## Task 5: SDK — builders

**Files:** `packages/sdk/src/instructions/direct.ts`, barrel exports.

- [ ] `stakeDirectIx(program, wallet, roundId, square, amount)`, `claimDirectIx`, `refundDirectIx` (accountsPartial pattern); `buildDirectStakeTx(...squares)` batching init-free multi-square stakes into one tx (entry-batch pattern, no session signer — wallet is the only signer). Vitest for account shapes.

## Task 6: Frontend — the one-approval flow

**Files:** `app/src/lib/writes.ts` (add `directStake`), `app/src/components/{PlayControls,StakeRail}.tsx` (rewire), tests.

- [ ] Write column becomes: select squares → amount → **"Stake · one approval"** → one tx (stake_direct×N; wallet signs; receipts panel gets the sig). No escrow panel, no enter button, no session in the direct path (components stay in-tree, unwired).
- [ ] Claim/refund buttons → `claim_direct`/`refund_direct` keyed off `miner.roundId` (poll pattern exists).
- [ ] Stake gating: round Open + countdown > ~5s (avoid deadline-race reverts); wallet-balance guard reused (amount×N + fees ≤ wallet).
- [ ] Full suite + typecheck + prod build.

## Task 7: E2E + human runbook + prod

- [ ] `scripts/_e2e-bet.mjs` v2: direct mode (fund → stake_direct×2 in one tx → keeper settles → claim_direct → assert ANSEM + refund-path probe on a cancelled round if cheap).
- [ ] Runbook v2 (short): connect → stake (ONE approval) → reveal → claim; multi-square PASS; no-deposit dead-ends impossible by construction.
- [ ] Then Track B as planned: Railway keeper (DIRECT_MODE env), Vercel app, soak, launch gates.

## Cut lines (if the clock wins)

Refund-path e2e probe (unit-tested is enough for devnet beta) · keeper IT direct variant (the e2e script covers it) · StakeRail polish. NOT cuttable: the three instructions' tests, existing-suite regression, devnet e2e, human runbook.
