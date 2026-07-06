# ANSEM Miner — M3: Devnet Deploy + Full-Flow Smoke (Design)

**Date:** 2026-07-06
**Milestone:** M3 (devnet deploy)
**Branch:** `m3-devnet-deploy`
**Predecessor:** M2 complete (ER + VRF + session keys), merged to `main` @ `c33701a`; 40/40 tests green locally.

---

## Goal

Deploy the ANSEM Miner program to **Solana devnet** as a real, mainnet-aligned artifact, and smoke-test the **full game flow** against **real devnet infrastructure + the MagicBlock devnet Ephemeral Rollup** — sequenced in phases so we always make progress even if a live subsystem (ER routing, VRF oracle) is not turnkey.

Full flow: `init → createRound → deposit → (delegate) → stake → (commit) → request_settle → VRF callback → swap → claim`.

## Non-goals (deferred)

- Mainnet deploy, real Jupiter swap, real ANSEM, jackpot funding, audit/legal — that is **M5**.
- Next.js frontend / bull-board — that is **M4**.
- Private ER (PER / TEE) — deliberately deferred (see main design spec).
- Sub-second **in-ER** VRF — M3 uses the L1-post-commit settle path we already built; the delegated in-ER queue (`5hBR571…`) is not needed.

---

## Decisions (locked with the user)

1. **Artifact = sBPF v3, done properly (no cutting corners).** Our current tested `.so` is **verified sBPF v0** (`e_flags=0x0`, confirmed by `llvm-readelf` and two independent ELF decoders) — NOT v3, contradicting a prior memory note. v0 deploys+executes on devnet today but rides the deprecation path (SIMD-0500 disables low-version deploy; SIMD-0161 disables v0 execution). For a mainnet-bound program we ship the forward-looking **v3** artifact — **and fully re-verify it**, because our entire 40/40 green suite was run on the v0 binary. We do not ship a deprecated version to dodge work, and we do not ship untested bytecode.
2. **Scope = full flow, phased.** Deploy → L1 smoke → ER wiring → VRF settle → full e2e, each leg independently green before the e2e gate.

---

## Feasibility (from the M3 de-risk workflow, 2026-07-06)

**Verdict: FEASIBLE with named risks.** Every external program we CPI to is live and executable on devnet, permissionlessly (no signup / whitelist / API key). Confirmed via live `getAccountInfo`, adversarially cross-checked, and matched against the pinned SDK crate ids:

| Dependency | Devnet address | Status |
|---|---|---|
| DLP delegation program | `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh` | ✅ live (loader-v3) |
| Gum session program | `KeyspM2ssCJbqUhQ4k7sveSiY4WjnYsrXkC8oDbwde5` | ✅ live, permissionless CPI |
| Ephemeral VRF program | `Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz` | ✅ live (loader-v3) |
| VRF base queue (L1-settle) | `Cuj97ggrhhidhbu39TijNVqE74xvKJ69gDervRUXAxGh` | ✅ live, VRF-owned — **use this on devnet** |
| VRF program identity (callback signer) | `9irBy75QS2BN81FUgXuHcjqceJJRuc9oDkAe8TKVvvAw` | PDA `["identity"]`; never a stored account — do NOT create/fund |
| MagicBlock devnet ER router | `https://devnet-router.magicblock.app` (+ `wss://…`) | ✅ live (getRoutes 200, baseFee 0, blockTimeMs 50) |
| Our program `ansem_miner` | `8Q9EnK7ydn6ywo7ZxeqhubqYybf7FFNNwnz8JzJjXZjz` | free to deploy |

Regional ER validator identities (delegation target): US `MUS3hc9TCw4cGC12vHNoYcCGzJG1txjgQLZWVoeNHNd`, EU `MEUGGrYPxKk17hCr7wpT6s8dtNokZj5U2L57vjYMS8e`, Asia `MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57`, TEE `MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo`.

**Deploy path (confirmed):** `solana program deploy` via the **BPF Upgradeable Loader (loader-v3)**; loader-v4 is NOT required and is inactive on devnet. sBPF-v3 execution is enabled on devnet (SIMD-0178/0189/0377 active).

**Deploy cost:** ~5.1 SOL steady-state (rent-exempt ProgramData, recoverable). A first-time upgradeable deploy transiently holds buffer + ProgramData → ~10.1 SOL peak. Wallet holds 10 SOL → **top up to ~15 SOL (free devnet airdrop) before deploy.** Do NOT use `--max-len 1448877` (needs ~10.085 SOL rent alone; auto-extend covers future growth).

