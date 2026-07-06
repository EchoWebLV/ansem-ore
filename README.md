# ANSEM Miner

An on-chain grid-game economy built as a single Anchor program (`ansem_miner`) on Solana. Players deposit SOL, stake it across a 5x5 (25-square) grid for a round, the round is settled with randomness that assigns each square a payout multiplier, the pot is swapped into ANSEM tokens, and players claim VRF-weighted payouts proportional to their stake and the square's multiplier.

This repository currently implements **M1: Program Core** — the full on-chain economy running entirely on L1 (Solana mainnet-equivalent execution), with no ephemeral rollup, no real VRF, and no real DEX swap. Those pieces are seamed off behind explicit modes/instructions so later milestones can replace them without changing the payout math or account model.

## What M1 is

M1 delivers, end to end:

- **`initialize`** — creates the singleton `Config`, a mock ANSEM SPL mint, and the PDA vaults (pot vault, treasury, mint authority, vault authority, jackpot authority).
- **`deposit` / `withdraw`** — a per-player `PlayerEscrow` PDA holding SOL; withdrawals are blocked while a round is unclaimed.
- **`create_round`** — opens a new `Round` PDA (grid state, deadline, pot) and advances `Config.current_round_id`.
- **`init_miner`** — creates a player's persistent `MinerPosition` PDA (their per-square stake for whichever round they're currently in).
- **`stake`** — stakes SOL from escrow onto a grid square for the open round (deadline, min-stake, per-round cap, and "must claim previous round first" guards enforced).
- **`settle(randomness)`** — admin-only in M1. Injects 32 bytes of randomness after the round's deadline passes; derives each square's payout multiplier (`multiplier_bps`, uniform in `[mult_min_bps, mult_max_bps]`, default ±20% i.e. `[8000, 12000]` bps) and whether/where a jackpot hit, via keccak-based pure functions in `math.rs`.
- **`execute_swap_mock`** — replaces a real Jupiter swap. Moves the round's pot lamports to the treasury PDA, deducts the protocol fee, and mints ANSEM to the payout vault at a fixed mock rate (`Config.mock_rate`). Gated behind `Config.swap_mode == SWAP_MODE_MOCK`.
- **`claim`** — pays a player their weighted share of the round's swap proceeds (`math::payout`, which floors so payouts never exceed proceeds), plus an additive jackpot share if the round hit and the player staked the jackpot square. Reconciles `PlayerEscrow.active_round` / `last_claimed_round` so the player can stake the next round.

The economic core — `math.rs` — is a **pure module** (no Anchor types) that computes per-square multipliers, weights, payouts, and jackpot rolls. It is unit-tested in isolation (`cargo test` inside `programs/ansem-miner`) and is the single source of truth for solvency: payouts are computed as a floored proportional share of `swap_proceeds`, so the sum of all claims can never exceed what was actually swapped in, by construction.

Integration tests (`tests/ansem-miner.ts`) additionally prove:
- A **solvency invariant** across multiple players staking different squares in the same round (sum of claims is within floor-rounding dust of swap proceeds).
- A **forced-jackpot** path (odds set to 1 via an admin-only test knob) exercising the additive jackpot payout.
- **Negative/guard tests**: out-of-range block index, staking beyond escrow balance, settling before the deadline, double-claim, and the `pot_vault` solvency guard across interleaved rounds and an idle (never-staked) depositor.
- A single **end-to-end happy path** for a fresh player chaining every instruction in lifecycle order: `initialize -> createRound -> deposit -> initMiner -> stake -> settle -> executeSwapMock -> claim`, asserting the final ANSEM ATA balance equals the round's swap proceeds and that `escrow.balance == deposit - staked`.

## How to run

Prerequisites: Anchor 0.31.1, Solana/Agave toolchain, Rust, Node/Yarn.

```bash
# Rust unit tests for the pure payout math
cd programs/ansem-miner && cargo test

# Full on-chain integration suite (builds the program, boots a local
# validator, runs tests/ansem-miner.ts)
cd /path/to/repo
pkill -f solana-test-validator 2>/dev/null; sleep 1; rm -rf test-ledger
anchor test
```

`anchor test` builds the program, starts `solana-test-validator`, deploys, and runs the full Mocha/Chai suite in `tests/ansem-miner.ts` against it.

## M1-only caveats

These are intentional seams for this milestone, not bugs:

