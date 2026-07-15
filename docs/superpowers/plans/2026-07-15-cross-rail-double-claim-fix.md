# Cross-Rail Double-Claim Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure a `MinerPosition` can produce at most one ANSEM payout across the legacy `claim` and direct `claim_direct` instructions.

**Architecture:** Keep both public instructions and use the already-shared `MinerPosition.block_stake` as their common consumption state. Add one isolated Anchor integration test that funds the payout vault with rollover, executes both claim instructions in one transaction in both orders, and proves only one payout and one ledger decrement occur.

**Tech Stack:** Rust, Anchor 1.0.2, Solana local validator, TypeScript, Mocha, Chai.

## Global Constraints

- Build from exact deployed-source baseline commit `c8b7a3a`.
- Do not change any account layout or instruction account list.
- Preserve both `claim` and `claim_direct` entrypoints.
- Preserve idempotent direct-claim behavior: a replay may succeed but must pay zero.
- `roll_beef` must run before either claim instruction clears `MinerPosition.block_stake`.
- Do not add BEEF accounts to an ANSEM claim instruction.
- Do not change refund behavior in this task.
- Do not deploy the program in this task.

---

### Task 1: Consume legacy claims through the shared stake replay guard

**Files:**
- Create: `tests/cross-rail-double-claim.ts`
- Modify: `programs/ansem-miner/src/instructions/claim.rs:67-121`

**Interfaces:**
- Consumes: existing `claim(round_id)` and `claim_direct(round_id)` instructions over one `MinerPosition`.
- Produces: identical public instruction interfaces, with both paths consuming `MinerPosition.block_stake` after the first payout.

- [ ] **Step 1: Add the isolated exploit regression test**

Create `tests/cross-rail-double-claim.ts` with this complete test fixture. The seed round deliberately creates more rollover inventory than one attack-round payout, so the vulnerable baseline can physically pay twice instead of merely failing for insufficient vault funds.

