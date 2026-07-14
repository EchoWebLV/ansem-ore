# Task 3 ER harness ordering fix report

## Status

DONE. The stale ER harness order is fixed without production-code changes. The full ER suite is GREEN with 8 passing tests, including task 8's `Insolvent` and payer non-debit assertions. Default generated artifacts were restored byte-for-byte to their pre-test baseline.

## Root cause

`join_round` accepts `miner` as `Account<MinerPosition>`. Anchor therefore requires the miner PDA to be owned by the ANSEM program while the L1 instruction deserializes and stamps it for the current round.

The harness instead ran these steps in this order:

1. `delegate_round`
2. `delegate_miner`, which changed the miner PDA owner to the DLP
3. `join_round` on L1

That order contradicted the production entry lifecycle documented in `round_entry.rs`, where `init_miner` precedes `join_round` and `delegate_miner` follows it. The subsequent L1 `join_round` account validation correctly rejected the DLP-owned miner.

## RED evidence

The devnet interface and binary were built successfully with:

```bash
anchor build -- --features devnet
```

The unmodified harness was then rerun on a fresh two-validator stack:

```bash
SKIP_BUILD=1 TEST_FILE=tests/ansem-miner-er.ts bash scripts/test-er.sh
```

It reproduced the stale ordering and reached:

```text
3 passing
1) task 4: join_round locks the escrow against withdrawal (no debit)
```

The exact failure already captured in `.superpowers/sdd/task-3-report.md` was:

```text
Error Code: AccountOwnedByWrongProgram
Program log: Left: DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh
Program log: Right: 8Q9EnK7ydn6ywo7ZxeqhubqYybf7FFNNwnz8JjXZjz
```

The fresh RED run was stopped after this expected failure so later sequential tests would not wait on state that task 4 failed to establish. The test script stopped both validators.

## Minimal harness change

Only the existing test blocks were reordered in `tests/ansem-miner-er.ts`:

1. `delegate_round`
2. `join_round`
3. `delegate_miner`
4. `stake`

The bodies, account inputs, and assertions of both the join and delegation tests are unchanged. This matches the production lifecycle while preserving the explicit assertion that delegation changes the miner owner to the DLP before the ER stake.

No Rust or other production file changed.

## GREEN evidence

With the same devnet build, the exact full suite command was rerun on a fresh stack:

```bash
SKIP_BUILD=1 TEST_FILE=tests/ansem-miner-er.ts bash scripts/test-er.sh
```

Result:

```text
task 4: join_round locks the escrow against withdrawal (no debit) passed
task 3: delegate_miner hands the persistent miner to the DLP (owner -> DLP) passed
task 5: stake runs on the ER (delegated round/miner updated; L1 escrow untouched) passed
task 6: settle(ER) -> commit_miner(keeper) -> commit_round passed
task 8: e2e tail - [swap Insolvent] -> reconcile -> swap -> claim passed
task 9: abandoned delegated round recovery passed

8 passing (2m)
```

The command exited 0 and its cleanup stopped both validators.

Task 8 passing specifically confirms that:

- the pre-reconcile `execute_swap_mock` returned `Insolvent`;
- the admin payer balance after that preflight rejection exactly equaled its balance before the call;
- reconcile, the solvent swap, and claim then completed.

## Artifact restoration and scope checks

After the ER run, the default build was restored with:

```bash
anchor build
```

The build completed its release and test profiles successfully. The restored files were compared against copies saved before the devnet build:

```text
target/idl/ansem_miner.json: byte-for-byte match
target/types/ansem_miner.ts: byte-for-byte match
target/deploy/ansem_miner.so: byte-for-byte match
```

The restored type contains `initializeReal` and `executeSwapReal` and does not contain the devnet-only `executeSwapMock`. `git status --porcelain=v1` was empty before adding this report, so no SDK sync, production, or generated-file side effects remained.

`git diff --check` passed before the implementation commit.

## Implementation commit

```text
4562ae8 test(er): join before delegating miner
```

Commit contents:

```text
tests/ansem-miner-er.ts | 26 lines moved, no body or assertion changes
```

## Concerns

No blocking concerns. The builds continue to emit the repository's existing Anchor macro `unexpected cfg` warnings, and Node emits the existing module-type warning while loading the TypeScript suite. Neither warning affected the build or the 8-test GREEN result.