**Wiring already in place (verified):** all test endpoints are `process.env`-driven (`PROVIDER_ENDPOINT`, `WS_ENDPOINT`, `EPHEMERAL_PROVIDER_ENDPOINT`, `VALIDATOR`, `VRF_BASE_QUEUE`); the VRF queue is passed as the client-supplied `oracleQueue` account. So the local→devnet queue difference (`GKE6d7…` → `Cuj97gg…`) needs **zero Rust change** — only env values.

---

## Architecture / approach

**Reuse the battle-tested flow logic, re-pointed at devnet** — not parallel bespoke scripts (which would drift from what we validated). The suites were *built* to be re-pointed; a devnet smoke is primarily a config/env layer + devnet-realism adaptations (idempotency, tolerance to latency, no genesis reset). The only genuinely new code is a deploy script and a devnet config/env layer.

**Program code is unchanged for devnet.** It is recompiled only to stamp sBPF v3.

### Local ↔ devnet differences (the whole delta)

| Concern | Local (test-er.sh) | Devnet (M3) |
|---|---|---|
| Base RPC | `mb-test-validator` :8899 | Helius devnet (`HELIUS_RPC_DEVNET`) |
| ER | local `ephemeral-validator` :7799 | hosted router `devnet-router.magicblock.app` |
| VRF base queue | `GKE6d7…` | `Cuj97gg…` |
| VRF oracle | test spawns local `vrf-oracle` | MagicBlock permissioned oracle (fallback: self-host) |
| Deploy | preload `.so` at genesis | `solana program deploy` (loader-v3) |
| State lifecycle | genesis reset each run | persistent → smoke must be idempotent |
| Wallet | `~/.config/solana/id.json` | `~/.config/solana/ansem-devnet.json` |
| Delegation target | local validator identity `mAGic…` | a regional identity (e.g. `MUS3hc9…`) |

---

## Components / files

- **`scripts/deploy-devnet.sh`** (new) — deploy the v3 `.so` via loader-v3. Idempotent + resumable: `--use-rpc` (Helius; avoids TPU/QUIC), persistent `--buffer <keypair>` so a mid-upload failure resumes, `--max-sign-attempts 60`, `--with-compute-unit-price`. Pre-flight: ensure wallet ≥ ~15 SOL (airdrop if low), assert program id is `8Q9EnK7…`, assert the local `.so` is v3 (`e_flags=3`). Post: verify the program account is executable; upgrade authority = deploy wallet; reclaim any orphaned buffer with `solana program close`. Resume by re-running with the same `--buffer`.
- **`scripts/devnet-env.sh`** (new, sourced) — single source of truth for devnet constants: Helius RPC/WS (from `.env`), router URL, `VRF_BASE_QUEUE=Cuj97gg…`, the delegation validator identity (**default US `MUS3hc9…`**, overridable), wallet path. Exports the same env var names the suites already read.
- **`tests/ansem-miner-devnet.ts`** (new) — the phased devnet smoke, reusing existing helpers, made **idempotent** (create-or-reuse config/mint/round; never assume a clean genesis) and **tolerant** (retry/backoff for devnet latency; poll for oracle fulfillment). Structured so each phase can run independently.
- **`docs/` run-book** (new) — exact commands + the devnet addresses used + how to resume/rollback.
- **Rust program:** unchanged; rebuilt with `--arch v3` only.

---

## Phased sequence (each leg independently green before the e2e gate)

### Phase 0 — v3 executability spike + full local re-verify
De-risk the linchpin before any devnet spend.
1. Build `anchor build -- --arch v3` (or `cargo build-sbf --arch v3`); assert the ELF stamps `e_flags=3` via `llvm-readelf`.
2. Bring up the local two-provider stack against the v3 `.so`; run the **M1 base suite** (19 tests — the quickest that actually executes the program on the validator; `cargo test` runs on the host and does NOT exercise on-chain execution) to confirm `mb-test-validator` **executes v3**.
3. **If local executes v3:** re-run the **entire gate on the v3 binary** — unit 9, M1 19, M2a 8, M2b 2, M2c 2 = **40/40**. Resolve anything that differs.
4. **If local cannot execute v3:** STOP and surface the fork (find a validator config that runs v3, or reconsider) — do NOT silently deploy locally-untested bytecode.
**Done when:** 40/40 green on a verified-v3 `.so`.