```typescript
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { getAccount, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey, Transaction } from "@solana/web3.js";
import { assert } from "chai";
import { keccak256 } from "js-sha3";
import { AnsemMiner } from "../target/types/ansem_miner";

const enc = (value: string) => Buffer.from(value);
const randomness = Buffer.alloc(32, 7); // u64(bytes 16..24) % 25 == 11, so no rollover bite.
const STAKE_WINDOW_SECS = 5;

describe("cross-rail double claim", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.AnsemMiner as Program<AnsemMiner>;
  const admin = provider.wallet as anchor.Wallet;

  const [config] = PublicKey.findProgramAddressSync([enc("config")], program.programId);
  const [ansemMint] = PublicKey.findProgramAddressSync([enc("ansem_mint")], program.programId);
  const [potVault] = PublicKey.findProgramAddressSync([enc("pot_vault")], program.programId);
  const [vaultAuthority] = PublicKey.findProgramAddressSync([enc("vault_auth")], program.programId);
  const [mintAuthority] = PublicKey.findProgramAddressSync([enc("mint_auth")], program.programId);
  const [treasury] = PublicKey.findProgramAddressSync([enc("treasury")], program.programId);
  const payoutVault = getAssociatedTokenAddressSync(ansemMint, vaultAuthority, true);

  const minerOf = (wallet: PublicKey) =>
    PublicKey.findProgramAddressSync([enc("miner"), wallet.toBuffer()], program.programId)[0];
  const escrowOf = (wallet: PublicKey) =>
    PublicKey.findProgramAddressSync([enc("escrow"), wallet.toBuffer()], program.programId)[0];
  const roundOf = (roundId: number) =>
    PublicKey.findProgramAddressSync(
      [enc("round"), new anchor.BN(roundId).toArrayLike(Buffer, "le", 8)],
      program.programId,
    )[0];
  const jackpotSquare = () =>
    keccak256.array([...randomness, ...Buffer.from("jackpot")])[0] % 25;

  const swapAccounts = (round: PublicKey) => ({
    payer: admin.publicKey,
    round,
    ansemMint,
    mintAuthority,
    vaultAuthority,
    payoutVault,
    potVault,
    treasury,
    tokenProgram: TOKEN_PROGRAM_ID,
  });
  const claimAccounts = (wallet: PublicKey, round: PublicKey, playerAta: PublicKey) => ({
    authority: wallet,
    config,
    round,
    miner: minerOf(wallet),
    escrow: escrowOf(wallet),
    ansemMint,
    vaultAuthority,
    payoutVault,
    playerAta,
    tokenProgram: TOKEN_PROGRAM_ID,
  });
  const claimDirectAccounts = (wallet: PublicKey, round: PublicKey, playerAta: PublicKey) => ({
    authority: wallet,
    config,
    round,
    miner: minerOf(wallet),
    ansemMint,
    vaultAuthority,
    payoutVault,
    playerAta,
    tokenProgram: TOKEN_PROGRAM_ID,
  });

  async function fundedPlayer(sol = 2): Promise<anchor.web3.Keypair> {
    const player = anchor.web3.Keypair.generate();
    const signature = await provider.connection.requestAirdrop(
      player.publicKey,
      sol * anchor.web3.LAMPORTS_PER_SOL,
    );
    await provider.connection.confirmTransaction(signature);
    return player;
  }

  async function settleAfterDeadline(round: PublicKey) {
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        await program.methods
          .settle([...randomness])
          .accounts({ admin: admin.publicKey, round })
          .rpc();
        return;
      } catch (error: any) {
        if (!error.toString().includes("RoundNotEnded")) throw error;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    throw new Error("round never became settleable");
  }

  async function freshRound(): Promise<{ id: number; pda: PublicKey }> {
    const current = await program.account.config.fetch(config);
    const id = current.currentRoundId.toNumber() + 1;
    const pda = roundOf(id);
    await program.methods.createRound().accounts({ payer: admin.publicKey, round: pda }).rpc();
    return { id, pda };
  }

  async function stakeSettleAndSwap(
    player: anchor.web3.Keypair,
    square: number,
    lamports: number,
  ): Promise<{ id: number; pda: PublicKey }> {
    const round = await freshRound();
    await program.methods
      .stakeDirect(new anchor.BN(round.id), square, new anchor.BN(lamports))
      .accounts({
        authority: player.publicKey,
        config,
        round: round.pda,
        miner: minerOf(player.publicKey),
        potVault,
      })
      .signers([player])
      .rpc();
    await settleAfterDeadline(round.pda);
    await program.methods.executeSwapMock().accounts(swapAccounts(round.pda)).rpc();
    return round;
  }

  before(async () => {
    await program.methods
      .initialize()
      .accounts({ admin: admin.publicKey, tokenProgram: TOKEN_PROGRAM_ID })
      .rpc();
    await program.methods.initJackpotConfig().accounts({ admin: admin.publicKey }).rpc();
    await program.methods
      .setRoundDuration(new anchor.BN(STAKE_WINDOW_SECS))
      .accounts({ admin: admin.publicKey })
      .rpc();
    await program.methods.setReturnBand(0, 0).accounts({ admin: admin.publicKey }).rpc();

    const seedPlayer = await fundedPlayer();
    const losingSquare = (jackpotSquare() + 1) % 25;
    await stakeSettleAndSwap(seedPlayer, losingSquare, 200_000_000);

    const seeded = await program.account.config.fetch(config);
    assert.isAbove(seeded.rolloverJackpot.toNumber(), 0, "seed round must fund rollover inventory");
  });

  async function assertSinglePayout(order: "legacy-first" | "direct-first") {
    const player = await fundedPlayer();
    const round = await stakeSettleAndSwap(player, jackpotSquare(), 100_000_000);

    // A direct staker can create the legacy escrow account with a zero deposit.
    await program.methods.deposit(new anchor.BN(0)).accounts({ authority: player.publicKey }).signers([player]).rpc();

    const playerAta = getAssociatedTokenAddressSync(ansemMint, player.publicKey);
    const legacy = await program.methods
      .claim(new anchor.BN(round.id))
      .accounts(claimAccounts(player.publicKey, round.pda, playerAta))
      .instruction();
    const direct = await program.methods
      .claimDirect(new anchor.BN(round.id))
      .accounts(claimDirectAccounts(player.publicKey, round.pda, playerAta))
      .instruction();

    const configBefore = await program.account.config.fetch(config);
    const roundBefore = await program.account.round.fetch(round.pda);
    const expected = BigInt(roundBefore.swapProceeds.toString());

    const transaction = new Transaction();
    transaction.add(...(order === "legacy-first" ? [legacy, direct] : [direct, legacy]));
    await provider.sendAndConfirm(transaction, [player]);

    const paid = (await getAccount(provider.connection, playerAta)).amount;
    const configAfter = await program.account.config.fetch(config);
    const roundAfter = await program.account.round.fetch(round.pda);
    const minerAfter = await program.account.minerPosition.fetch(minerOf(player.publicKey));

    assert.equal(paid.toString(), expected.toString(), `${order} must pay exactly once`);
    assert.equal(
      roundAfter.claimedProceeds.sub(roundBefore.claimedProceeds).toString(),
      expected.toString(),
      `${order} must record one payout`,
    );
    assert.equal(
      configBefore.ansemObligations.sub(configAfter.ansemObligations).toString(),
      expected.toString(),
      `${order} must decrement obligations once`,
    );
    assert.equal(
      minerAfter.blockStake.reduce((sum: number, value: anchor.BN) => sum + value.toNumber(), 0),
      0,
      `${order} must consume the shared stake`,
    );
  }

  it("claim then claim_direct in one transaction pays once", async () => {
    await assertSinglePayout("legacy-first");
  });

  it("claim_direct then claim in one transaction pays once", async () => {
    await assertSinglePayout("direct-first");
  });
});
```

- [ ] **Step 2: Run the focused test against the vulnerable baseline and verify RED**

The repository-pinned Anchor 1.0.2 CLI does not use `anchor test --run <file>` to select a TypeScript file. Build once, then run only this file against a fresh legacy validator:

