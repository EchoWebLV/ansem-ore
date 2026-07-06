# ANSEM Miner — M3 Devnet Deploy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **OPERATOR NOTE:** Phase 0–1 are deterministic and subagent-friendly. **Phases 2–3 interact with LIVE MagicBlock devnet infra** (hosted ER router, permissioned VRF oracle) and contain empirical decision points + fallbacks — an operator (or a human-in-the-loop agent) should watch these, not fire-and-forget. Never treat a live-infra timeout as a code bug without first checking the fallback.

**Goal:** Deploy the ANSEM Miner program to Solana devnet as a verified sBPF-v3 artifact and smoke-test the full game flow (init → round → ER stake → VRF settle → swap → claim) against real devnet infrastructure, phased so each leg is independently green.

**Architecture:** The program code is unchanged; it is recompiled with `--arch v3`. Our test suites are already `process.env`-driven, so devnet is reached via a config/env layer (`scripts/devnet-env.sh`) plus a new deploy script and a devnet-adapted smoke suite that mirrors `tests/ansem-miner-vrf.ts` but is made idempotent (no genesis reset), funded by transfer (not airdrop), and pointed at the hosted devnet ER router + the real VRF oracle.

**Tech Stack:** Anchor 1.0.2 (avm) / Agave solana-cli 4.1.0-beta.2 / `cargo build-sbf --arch v3` / MagicBlock `ephemeral-rollups-sdk 0.14.3` + `ephemeral-vrf-sdk 0.3.0` + `session-keys 3.1.1` / Helius devnet RPC / ts-mocha.

**Reference (read before starting):**
- Spec: `docs/superpowers/specs/2026-07-06-ansem-miner-m3-devnet-deploy-design.md` (all confirmed devnet addresses live here).
- Full-flow template to mirror: `tests/ansem-miner-vrf.ts` (does init→deposit→createRound→initMiner→delegate→join→ER stake→commit→request_settle→oracle→reconcile→swap→claim).
- Local stack harness: `scripts/test-er.sh`.
- Secrets (git-ignored `.env`): `HELIUS_RPC_DEVNET`, `HELIUS_RPC_MAINNET`, `DEPLOY_WALLET_PUBKEY`. Deploy keypair at `~/.config/solana/ansem-devnet.json` (pubkey `9FuMzZyQaTabe5PhXYZxSxRDgxx5576aByJtNXucBVbF`).

**Confirmed devnet constants (from the de-risk):**
- Program id: `8Q9EnK7ydn6ywo7ZxeqhubqYybf7FFNNwnz8JzJjXZjz` (free to deploy; keypair `target/deploy/ansem_miner-keypair.json`).
- ER router: `https://devnet-router.magicblock.app` / `wss://devnet-router.magicblock.app`.
- VRF base queue (L1 settle): `Cuj97ggrhhidhbu39TijNVqE74xvKJ69gDervRUXAxGh`.
- Delegation validator identity (default US): `MUS3hc9TCw4cGC12vHNoYcCGzJG1txjgQLZWVoeNHNd`.
- DLP: `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh`. Gum: `KeyspM2ssCJbqUhQ4k7sveSiY4WjnYsrXkC8oDbwde5`. VRF program: `Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz`.

---

## File Structure

| File | Responsibility | Created / Modified |
|---|---|---|
| `scripts/test-er.sh` | Add `ARCH` env so the local stack can build+run the v3 binary | Modify |
| `scripts/devnet-env.sh` | Single source of truth for devnet env exports (sourced by deploy + smoke) | Create |
| `scripts/deploy-devnet.sh` | Idempotent, resumable loader-v3 deploy of the v3 `.so` to devnet | Create |
| `tests/ansem-miner-devnet.ts` | Phased devnet smoke (L1 → ER → VRF → e2e), idempotent + tolerant | Create |
| `docs/devnet-runbook.md` | Exact commands, addresses, resume/rollback notes | Create |
| Rust program | Unchanged (recompiled `--arch v3` only) | — |

---

# PHASE 0 — v3 build + full local re-verify (THE GATE)

**Goal of phase:** Produce a verified sBPF-v3 `.so` and prove the entire local suite (40 tests) passes on it. If the local validator cannot execute v3, STOP here.

### Task 0.1: Teach the local harness to build the v3 binary

**Files:**
- Modify: `scripts/test-er.sh:68-71` (the build block)