### Phase 1 — deploy + L1 smoke (no infra dependency)
1. Top up wallet to ~15 SOL (free airdrop).
2. `scripts/deploy-devnet.sh` → program live + executable on devnet; verify with `solana program show`.
3. L1-only smoke (idempotent): `init → createRound → deposit → stake (wallet path) → settle (admin) → swap (mock) → claim`, asserting ANSEM received.
4. Session-key smoke on L1: `createSessionV2` against the live gum program → session-gated `stake` wallet-path boundary check.
**Done when:** program live + the non-ER legs green on devnet.

### Phase 2 — ER wiring via hosted router (hosted-first)
1. Point the client at `https://devnet-router.magicblock.app`.
2. `delegate_round` / `delegate_miner` (DLP CPI, targeting a regional validator identity) → confirm accounts route to the ER.
3. ER `stake` (session-gated) → `commit`/undelegate round-trip back to L1.
4. **Empirically confirm the two flagged unknowns here:** (a) getAccountInfo read-routing-by-delegation through the router; (b) the exact delegate-instruction validator-identity parameter wiring in `ephemeral-rollups-sdk 0.14.3`.
**Fallback:** self-hosted `ephemeral-validator --remote-url https://rpc.magicblock.app/devnet` (delegation is validator-identity-scoped, so NOT drop-in — used only for deterministic CI if the hosted ER misbehaves).
**Done when:** an ER stake is executed and committed back to L1 on devnet.

### Phase 3 — VRF settle (least turnkey)
1. On L1 post-commit: `request_settle` against the live base queue `Cuj97gg…`.
2. Wait for the **real** MagicBlock permissioned oracle callback (signer `9irBy75…`) → round `Settled`.
3. Budget an unknown small per-request SOL fee (unpublished).
**Fallback:** if the hosted oracle does not fulfill promptly, run our own `vrf-oracle` against our **own** queue (the default queues are MagicBlock-permissioned and cannot be self-fulfilled).
**Done when:** a devnet round settles via a real VRF callback (or the documented self-host fallback).

### Phase 4 — full e2e on devnet
Run `init → round → delegate → ER stake → commit → request_settle → VRF callback → reconcile → swap → claim` end-to-end, only after Phases 1–3 are each independently green.
**Done when:** one full devnet round completes and a staker claims ANSEM.

---

## Error handling / devnet-specific rigor

- **Idempotent + resumable everywhere** — no genesis reset to lean on. Create-or-reuse singletons (config/mint); buffer-resume on flaky upload; poll-with-timeout for oracle/ER.
- **Helius RPC only** — never the rate-limited public `api.devnet.solana.com`.
- **Wallet top-up pre-flight** — clear the transient deploy peak before flipping.
- **Secrets** — stay in git-ignored `.env`; nothing committed. The deploy/buffer keypairs live outside the repo (`~/.config/solana/`).
- **Standing guardrail** — no fund-moving test seams / rug vectors even on devnet ([[avoid-rug-vector-test-seams]]).
- **Per-phase fallbacks** — a single flaky subsystem never blocks demonstrating the rest.

## Open items to confirm empirically during execution

1. Local `mb-test-validator` executes sBPF v3 (Phase 0 gate).
2. getAccountInfo read-routing-by-delegation through the router (Phase 2).
3. Exact delegate-instruction validator-identity param wiring (Phase 2).
4. `createSessionV2` discriminator against the devnet-deployed gum program (Phase 1).
5. Hosted devnet VRF oracle fulfillment liveness/SLA + per-request fee (Phase 3).
6. Devnet code path uses the devnet base queue `Cuj97gg…`, not the local `GKE6d7…`.

## Done criteria (milestone)

- Program live + executable on devnet as a **verified sBPF v3** artifact; 40/40 local gate green on that same v3 binary.
- Phases 1–4 each green on devnet (with documented fallbacks where infra required them).
- A `docs/` run-book: exact commands, devnet addresses, resume/rollback notes.
- Memory updated: the v0→v3 build correction (default `cargo build-sbf` emits v0; v3 requires `--arch v3`), and the devnet constants (queue `Cuj97gg…`, router, validator identities).
