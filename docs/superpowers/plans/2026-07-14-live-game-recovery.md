# Live Game Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to execute this plan task by task.

**Goal:** Permanently recover the mainnet game loop, make base BEEF fully collateralized and unskippable, make the seeder preserve player entitlement, and restore 60-second rounds.

**Architecture:** The Solana program tops up only the post-swap rent shortfall after passing existing solvency checks and rejects unfunded BEEF bonus configuration. The keeper uses an idempotent stamp operation as a gate before advancing a funded claimable round. The launch seeder rolls a stamped emission before entering another round. Railway supplies the authoritative 60-second round duration.

**Tech Stack:** Anchor/Rust, Solana web3.js, TypeScript, Vitest, Mocha/Chai, Node.js test runner, pnpm, Railway CLI, Solana CLI.

## Global Constraints

- Work in an isolated `codex/live-game-recovery` worktree. Do not modify or stage the user's dirty checkout.
- Follow red-green-refactor for every behavior change. Capture the failing test before implementation.
- Preserve account layouts, instruction discriminators, mint authority, treasury ownership, payout ratios, and winner selection.
- Do not sweep, burn, reassign, or reduce accounting for the existing 47.481502 BEEF vault reserve.
- Base BEEF remains enabled. Only the unfunded activity bonus is disabled.
- Do not deploy until the complete local verification task passes and the mainnet upgrade authority is confirmed.
- Commit after each task with only that task's files staged.

---

### Task 1: Disable the live unfunded BEEF bonus

**Files:**

- Read: `packages/sdk/src/instructions/keeper.ts`
- Read: `packages/sdk/src/accounts.ts`
- Operational state: mainnet `BeefConfig` PDA

**Step 1: Read and record current config**

Use a read-only Node script through the built SDK and the configured mainnet RPC. Record `max_beef`, `sat_lamports`, `activity_window_secs`, `secs_per_tick`, `tick_bps`, `bonus_cap_bps`, `minted_total`, and `total_owed`.

Expected: the existing economic and accounting values are readable and the current bonus values are nonzero.

**Step 2: Submit the narrow config change**

Build `setBeefParamsIx` using the keeper admin key. Preserve max supply, saturation, activity window, and seconds per tick. Set only:

```ts
tickBps: 0,
bonusCapBps: 0,
```

Send and confirm the transaction.

**Step 3: Read back and verify**

Expected:

```text
tick_bps = 0
bonus_cap_bps = 0
minted_total unchanged
total_owed unchanged
vault token balance unchanged
treasury token balance unchanged
```

Record the transaction signature in the deployment evidence. This task changes live configuration only and has no source commit.

---

### Task 2: Add a rent-reserve regression test for real swaps

**Files:**

- Modify: `tests/mainnet-path.ts`
- Read: `programs/ansem-miner/src/instructions/swap.rs`

**Step 1: Write the failing integration test**

Add a test that starts from an otherwise empty pot vault, transfers 1,000 lamports of dust, creates and funds a round whose available balance equals its pot, settles it, and invokes the real swap path.

Assert:

```ts
expect(postSwapPotVaultLamports).to.be.gte(
  await provider.connection.getMinimumBalanceForRentExemption(0),
);
expect(postSwapTreasuryLamports - preSwapTreasuryLamports).to.equal(
  Number(roundPot),
);
```

Also add or retain an insolvency case proving a missing pot fails without debiting the payer.

**Step 2: Run the focused test and confirm RED**

Run:

```bash
pnpm exec ts-mocha -p ./tsconfig.json -t 1000000 tests/mainnet-path.ts --grep "rent reserve"
```

Expected: the swap fails because the exact pot transfer would leave the pot vault below the rent-exempt minimum.

**Step 3: Commit the red test**

```bash
git add tests/mainnet-path.ts
git commit -m "test(program): reproduce pot vault rent wedge"
```

---

### Task 3: Make real and mock swaps preserve rent

**Files:**

- Modify: `programs/ansem-miner/src/instructions/swap.rs`
- Test: `tests/mainnet-path.ts`

**Step 1: Extract one shared helper**

After the existing escrow and pot solvency checks, call a helper from both swap handlers:

