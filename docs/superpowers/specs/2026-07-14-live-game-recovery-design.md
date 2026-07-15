# Live Game Recovery Design

**Date:** 2026-07-14

**Status:** Approved

**Scope:** Recover the mainnet ANSEM mining loop, make base BEEF issuance safe and durable, restore 60-second rounds, and prove the complete flow on mainnet.

## Context

The production game appeared to fail as one large outage: betting was unavailable, the countdown stopped, and BEEF stopped appearing. These symptoms shared one cause in the round state machine.

Round 124 reached the swap step with a funded pot. The real swap instruction tried to transfer the exact pot out of the zero-data `pot_vault`, which would have left 1,000 lamports. Solana requires the account to retain the rent-exempt minimum, currently 890,880 lamports. The transfer failed 279 times, so the round never advanced. Betting is only allowed in an open round, the countdown is derived from the open round deadline, and BEEF is stamped only after the ANSEM swap. The failed swap therefore stopped all three visible features.

A 1,500,000-lamport operational top-up allowed the round to complete. That recovered the live loop but did not remove the defect.

The investigation also found a separate BEEF solvency defect. Base player BEEF is minted into the BEEF vault and added to `total_owed`. Activity bonus BEEF is added to `total_owed` without being minted into the vault. Any positive aggregate bonus makes the vault undercollateralized. The launch seeder also stakes each new round without rolling the previous round's stamped BEEF into its miner account, so player emissions can remain in the vault with no recoverable miner position.

At approval time, the BEEF mint supply and protocol accounting matched at 59.351875 BEEF. The vault held 47.481502 BEEF, the treasury held 11.870373 BEEF, and `total_owed` was 47.481502 BEEF. The vault balance equals its liability only because no activity bonus has yet been accrued. The existing vault balance includes emissions whose original seeder position has been overwritten.

## Goals

1. A funded round can always complete its ANSEM swap when the pot and escrow accounting are solvent, including when the pot vault would otherwise fall below rent exemption.
2. BEEF remains fully collateralized: every token owed to players is already present in the BEEF vault.
3. A funded claimable round cannot be skipped before its BEEF emission is durably observed.
4. The launch seeder rolls every stamped round before staking in the next round.
5. Production returns to 60-second rounds.
6. The complete production flow is proven from bet through swap, BEEF stamp, roll, claim, and next round.

## Non-goals

- Designing a new funded bonus pool or changing the BEEF account layout.
- Reconstructing overwritten historical miner positions.
- Sweeping, burning, or reassigning the existing 47.481502 BEEF vault reserve.
- Changing ANSEM winner selection, payout ratios, or Jupiter routing.
- Redesigning the app UI.

## Chosen Approach

Use defense in depth across the program, keeper, and launch script.

- The program funds only a missing rent reserve from the admin payer immediately before a valid swap.
- The program permits base-only BEEF parameters and rejects nonzero bonus parameters.
- The keeper treats BEEF stamping as an idempotent, pre-advance requirement for funded claimable rounds.
- The launch seeder waits for and rolls each stamped BEEF round before it can place the next stake.
- Railway becomes authoritative for a 60-second duration through `KEEPER_ROUND_SECS=60`.

This is preferred over a keeper-only top-up because the same rent edge could recur from another caller or after an operational configuration change. A fully funded bonus redesign is deferred because it adds economic policy, reserve sizing, and migration decisions that are not required to restore a safe base-mining launch.

## Architecture

### 1. Rent-safe swap

Both real and mock swap handlers call one program helper before transferring the pot.

The helper preserves this ordering:

1. Verify the pot vault covers all escrow liabilities.
2. Verify available lamports cover the exact round pot.
3. Calculate `post_swap_lamports = pot_vault_lamports - pot`.
4. Read `Rent::get()?.minimum_balance(0)`.
5. Calculate `shortfall = rent_minimum.saturating_sub(post_swap_lamports)`.
6. If `shortfall > 0`, transfer exactly that amount from the signer payer to the pot vault using the system program.
7. Transfer the exact pot to the swap destination.

This does not hide insolvency. Missing escrow or pot funds fail before the payer contributes anything. The payer only restores the rent floor after the swap is already known to be economically valid.

The invariant after a successful swap is:

```text
pot_vault.lamports >= Rent::minimum_balance(0)
```

### 2. Fully collateralized base BEEF

For this recovery release, activity bonuses are disabled at both configuration and code levels.

- `DEFAULT_BEEF_TICK_BPS = 0`
- `DEFAULT_BEEF_BONUS_CAP_BPS = 0`
- `init_beef` rejects nonzero `tick_bps` or `bonus_cap_bps`.
- `set_beef_params` rejects nonzero `tick_bps` or `bonus_cap_bps`.
- Existing fields and account layouts remain unchanged.

Base player emissions continue unchanged. On each stamp, the exact player allocation is minted to the BEEF vault and the same amount is added to `total_owed`. Claims reduce both the vault balance and `total_owed` by the transferred amount.

The invariant is:

```text
beef_vault.amount >= beef_config.total_owed
```

For new stamps without external donations, equality is expected.

The live config is changed to zero bonus parameters before the replacement binary is deployed. This closes the immediate configuration risk. The program restriction prevents a later accidental re-enable without a deliberate new program version and funded bonus design.

### 3. Durable, idempotent stamp gate

The keeper's stamp operation becomes idempotent:

1. Read the `BeefRound` account for the target round.
2. If it exists, publish its emission to the keeper snapshot and return success without sending a transaction.
3. If it does not exist, send `stamp_beef`.
4. Re-read with bounded delay until the account is visible.
5. Publish the observed emission and return success.
6. If visibility never arrives, throw so the keeper loop retries the same state.