> **DISCOVERED DURING EXECUTION:** `anchor build -- --arch v3` FAILS two ways: (1) the default rustup toolchain is `1.89.0-sbpf-solana-v1.52`, whose sysroot lacks `sbpfv3-solana-solana` (`error[E0463]: can't find crate for core`); (2) `anchor build` already injects its own `--tools-version`, so a second one via passthrough errors `provided more than once`. The v3 sysroot ships in **platform-tools v1.54** (cached), so v3 must build the `.so` **directly** with `cargo build-sbf --arch v3 --tools-version v1.54`. The program interface is unchanged, so the existing `target/types/ansem_miner.ts` stays valid (no IDL regen needed).

- [ ] **Step 1: Add an `ARCH` env to the build step.** Replace the build block so v0 uses `anchor build` (keeps IDL regen) and non-v0 uses direct `cargo build-sbf` pinned to v1.54:

```bash
if [ "${SKIP_BUILD:-0}" != "1" ]; then
  ARCH="${ARCH:-v0}"
  echo "Building program (arch=$ARCH)..."
  if [ "$ARCH" = "v0" ]; then
    anchor build || { echo "ERROR: anchor build failed"; exit 1; }
  else
    cargo build-sbf --arch "$ARCH" --tools-version v1.54 \
      || { echo "ERROR: cargo build-sbf --arch $ARCH failed"; exit 1; }
  fi
fi
```

- [ ] **Step 2: Build v3 and verify it compiles.** Run:

```bash
cd /Users/yordanlasonov/Documents/GitHub/ansem-ore
cargo build-sbf --arch v3 --tools-version v1.54 2>&1 | tail -5
```