```rust
fn ensure_post_swap_rent_reserve<'info>(
    payer: &Signer<'info>,
    pot_vault: &SystemAccount<'info>,
    system_program: &Program<'info, System>,
    pot: u64,
) -> Result<()> {
    let post_swap = pot_vault.to_account_info().lamports().checked_sub(pot)
        .ok_or(error!(AnsemError::InsufficientPotVaultFunds))?;
    let shortfall = Rent::get()?.minimum_balance(0).saturating_sub(post_swap);
    if shortfall > 0 {
        system_program::transfer(
            CpiContext::new(
                system_program.to_account_info(),
                system_program::Transfer {
                    from: payer.to_account_info(),
                    to: pot_vault.to_account_info(),
                },
            ),
            shortfall,
        )?;
    }
    Ok(())
}
```

Use the repository's actual error variant and account types if their names differ. Do not move the helper before solvency validation.

**Step 2: Run focused tests and confirm GREEN**

```bash
pnpm exec ts-mocha -p ./tsconfig.json -t 1000000 tests/mainnet-path.ts --grep "rent reserve|insolvent"
```

Expected: rent-reserve and insolvency cases pass.

**Step 3: Run program formatting and the whole mainnet-path suite**

```bash
cargo fmt --all -- --check
pnpm exec ts-mocha -p ./tsconfig.json -t 1000000 tests/mainnet-path.ts
```

Expected: both commands exit 0.

**Step 4: Commit**

```bash
git add programs/ansem-miner/src/instructions/swap.rs tests/mainnet-path.ts
git commit -m "fix(program): preserve pot vault rent after swaps"
```

---

### Task 4: Add base-only BEEF safety tests

**Files:**

- Modify: `tests/direct-beef.ts`
- Modify: `tests/beef-cap.ts`
- Modify: `programs/ansem-miner/src/math.rs` only if unit coverage belongs beside parameter math

**Step 1: Replace bonus-positive expectations**

For fresh test rounds, configure `tick_bps=0` and `bonus_cap_bps=0`. Assert that activity time does not increase miner shares or `total_owed`, and a roll plus claim transfers exactly the stamped base player emission.

Add the collateralization assertion:

```ts
expect(beefVault.amount).to.be.gte(beefConfig.totalOwed);
```

For an isolated fresh lifecycle, assert equality before claim and a zero fresh liability delta after claim.

**Step 2: Add rejection tests**

Add one initialization or update case for each invalid form:

```text
tick_bps > 0, bonus_cap_bps = 0 -> BadBeefParams
tick_bps = 0, bonus_cap_bps > 0 -> BadBeefParams
```

**Step 3: Run focused tests and confirm RED**

```bash
pnpm exec ts-mocha -p ./tsconfig.json -t 1000000 tests/direct-beef.ts tests/beef-cap.ts
```

Expected: current program accepts nonzero bonus parameters and at least the rejection assertions fail.

**Step 4: Commit the red tests**

```bash
git add tests/direct-beef.ts tests/beef-cap.ts programs/ansem-miner/src/math.rs
git commit -m "test(beef): specify fully collateralized base emissions"
```

---

### Task 5: Enforce base-only BEEF in program and SDK defaults

**Files:**

- Modify: `programs/ansem-miner/src/constants.rs`
- Modify: `programs/ansem-miner/src/instructions/beef.rs`
- Modify: `packages/sdk/src/constants.ts`
- Modify: generated IDL only if the build changes it: `target/idl/ansem_miner.json`
- Sync: `packages/sdk/src/idl/ansem_miner.json`
- Sync: `packages/sdk/src/idl/ansem_miner.ts`
- Test: `tests/direct-beef.ts`
- Test: `tests/beef-cap.ts`

**Step 1: Set safe defaults**

Set both Rust and TypeScript defaults to zero:

```rust
pub const DEFAULT_BEEF_TICK_BPS: u16 = 0;
pub const DEFAULT_BEEF_BONUS_CAP_BPS: u16 = 0;
```

```ts
export const DEFAULT_BEEF_TICK_BPS = 0;
export const DEFAULT_BEEF_BONUS_CAP_BPS = 0;
```

**Step 2: Reject unfunded bonus configuration**

Extend the shared parameter validation used by `init_beef` and `set_beef_params`:

```rust
require!(tick_bps == 0, AnsemError::BadBeefParams);
require!(bonus_cap_bps == 0, AnsemError::BadBeefParams);
```

Keep the existing denominator validation and account fields.

**Step 3: Run focused tests and confirm GREEN**

```bash
pnpm exec ts-mocha -p ./tsconfig.json -t 1000000 tests/direct-beef.ts tests/beef-cap.ts
```

Expected: base lifecycle, collateralization, and rejection tests pass.

