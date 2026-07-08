# ANSEM Miner — Devnet Run-book (M3)

Operational reference for the devnet deployment. The program is **live on devnet** as a
verified sBPF-v3 artifact and the full game loop (deploy → L1 → ER stake → VRF settle →
claim, incl. gasless session-key staking) is verified end-to-end against real MagicBlock
devnet infra.

## Live addresses (devnet)

| Thing | Address |
|---|---|
| ANSEM Miner program | `8Q9EnK7ydn6ywo7ZxeqhubqYybf7FFNNwnz8JzJjXZjz` |
| ProgramData | `2K1sLP43GKajCgrGTgkAfvc23GVLgqY1YQwwkCGBaFvM` |
| Upgrade authority / deploy wallet | `9FuMzZyQaTabe5PhXYZxSxRDgxx5576aByJtNXucBVbF` (`~/.config/solana/ansem-devnet.json`) |
| DLP delegation program | `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh` |
| Gum session program | `KeyspM2ssCJbqUhQ4k7sveSiY4WjnYsrXkC8oDbwde5` |
| Ephemeral-VRF program | `Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz` |
| VRF base queue (L1 settle) | `Cuj97ggrhhidhbu39TijNVqE74xvKJ69gDervRUXAxGh` |
| ER region endpoint (US) | `https://devnet-us.magicblock.app` (+ `wss://`) — **use this for ER writes, NOT the router** |
| ER validator identity (US) | `MUS3hc9TCw4cGC12vHNoYcCGzJG1txjgQLZWVoeNHNd` |
| Helius devnet RPC | `HELIUS_RPC_DEVNET` in git-ignored `.env` |

Other regions: EU `MEUGGrYPxKk17hCr7wpT6s8dtNokZj5U2L57vjYMS8e` / `devnet-eu…`, Asia `MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57` / `devnet-as…`, TEE `MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo` / `devnet-tee…`. The `VALIDATOR` env and the `EPHEMERAL_PROVIDER_ENDPOINT` region MUST match.

## Build (sBPF v3)

```bash
# v3 is opt-in and needs platform-tools v1.54 (the default v1.52 lacks the v3 sysroot).
# anchor build can't pass --tools-version, so build the .so directly:
cargo build-sbf --arch v3 --tools-version v1.54
# verify: Flags must be 0x3
"$(ls ~/.cache/solana/*/platform-tools/llvm/bin/llvm-readelf | head -1)" -h target/deploy/ansem_miner.so | grep Flags
```

Running v3 through the local ER needs `ephemeral-validator >= 0.13.3` (0.12.0 can't clone v3). Local full gate: `ARCH=v3 TEST_FILE=… bash scripts/test-er.sh` (40/40).

## Deploy / upgrade

```bash
bash scripts/deploy-devnet.sh   # loader-v3, --use-rpc, resumable persistent --buffer
```
- Cost: ~4.2 SOL rent (recoverable) for the 605 KB v3 program; a first deploy transiently holds buffer+programdata (~8.4 SOL peak).
- **Resume** a failed upload: re-run the same command (the persistent `target/deploy/ansem_miner-buffer.json` resumes). Reclaim an abandoned buffer: `solana program close <buffer-pubkey> --keypair ~/.config/solana/ansem-devnet.json --url <helius>`.
- **Upgrade**: same command redeploys to the same program id (authority = deploy wallet).

## Fund the deploy wallet (devnet)

The web faucet blocks agents and CLI airdrops are rate-limited. Use the PoW faucet:
```bash
cargo install devnet-pow   # once
devnet-pow mine -k ~/.config/solana/ansem-devnet.json -u dev -t 5000000000 --reward 0.02 -d 3 --no-infer
```
~0.02 SOL per solve. Stop it (`pkill -f devnet-pow`) before running timing-sensitive ER tests (PoW maxes CPU). The devnet smoke funds throwaway players ~0.1 SOL each; `min_stake` is 0.01 SOL.

## Run the smoke (per phase)

```bash
source scripts/devnet-env.sh
pnpm exec ts-mocha -p ./tsconfig.json -t 1000000 -g "phase 1" tests/ansem-miner-devnet.ts  # L1 flow + session CPI
pnpm exec ts-mocha -p ./tsconfig.json -t 1000000 -g "phase 2" tests/ansem-miner-devnet.ts  # ER stake + commit
pnpm exec ts-mocha -p ./tsconfig.json -t 1000000 -g "phase 3" tests/ansem-miner-devnet.ts  # VRF settle via real oracle
pnpm exec ts-mocha -p ./tsconfig.json -t 1000000 -g "phase 4" tests/ansem-miner-devnet.ts  # full gasless e2e
```
Run phases **individually** — the dev-tier Helius key rate-limits a long combined run (each phase is green in isolation; a paid RPC tier would allow the full suite in one pass).

## Empirical findings (the devnet gotchas we hit)

1. **ER writes → regional endpoint, NOT the router.** A stake/commit through `devnet-router.magicblock.app` fails `Blockhash not found` (it proxies an L1 blockhash the ER doesn't have). Use `devnet-us.magicblock.app` (matching the delegated validator's region). The router is fine for delegation-routed reads, not for signing ER writes.
2. **VRF oracle is live and FAST.** `request_settle` against the base queue is fulfilled by the permissioned MagicBlock oracle within seconds (round was `Settled` right after the request posted). No self-hosted oracle needed. `request_settle` must run **without** `skipPreflight` so a clock-lag `RoundNotEnded` surfaces cleanly (skipPreflight mangles it to "Unknown action 'undefined'").
3. **Dev-tier RPC rate limits.** Bursts of L1 sends hit Helius 429s on `getLatestBlockhash`. `l1Send` retries **pre-send** transients only (safe — the tx never left). Space tests (`afterEach` 12 s). Poll reads (ATA after claim throws `TokenAccountNotFoundError` until the mint propagates).
4. **No genesis reset.** Smokes are idempotent: create-or-skip init, fresh player + round id per run, and `createFreshRound` self-heals a stranded round — including committing an ER-**delegated** stranded round back to L1 before cancelling.
5. **Validator-clock lag on devnet too.** Deadline-gated `settle`/`cancel` are retried until the on-chain clock passes the deadline (`retryPastDeadline`).
6. **Propagation races.** After `join_round`, poll `escrow.active_round == id` before staking (else `NotCurrentRound`); after `delegate`, poll owner == DLP before proceeding.