- **Admin-only `settle`**: randomness is passed in as a plain instruction argument by the admin keypair, after the round's deadline has passed. There is no verifiable randomness function (VRF) yet — the admin is trusted in M1. M2 replaces this with MagicBlock ephemeral VRF (`request_settle` / `settle_callback`).
- **Mock swap**: `execute_swap_mock` does not touch a real DEX. It moves the round's pot lamports to a treasury PDA and mints ANSEM at a fixed rate (`Config.mock_rate`) directly to the payout vault. This is gated behind `Config.swap_mode`; a real Jupiter-integrated `begin_swap` / `record_swap` keeper is a mainnet-milestone concern, not M1.
- **Claim-before-next-round**: `MinerPosition` is a single persistent account per player, reset in place for each new round. A player who staked round N and has not yet called `claim` for round N cannot `stake` into round N+1 — enforced via `PlayerEscrow.active_round` (see `AnsemError::UnclaimedRound`). This is a deliberate v1 simplification, not a defect.
- **No ephemeral rollup / session keys**: everything in M1 executes and settles on L1 directly; there is no MagicBlock delegation (`#[delegate]`/`#[commit]`/`#[ephemeral]`) and no session-key flow yet.

## M2a: ER foundation (implemented)

M2a moves the staking hot path into a **MagicBlock Ephemeral Rollup (ER)** while keeping all value on L1, and relocates the escrow debit to a reconcile-at-commit model. It builds on M1 without changing the payout math.

Lifecycle (one round):

```
L1:  create_round → delegate_round                      (admin, per round)
L1:  init_miner → delegate_miner                        (per player; re-delegated each round)
L1:  join_round(round_id)                               (per player: sets active_round lock, NO debit)
ER:  stake(block, amount)                               (per player, N×; soft budget check, no escrow write)
ER:  commit_round()   [commit_and_undelegate]           (Round back to L1, writable)
ER:  commit_miner()   [commit_and_undelegate]           (MinerPosition snapshot back to L1, our-owned)
L1:  reconcile_miner(round_id)                          (permissionless: debit escrow from committed block_stake; releases lock)
L1:  settle(randomness) [M1 admin path, unchanged]
L1:  execute_swap_mock()                                (M1; solvency gate refuses until every staker is reconciled)
L1:  claim(round_id)   [M1, unchanged]
```

Key design points:
- **Escrow relocation (reconcile-at-commit + up-front lock).** `join_round` sets `PlayerEscrow.active_round` (the withdraw-lock) with **no debit**. ER `stake` only writes the delegated Round/MinerPosition (escrow is a read-only clone, soft-checked). The **debit happens on L1 in `reconcile_miner`**, from the committed `block_stake` snapshot, guarded by `PlayerEscrow.reconciled_round` (no double-debit). `reconcile_miner` is the single lock-release point — it frees stakers **and** join-without-stake players.
- **Solvency is auto-gated.** Between ER staking and reconcile, `total_escrow_balance` still counts the staked lamports as idle while `Round.pot` also claims them, so `execute_swap_mock`'s `pot_vault ≥ total_escrow_balance + pot` check **refuses the swap until every staker is reconciled**. An un-reconciled staker makes the check stricter, never unsafe.
- **Miner is commit-and-undelegated** (not commit-only) at round end, so it returns to our program on L1 for `reconcile_miner`/`claim` to read as a normal `Account`, and is re-delegated next round.
- **Abandoned delegated round recovery:** admin force-commits it on the ER (undelegate → L1) → L1 `cancel_round` → the joiner `refund`s to release their lock (`refund` only unlocks now — under reconcile-at-commit a cancelled round was never debited, so there is nothing to credit back).

Run the two-provider local stack (base `mb-test-validator` + `ephemeral-validator`):

```bash
bash scripts/test-er.sh          # tests/ansem-miner-er.ts, 8/8
```

VRF and session keys are **not** in M2a — real ephemeral VRF is **M2b**, session keys are **M2c**.

## Deferred milestones

Not built in this repository yet — tracked for later work:

- **M2b**: real MagicBlock ephemeral VRF for `settle` (`request_settle` / `settle_callback` replacing the injected-randomness admin path).
- **M2c**: session keys (gasless, popup-free ER staking without per-tx wallet approval).
- **M3**: Devnet deployment and Metaplex token metadata for the ANSEM mint.
- **M4**: The Next.js frontend.

## Program layout

```
programs/ansem-miner/src/
├── lib.rs                # declare_id!, program mod, instruction entrypoints
├── constants.rs          # seeds, grid size, decimals, param defaults
├── error.rs               # AnsemError
├── math.rs                # pure payout math (multipliers, weights, payout, jackpot)
├── state/                 # Config, Round, MinerPosition, PlayerEscrow
└── instructions/          # initialize, escrow (deposit/withdraw), round, miner,
                            # stake, settle, swap, claim
tests/ansem-miner.ts        # TS/Mocha integration suite
```

See `docs/superpowers/specs/2026-07-06-ansem-miner-design.md` for the full design spec and `docs/superpowers/plans/2026-07-06-ansem-miner-m1-program-core.md` for the task-by-task implementation plan.