**Step 4: Sync IDL and build SDK**

```bash
anchor build
pnpm run sdk:sync-idl
pnpm --filter @ansem/sdk build
pnpm --filter @ansem/sdk test
```

Expected: every command exits 0. Review generated diffs and stage them only if they reflect the compiled program.

**Step 5: Commit**

```bash
git add programs/ansem-miner/src/constants.rs programs/ansem-miner/src/instructions/beef.rs packages/sdk/src/constants.ts tests/direct-beef.ts tests/beef-cap.ts target/idl/ansem_miner.json packages/sdk/src/idl/ansem_miner.json packages/sdk/src/idl/ansem_miner.ts
git commit -m "fix(beef): enforce fully funded base-only rewards"
```

Omit unchanged generated files from `git add`.

---

### Task 6: Specify idempotent keeper stamping

**Files:**

- Modify: `keeper/test/beef.test.ts`
- Read: `keeper/src/beef.ts`

**Step 1: Add four unit tests**

Test these behaviors with injected read, send, sleep, and snapshot callbacks:

1. Existing `BeefRound` returns success, sends no transaction, and publishes the emission.
2. Missing account sends once, then delayed reads eventually publish the emission.
3. A send error after the account landed is recovered by a second `stamp(roundId)` call through its pre-read.
4. Send success followed by exhausted reads throws and never publishes a fabricated emission.

Use zero-delay injected sleep in tests.

**Step 2: Run and confirm RED**

```bash
pnpm --filter @ansem/keeper test -- beef.test.ts
```

Expected: current single-read, send-first implementation fails the new retry and idempotency assertions.

**Step 3: Commit the red tests**

```bash
git add keeper/test/beef.test.ts
git commit -m "test(keeper): specify durable idempotent beef stamps"
```

---

### Task 7: Implement durable keeper stamping

**Files:**

- Modify: `keeper/src/beef.ts`
- Test: `keeper/test/beef.test.ts`

**Step 1: Implement read-before-send and bounded observation**

Introduce private or exported testable helpers with defaults suitable for production:

```ts
type StampRetryOptions = {
  attempts: number;
  delayMs: number;
  sleep: (ms: number) => Promise<void>;
};
```

The public stamp flow must:

```text
read existing -> return if found -> send -> retry read -> publish exact account emission
```

Never publish a configured or calculated fallback emission.

**Step 2: Run focused test and typecheck**

```bash
pnpm --filter @ansem/keeper test -- beef.test.ts
pnpm --filter @ansem/keeper typecheck
```

Expected: both exit 0.

**Step 3: Commit**

```bash
git add keeper/src/beef.ts keeper/test/beef.test.ts
git commit -m "fix(keeper): make beef stamping idempotent"
```

---

### Task 8: Gate next-round creation on a funded stamp

**Files:**

- Modify: `keeper/test/service.test.ts`
- Modify: `keeper/src/service.ts`
- Modify: `keeper/src/actions.ts` only if the decision boundary needs a named helper

**Step 1: Write three service tests**

At the `CreateRound` dispatch boundary, assert:

1. `Claimable` current round plus failed BEEF stamp rejects and does not call `createAndDelegate`.
2. `Claimable` current round plus successful BEEF stamp calls `createAndDelegate` exactly once.
3. Empty `Closed` current round advances without attempting a funded stamp.

**Step 2: Run and confirm RED**

```bash
pnpm --filter @ansem/keeper test -- service.test.ts
```

Expected: current dispatch creates the next round without the pre-advance stamp gate.

**Step 3: Implement the gate**

Immediately before `createAndDelegate(ctx, currentRoundId + 1)`, inspect the current round state already present in the service loop. If it is `Claimable` and the BEEF stamper is enabled, await `beefStamper.stamp(currentRoundId)`. Propagate failure.

Do not require a stamp for an empty `Closed` round.

**Step 4: Run keeper verification**

```bash
pnpm --filter @ansem/keeper test
pnpm --filter @ansem/keeper typecheck
```

Expected: all keeper tests pass, with only documented integration skips.

**Step 5: Commit**

```bash
git add keeper/src/service.ts keeper/src/actions.ts keeper/test/service.test.ts
git commit -m "fix(keeper): stamp beef before advancing funded rounds"
```

Omit `keeper/src/actions.ts` if unchanged.

---

### Task 9: Specify and implement seeder roll-before-next-stake

**Files:**