```bash
anchor build -- --features devnet

LEDGER=$(mktemp -d /tmp/ansem-claim-red.XXXXXX)
solana-test-validator --reset --ledger "$LEDGER" --mint "$(solana address)" \
  --bpf-program 8Q9EnK7ydn6ywo7ZxeqhubqYybf7FFNNwnz8JzJjXZjz target/deploy/ansem_miner.so \
  >"$LEDGER/validator.log" 2>&1 &
VALIDATOR_PID=$!
trap 'kill "$VALIDATOR_PID" 2>/dev/null || true; rm -rf "$LEDGER"' EXIT
until solana cluster-version --url http://127.0.0.1:8899 >/dev/null 2>&1; do sleep 1; done
ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 \
ANCHOR_WALLET="$HOME/.config/solana/id.json" \
  pnpm exec ts-mocha -p ./tsconfig.json -t 1000000 tests/cross-rail-double-claim.ts
```

Expected: FAIL in the `legacy-first` case because the wallet receives two payouts and the ledger is decremented twice. The `direct-first` case may pass because `claim_direct` already clears the stake. Do not write production code until the legacy-first failure has been observed and recorded.

- [ ] **Step 3: Apply the minimal shared-consumption fix**

In `claim_handler`, change the miner binding from immutable to mutable:

```rust
let miner = &mut ctx.accounts.miner;
```

After updating `round.claimed_proceeds` and `config.ansem_obligations`, but before writing the escrow bookkeeping, add:

```rust
// Cross-rail idempotency: both claim handlers consume the same shared stake
// snapshot. roll_beef must run before either claim because its share is derived
// from block_stake.
miner.block_stake = [0u64; GRID_SIZE];
```

Do not change the `Claim` account struct, payout formula, escrow fields, or `claim_direct`.

- [ ] **Step 4: Run the focused test and verify GREEN**

Rebuild the devnet binary and run the focused file against a new validator:

```bash
anchor build -- --features devnet

LEDGER=$(mktemp -d /tmp/ansem-claim-green.XXXXXX)
solana-test-validator --reset --ledger "$LEDGER" --mint "$(solana address)" \
  --bpf-program 8Q9EnK7ydn6ywo7ZxeqhubqYybf7FFNNwnz8JzJjXZjz target/deploy/ansem_miner.so \
  >"$LEDGER/validator.log" 2>&1 &
VALIDATOR_PID=$!
trap 'kill "$VALIDATOR_PID" 2>/dev/null || true; rm -rf "$LEDGER"' EXIT
until solana cluster-version --url http://127.0.0.1:8899 >/dev/null 2>&1; do sleep 1; done
ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 \
ANCHOR_WALLET="$HOME/.config/solana/id.json" \
  pnpm exec ts-mocha -p ./tsconfig.json -t 1000000 tests/cross-rail-double-claim.ts
```

Expected: PASS, 2 passing and 0 failing. Both instruction orders transfer and account for exactly one payout.

- [ ] **Step 5: Run relevant regression suites**

Run each TypeScript file against its own fresh validator, then run the Rust suite:

```bash
run_anchor_file() {
  TEST_FILE="$1"
  LEDGER=$(mktemp -d /tmp/ansem-claim-regression.XXXXXX)
  solana-test-validator --reset --ledger "$LEDGER" --mint "$(solana address)" \
    --bpf-program 8Q9EnK7ydn6ywo7ZxeqhubqYybf7FFNNwnz8JzJjXZjz target/deploy/ansem_miner.so \
    >"$LEDGER/validator.log" 2>&1 &
  VALIDATOR_PID=$!
  until solana cluster-version --url http://127.0.0.1:8899 >/dev/null 2>&1; do sleep 1; done
  ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 \
  ANCHOR_WALLET="$HOME/.config/solana/id.json" \
    pnpm exec ts-mocha -p ./tsconfig.json -t 1000000 "$TEST_FILE"
  STATUS=$?
  kill "$VALIDATOR_PID" 2>/dev/null || true
  wait "$VALIDATOR_PID" 2>/dev/null || true
  rm -rf "$LEDGER"
  return "$STATUS"
}

run_anchor_file tests/direct-stake.ts
run_anchor_file tests/direct-beef.ts

cargo test -p ansem-miner --all-targets
```

Expected:

- `tests/direct-stake.ts`: all tests pass, including same-rail direct idempotency.
- `tests/direct-beef.ts`: all tests pass, including `[roll_beef, claim_direct]` ordering.
- Rust: 23 unit tests and 9 invariant tests pass.

- [ ] **Step 6: Verify the mainnet build shape**

Run:

```bash
anchor build
git diff --check
git status --short
```

Expected: mainnet-feature build succeeds, no whitespace errors, and only the new regression test plus `claim.rs` are modified beyond the already-committed design and plan documents.

- [ ] **Step 7: Commit the implementation**

```bash
git add tests/cross-rail-double-claim.ts programs/ansem-miner/src/instructions/claim.rs
git commit -m "fix(program): prevent cross-rail double claims"
```
