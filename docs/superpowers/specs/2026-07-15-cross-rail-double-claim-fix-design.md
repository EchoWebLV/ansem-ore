# Cross-Rail Double-Claim Fix Design

**Date:** 2026-07-15

**Status:** Approved

## Problem

The program exposes two ANSEM claim instructions over the same `MinerPosition`:

- `claim` prevents replay by writing `PlayerEscrow.last_claimed_round`, but leaves `MinerPosition.block_stake` intact.
- `claim_direct` prevents replay by zeroing `MinerPosition.block_stake`, but does not read `PlayerEscrow.last_claimed_round`.

A player with a nonzero payout can therefore call `claim` and then `claim_direct` for the same round. Both instructions calculate a payout from the same unchanged stake snapshot, so the payout vault and obligation ledger are charged twice.

## Goal

Make a position consumable exactly once across both claim instructions without changing account layouts, adding rent-bearing accounts, or changing client account lists.

## Non-Goals

- Fixing the cross-rail SOL refund vulnerability.
- Changing payout math, settlement, BEEF emission, or claim-window behavior.
- Removing either claim instruction.
- Migrating existing on-chain accounts.

## Considered Approaches

### 1. Consume the shared stake in both claim handlers

After the legacy `claim` finishes its token transfer and ledger updates, zero `miner.block_stake`, matching `claim_direct`.

This is the selected approach. It is the smallest change, uses the shared position as the common replay guard, requires no migration, and preserves both public instructions.

### 2. Add a per-wallet, per-round claim receipt PDA

Both handlers could create the same receipt account and reject a second creation. This gives an explicit audit trail, but changes both account lists, adds rent, requires SDK and application changes, and increases deployment risk.

### 3. Disable the legacy claim instruction

This immediately removes one attack rail, but can strand legacy escrow users and removes the future automation path.

## Selected Design

`claim_handler` will take a mutable reference to `ctx.accounts.miner` and set:

```rust
miner.block_stake = [0u64; GRID_SIZE];
```

The write happens after payout calculation, token transfer, and ledger updates. Solana transaction atomicity ensures a failed transfer or failed ledger update also rolls back the stake consumption.

The existing `escrow.last_claimed_round` update remains. It continues to provide legacy-rail replay semantics and escrow bookkeeping, while the cleared shared stake prevents either rail from paying again.

No new error is introduced. A cross-rail replay that reaches `claim_direct` after `claim` computes a zero payout, matching the existing idempotent behavior of repeated direct claims. Calling `claim_direct` first already clears the shared stake, so a later legacy `claim` also computes a zero payout before updating the escrow marker.

## BEEF Ordering

`roll_beef` derives a player's BEEF share from `MinerPosition.block_stake`. It must run before any claim instruction that clears the stake.

The direct application flow already submits `roll_beef` before `claim_direct`. This fix makes the dormant legacy claim path obey the same ordering rule. The contract change must not add BEEF accounts to either ANSEM claim instruction because BEEF must remain unable to block ANSEM claims.

## Tests

Add integration coverage for both cross-rail orders:

1. `claim` followed by `claim_direct` pays the player exactly once.
2. `claim_direct` followed by `claim` pays the player exactly once.
3. The first successful claim clears all `miner.block_stake` entries.
4. `round.claimed_proceeds` and `config.ansem_obligations` change only by the first payout.
5. Existing same-rail replay and BEEF bundle-order tests remain green.

The test must be observed failing against the deployed-source baseline before the production change is written, then passing after the minimal handler change.

## Deployment Safety

- Build from the exact deployed-source baseline commit `c8b7a3a`.
- Do not change any account layout or instruction account list.
- Run the focused exploit regression test, the complete Rust program suite, and the relevant Anchor integration suite.
- Build the deployable program and compare the resulting program ID before any deployment decision.
- Deployment itself is outside this implementation task and requires an explicit later action.