- Create: `scripts/_seed-beef-roll.mjs`
- Create: `scripts/_seed-beef-roll.test.mjs`
- Modify: `scripts/seed-jackpot-roll.mjs`

**Step 1: Write the failing helper tests**

Specify a dependency-injected helper:

```js
export async function rollStampedRound({
  roundId,
  readBeefRound,
  sendRoll,
  sleep,
  attempts,
  delayMs,
})
```

Test that it waits through missing `BeefRound` reads, retries a transient roll send, and returns only after success. Test that exhaustion throws.

**Step 2: Run and confirm RED**

```bash
node --test scripts/_seed-beef-roll.test.mjs
```

Expected: module-not-found or missing-export failure.

**Step 3: Implement the minimal helper**

The helper must never return success before `sendRoll` succeeds. Its exhaustion error must include the round ID and last failure.

**Step 4: Integrate with the seeder**

Import `rollBeefIx` and `beefRoundPda` from `@ansem/sdk`. After the current round becomes claimable, wait for its `BeefRound` and submit `rollBeefIx` for the seeder miner before the loop can stake in another round.

Do not catch and continue past an exhausted roll.

**Step 5: Run tests and syntax check**

```bash
node --test scripts/_seed-beef-roll.test.mjs
node --check scripts/seed-jackpot-roll.mjs
```

Expected: both exit 0.

**Step 6: Commit**

```bash
git add scripts/_seed-beef-roll.mjs scripts/_seed-beef-roll.test.mjs scripts/seed-jackpot-roll.mjs
git commit -m "fix(ops): roll seeded beef before the next stake"
```

---

### Task 10: Add the production recovery runbook

**Files:**

- Create: `docs/superpowers/runbooks/2026-07-14-live-game-recovery.md`

**Step 1: Document exact preflight and evidence fields**

Include commands and blank evidence labels, not unresolved implementation placeholders, for:

- source commit and clean release worktree
- program ID and program-data address
- upgrade authority match
- live bonus config readback
- deterministic SBF build hash
- program upgrade signature and deployed hash
- Railway deployment ID and `KEEPER_ROUND_SECS=60`
- keeper health and snapshot URLs
- controlled stake, swap, stamp, roll, and claim signatures
- post-proof BEEF supply, vault, treasury, and `total_owed`

**Step 2: Add rollback commands**

Document keeper image rollback, previous program binary redeploy, and the explicit rule that bonus stays zero and the BEEF vault is never swept.

**Step 3: Review for executable commands**

Run:

```bash
rg -n "TODO|TBD|fill this|implement later" docs/superpowers/runbooks/2026-07-14-live-game-recovery.md
```

Expected: no matches.

**Step 4: Commit**

```bash
git add docs/superpowers/runbooks/2026-07-14-live-game-recovery.md
git commit -m "docs(ops): add live game recovery runbook"
```

---

### Task 11: Run complete local verification and independent review

**Files:**

- Review all changes since the plan commit
- Modify only files required to fix review findings

**Step 1: Run repository verification**

```bash
cargo fmt --all -- --check
anchor build
pnpm run sdk:sync-idl
pnpm --filter @ansem/sdk build
pnpm --filter @ansem/sdk test
pnpm --filter @ansem/keeper typecheck
pnpm --filter @ansem/keeper test
pnpm --filter @ansem/app typecheck
pnpm --filter @ansem/app test
node --test scripts/_seed-beef-roll.test.mjs
node --check scripts/seed-jackpot-roll.mjs
```

Expected: all commands exit 0. Record exact test counts and any documented skips.

**Step 2: Build the deployable SBF artifact**

Use the repository's pinned Anchor/Solana toolchain:

```bash
anchor build
shasum -a 256 target/deploy/ansem_miner.so
solana program dump 8Q9EnK7ydn6ywo7ZxeqhubqYybf7FFNNwnz8JzJjXZjz /tmp/ansem-miner-current.so --url mainnet-beta
shasum -a 256 /tmp/ansem-miner-current.so
```

Expected: the new artifact hash is recorded and intentionally differs from the pre-upgrade deployed hash.

**Step 3: Request independent reviews**

Dispatch separate spec-compliance and code-quality reviews. Resolve every blocking or high-severity finding with a failing regression test, then rerun the affected suite.

**Step 4: Commit review fixes**

If fixes were required, inspect `git status --short`, stage each reviewed fix file explicitly by its real path, inspect `git diff --cached`, and commit with message `fix(recovery): address verification findings`. If no fixes were required, do not create an empty commit.