Before creating the next round, the keeper applies a gate:

- If the current round is `Claimable` and BEEF stamping is enabled, the current round must pass the idempotent stamp operation.
- If stamping fails, the next round is not created. The loop retries.
- An empty `Closed` round may advance without a stamp because it has no funded emission.

This changes the previous best-effort policy for a narrow interval after the ANSEM swap. Base BEEF can briefly delay the next round, but a transient RPC failure can no longer permanently skip a funded emission. The swap has already succeeded, so no player ANSEM funds are at risk during this retry.

### 4. Seeder rolls before the next stake

The launch seeder's per-round sequence becomes:

```text
stake -> wait for claimable -> wait for BeefRound -> roll_beef -> next round
```

The roll helper uses bounded retries for account propagation and transient transaction failure. It throws after exhaustion. The outer seeder must stop instead of staking into another round, because a new-round stake resets the miner position and would make the earlier share unreachable.

The helper accepts its read, send, and sleep dependencies so the propagation and retry behavior can be tested without mainnet access.

### 5. Sixty-second rounds

`KEEPER_ROUND_SECS=60` is set in the production keeper environment. `createAndDelegate` already writes the configured duration as rounds are created, so the next created round updates the on-chain config and all following deadlines use 60 seconds.

No app constant is introduced. The app continues to render the on-chain round deadline and keeper snapshot.

## Existing BEEF Reserve

The 47.481502 BEEF already in the vault remains untouched. It is treated as a conservative protocol reserve while the correct historical ownership cannot be reconstructed from current accounts. This release does not claim that those tokens are protocol revenue and does not make them available to new players.

New roll and claim tests must use fresh round IDs and verify only newly stamped entitlement. No migration may reduce `total_owed`, move vault tokens, or change treasury balances.

## Error Handling

- A genuinely insolvent pot continues to fail with the existing solvency error. The payer is not charged.
- A payer unable to cover the rent shortfall causes the swap transaction to fail atomically. The keeper retries after the payer is funded.
- Nonzero BEEF bonus configuration fails with `BadBeefParams`.
- Stamp submission failure does not advance the round. A transaction that landed but returned an RPC error is recovered by the next pre-read.
- Stamp account propagation beyond the bounded read window produces a retriable keeper error.
- Seeder roll exhaustion stops the seeder with a visible error before it can overwrite the miner position.

## Security and Trust Boundaries

- Only the existing admin signer funds rent and configures BEEF.
- The rent helper cannot transfer more than the calculated rent shortfall.
- Player principal and escrow liabilities are checked before admin funds enter the pot vault.
- The keeper cannot invent a BEEF emission; it only submits the on-chain instruction and reads the resulting program account.
- Zero bonus parameters remove an unfunded liability path while preserving the current mint authority and vault authority model.

## Testing Strategy

### Program integration

- A real swap with only 1,000 residual lamports succeeds after an exact payer-funded rent top-up.
- The post-swap pot vault is rent exempt.
- An insolvent pot still fails and does not debit the payer.
- BEEF initialization and updates accept zero bonus values.
- BEEF initialization and updates reject any nonzero tick or cap.
- A stamped base emission keeps vault balance and `total_owed` equal.
- Roll and claim transfer only base entitlement and return the liability to zero for fresh test rounds.

### Keeper unit tests

- An existing stamp skips transaction submission and refreshes the snapshot emission.
- Delayed account visibility after submission is retried.
- A transaction error after landing is recovered by the next invocation.
- Exhausted stamp observation prevents next-round creation.
- A successful stamp permits next-round creation.
- An empty closed round still advances.

### Seeder unit tests

- The helper waits for `BeefRound`, retries transient roll failure, and succeeds.
- Exhaustion throws and no following stake callback runs.

### Full verification

- Rust formatting and program tests.
- SDK build, typecheck, and tests.
- Keeper typecheck and full tests.
- App typecheck and full tests.
- Reproducible SBF build and program binary inspection.

## Deployment Sequence

1. Set live BEEF `tick_bps` and `bonus_cap_bps` to zero; read the account back.
2. Build and verify the recovery binary from the isolated release branch.
3. Confirm the program-data upgrade authority matches the available upgrade signer.
4. Upgrade the mainnet program and verify the deployed program hash.
5. Deploy the keeper with the durable stamp gate and `KEEPER_ROUND_SECS=60`.
6. Verify the next round is open with a deadline approximately 60 seconds after start.
7. Run one controlled dust stake and observe swap, stamp, roll, claim, and next-round creation.
8. Confirm `beef_vault.amount >= total_owed` and record all transaction signatures.

## Rollback

- If the keeper release fails, roll back the keeper image while keeping bonus parameters at zero. Manually supervise funded claimable rounds so none advance without a stamp.
- If the program upgrade fails verification, redeploy the previously verified binary. The live bonus config remains zero and the operational rent top-up remains available as a temporary swap recovery.
- Do not restore nonzero bonus parameters as part of rollback.
- Do not sweep the BEEF vault during rollback.

## Acceptance Criteria

- No valid funded swap can wedge solely because the pot vault would fall below rent exemption.
- Live BEEF bonus parameters are zero and nonzero parameters are rejected by the deployed program.
- Every new funded claimable round has a visible `BeefRound` before the next round opens.
- The seeder has a visible miner entitlement before it stakes in another round.
- Production rounds run at 60 seconds.
- The controlled mainnet proof completes without manual lamport top-up.