Expected: `Finished release [optimized]` (only the harmless `#[ephemeral]` cfg-check warning). The v3 `.so` is ~605,832 bytes (smaller than v0's 724,416).

- [ ] **Step 3: Assert the artifact is genuinely v3.** Run:

```bash
LLVM_READELF=$(ls ~/.cache/solana/*/platform-tools/llvm/bin/llvm-readelf | head -1)
"$LLVM_READELF" -h target/deploy/ansem_miner.so | grep -i flags
```

Expected: `Flags: 0x3` (was `0x0` for the v0 build). If it still shows `0x0`, the `--arch v3` did not take — do not proceed.

- [ ] **Step 4: Commit.**

```bash
git add scripts/test-er.sh
git commit -m "M3 phase0: ARCH env in test-er.sh; default v0, v3 opt-in"
```

### Task 0.2: v3 executability spike (the local-can-run-v3 gate)

**Files:** none (runs the existing M1 suite against the v3 binary)

- [ ] **Step 1: Run the M1 base suite on the v3 binary.** (`cargo test` runs on the host and does NOT exercise on-chain execution, so it cannot confirm v3 — a TS suite that actually invokes the program is required. M1 is the quickest.)

```bash
ARCH=v3 TEST_FILE=tests/ansem-miner.ts bash scripts/test-er.sh 2>&1 | tail -30
```

Expected: `19 passing`. This proves `mb-test-validator` **executes** the v3 program (a v3-execution failure surfaces as `InvalidBpfVersion`/`program failed to complete` on the first instruction).

- [ ] **Step 2: DECISION GATE.**
  - **If 19 passing:** local executes v3 → proceed to Task 0.3.
  - **If it fails with a version/loader error** (`unsupported sBPF version`, `InvalidBpfVersion`, program-load failure on every call): STOP. Do not deploy locally-untested bytecode. Report to the operator with the exact error. Options to escalate: (a) check whether a newer `mb-test-validator` enables v3 execution; (b) reconsider the artifact decision with the user. Do NOT silently fall back to v0-for-devnet.

### Task 0.3: Full local re-verify on the v3 binary (40/40)

**Files:** none

- [ ] **Step 1: Rust unit tests** (host-side, fast sanity):

```bash
cargo test 2>&1 | tail -5
```

Expected: `test result: ok. 9 passed`.

- [ ] **Step 2: Run each integration suite on the v3 binary** (reuse one build; `SKIP_BUILD=1` after the first). Run sequentially — they share ports:

```bash
ARCH=v3 TEST_FILE=tests/ansem-miner.ts         bash scripts/test-er.sh 2>&1 | tail -5   # M1: 19 passing
SKIP_BUILD=1 TEST_FILE=tests/ansem-miner-er.ts      bash scripts/test-er.sh 2>&1 | tail -5   # M2a: 8 passing
SKIP_BUILD=1 TEST_FILE=tests/ansem-miner-vrf.ts     bash scripts/test-er.sh 2>&1 | tail -5   # M2b: 2 passing
SKIP_BUILD=1 TEST_FILE=tests/ansem-miner-session.ts bash scripts/test-er.sh 2>&1 | tail -5   # M2c: 2 passing
```

Expected: `19 passing`, `8 passing`, `2 passing`, `2 passing`. Total with unit = **40/40** on verified-v3 bytecode.

- [ ] **Step 2b: Hygiene check** (no stray validators after the runs):

```bash
pgrep -fl 'mb-test-validator|ephemeral-validator|vrf-oracle' || echo "clean"
```

Expected: `clean`.

- [ ] **Step 3: Commit the phase-0 completion marker.** (No code changed beyond Task 0.1; commit a note so the gate is recorded.)

```bash
git commit --allow-empty -m "M3 phase0: 40/40 local gate green on verified sBPF-v3 binary"
```

---

# PHASE 1 — deploy + L1 smoke

**Goal of phase:** Program live + executable on devnet; the non-ER legs (init/round/deposit/stake-wallet/settle/swap/claim) and a session-key CPI all green on devnet.

### Task 1.1: Devnet env layer

**Files:**
- Create: `scripts/devnet-env.sh`

- [ ] **Step 1: Write the env script.** It reads `HELIUS_RPC_DEVNET` from `.env` and exports the same var names the suites already consume.

```bash
#!/bin/bash
# ANSEM Miner — devnet env. `source` this before deploy-devnet.sh or the smoke.
# Single source of truth for the local->devnet delta (see M3 spec).
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

RPC=$(grep '^HELIUS_RPC_DEVNET=' "$REPO_ROOT/.env" | cut -d= -f2- | tr -d '"')
[ -z "$RPC" ] && { echo "ERROR: HELIUS_RPC_DEVNET missing from .env"; return 1 2>/dev/null || exit 1; }
WS=$(echo "$RPC" | sed -E 's#^https#wss#')

export DEVNET_WALLET="${DEVNET_WALLET:-$HOME/.config/solana/ansem-devnet.json}"

# L1 (base) provider — used by anchor's AnchorProvider.env().
export ANCHOR_PROVIDER_URL="$RPC"
export ANCHOR_WALLET="$DEVNET_WALLET"
export PROVIDER_ENDPOINT="$RPC"
export WS_ENDPOINT="$WS"

# ER — the hosted MagicBlock devnet router (auto-routes per-tx by delegation).
export EPHEMERAL_PROVIDER_ENDPOINT="https://devnet-router.magicblock.app"
export EPHEMERAL_WS_ENDPOINT="wss://devnet-router.magicblock.app"

# Delegation target (regional ER validator identity) + devnet VRF base queue.
export VALIDATOR="${VALIDATOR:-MUS3hc9TCw4cGC12vHNoYcCGzJG1txjgQLZWVoeNHNd}"
export VRF_BASE_QUEUE="Cuj97ggrhhidhbu39TijNVqE74xvKJ69gDervRUXAxGh"

echo "devnet-env: RPC=$(echo "$RPC" | sed -E 's/api-key=.*/api-key=<masked>/') wallet=$DEVNET_WALLET validator=$VALIDATOR"
```

- [ ] **Step 2: Verify it sources cleanly.** Run:

```bash
cd /Users/yordanlasonov/Documents/GitHub/ansem-ore && source scripts/devnet-env.sh && echo "OK $EPHEMERAL_PROVIDER_ENDPOINT"
```

Expected: `devnet-env: RPC=…api-key=<masked>… validator=MUS3hc9…` then `OK https://devnet-router.magicblock.app`.

- [ ] **Step 3: Commit.**

```bash
git add scripts/devnet-env.sh && git commit -m "M3 phase1: scripts/devnet-env.sh (devnet env layer)"
```

### Task 1.2: Fund the deploy wallet above the transient deploy peak

**Files:** none

- [ ] **Step 1: Check balance.** Run:

```bash
source scripts/devnet-env.sh
solana balance "$DEVNET_WALLET" --url "$ANCHOR_PROVIDER_URL"
```

Expected: `10 SOL` (or current). A first-time upgradeable deploy transiently holds buffer + programdata ≈ 10.1 SOL, so 10 is too tight.

- [ ] **Step 2: Top up to ~15 SOL via free devnet airdrop.** (Helius may rate-limit airdrops; if it 429s, retry or use `https://faucet.solana.com`. Do NOT block on getting exactly 15 — ≥11 SOL suffices.)

```bash
for i in 1 2 3 4 5; do solana airdrop 1 "$DEVNET_WALLET" --url "$ANCHOR_PROVIDER_URL" && sleep 2; done
solana balance "$DEVNET_WALLET" --url "$ANCHOR_PROVIDER_URL"
```

Expected: balance ≥ 11 SOL. If airdrops are throttled, top up from any other funded devnet wallet you control.

### Task 1.3: Deploy script + first deploy

**Files:**
- Create: `scripts/deploy-devnet.sh`

- [ ] **Step 1: Write the deploy script** (idempotent, resumable, loader-v3):

```bash
#!/bin/bash
# ANSEM Miner — devnet deploy (loader-v3, resumable). Deploys the prebuilt v3 .so.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
source scripts/devnet-env.sh

SO="$REPO_ROOT/target/deploy/ansem_miner.so"
PROGRAM_KP="$REPO_ROOT/target/deploy/ansem_miner-keypair.json"
BUFFER_KP="$REPO_ROOT/target/deploy/ansem_miner-buffer.json"   # persistent → resumable
PROGRAM_ID="8Q9EnK7ydn6ywo7ZxeqhubqYybf7FFNNwnz8JzJjXZjz"

# Pre-flight guards.
[ -f "$SO" ] || { echo "ERROR: $SO missing — build phase 0 first"; exit 1; }
LLVM_READELF=$(ls ~/.cache/solana/*/platform-tools/llvm/bin/llvm-readelf | head -1)
FLAGS=$("$LLVM_READELF" -h "$SO" | awk '/Flags/{print $2}')
[ "$FLAGS" = "0x3" ] || { echo "ERROR: .so is not sBPF v3 (Flags=$FLAGS) — rebuild with ARCH=v3"; exit 1; }
[ "$(solana-keygen pubkey "$PROGRAM_KP")" = "$PROGRAM_ID" ] || { echo "ERROR: program keypair != $PROGRAM_ID"; exit 1; }

# If already deployed, this is an UPGRADE; else initial deploy. Same command works
# for both. A persistent --buffer makes a mid-upload failure resumable: just re-run.
[ -f "$BUFFER_KP" ] || solana-keygen new --no-bip39-passphrase -s -o "$BUFFER_KP" >/dev/null

echo "Deploying $SO -> $PROGRAM_ID on devnet ..."
solana program deploy "$SO" \
  --program-id "$PROGRAM_KP" \
  --buffer "$BUFFER_KP" \
  --keypair "$DEVNET_WALLET" \
  --url "$ANCHOR_PROVIDER_URL" \
  --use-rpc \
  --with-compute-unit-price 50000 \
  --max-sign-attempts 60

echo "Deployed. Verifying ..."
solana program show "$PROGRAM_ID" --url "$ANCHOR_PROVIDER_URL"
```

- [ ] **Step 2: Run the deploy.**

```bash
bash scripts/deploy-devnet.sh 2>&1 | tail -25
```

Expected: `Program Id: 8Q9EnK7…` and a `solana program show` block with `Authority: 9FuMzZyQ…`, a data length ≈ 724416, `Balance` ≈ 5.04 SOL.

- [ ] **Step 3: If the upload fails mid-way** (RPC flake): re-run the SAME command — the persistent `--buffer` resumes from where it stopped. If it fails with "account already in use" for the program, the deploy already succeeded (verify with `solana program show`). Reclaim a stuck buffer only if you abandon it: `solana program close "$(solana-keygen pubkey target/deploy/ansem_miner-buffer.json)" --url "$ANCHOR_PROVIDER_URL" --keypair "$DEVNET_WALLET"`.

- [ ] **Step 4: Verify executable + IDL match.** Run:

```bash
source scripts/devnet-env.sh
solana program show 8Q9EnK7ydn6ywo7ZxeqhubqYybf7FFNNwnz8JzJjXZjz --url "$ANCHOR_PROVIDER_URL" | grep -Ei "authority|data length|last deployed"
```

Expected: authority = deploy wallet; data length > 0; a last-deployed slot.

- [ ] **Step 5: Commit.**

```bash
git add scripts/deploy-devnet.sh && git commit -m "M3 phase1: scripts/deploy-devnet.sh + program live on devnet"
```

### Task 1.4: Devnet smoke suite skeleton + L1 flow

**Files:**
- Create: `tests/ansem-miner-devnet.ts`

Mirror the PDA/account/helper setup from `tests/ansem-miner-vrf.ts:1-137` (imports, `awaitOwner`/`awaitOwnerIs`/`awaitEr`/`erRpcTolerant`, all `findProgramAddressSync` PDAs, `swapAccounts()`/`claimAccounts()`), then apply the devnet adaptations below. Do NOT copy the local-oracle `spawn`/`startOracle`/`stopOracle` block — devnet uses the real oracle.

- [ ] **Step 1: Add the idempotent-init + fund-by-transfer + fresh-round helpers.** After the PDA block, add:

```typescript
import { SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";

// Devnet has no genesis reset — initialize is one-time. Create-or-skip.
async function ensureInitialized() {
  const cfg = await program.account.config.fetch(configPda).catch(() => null);
  if (cfg) { console.log("   config exists (round_id=" + cfg.currentRoundId + ") — skip initialize"); return; }
  await program.methods.initialize().accounts({ admin: admin.publicKey }).rpc();
  console.log("   initialized config + mint + vaults");
}

// Fund the ephemeral player from the deploy wallet (devnet airdrop is throttled).
async function fundFromAdmin(to: PublicKey, lamports: number) {
  const tx = new Transaction().add(SystemProgram.transfer({
    fromPubkey: admin.publicKey, toPubkey: to, lamports,
  }));
  await provider.sendAndConfirm(tx);
}

// createRound makes round (current_round_id + 1); read the id back from config.
async function createFreshRound(): Promise<{ id: number; pda: PublicKey }> {
  await program.methods.setRoundDuration(new anchor.BN(20)).accounts({ admin: admin.publicKey }).rpc();
  await program.methods.createRound()
    .accounts({ payer: admin.publicKey, round: nextRoundPda(await peekNextRoundId()) }).rpc();
  const cfg = await program.account.config.fetch(configPda);
  const id = cfg.currentRoundId.toNumber();
  return { id, pda: nextRoundPda(id) };
}
async function peekNextRoundId(): Promise<number> {
  const cfg = await program.account.config.fetch(configPda);
  return cfg.currentRoundId.toNumber() + 1;
}
function nextRoundPda(id: number): PublicKey {
  return PublicKey.findProgramAddressSync([enc("round"), roundSeed(id)], program.programId)[0];
}
```

- [ ] **Step 2: Write the Phase-1 L1 test.** A fresh player per run (avoids cross-run miner state); the whole non-ER flow on L1:

```typescript
describe("ansem-miner (M3 devnet)", () => {
  const player = Keypair.generate();
  const [escrowPda] = PublicKey.findProgramAddressSync([enc("escrow"), player.publicKey.toBuffer()], program.programId);
  const [minerPda]  = PublicKey.findProgramAddressSync([enc("miner"),  player.publicKey.toBuffer()], program.programId);
  const playerAta = getAssociatedTokenAddressSync(ansemMint, player.publicKey);

  it("phase 1: L1 flow — init(idempotent) -> round -> deposit -> stake(wallet) -> settle -> swap -> claim", async function () {
    this.timeout(180000);
    await ensureInitialized();
    await fundFromAdmin(player.publicKey, 3 * anchor.web3.LAMPORTS_PER_SOL);
    await program.methods.deposit(new anchor.BN(1 * anchor.web3.LAMPORTS_PER_SOL))
      .accounts({ authority: player.publicKey }).signers([player]).rpc();
    const { id, pda: roundPda } = await createFreshRound();
    await program.methods.initMiner().accounts({ authority: player.publicKey }).signers([player]).rpc()
      .catch((e: any) => { if (!/already in use/.test(String(e))) throw e; }); // persistent miner may exist
    // join + stake on L1 (wallet path — sessionToken: null)
    await program.methods.joinRound(new anchor.BN(id))
      .accounts({ authority: player.publicKey, config: configPda, escrow: escrowPda }).signers([player]).rpc();
    await program.methods.stake(0, new anchor.BN(0.5 * anchor.web3.LAMPORTS_PER_SOL))
      .accounts({ authority: player.publicKey, config: configPda, round: roundPda, miner: minerPda, escrow: escrowPda, sessionToken: null })
      .signers([player]).rpc();
    // wait out the deadline, admin-settle (M1 fallback path — no VRF here), reconcile, swap, claim
    await awaitEr(() => program.account.round.fetch(roundPda), (r: any) => Date.now()/1000 >= r.deadlineTs.toNumber(), 60);
    await program.methods.settle(new anchor.BN(id), Array(32).fill(7)).accounts({ admin: admin.publicKey, round: roundPda, config: configPda }).rpc();
    await program.methods.reconcileMiner(new anchor.BN(id)).accounts({ config: configPda, escrow: escrowPda, miner: minerPda }).rpc();
    await program.methods.executeSwapMock().accounts({ ...swapAccounts(), round: roundPda }).rpc();
    await program.methods.claim(new anchor.BN(id)).accounts({ ...claimAccounts(), round: roundPda, authority: player.publicKey, playerAta }).signers([player]).rpc();
    const ata = await getAccount(provider.connection, playerAta);
    assert.isAbove(Number(ata.amount), 0, "player mined ANSEM on devnet L1");
  });
});
```

> NOTE: `settle`'s exact account list + arg order is in `programs/ansem-miner/src/instructions/settle.rs` — verify the admin-settle signature (M1 fallback) matches before running. `swapAccounts()`/`claimAccounts()` from the template hardcode `round: roundPda` for a fixed round; here we spread and override `round` with the fresh id's PDA.

- [ ] **Step 3: Run the Phase-1 smoke against devnet.**

```bash
source scripts/devnet-env.sh
yarn run ts-mocha -p ./tsconfig.json -t 1000000 -g "phase 1" tests/ansem-miner-devnet.ts 2>&1 | tail -30
```

Expected: `1 passing`, with `player mined ANSEM on devnet L1`.

- [ ] **Step 4: Commit.**

```bash
git add tests/ansem-miner-devnet.ts && git commit -m "M3 phase1: devnet L1 smoke green (deploy -> stake -> settle -> swap -> claim)"
```

### Task 1.5: Session-key CPI smoke on devnet (L1)

**Files:**
- Modify: `tests/ansem-miner-devnet.ts` (add one `it`)

Mirror the gum-session setup from `tests/ansem-miner-session.ts` (the `SessionTokenManager` import + `createSession` helper + token PDA derivation).

- [ ] **Step 1: Add a session-boundary `it` block** that creates a real `SessionTokenV2` against the live devnet gum program and asserts a valid-session L1 stake passes and an expired-token stake fails:

```typescript
it("phase 1: session-key CPI works against the live devnet gum program", async function () {
  this.timeout(120000);
  // Reuse the createSession + stakeL1 helpers copied from tests/ansem-miner-session.ts.
  // 1) createSession(sessionKp, program.programId, now+900) against Keysp… on devnet.
  // 2) a session-signed L1 stake into a funded+joined miner passes.
  // 3) an expired-token (validUntil = now-60) session stake is rejected.
  // (Full helper bodies: copy from tests/ansem-miner-session.ts and point provider at devnet.)
});
```

> This is the one L1 CPI never exercised on devnet (spec open item #4). If `createSessionV2`'s discriminator/name differs on the deployed gum program vs the pinned crate, this surfaces it here as a clear CPI error rather than deep in Phase 2.

- [ ] **Step 2: Run + commit.**

```bash
source scripts/devnet-env.sh
yarn run ts-mocha -p ./tsconfig.json -t 1000000 -g "session-key CPI" tests/ansem-miner-devnet.ts 2>&1 | tail -20
git add tests/ansem-miner-devnet.ts && git commit -m "M3 phase1: session-key CPI green on devnet gum program"
```

Expected: `1 passing`.

---

# PHASE 2 — ER wiring via the hosted devnet router (LIVE INFRA)

**Goal of phase:** A stake executed inside the MagicBlock devnet ER and committed back to L1.

### Task 2.1: Delegate + ER stake + commit round-trip

**Files:**
- Modify: `tests/ansem-miner-devnet.ts` (add the Phase-2 `it`)

The mechanics are identical to `tests/ansem-miner-vrf.ts:157-207` (delegateRound→delegateMiner→joinRound→ER stake loop→commitRound→commitMiner). The devnet delta is env-only: `VALIDATOR`, `EPHEMERAL_PROVIDER_ENDPOINT`, and the ER provider already read these.

- [ ] **Step 1: Add the Phase-2 `it`** by copying the ER staking block from the template and using the fresh-round helpers:

```typescript
it("phase 2: ER stake via devnet router -> commit round-trip to L1", async function () {
  this.timeout(240000);
  await ensureInitialized();
  const player = Keypair.generate();
  const [escrowPda] = PublicKey.findProgramAddressSync([enc("escrow"), player.publicKey.toBuffer()], program.programId);
  const [minerPda]  = PublicKey.findProgramAddressSync([enc("miner"),  player.publicKey.toBuffer()], program.programId);
  await fundFromAdmin(player.publicKey, 3 * anchor.web3.LAMPORTS_PER_SOL);
  await program.methods.deposit(new anchor.BN(1 * anchor.web3.LAMPORTS_PER_SOL)).accounts({ authority: player.publicKey }).signers([player]).rpc();
  await program.methods.initMiner().accounts({ authority: player.publicKey }).signers([player]).rpc().catch((e:any)=>{ if(!/already in use/.test(String(e))) throw e; });
  const { id, pda: roundPda } = await createFreshRound();
  // delegate (validator identity from env VALIDATOR), join, ER stake loop, commit — copy verbatim
  // from ansem-miner-vrf.ts:157-207, substituting roundPda/id and keeping sessionToken:null.
  // Assert after commit: round owner == program (undelegated) and pot == staked amount.
});
```

- [ ] **Step 2: Run it and WATCH the routing.**

```bash
source scripts/devnet-env.sh
yarn run ts-mocha -p ./tsconfig.json -t 1000000 -g "phase 2" tests/ansem-miner-devnet.ts 2>&1 | tail -40
```

Expected: `1 passing`; after `delegateRound`, `awaitOwner(round)` returns the DLP id `DELeGG…`; the ER stake updates the miner in the ER; after `commitRound`/`commitMiner`, owners return to the program id.

- [ ] **Step 3: EMPIRICAL CHECKPOINTS (spec open items #2, #3).** Record findings in the run-book:
  - **Read-routing:** does `ephemeralProgram.account.minerPosition.fetch(minerPda)` (via the router) return the ER value while the account is delegated? If the router does NOT auto-route reads, point the ER connection at a specific regional ER RPC (`https://devnet-us.magicblock.app`) instead of the router and re-run.
  - **Validator-identity param:** confirm `delegateRound`'s `remainingAccounts([{pubkey: VALIDATOR, ...}])` is accepted and the account lands on the region for `VALIDATOR`. If delegation errors on the identity, try omitting `remainingAccounts` (defaults to any validator) and record which works.

- [ ] **Step 4: FALLBACK (only if the hosted ER misbehaves).** Self-host against devnet:

```bash
ephemeral-validator --no-tui --lifecycle ephemeral --remote-url https://rpc.magicblock.app/devnet --listen 127.0.0.1:7799 --reset &
# then override for this run only:
EPHEMERAL_PROVIDER_ENDPOINT=http://127.0.0.1:7799 EPHEMERAL_WS_ENDPOINT=ws://127.0.0.1:7800 \
  yarn run ts-mocha -p ./tsconfig.json -t 1000000 -g "phase 2" tests/ansem-miner-devnet.ts
```

Delegation is validator-identity-scoped, so with a self-hosted ER you must delegate to ITS identity (`VALIDATOR=<self-hosted identity>`), not the hosted regional one.

- [ ] **Step 5: Commit.**

```bash
git add tests/ansem-miner-devnet.ts docs/devnet-runbook.md && git commit -m "M3 phase2: ER stake + commit round-trip on devnet (routing findings recorded)"
```

---

# PHASE 3 — VRF settle via the real devnet oracle (LEAST TURNKEY)

**Goal of phase:** A devnet round settles via a real MagicBlock VRF callback.

### Task 3.1: request_settle → real oracle callback → Settled

**Files:**
- Modify: `tests/ansem-miner-devnet.ts` (add the Phase-3 `it`)

The on-chain calls are identical to `tests/ansem-miner-vrf.ts:209-267` — the ONLY differences: (1) do NOT spawn a local `vrf-oracle` (the permissioned devnet oracle fulfills); (2) `VRF_BASE_QUEUE` is the devnet queue (already set by `devnet-env.sh`); (3) a longer fulfillment timeout.

- [ ] **Step 1: Add the Phase-3 `it`** (continues from a committed, past-deadline round on L1):

```typescript
it("phase 3: request_settle on L1 -> real devnet VRF oracle callback -> Settled", async function () {
  this.timeout(300000);
  // Precondition: a round that has been ER-staked + committed back to L1, past deadline
  // (reuse the phase-2 flow to reach that state, or run phases 2+3 in one it).
  // 1) request_settle(seed) against oracleQueue = VRF_BASE_QUEUE (Cuj97gg…) on L1.
  //    Idempotent retry until round.state leaves OPEN (copy the retry loop from
  //    ansem-miner-vrf.ts:227-244) — but NO startOracle()/stopOracle().
  // 2) await round.state === 2 (Settled) with tries=180 @ 400ms (~72s) — the real
  //    oracle's latency is unobserved; give it room.
  // 3) assert randomness is nonzero, then reconcile -> swap -> claim, assert ANSEM > 0.
});
```

- [ ] **Step 2: Run + WATCH for oracle fulfillment.**

```bash
source scripts/devnet-env.sh
yarn run ts-mocha -p ./tsconfig.json -t 1000000 -g "phase 3" tests/ansem-miner-devnet.ts 2>&1 | tail -40
```

Expected: round advances OPEN→VrfPending(1)→Settled(2); `randomness` nonzero; claim mints ANSEM.

- [ ] **Step 3: DECISION GATE (spec open item #5).**
  - **If it settles:** the hosted oracle is live — record the observed latency + any per-request fee (diff the payer balance before/after `request_settle`) in the run-book.
  - **If it stalls in VrfPending past the timeout:** the permissioned oracle did not fulfill. Do NOT treat as a code bug. Fallback: run our OWN `vrf-oracle` against our OWN queue (the default `Cuj97gg…` is MagicBlock-permissioned and cannot be self-fulfilled). This requires creating a self-owned queue + pointing `VRF_BASE_QUEUE` at it and spawning `vrf-oracle` against devnet — document the exact steps in the run-book when reached, and confirm with the operator before spending time on it.

- [ ] **Step 4: Commit.**

```bash
git add tests/ansem-miner-devnet.ts docs/devnet-runbook.md && git commit -m "M3 phase3: devnet round settled via real VRF oracle (latency/fee recorded)"
```

---

# PHASE 4 — full e2e on devnet

**Goal of phase:** One `it` runs the complete flow end-to-end on devnet, only after Phases 1–3 are each green.

### Task 4.1: Full-flow e2e

**Files:**
- Modify: `tests/ansem-miner-devnet.ts` (add the Phase-4 `it`)

- [ ] **Step 1: Add the e2e `it`** chaining the proven pieces: `ensureInitialized → fund → deposit → initMiner → createFreshRound → delegateRound/Miner → joinRound → ER stake (session-gated) → commitRound/Miner → request_settle → real oracle → reconcileMiner → executeSwapMock → claim`, asserting ANSEM > 0. This is a composition of the Phase-2 and Phase-3 bodies with a session-key-signed ER stake (use the `createSession` helper from Task 1.5 so the ER stake is signed by the ephemeral key, proving the headline gasless path on devnet).

- [ ] **Step 2: Run the full e2e.**

```bash
source scripts/devnet-env.sh
yarn run ts-mocha -p ./tsconfig.json -t 1000000 -g "phase 4" tests/ansem-miner-devnet.ts 2>&1 | tail -40
```

Expected: `1 passing` — a full devnet round from session-key ER stake through VRF settle to ANSEM claim.

- [ ] **Step 3: Commit.**

```bash
git add tests/ansem-miner-devnet.ts && git commit -m "M3 phase4: full devnet e2e green (session ER stake -> VRF settle -> claim)"
```

---

# FINALIZATION

### Task F.1: Run-book

**Files:**
- Create: `docs/devnet-runbook.md`

- [ ] **Step 1: Write the run-book** capturing: the exact deploy command, the program id + all devnet addresses used, how to top up / resume a failed deploy / reclaim a buffer / upgrade (`solana program deploy` again on the same id), the empirical findings from Phases 2–3 (routing behavior, validator-identity wiring, oracle latency + fee), and the fallbacks. This is the operational reference for future devnet redeploys.

- [ ] **Step 2: Commit.**

```bash
git add docs/devnet-runbook.md && git commit -m "M3: devnet run-book (deploy/resume/upgrade + empirical infra findings)"
```

### Task F.2: Update memory + finish the branch

- [ ] **Step 1: Correct + extend memory** (outside the repo, in the memory dir):
  - `anchor-solana-gotchas.md`: FIX the sBPF claim — default `cargo build-sbf`/`anchor build` emits **sBPF v0**, not v3; v3 requires `anchor build -- --arch v3` (verified `Flags: 0x0` → `0x3`). Add: devnet deploy is loader-v3; `solana program deploy` transiently needs ~2× rent (buffer + programdata).
  - `ansem-miner-project.md`: add the M3 DONE bullet (program id live on devnet as v3; the phased green results; the devnet constants: router, VRF queue `Cuj97gg…`, validator identity).
  - `devnet-deploy-setup.md`: append the deployed-program facts + run-book pointer.

- [ ] **Step 2: Finish the branch** via superpowers:finishing-a-development-branch (verify 40/40 local still green, then present merge options).

---

## Self-Review notes (author)

- **Spec coverage:** Phase 0 (v3 + re-verify), Phase 1 (deploy + L1 + session CPI), Phase 2 (ER via router + open items #2/#3), Phase 3 (VRF via real oracle + open item #5), Phase 4 (e2e), Finalization (run-book + memory incl. v0→v3 correction, done-criteria) — all spec sections map to a task. Open item #6 (devnet queue vs local) is handled by `devnet-env.sh` exporting `VRF_BASE_QUEUE=Cuj97gg…`.
- **Empirical honesty:** Phases 2–3 legitimately cannot pre-state exact outputs for live infra; each has an explicit observable success criterion + a decision gate + a fallback, rather than a fake deterministic assertion.
- **Idempotency:** every devnet write path is create-or-skip / fresh-keypair / fresh-round-id — no reliance on a genesis reset.
- **Type/name consistency:** `configPda`, `roundSeed`, `enc`, `swapAccounts()`, `claimAccounts()`, `awaitEr` reused verbatim from the template; `config.currentRoundId` matches the Rust field `current_round_id` (round.rs:30).