**Step 5: Confirm release worktree state**

```bash
git status --short
git log --oneline --decorate -12
```

Expected: clean worktree and task commits present in order.

---

### Task 12: Upgrade program and keeper

**Files:**

- Operational state: mainnet program
- Operational state: Railway keeper deployment
- Update evidence: `docs/superpowers/runbooks/2026-07-14-live-game-recovery.md`

**Step 1: Confirm authority and balances**

Use `solana program show` to verify the program-data upgrade authority equals the available signer. Verify the signer and keeper payer have enough SOL for upgrade rent, fees, and the maximum 890,880-lamport swap reserve top-up.

Expected: exact public keys match and balances are sufficient. Stop before mutation if they do not.

**Step 2: Upgrade the program**

Deploy `target/deploy/ansem_miner.so` to the existing program ID with the confirmed authority. Record the signature.

**Step 3: Verify deployed bytes**

Dump the program and compare SHA-256 with the local artifact.

Expected: hashes match exactly.

**Step 4: Deploy keeper configuration**

Set the production Railway variable:

```text
KEEPER_ROUND_SECS=60
```

Deploy the reviewed keeper commit. Preserve the current real swap mode, RPC endpoints, program ID, mint, admin, Jupiter configuration, and all secrets.

**Step 5: Verify service health and round timing**

Check the health endpoint, snapshot endpoint, and logs. Verify a newly created round has:

```text
deadline - started_at = 60 seconds
state = Open
```

Record deployment ID and timestamps.

**Step 6: Commit deployment evidence**

Update only the runbook evidence section with public keys, hashes, deployment IDs, and transaction signatures. Do not commit secrets or RPC credentials.

```bash
git add docs/superpowers/runbooks/2026-07-14-live-game-recovery.md
git commit -m "docs(ops): record recovery deployment evidence"
```

---

### Task 13: Prove the complete mainnet flow

**Files:**

- Update evidence: `docs/superpowers/runbooks/2026-07-14-live-game-recovery.md`

**Step 1: Capture pre-proof accounting**

Record current round, pot vault lamports, BEEF mint supply, BEEF vault balance, treasury balance, `minted_total`, and `total_owed`.

**Step 2: Submit one controlled dust stake**

Use the approved test wallet and the smallest configured valid stake. Record the stake signature and round ID.

**Step 3: Observe the round without manual intervention**

Wait for and record:

```text
Open -> settling -> Claimable
ANSEM swap signature
BeefRound account and emission
next Open round
```

Expected: no manual pot-vault top-up is used, the next round opens only after `BeefRound` exists, and the new deadline is 60 seconds.

**Step 4: Roll and claim the fresh entitlement**

Submit `roll_beef` for the test miner and then `claim_beef`. Record both signatures and the exact received base amount.

**Step 5: Reconcile accounting**

Assert:

```text
beef_vault.amount >= total_owed
mint supply delta = player base emission + treasury emission
test wallet claim = its rolled base entitlement
existing 47.481502 reserve was not moved by deployment or migration
```

**Step 6: Commit proof evidence**

```bash
git add docs/superpowers/runbooks/2026-07-14-live-game-recovery.md
git commit -m "docs(ops): record mainnet recovery proof"
```

---

### Task 14: Final audit and handoff

**Files:**

- Read: `docs/superpowers/specs/2026-07-14-live-game-recovery-design.md`
- Read: `docs/superpowers/runbooks/2026-07-14-live-game-recovery.md`

**Step 1: Audit every acceptance criterion**

Map each design acceptance criterion to a test result or mainnet transaction signature. Confirm there are no undocumented skips.

**Step 2: Check live state one final time**

Verify the current round is advancing, betting is enabled while open, the countdown deadline is changing per round, recent funded rounds have BEEF stamps, bonus parameters remain zero, and BEEF remains collateralized.

**Step 3: Confirm no sensitive or unrelated files are committed**

```bash
git status --short
git diff --check HEAD~12..HEAD
git show --stat --oneline HEAD~12..HEAD
```

Expected: clean release worktree, no whitespace errors, no secrets, and no files from the user's dirty checkout.

**Step 4: Report the result**

Lead with the live outcome in simple English. Include the deployed commit, program hash, Railway deployment ID, proof round, transaction signatures, verification counts, and the explicit note that the historical 47.481502 BEEF reserve remains untouched pending a separate ownership decision.
