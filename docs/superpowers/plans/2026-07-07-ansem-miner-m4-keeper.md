# ANSEM Miner — M4 Frontend Part 2: Keeper (round loop + participant index + read-layer) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `@ansem/keeper` — a long-running Node service that runs continuous hands-off ANSEM Miner rounds on devnet and serves a live `BoardSnapshot` to browsers over WebSocket + REST — so M4a's backbone is verifiable with no UI.

**Architecture:** One always-on process holding the `config.admin` wallet, split into pure decision logic (unit-tested, network-free) and thin I/O executors (proven against devnet). A crank poll-loop reads on-chain state → decides the next action via a pure state machine → executes it with the `@ansem/sdk` instruction builders + ER resilience helpers. A participant index (`getProgramAccounts` memcmp filters) supplies the roster for commit/reconcile and the leaderboard. A read-layer aggregates an in-memory snapshot and pushes it to browsers, so clients never touch devnet RPC.

**Tech Stack:** TypeScript (ESM), Node 22, `@ansem/sdk` (workspace), `@coral-xyz/anchor` 0.32, `@solana/web3.js` 1.95, `ws` (WebSocket server), `bs58` (memcmp encoding), Node built-in `http` (REST), `vitest` (unit), `tsx` (dev run). pnpm + turbo workspace.

---

## Grounded reference (read before starting — the engineer has zero context)

Everything below is verified against `programs/ansem-miner/src/**`, `packages/sdk/src/**`, `tests/ansem-miner-devnet.ts`, and `scripts/devnet-env.sh` on 2026-07-07. **Do not re-derive these — they are authoritative.**

### The hands-off round the keeper drives (spec §2, proven in `tests/ansem-miner-devnet.ts`)
```
[KEEPER] create_round → delegate_round            (L1; round → DLP/ER)
[PLAYER] join_round + delegate_miner + session mint (L1; one batched popup)
[PLAYER] stake ×N                                  (ER; gasless, session-signed)
  — deadline —
[KEEPER] request_settle (ER/L1) → oracle settle_callback → SETTLED
[KEEPER] commit_miner ×all  THEN  commit_round     (ER; while round still delegated)
[DLP]    process_undelegation                      (L1; lands committed accounts)
[KEEPER] reconcile_miner ×all → execute_swap_mock  (L1; → CLAIMABLE, next round opens)
[PLAYER] claim                                     (L1; any time after CLAIMABLE)
Stall/grace: if the oracle never fulfills, cancel_round after a bounded grace window.
```

### Round state machine (`programs/ansem-miner/src/state/round.rs`)
`OPEN(0) → VRF_PENDING(1) → SETTLED(2) → CLAIMABLE(4)`; `SWAPPING(3)` reserved/unused; recovery `{OPEN|VRF_PENDING|SETTLED} → CLOSED(5)` via `cancel_round`. Only **one** un-finalized round exists at a time — `create_round` is gated on `config.current_round_finalized == true`.

### SDK surface the keeper consumes (all exported from `@ansem/sdk`, verified in `packages/sdk/src/index.ts`)
- **Programs:** `createProgram(connection, wallet)` (L1), `createErProgram(erConnection, wallet)` (ER).
- **PDAs:** `configPda()`, `roundPda(id)`, `minerPda(wallet)`, `escrowPda(wallet)`, `payoutVault()`, `playerAta(wallet)`.
- **Decoders:** `fetchConfig(program, configPda())` → `ConfigState`; `fetchRound(program, roundPda(id))` → `RoundStateData`; `fetchMiner`, `fetchEscrow`; `toBoardSnapshot(round, config, updatedAt)` → `BoardSnapshot`; type `BoardSnapshot`; `MinerState`, `ConfigState`, `RoundStateData`.
- **Keeper ix builders** (`packages/sdk/src/instructions/keeper.ts`): `createRoundIx(p, keeper, newRoundId)`, `delegateRoundIx(p, keeper, roundId, validator)`, `requestSettleIx(p, keeper, roundId, clientSeed, oracleQueue?)`, `settleIx(p, keeper, roundId, randomness[])`, `commitRoundIx(erP, keeper, roundId)`, `commitMinerIx(erP, keeper, minerAccount, roundAccount)`, `reconcileMinerIx(p, roundId, escrow, miner)`, `executeSwapMockIx(p, keeper, roundId)`, `cancelRoundIx(p, keeper, roundId)`, `setRoundDurationIx`, `setReturnBandIx`. Each returns an Anchor **methods builder** — call `.rpc(opts)` (or `.signers([]).rpc()`) on it.
- **ER helpers** (`packages/sdk/src/er.ts`): `sleep(ms)`, `erRpcTolerant(send)` (swallow ER confirm-flake), `retryPastDeadline(fn, label, tries?, intervalMs?)` (validator-clock lag), `l1Send(fn, tries?, baseMs?)` (pre-send 429 retry), `awaitOwnerIs(conn, pubkey, expectedOwner, tries?, intervalMs?)`, `awaitEr(fetchFn, pred, tries?, intervalMs?)`, `flushCommit(sig, erConnection)` (wraps `GetCommitmentSignature`).
- **Constants:** `PROGRAM_ID`, `RoundState` (enum), `GRID_SIZE` (25), `DLP_PROGRAM_ID`, `VRF_BASE_QUEUE`, `DEFAULT_ER_VALIDATOR`, `DEFAULT_ER_ENDPOINT` (`https://devnet-us.magicblock.app`), `DEFAULT_ER_WS_ENDPOINT`, `DEFAULT_ROUND_DURATION_SECS` (60).

### On-chain account layouts (verified in `programs/ansem-miner/src/state/*.rs`) — for `getProgramAccounts` memcmp
- **`MinerPosition`**: `authority: Pubkey`, `round_id: u64`, `block_stake: [u64;25]`, `bump: u8`.
  - Total data size = `8 (disc) + 32 + 8 + 25*8 + 1 = 249` bytes.
  - `round_id` at **offset 40** (`8 + 32`). `authority` at offset 8.
- **`PlayerEscrow`**: `authority`, `balance`, `deposited_total`, `withdrawn_total`, `last_claimed_round`, `active_round`, `reconciled_round`, `bump`.
  - Total data size = `8 + 32 + 8*6 + 1 = 89` bytes.
  - `active_round` at **offset 72** (`8 + 32 + 8*4`).
- **No events are emitted** by the program (`grep emit! → none`). The participant index is built from `getProgramAccounts`, not logs.

### Participant-index owner-state caveats (critical — do not skip)
- **Escrow is never delegated** — always L1-resident and program-owned. So the authoritative **joined roster** = `getProgramAccounts(PlayerEscrow, memcmp active_round@72 == roundId)` on **L1**. This roster drives **both** the `commit_miner` pass and the `reconcile_miner` pass (reconcile must run for every joined wallet — staked or not — to clear its withdraw-lock, per spec §7).
- **Round + Miner ARE delegated during OPEN** (owned by `DLP_PROGRAM_ID` on L1; live copies in the ER). Therefore: while a round is OPEN, read live per-square stakes from the **ER** program (`erProgram.account.round.fetch`), and a `getProgramAccounts` on our program for miners will **not** see delegated miners. Post-commit, miners are program-owned on L1 with `round_id == id`.
- `commit_miner` is idempotent + owner-gated by the ER: iterate the joined roster, attempt `commitMinerIx` per wallet's `minerPda`, skip on `CommitTooEarly` (retry) / already-committed (owner is program). This is exactly the `commitMinerThenRound` pattern in `tests/ansem-miner-devnet.ts:128-148`.

### Env (from `scripts/devnet-env.sh`; the keeper reads `process.env`)
`ANCHOR_PROVIDER_URL` (L1 RPC), `WS_ENDPOINT` (L1 ws), `EPHEMERAL_PROVIDER_ENDPOINT` (default `https://devnet-us.magicblock.app`), `EPHEMERAL_WS_ENDPOINT`, `VALIDATOR` (default `MUS3hc9TCw4cGC12vHNoYcCGzJG1txjgQLZWVoeNHNd`), `VRF_BASE_QUEUE`, `DEVNET_WALLET` (path to the keeper/admin keypair JSON = `config.admin`). Keeper-specific (new, with defaults): `KEEPER_ROUND_SECS` (60), `KEEPER_GRACE_SECS` (180), `KEEPER_POLL_MS` (4000), `KEEPER_HTTP_PORT` (8787).

### Workspace facts
- `pnpm-workspace.yaml` already globs `packages/*`, **`keeper`**, `app`. So the keeper package lives at **repo-root `keeper/`** (NOT `packages/keeper/`), package name `@ansem/keeper`.
- Cross-package dep on the SDK: `"@ansem/sdk": "workspace:*"`.
- ESM everywhere (`"type": "module"`); JSON imports use `with { type: "json" }`; `@coral-xyz/anchor` is CJS → use `import * as anchor` then `anchor.BN` (named `BN` import fails), while `Program`/`AnchorProvider`/`Wallet` named imports are fine.
- Turbo `test`/`typecheck`/`build` all `dependsOn: ["^build"]`, so the SDK must be built before the keeper's turbo tasks run. Direct `pnpm --filter @ansem/keeper test` also works once `@ansem/sdk` is built once (`pnpm --filter @ansem/sdk build`).

---

## File structure

```
keeper/
  package.json            # @ansem/keeper, ESM, workspace dep on @ansem/sdk; deps ws, bs58; dev tsx, vitest
  tsconfig.json           # ESNext/Bundler, strict, src → dist
  vitest.config.ts        # node env, test/**/*.test.ts
  README.md               # how to run against devnet + the M4a verify command
  src/
    env.ts                # loadKeeperConfig(env, loadKeypair) → KeeperConfig  (PURE except injected loader)
    logger.ts             # structured line logger (level, msg, fields)
    chain.ts              # buildChain(cfg) → { conn, erConn, wallet, program, erProgram }  (I/O wiring)
    participants.ts       # memcmp offsets + pure decoders + fetchJoinedWallets / fetchStakerMiners (I/O)
    crank/
      decide.ts           # decideAction(state) → CrankAction  (PURE — the state machine, the heart)
      actions.ts          # executeAction(action, ctx)  (I/O — SDK builders + ER helpers)
      loop.ts             # runCrankTick(deps) — fetch → decide → act; grace-clock tracking
    read/
      snapshot.ts         # buildFullSnapshot(round, config, miners, events, now) → FullSnapshot  (PURE)
      events.ts           # diffEvents(prev, next) → KeeperEvent[]  (PURE)
      server.ts           # startReadServer(port, getSnapshot) → ReadServer  (ws + REST, I/O)
    service.ts            # createService(cfg, deps) — wires loop + read server + poll timer
    main.ts               # CLI entry: loadKeeperConfig(process.env, fsLoadKeypair) → createService().start()
  test/
    env.test.ts
    decide.test.ts
    participants.test.ts
    snapshot.test.ts
    events.test.ts
    server.test.ts
    service.test.ts
    devnet-round.it.ts    # gated by KEEPER_DEVNET_IT=1 — one full headless round on devnet (M4a verify)
```

---

## Task 1: Keeper package scaffold + workspace wiring

**Files:**
- Create: `keeper/package.json`, `keeper/tsconfig.json`, `keeper/vitest.config.ts`, `keeper/src/index.ts`
- Test: `keeper/test/smoke.test.ts`

- [ ] **Step 1: Write the failing test**

`keeper/test/smoke.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { KEEPER_NAME } from "../src/index.js";

describe("keeper scaffold", () => {
  it("exports a package identity", () => {
    expect(KEEPER_NAME).toBe("@ansem/keeper");
  });
});
```

- [ ] **Step 2: Create the package files**

`keeper/package.json`:
```json
{
  "name": "@ansem/keeper",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "dev": "tsx src/main.ts",
    "start": "node dist/main.js"
  },
  "dependencies": {
    "@ansem/sdk": "workspace:*",
    "@coral-xyz/anchor": "^0.32.1",
    "@solana/web3.js": "^1.95.0",
    "bs58": "^5.0.0",
    "ws": "^8.18.0"
  },
  "devDependencies": {
    "typescript": "^5.4.2",
    "vitest": "^2.1.0",
    "tsx": "^4.19.0",
    "@types/node": "^20.11.0",
    "@types/ws": "^8.5.10"
  }
}
```

`keeper/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "declaration": true,
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src"]
}
```

`keeper/vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { environment: "node", include: ["test/**/*.test.ts"] } });
```

`keeper/src/index.ts`:
```ts
export const KEEPER_NAME = "@ansem/keeper";
```

- [ ] **Step 3: Install + build the SDK dependency once, then run the test**

Run:
```bash
pnpm install
pnpm --filter @ansem/sdk build
pnpm --filter @ansem/keeper test
```
Expected: `pnpm install` links `@ansem/sdk` into `keeper/node_modules`; SDK build emits `packages/sdk/dist`; the smoke test PASSES (1 passed).

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @ansem/keeper typecheck`
Expected: exit 0, no errors.

- [ ] **Step 5: Commit**

```bash
git add keeper/ pnpm-lock.yaml
git commit -m "feat(keeper): scaffold @ansem/keeper package (workspace dep on @ansem/sdk)"
```

---

## Task 2: Env / config loader (`env.ts`)

**Files:**
- Create: `keeper/src/env.ts`
- Test: `keeper/test/env.test.ts`

Keypair loading is injected so the loader is pure/testable (no fs in tests).

- [ ] **Step 1: Write the failing test**

`keeper/test/env.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { Keypair } from "@solana/web3.js";
import { loadKeeperConfig } from "../src/env.js";

const kp = Keypair.generate();
const fakeLoad = (_path: string) => kp;

const baseEnv = {
  ANCHOR_PROVIDER_URL: "https://rpc.example",
  WS_ENDPOINT: "wss://rpc.example",
  DEVNET_WALLET: "/tmp/kp.json",
};

describe("loadKeeperConfig", () => {
  it("fills defaults for optional fields", () => {
    const cfg = loadKeeperConfig(baseEnv as any, fakeLoad);
    expect(cfg.rpcUrl).toBe("https://rpc.example");
    expect(cfg.erEndpoint).toBe("https://devnet-us.magicblock.app");
    expect(cfg.validator.toBase58()).toBe("MUS3hc9TCw4cGC12vHNoYcCGzJG1txjgQLZWVoeNHNd");
    expect(cfg.roundDurationSecs).toBe(60);
    expect(cfg.graceSecs).toBe(180);
    expect(cfg.pollMs).toBe(4000);
    expect(cfg.httpPort).toBe(8787);
    expect(cfg.adminKeypair.publicKey.equals(kp.publicKey)).toBe(true);
  });

  it("honors overrides", () => {
    const cfg = loadKeeperConfig(
      { ...baseEnv, KEEPER_ROUND_SECS: "30", KEEPER_HTTP_PORT: "9000", VALIDATOR: "MUS3hc9TCw4cGC12vHNoYcCGzJG1txjgQLZWVoeNHNd" } as any,
      fakeLoad,
    );
    expect(cfg.roundDurationSecs).toBe(30);
    expect(cfg.httpPort).toBe(9000);
  });

  it("throws when a required var is missing", () => {
    expect(() => loadKeeperConfig({ WS_ENDPOINT: "x", DEVNET_WALLET: "y" } as any, fakeLoad))
      .toThrow(/ANCHOR_PROVIDER_URL/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ansem/keeper test env`
Expected: FAIL — `Cannot find module '../src/env.js'`.

- [ ] **Step 3: Implement `env.ts`**

```ts
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  DEFAULT_ER_ENDPOINT, DEFAULT_ER_WS_ENDPOINT, DEFAULT_ER_VALIDATOR, VRF_BASE_QUEUE,
} from "@ansem/sdk";

export interface KeeperConfig {
  rpcUrl: string;
  wsUrl: string;
  erEndpoint: string;
  erWsEndpoint: string;
  validator: PublicKey;
  vrfQueue: PublicKey;
  adminKeypair: Keypair;
  roundDurationSecs: number;
  graceSecs: number;
  pollMs: number;
  httpPort: number;
}

const req = (env: NodeJS.ProcessEnv, key: string): string => {
  const v = env[key];
  if (!v) throw new Error(`missing required env var: ${key}`);
  return v;
};
const num = (env: NodeJS.ProcessEnv, key: string, dflt: number): number => {
  const v = env[key];
  return v === undefined ? dflt : Number(v);
};

export function loadKeeperConfig(
  env: NodeJS.ProcessEnv,
  loadKeypair: (path: string) => Keypair,
): KeeperConfig {
  return {
    rpcUrl: req(env, "ANCHOR_PROVIDER_URL"),
    wsUrl: env.WS_ENDPOINT || req(env, "ANCHOR_PROVIDER_URL").replace(/^http/, "ws"),
    erEndpoint: env.EPHEMERAL_PROVIDER_ENDPOINT || DEFAULT_ER_ENDPOINT,
    erWsEndpoint: env.EPHEMERAL_WS_ENDPOINT || DEFAULT_ER_WS_ENDPOINT,
    validator: new PublicKey(env.VALIDATOR || DEFAULT_ER_VALIDATOR),
    vrfQueue: new PublicKey(env.VRF_BASE_QUEUE || VRF_BASE_QUEUE),
    adminKeypair: loadKeypair(req(env, "DEVNET_WALLET")),
    roundDurationSecs: num(env, "KEEPER_ROUND_SECS", 60),
    graceSecs: num(env, "KEEPER_GRACE_SECS", 180),
    pollMs: num(env, "KEEPER_POLL_MS", 4000),
    httpPort: num(env, "KEEPER_HTTP_PORT", 8787),
  };
}

/** Real keypair loader (fs) — used by main.ts, never by unit tests. */
export function fsLoadKeypair(path: string): Keypair {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require("node:fs");
  const raw = JSON.parse(fs.readFileSync(path, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}
```
> Note: `DEFAULT_ER_VALIDATOR` and `VRF_BASE_QUEUE` are `PublicKey` in the SDK; `new PublicKey(pk)` accepts a `PublicKey`, so the fallbacks type-check.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @ansem/keeper test env`
Expected: PASS (3 passed).

- [ ] **Step 5: Commit**

```bash
git add keeper/src/env.ts keeper/test/env.test.ts
git commit -m "feat(keeper): env/config loader with injected keypair loader"
```

---

## Task 3: Structured logger (`logger.ts`)

**Files:**
- Create: `keeper/src/logger.ts`
- Test: `keeper/test/logger.test.ts` (folded into `env.test.ts` is fine; keep separate for clarity)

- [ ] **Step 1: Write the failing test**

`keeper/test/logger.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { makeLogger } from "../src/logger.js";

describe("makeLogger", () => {
  it("emits a single JSON line with level, msg, and fields", () => {
    const lines: string[] = [];
    const log = makeLogger((l) => lines.push(l), () => 1720000000000);
    log.info("round opened", { roundId: 42 });
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.level).toBe("info");
    expect(parsed.msg).toBe("round opened");
    expect(parsed.roundId).toBe(42);
    expect(parsed.t).toBe(1720000000000);
  });

  it("serializes bigint fields as strings", () => {
    const lines: string[] = [];
    const log = makeLogger((l) => lines.push(l), () => 0);
    log.warn("pot", { pot: 123n });
    expect(JSON.parse(lines[0]).pot).toBe("123");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ansem/keeper test logger`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `logger.ts`**

```ts
export type LogLevel = "info" | "warn" | "error";
export interface Logger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

const jsonSafe = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);

export function makeLogger(
  sink: (line: string) => void = (l) => console.log(l),
  now: () => number = () => Date.now(),
): Logger {
  const emit = (level: LogLevel, msg: string, fields?: Record<string, unknown>) =>
    sink(JSON.stringify({ t: now(), level, msg, ...fields }, jsonSafe));
  return {
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @ansem/keeper test logger`
Expected: PASS (2 passed).

- [ ] **Step 5: Commit**

```bash
git add keeper/src/logger.ts keeper/test/logger.test.ts
git commit -m "feat(keeper): structured JSON line logger (bigint-safe)"
```

---

## Task 4: Crank state machine (`crank/decide.ts`) — the heart

**Files:**
- Create: `keeper/src/crank/decide.ts`
- Test: `keeper/test/decide.test.ts`

Pure function: given the observed chain state, return the single next action. No I/O.

- [ ] **Step 1: Write the failing test**

`keeper/test/decide.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { RoundState } from "@ansem/sdk";
import { decideAction, CrankAction, CrankState } from "../src/crank/decide.js";

const base: CrankState = {
  finalized: true,
  currentRoundId: 100,
  round: null,
  nowSec: 1000,
  vrfPendingSinceSec: null,
  graceSecs: 180,
};

describe("decideAction", () => {
  it("creates a round when finalized and none in flight", () => {
    expect(decideAction(base)).toBe(CrankAction.CreateRound);
  });

  it("creates a round when the current round is CLAIMABLE (finalized)", () => {
    expect(decideAction({ ...base, round: { state: RoundState.Claimable, deadlineTs: 0, roundId: 100 } }))
      .toBe(CrankAction.CreateRound);
  });

  it("creates a round when the current round is CLOSED", () => {
    expect(decideAction({ ...base, finalized: false, round: { state: RoundState.Closed, deadlineTs: 0, roundId: 100 } }))
      .toBe(CrankAction.CreateRound);
  });

  it("is idle while OPEN before the deadline", () => {
    expect(decideAction({ ...base, finalized: false, round: { state: RoundState.Open, deadlineTs: 2000, roundId: 100 } }))
      .toBe(CrankAction.Idle);
  });

  it("settles once OPEN passes the deadline", () => {
    expect(decideAction({ ...base, finalized: false, round: { state: RoundState.Open, deadlineTs: 999, roundId: 100 } }))
      .toBe(CrankAction.Settle);
  });

  it("awaits the oracle while VRF_PENDING within grace", () => {
    expect(decideAction({ ...base, finalized: false, vrfPendingSinceSec: 950,
      round: { state: RoundState.VrfPending, deadlineTs: 0, roundId: 100 } }))
      .toBe(CrankAction.AwaitOracle);
  });

  it("cancels a VRF_PENDING round that blew past the grace window", () => {
    expect(decideAction({ ...base, finalized: false, nowSec: 2000, vrfPendingSinceSec: 950,
      round: { state: RoundState.VrfPending, deadlineTs: 0, roundId: 100 } }))
      .toBe(CrankAction.Cancel);
  });

  it("finalizes a SETTLED round (commit → reconcile → swap)", () => {
    expect(decideAction({ ...base, finalized: false, round: { state: RoundState.Settled, deadlineTs: 0, roundId: 100 } }))
      .toBe(CrankAction.Finalize);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ansem/keeper test decide`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `crank/decide.ts`**

```ts
import { RoundState } from "@ansem/sdk";

export enum CrankAction {
  Idle = "idle",
  CreateRound = "create_round",
  Settle = "settle",
  AwaitOracle = "await_oracle",
  Finalize = "finalize",
  Cancel = "cancel",
}

export interface CrankRoundView {
  state: RoundState;
  deadlineTs: number;
  roundId: number;
}

export interface CrankState {
  finalized: boolean;              // config.current_round_finalized
  currentRoundId: number;          // config.current_round_id
  round: CrankRoundView | null;    // null when the current round PDA is absent
  nowSec: number;                  // wall-clock seconds
  vrfPendingSinceSec: number | null; // when the loop first observed VRF_PENDING
  graceSecs: number;               // oracle grace window before cancel
}

/** The single next action for the crank. Pure; the loop supplies observed state. */
export function decideAction(s: CrankState): CrankAction {
  // No round in flight, or the current one is terminal → open the next round.
  if (s.finalized || s.round === null) return CrankAction.CreateRound;

  switch (s.round.state) {
    case RoundState.Claimable:
    case RoundState.Closed:
      return CrankAction.CreateRound;

    case RoundState.Open:
      return s.nowSec < s.round.deadlineTs ? CrankAction.Idle : CrankAction.Settle;

    case RoundState.VrfPending: {
      const waited = s.vrfPendingSinceSec === null ? 0 : s.nowSec - s.vrfPendingSinceSec;
      return waited > s.graceSecs ? CrankAction.Cancel : CrankAction.AwaitOracle;
    }

    case RoundState.Settled:
      return CrankAction.Finalize;

    default: // Swapping (reserved/unused in mock) — nothing safe to do; wait.
      return CrankAction.Idle;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @ansem/keeper test decide`
Expected: PASS (8 passed).

- [ ] **Step 5: Commit**

```bash
git add keeper/src/crank/decide.ts keeper/test/decide.test.ts
git commit -m "feat(keeper): pure crank state machine (decideAction)"
```

---

## Task 5: Participant index (`participants.ts`)

**Files:**
- Create: `keeper/src/participants.ts`
- Test: `keeper/test/participants.test.ts`

Pure offset/decoder helpers get real tests against a hand-built buffer; the `getProgramAccounts` wrappers are thin I/O over the pure parts.

- [ ] **Step 1: Write the failing test**

`keeper/test/participants.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { Keypair } from "@solana/web3.js";
import {
  MINER_ROUND_ID_OFFSET, ESCROW_ACTIVE_ROUND_OFFSET, MINER_ACCOUNT_SIZE, ESCROW_ACCOUNT_SIZE,
  u64LEBytes, decodeMinerAuthority, decodeEscrowAuthority,
} from "../src/participants.js";

describe("participant index layout constants", () => {
  it("locks the memcmp offsets to the on-chain layout", () => {
    expect(MINER_ROUND_ID_OFFSET).toBe(40);       // 8 disc + 32 authority
    expect(ESCROW_ACTIVE_ROUND_OFFSET).toBe(72);  // 8 + 32 + 8*4
    expect(MINER_ACCOUNT_SIZE).toBe(249);         // 8 + 32 + 8 + 25*8 + 1
    expect(ESCROW_ACCOUNT_SIZE).toBe(89);         // 8 + 32 + 8*6 + 1
  });

  it("encodes a u64 round id little-endian for memcmp", () => {
    expect([...u64LEBytes(1)]).toEqual([1, 0, 0, 0, 0, 0, 0, 0]);
    expect([...u64LEBytes(256)]).toEqual([0, 1, 0, 0, 0, 0, 0, 0]);
  });

  it("decodes the authority pubkey from a raw miner account", () => {
    const kp = Keypair.generate();
    const data = Buffer.alloc(MINER_ACCOUNT_SIZE);
    kp.publicKey.toBuffer().copy(data, 8); // authority at offset 8
    expect(decodeMinerAuthority(data).equals(kp.publicKey)).toBe(true);
  });

  it("decodes the authority pubkey from a raw escrow account", () => {
    const kp = Keypair.generate();
    const data = Buffer.alloc(ESCROW_ACCOUNT_SIZE);
    kp.publicKey.toBuffer().copy(data, 8);
    expect(decodeEscrowAuthority(data).equals(kp.publicKey)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ansem/keeper test participants`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `participants.ts`**

```ts
import { Connection, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { PROGRAM_ID } from "@ansem/sdk";

// Offsets/sizes are locked to programs/ansem-miner/src/state/{miner,escrow}.rs.
export const MINER_ROUND_ID_OFFSET = 40;       // 8 disc + 32 authority
export const ESCROW_ACTIVE_ROUND_OFFSET = 72;  // 8 + 32 + 8 (balance) + 8 + 8 + 8
export const MINER_ACCOUNT_SIZE = 249;         // 8 + 32 + 8 + 25*8 + 1
export const ESCROW_ACCOUNT_SIZE = 89;         // 8 + 32 + 8*6 + 1

const AUTHORITY_OFFSET = 8; // both accounts: pubkey immediately after the discriminator

export function u64LEBytes(n: number | bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(n));
  return buf;
}
export const decodeMinerAuthority = (data: Buffer): PublicKey =>
  new PublicKey(data.subarray(AUTHORITY_OFFSET, AUTHORITY_OFFSET + 32));
export const decodeEscrowAuthority = (data: Buffer): PublicKey =>
  new PublicKey(data.subarray(AUTHORITY_OFFSET, AUTHORITY_OFFSET + 32));

/**
 * Authoritative joined roster: escrow is never delegated, so this returns every
 * wallet with escrow.active_round == roundId on L1. Drives BOTH the commit_miner
 * and the reconcile_miner passes (reconcile clears the withdraw-lock for joined-
 * but-unstaked wallets too — spec §7).
 */
export async function fetchJoinedWallets(conn: Connection, roundId: number): Promise<PublicKey[]> {
  const accts = await conn.getProgramAccounts(PROGRAM_ID, {
    filters: [
      { dataSize: ESCROW_ACCOUNT_SIZE },
      { memcmp: { offset: ESCROW_ACTIVE_ROUND_OFFSET, bytes: bs58.encode(u64LEBytes(roundId)) } },
    ],
  });
  return accts.map((a) => decodeEscrowAuthority(a.account.data as Buffer));
}

/**
 * Program-owned (post-commit) miner PDAs for a round. Returns [] while the round
 * is OPEN (miners still delegated to the DLP). Used for the reconcile pass and
 * the leaderboard once accounts are back on L1.
 */
export async function fetchStakerWallets(conn: Connection, roundId: number): Promise<PublicKey[]> {
  const accts = await conn.getProgramAccounts(PROGRAM_ID, {
    filters: [
      { dataSize: MINER_ACCOUNT_SIZE },
      { memcmp: { offset: MINER_ROUND_ID_OFFSET, bytes: bs58.encode(u64LEBytes(roundId)) } },
    ],
  });
  return accts.map((a) => decodeMinerAuthority(a.account.data as Buffer));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @ansem/keeper test participants`
Expected: PASS (4 passed).

- [ ] **Step 5: Commit**

```bash
git add keeper/src/participants.ts keeper/test/participants.test.ts
git commit -m "feat(keeper): participant index (memcmp offsets + joined/staker rosters)"
```

---

## Task 6: Snapshot builder (`read/snapshot.ts`)

**Files:**
- Create: `keeper/src/read/snapshot.ts`
- Test: `keeper/test/snapshot.test.ts`

Pure: compose the SDK `BoardSnapshot` + a leaderboard from decoded miners + recent events.

- [ ] **Step 1: Write the failing test**

`keeper/test/snapshot.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { RoundState } from "@ansem/sdk";
import { buildFullSnapshot, MinerRow } from "../src/read/snapshot.js";
import type { KeeperEvent } from "../src/read/events.js";

const grid = (over: Record<number, bigint> = {}) =>
  Array.from({ length: 25 }, (_, i) => over[i] ?? 0n);

const round = {
  roundId: 100, deadlineTs: 5000, blockSol: grid({ 3: 10n, 7: 5n }), pot: 15n,
  state: RoundState.Open, randomness: new Array(32).fill(0), jackpotSquare: 0,
  jackpotPool: 0n, swapProceeds: 0n,
};
const config = {
  admin: "A", ansemMint: "M", swapMode: 0, currentRoundId: 100, roundDurationSecs: 60,
  feeBps: 0, multMinBps: 5000, multMaxBps: 5000, minStake: 0n, maxStakePerRound: 0n,
  mockRate: 1n, totalEscrowBalance: 100n, rolloverJackpot: 4n, currentRoundFinalized: false,
};

describe("buildFullSnapshot", () => {
  it("wraps the SDK BoardSnapshot and appends a stake-sorted leaderboard", () => {
    const miners: MinerRow[] = [
      { wallet: "alice", blockStake: grid({ 3: 8n }) },
      { wallet: "bob", blockStake: grid({ 3: 2n, 7: 5n }) },
    ];
    const events: KeeperEvent[] = [{ type: "round.open", roundId: 100, deadlineTs: 5000 }];
    const snap = buildFullSnapshot(round as any, config as any, miners, events, 999);

    expect(snap.roundId).toBe(100);
    expect(snap.state).toBe(RoundState.Open);
    expect(snap.pot).toBe(15n);
    expect(snap.blockSol[3]).toBe(10n);
    expect(snap.jackpotSquare).toBeNull(); // hidden pre-settle
    expect(snap.updatedAt).toBe(999);
    // bob has 7 total, alice 8 → alice first
    expect(snap.leaderboard.map((r) => r.wallet)).toEqual(["alice", "bob"]);
    expect(snap.leaderboard[0].totalStake).toBe(8n);
    expect(snap.recentEvents).toHaveLength(1);
  });

  it("reveals the jackpot square once settled", () => {
    const settled = { ...round, state: RoundState.Settled, jackpotSquare: 7 };
    const snap = buildFullSnapshot(settled as any, config as any, [], [], 1);
    expect(snap.jackpotSquare).toBe(7);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ansem/keeper test snapshot`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `read/snapshot.ts`**

```ts
import { toBoardSnapshot, BoardSnapshot, RoundStateData, ConfigState } from "@ansem/sdk";
import type { KeeperEvent } from "./events.js";

export interface MinerRow { wallet: string; blockStake: bigint[]; }
export interface LeaderRow { wallet: string; totalStake: bigint; squares: number[]; }

export interface FullSnapshot extends BoardSnapshot {
  leaderboard: LeaderRow[];
  recentEvents: KeeperEvent[];
}

const sum = (xs: bigint[]): bigint => xs.reduce((a, b) => a + b, 0n);

export function buildFullSnapshot(
  round: RoundStateData,
  config: ConfigState,
  miners: MinerRow[],
  recentEvents: KeeperEvent[],
  updatedAt: number,
): FullSnapshot {
  const board = toBoardSnapshot(round, config, updatedAt);
  const leaderboard: LeaderRow[] = miners
    .map((m) => ({
      wallet: m.wallet,
      totalStake: sum(m.blockStake),
      squares: m.blockStake.flatMap((v, i) => (v > 0n ? [i] : [])),
    }))
    .filter((r) => r.totalStake > 0n)
    .sort((a, b) => (b.totalStake > a.totalStake ? 1 : b.totalStake < a.totalStake ? -1 : 0));
  return { ...board, leaderboard, recentEvents };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @ansem/keeper test snapshot`
Expected: PASS (2 passed).

- [ ] **Step 5: Commit**

```bash
git add keeper/src/read/snapshot.ts keeper/test/snapshot.test.ts
git commit -m "feat(keeper): pure BoardSnapshot builder with leaderboard"
```

---

## Task 7: Event diffing (`read/events.ts`)

**Files:**
- Create: `keeper/src/read/events.ts`
- Test: `keeper/test/events.test.ts`

Pure: derive typed events from the transition between two board snapshots.

- [ ] **Step 1: Write the failing test**

`keeper/test/events.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { RoundState } from "@ansem/sdk";
import { diffEvents } from "../src/read/events.js";
import type { BoardSnapshot } from "@ansem/sdk";

const grid = (over: Record<number, bigint> = {}) =>
  Array.from({ length: 25 }, (_, i) => over[i] ?? 0n);

const snap = (over: Partial<BoardSnapshot>): BoardSnapshot => ({
  roundId: 100, state: RoundState.Open, deadlineTs: 5000, pot: 0n, blockSol: grid(),
  jackpotSquare: null, jackpotPool: 0n, rolloverJackpot: 0n, updatedAt: 0, ...over,
});

describe("diffEvents", () => {
  it("emits round.open for a brand-new open round", () => {
    const ev = diffEvents(null, snap({}));
    expect(ev).toEqual([{ type: "round.open", roundId: 100, deadlineTs: 5000 }]);
  });

  it("emits round.open when the round id advances", () => {
    const ev = diffEvents(snap({ roundId: 100 }), snap({ roundId: 101 }));
    expect(ev.some((e) => e.type === "round.open" && e.roundId === 101)).toBe(true);
  });

  it("emits a stake event when a square's stake grows", () => {
    const ev = diffEvents(snap({ blockSol: grid({ 3: 2n }) }), snap({ blockSol: grid({ 3: 9n }), pot: 9n }));
    expect(ev).toContainEqual({ type: "stake", roundId: 100, square: 3, totalStake: "9" });
  });

  it("emits round.settling on Open→VrfPending", () => {
    const ev = diffEvents(snap({}), snap({ state: RoundState.VrfPending }));
    expect(ev).toContainEqual({ type: "round.settling", roundId: 100 });
  });

  it("emits round.revealed on →Settled with the jackpot square", () => {
    const ev = diffEvents(snap({ state: RoundState.VrfPending }),
      snap({ state: RoundState.Settled, jackpotSquare: 7 }));
    expect(ev).toContainEqual({ type: "round.revealed", roundId: 100, jackpotSquare: 7 });
  });

  it("emits round.claimable on →Claimable", () => {
    const ev = diffEvents(snap({ state: RoundState.Settled }), snap({ state: RoundState.Claimable }));
    expect(ev).toContainEqual({ type: "round.claimable", roundId: 100 });
  });

  it("emits nothing on an identical snapshot", () => {
    const s = snap({ blockSol: grid({ 1: 1n }) });
    expect(diffEvents(s, s)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ansem/keeper test events`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `read/events.ts`**

```ts
import { RoundState, BoardSnapshot } from "@ansem/sdk";

export type KeeperEvent =
  | { type: "round.open"; roundId: number; deadlineTs: number }
  | { type: "stake"; roundId: number; square: number; totalStake: string }
  | { type: "round.settling"; roundId: number }
  | { type: "round.revealed"; roundId: number; jackpotSquare: number }
  | { type: "round.claimable"; roundId: number };

/** Typed events for the transition prev → next. `prev = null` on cold start. */
export function diffEvents(prev: BoardSnapshot | null, next: BoardSnapshot): KeeperEvent[] {
  const out: KeeperEvent[] = [];

  // New round (cold start or id advanced) that is currently open.
  if ((!prev || next.roundId !== prev.roundId) && next.state === RoundState.Open) {
    out.push({ type: "round.open", roundId: next.roundId, deadlineTs: next.deadlineTs });
  }

  if (prev && next.roundId === prev.roundId) {
    // Per-square stake increases.
    for (let i = 0; i < next.blockSol.length; i++) {
      if (next.blockSol[i] > (prev.blockSol[i] ?? 0n)) {
        out.push({ type: "stake", roundId: next.roundId, square: i, totalStake: next.blockSol[i].toString() });
      }
    }
    // State transitions.
    if (prev.state === RoundState.Open && next.state === RoundState.VrfPending) {
      out.push({ type: "round.settling", roundId: next.roundId });
    }
    if (prev.state < RoundState.Settled && next.state === RoundState.Settled && next.jackpotSquare !== null) {
      out.push({ type: "round.revealed", roundId: next.roundId, jackpotSquare: next.jackpotSquare });
    }
    if (prev.state !== RoundState.Claimable && next.state === RoundState.Claimable) {
      out.push({ type: "round.claimable", roundId: next.roundId });
    }
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @ansem/keeper test events`
Expected: PASS (7 passed).

- [ ] **Step 5: Commit**

```bash
git add keeper/src/read/events.ts keeper/test/events.test.ts
git commit -m "feat(keeper): pure event diffing over board snapshots"
```

---

## Task 8: Crank actions (`crank/actions.ts`)

**Files:**
- Create: `keeper/src/crank/actions.ts`
- Test: `keeper/test/actions.test.ts`

The impure executors. To keep them unit-testable without a validator, each executor takes an `ActionCtx` of small injected callables (the SDK builders wrapped as `() => Promise`), so a test asserts the **right calls happen in the right order**. The devnet integration test (Task 11) is the real end-to-end proof.

- [ ] **Step 1: Write the failing test**

`keeper/test/actions.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { finalizeRound, FinalizeDeps } from "../src/crank/actions.js";

const wallet = (s: string) => PublicKey.unique();

describe("finalizeRound", () => {
  it("commits every joined miner, then the round, then reconciles all, then swaps — in order", async () => {
    const calls: string[] = [];
    const joined = [wallet("a"), wallet("b")];
    const deps: FinalizeDeps = {
      joinedWallets: async () => joined,
      commitMiner: async (w) => { calls.push(`commit:${joined.indexOf(w)}`); },
      commitRound: async () => { calls.push("commitRound"); },
      reconcileMiner: async (w) => { calls.push(`reconcile:${joined.indexOf(w)}`); },
      executeSwap: async () => { calls.push("swap"); },
    };
    await finalizeRound(100, deps);

    // Both commits precede commitRound; both reconciles precede swap; swap last.
    expect(calls.indexOf("commit:0")).toBeLessThan(calls.indexOf("commitRound"));
    expect(calls.indexOf("commit:1")).toBeLessThan(calls.indexOf("commitRound"));
    expect(calls.indexOf("commitRound")).toBeLessThan(calls.indexOf("reconcile:0"));
    expect(calls.indexOf("reconcile:0")).toBeLessThan(calls.indexOf("swap"));
    expect(calls.indexOf("reconcile:1")).toBeLessThan(calls.indexOf("swap"));
    expect(calls[calls.length - 1]).toBe("swap");
  });

  it("continues reconciling even if one miner commit throws (idempotent/self-healing)", async () => {
    const joined = [wallet("a"), wallet("b")];
    const reconciled: number[] = [];
    const deps: FinalizeDeps = {
      joinedWallets: async () => joined,
      commitMiner: async (w) => { if (joined.indexOf(w) === 0) throw new Error("CommitTooEarly"); },
      commitRound: async () => {},
      reconcileMiner: async (w) => { reconciled.push(joined.indexOf(w)); },
      executeSwap: async () => {},
    };
    await finalizeRound(100, deps);
    expect(reconciled).toEqual([0, 1]); // both still reconciled
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ansem/keeper test actions`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `crank/actions.ts`**

The finalize executor is the coordination core (ordering + resilience). The other actions (`createAndDelegate`, `settle`, `cancel`) are thin wrappers over the SDK builders; include them here so `executeAction` in the loop can dispatch. The devnet IT exercises their real on-chain behavior.

```ts
import { Connection, PublicKey } from "@solana/web3.js";
import { Program } from "@coral-xyz/anchor";
import * as anchor from "@coral-xyz/anchor";
import {
  AnsemMiner, configPda, roundPda, minerPda, escrowPda, payoutVault,
  createRoundIx, delegateRoundIx, requestSettleIx, commitRoundIx, commitMinerIx,
  reconcileMinerIx, executeSwapMockIx, cancelRoundIx,
  erRpcTolerant, retryPastDeadline, l1Send, awaitOwnerIs, flushCommit, sleep,
  DLP_PROGRAM_ID, PROGRAM_ID,
} from "@ansem/sdk";
import type { Logger } from "../logger.js";
import { fetchJoinedWallets } from "../participants.js";

/** Small injected surface so finalize's ordering/resilience is unit-testable. */
export interface FinalizeDeps {
  joinedWallets: () => Promise<PublicKey[]>;
  commitMiner: (wallet: PublicKey) => Promise<void>; // ER; may throw (retried/idempotent upstream)
  commitRound: () => Promise<void>;
  reconcileMiner: (wallet: PublicKey) => Promise<void>;
  executeSwap: () => Promise<void>;
}

/**
 * SETTLED → CLAIMABLE. Commit every joined miner (while still delegated) THEN the
 * round; then reconcile every joined wallet (staked or not — clears the lock) and
 * swap. Commit failures are swallowed per-miner (idempotent; a stale/early commit
 * self-heals on the next tick); reconcile+swap must still run.
 */
export async function finalizeRound(roundId: number, deps: FinalizeDeps): Promise<void> {
  const joined = await deps.joinedWallets();
  for (const w of joined) {
    try { await deps.commitMiner(w); } catch { /* idempotent: retry next tick / already committed */ }
  }
  await deps.commitRound();
  for (const w of joined) {
    await deps.reconcileMiner(w); // reconcile is idempotent (reconciled_round guard)
  }
  await deps.executeSwap();
}

/** Wire the real SDK/ER calls into FinalizeDeps for the live loop. */
export function liveFinalizeDeps(ctx: ActionCtx, roundId: number): FinalizeDeps {
  const rpda = roundPda(roundId);
  return {
    joinedWallets: () => fetchJoinedWallets(ctx.conn, roundId),
    commitMiner: async (w) => {
      const mpda = minerPda(w);
      const info = await ctx.conn.getAccountInfo(mpda, "confirmed").catch(() => null);
      if (info && info.owner.toBase58() === PROGRAM_ID.toBase58()) return; // already on L1
      const sig = await commitMinerIx(ctx.erProgram, ctx.keeper, mpda, rpda)
        .rpc({ skipPreflight: true, commitment: "confirmed" });
      await flushCommit(sig, ctx.erConn);
    },
    commitRound: async () => {
      await erRpcTolerant(() => commitRoundIx(ctx.erProgram, ctx.keeper, roundId)
        .rpc({ skipPreflight: true, commitment: "confirmed" }));
      await awaitOwnerIs(ctx.conn, rpda, PROGRAM_ID.toBase58());
    },
    reconcileMiner: async (w) =>
      l1Send(() => reconcileMinerIx(ctx.program, roundId, escrowPda(w), minerPda(w)).rpc()),
    executeSwap: async () =>
      l1Send(() => executeSwapMockIx(ctx.program, ctx.keeper, roundId).rpc()),
  };
}

export interface ActionCtx {
  conn: Connection;
  erConn: Connection;
  program: Program<AnsemMiner>;
  erProgram: Program<AnsemMiner>;
  keeper: PublicKey;
  validator: PublicKey;
  vrfQueue: PublicKey;
  roundDurationSecs: number;
  log: Logger;
}

/** finalized/terminal → open + delegate the next round (id = current + 1). */
export async function createAndDelegate(ctx: ActionCtx, nextRoundId: number): Promise<void> {
  await l1Send(() => createRoundIx(ctx.program, ctx.keeper, nextRoundId).rpc());
  await l1Send(() => delegateRoundIx(ctx.program, ctx.keeper, nextRoundId, ctx.validator)
    .rpc({ skipPreflight: true, commitment: "confirmed" }));
  await awaitOwnerIs(ctx.conn, roundPda(nextRoundId), DLP_PROGRAM_ID.toBase58());
  ctx.log.info("round opened + delegated", { roundId: nextRoundId });
}

/** OPEN past deadline → request VRF settle; retry through clock-lag until it leaves OPEN. */
export async function requestSettle(ctx: ActionCtx, roundId: number): Promise<void> {
  await retryPastDeadline(
    () => requestSettleIx(ctx.program, ctx.keeper, roundId, 7, ctx.vrfQueue).rpc({ commitment: "confirmed" }),
    `request_settle round ${roundId}`,
  );
  ctx.log.info("request_settle posted", { roundId });
}

/** Grace exceeded / stranded → cancel (past-deadline gated); players refund off-loop. */
export async function cancelRound(ctx: ActionCtx, roundId: number): Promise<void> {
  await retryPastDeadline(
    () => cancelRoundIx(ctx.program, ctx.keeper, roundId).rpc(),
    `cancel round ${roundId}`,
  );
  ctx.log.warn("round cancelled (grace exceeded / stranded)", { roundId });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @ansem/keeper test actions`
Expected: PASS (2 passed).

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @ansem/keeper typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add keeper/src/crank/actions.ts keeper/test/actions.test.ts
git commit -m "feat(keeper): crank action executors (finalize ordering + create/settle/cancel)"
```

---

## Task 9: Read server (`read/server.ts`)

**Files:**
- Create: `keeper/src/read/server.ts`
- Test: `keeper/test/server.test.ts`

WebSocket (via `ws`) + a tiny REST surface over Node `http`. Tested fully in-process (ephemeral port, a real ws client) — no devnet.

- [ ] **Step 1: Write the failing test**

`keeper/test/server.test.ts`:
```ts
import { describe, it, expect, afterEach } from "vitest";
import { WebSocket } from "ws";
import { RoundState } from "@ansem/sdk";
import { startReadServer, ReadServer } from "../src/read/server.js";
import type { FullSnapshot } from "../src/read/snapshot.js";

const grid = () => Array.from({ length: 25 }, () => 0n);
const snap = (roundId: number): FullSnapshot => ({
  roundId, state: RoundState.Open, deadlineTs: 5000, pot: 3n, blockSol: grid(),
  jackpotSquare: null, jackpotPool: 0n, rolloverJackpot: 0n, updatedAt: 1,
  leaderboard: [], recentEvents: [],
});

let server: ReadServer;
afterEach(async () => { await server?.close(); });

describe("read server", () => {
  it("serves the current snapshot over REST (bigint as string)", async () => {
    let current: FullSnapshot | null = snap(100);
    server = await startReadServer(0, () => current);
    const res = await fetch(`http://127.0.0.1:${server.port}/snapshot`);
    const body = await res.json();
    expect(body.roundId).toBe(100);
    expect(body.pot).toBe("3"); // bigint serialized as string
  });

  it("pushes the snapshot to a ws client on connect and on broadcast", async () => {
    let current: FullSnapshot | null = snap(100);
    server = await startReadServer(0, () => current);
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
    const messages: any[] = [];
    await new Promise<void>((resolve, reject) => {
      ws.on("message", (d) => { messages.push(JSON.parse(d.toString())); resolve(); });
      ws.on("error", reject);
    });
    expect(messages[0].snapshot.roundId).toBe(100); // initial push on connect

    const got = new Promise<any>((resolve) => ws.on("message", (d) => resolve(JSON.parse(d.toString()))));
    current = snap(101);
    server.broadcast(current, [{ type: "round.open", roundId: 101, deadlineTs: 5000 }]);
    const msg = await got;
    expect(msg.snapshot.roundId).toBe(101);
    expect(msg.events[0].type).toBe("round.open");
    ws.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ansem/keeper test server`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `read/server.ts`**

```ts
import { createServer, Server } from "node:http";
import { AddressInfo } from "node:net";
import { WebSocketServer, WebSocket } from "ws";
import type { FullSnapshot } from "./snapshot.js";
import type { KeeperEvent } from "./events.js";

export interface ReadServer {
  port: number;
  broadcast: (snapshot: FullSnapshot, events: KeeperEvent[]) => void;
  close: () => Promise<void>;
}

const jsonSafe = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);
const encode = (obj: unknown) => JSON.stringify(obj, jsonSafe);

export function startReadServer(
  port: number,
  getSnapshot: () => FullSnapshot | null,
): Promise<ReadServer> {
  const http: Server = createServer((req, res) => {
    if (req.url === "/health") { res.writeHead(200).end("ok"); return; }
    if (req.url === "/snapshot") {
      const snap = getSnapshot();
      res.writeHead(snap ? 200 : 503, { "content-type": "application/json", "access-control-allow-origin": "*" });
      res.end(snap ? encode(snap) : encode({ error: "no snapshot yet" }));
      return;
    }
    res.writeHead(404).end();
  });

  const wss = new WebSocketServer({ server: http });
  wss.on("connection", (ws: WebSocket) => {
    const snap = getSnapshot();
    if (snap) ws.send(encode({ snapshot: snap, events: [] }));
  });

  return new Promise((resolve) => {
    http.listen(port, "127.0.0.1", () => {
      const actualPort = (http.address() as AddressInfo).port;
      resolve({
        port: actualPort,
        broadcast: (snapshot, events) => {
          const payload = encode({ snapshot, events });
          for (const client of wss.clients) if (client.readyState === WebSocket.OPEN) client.send(payload);
        },
        close: () => new Promise<void>((res) => { wss.close(); http.close(() => res()); }),
      });
    });
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @ansem/keeper test server`
Expected: PASS (2 passed).

- [ ] **Step 5: Commit**

```bash
git add keeper/src/read/server.ts keeper/test/server.test.ts
git commit -m "feat(keeper): read-layer server (ws push + REST /snapshot, bigint-safe)"
```

---

## Task 10: Chain wiring + service (`chain.ts`, `crank/loop.ts`, `service.ts`, `main.ts`)

**Files:**
- Create: `keeper/src/chain.ts`, `keeper/src/crank/loop.ts`, `keeper/src/service.ts`, `keeper/src/main.ts`
- Test: `keeper/test/service.test.ts`

The service composes: build a snapshot each tick → diff events → broadcast → decide → execute. The tick is a pure-ish orchestrator with all chain reads/writes injected, so the test drives a fake chain (no devnet) and asserts the snapshot is served and the right action dispatched.

- [ ] **Step 1: Write the failing test**

`keeper/test/service.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { RoundState } from "@ansem/sdk";
import { CrankAction } from "../src/crank/decide.js";
import { runTick, TickDeps, TickState } from "../src/crank/loop.js";

const grid = () => Array.from({ length: 25 }, () => 0n);
const config: any = { currentRoundId: 100, currentRoundFinalized: false, rolloverJackpot: 0n, multMinBps: 5000, multMaxBps: 5000 };
const openRound: any = {
  roundId: 100, deadlineTs: 5000, blockSol: grid(), pot: 0n, state: RoundState.Open,
  randomness: new Array(32).fill(0), jackpotSquare: 0, jackpotPool: 0n, swapProceeds: 0n,
};

function makeDeps(over: Partial<TickDeps> = {}): { deps: TickDeps; dispatched: CrankAction[]; broadcasts: number } {
  const dispatched: CrankAction[] = [];
  let broadcasts = 0;
  const deps: TickDeps = {
    fetchConfig: async () => config,
    fetchRound: async () => openRound,
    fetchMiners: async () => [],
    dispatch: async (a) => { dispatched.push(a); },
    broadcast: () => { broadcasts++; },
    nowSec: () => 4000, // before deadline
    ...over,
  };
  return { deps, dispatched, broadcasts, get broadcastsCount() { return broadcasts; } } as any;
}

describe("runTick", () => {
  it("builds+broadcasts a snapshot and dispatches Idle while OPEN pre-deadline", async () => {
    const { deps, dispatched } = makeDeps();
    const state: TickState = { prevSnapshot: null, vrfPendingSinceSec: null };
    const next = await runTick(deps, state);
    expect(dispatched).toEqual([CrankAction.Idle]);
    expect(next.prevSnapshot?.roundId).toBe(100);
  });

  it("dispatches Settle once OPEN passes the deadline", async () => {
    const { deps, dispatched } = makeDeps({ nowSec: () => 6000 });
    await runTick(deps, { prevSnapshot: null, vrfPendingSinceSec: null });
    expect(dispatched).toEqual([CrankAction.Settle]);
  });

  it("stamps vrfPendingSinceSec the first tick a round is VRF_PENDING", async () => {
    const pending = { ...openRound, state: RoundState.VrfPending };
    const { deps } = makeDeps({ fetchRound: async () => pending as any, nowSec: () => 6000 });
    const next = await runTick(deps, { prevSnapshot: null, vrfPendingSinceSec: null });
    expect(next.vrfPendingSinceSec).toBe(6000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ansem/keeper test service`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `crank/loop.ts`**

```ts
import { RoundState, ConfigState, RoundStateData, BoardSnapshot, toBoardSnapshot } from "@ansem/sdk";
import { decideAction, CrankAction, CrankState } from "./decide.js";
import { buildFullSnapshot, FullSnapshot, MinerRow } from "../read/snapshot.js";
import { diffEvents, KeeperEvent } from "../read/events.js";

export interface TickDeps {
  fetchConfig: () => Promise<ConfigState>;
  fetchRound: () => Promise<RoundStateData | null>;
  fetchMiners: (roundId: number) => Promise<MinerRow[]>;
  dispatch: (action: CrankAction, ctx: { config: ConfigState; round: RoundStateData | null }) => Promise<void>;
  broadcast: (snap: FullSnapshot, events: KeeperEvent[]) => void;
  nowSec: () => number;
  graceSecs?: number;
  getSnapshot?: (snap: FullSnapshot) => void; // optional: store latest for REST
}

export interface TickState {
  prevSnapshot: BoardSnapshot | null;
  vrfPendingSinceSec: number | null;
}

/** One crank+read tick. Returns the next TickState (prev snapshot + grace clock). */
export async function runTick(deps: TickDeps, state: TickState): Promise<TickState> {
  const config = await deps.fetchConfig();
  const round = await deps.fetchRound();
  const now = deps.nowSec();

  // Grace clock: stamp the first tick we see VRF_PENDING; clear otherwise.
  let vrfPendingSinceSec = state.vrfPendingSinceSec;
  if (round?.state === RoundState.VrfPending) {
    vrfPendingSinceSec = vrfPendingSinceSec ?? now;
  } else {
    vrfPendingSinceSec = null;
  }

  // Build + broadcast the read snapshot.
  let prevSnapshot = state.prevSnapshot;
  if (round) {
    const miners = await deps.fetchMiners(round.roundId);
    const events = diffEvents(prevSnapshot, /* next */ buildBoardOnly(round, config, now));
    const full = buildFullSnapshot(round, config, miners, events, now);
    deps.getSnapshot?.(full);
    deps.broadcast(full, events);
    prevSnapshot = full;
  }

  // Decide + dispatch the crank action.
  const crankState: CrankState = {
    finalized: config.currentRoundFinalized,
    currentRoundId: config.currentRoundId,
    round: round ? { state: round.state, deadlineTs: round.deadlineTs, roundId: round.roundId } : null,
    nowSec: now,
    vrfPendingSinceSec,
    graceSecs: deps.graceSecs ?? 180,
  };
  const action = decideAction(crankState);
  await deps.dispatch(action, { config, round });

  return { prevSnapshot, vrfPendingSinceSec };
}

// Board-only projection reused for the event diff (avoids leaderboard cost).
const buildBoardOnly = (round: RoundStateData, config: ConfigState, now: number): BoardSnapshot =>
  toBoardSnapshot(round, config, now);
```

- [ ] **Step 4: Implement `chain.ts`, `service.ts`, `main.ts`**

`keeper/src/chain.ts`:
```ts
import { Connection, Keypair } from "@solana/web3.js";
import { Program } from "@coral-xyz/anchor";
import { Wallet } from "@coral-xyz/anchor";
import { AnsemMiner, createProgram, createErProgram } from "@ansem/sdk";
import type { KeeperConfig } from "./env.js";

export interface Chain {
  conn: Connection;
  erConn: Connection;
  wallet: Wallet;
  program: Program<AnsemMiner>;
  erProgram: Program<AnsemMiner>;
}

export function buildChain(cfg: KeeperConfig): Chain {
  const conn = new Connection(cfg.rpcUrl, { wsEndpoint: cfg.wsUrl, commitment: "confirmed" });
  const erConn = new Connection(cfg.erEndpoint, { wsEndpoint: cfg.erWsEndpoint, commitment: "confirmed" });
  const wallet = new Wallet(cfg.adminKeypair);
  return {
    conn, erConn, wallet,
    program: createProgram(conn, wallet),
    erProgram: createErProgram(erConn, wallet),
  };
}
```

`keeper/src/service.ts`:
```ts
import {
  fetchConfig, fetchRound, fetchMiner, configPda, roundPda, minerPda, sleep,
} from "@ansem/sdk";
import type { KeeperConfig } from "./env.js";
import { buildChain, Chain } from "./chain.js";
import { makeLogger, Logger } from "./logger.js";
import { runTick, TickState } from "./crank/loop.js";
import { CrankAction } from "./crank/decide.js";
import {
  ActionCtx, createAndDelegate, requestSettle, cancelRound, finalizeRound, liveFinalizeDeps,
} from "./crank/actions.js";
import { fetchStakerWallets } from "./participants.js";
import { startReadServer, ReadServer } from "./read/server.js";
import type { FullSnapshot } from "./read/snapshot.js";

export interface Service { start: () => Promise<void>; stop: () => Promise<void>; }

export function createService(cfg: KeeperConfig, log: Logger = makeLogger()): Service {
  const chain: Chain = buildChain(cfg);
  const ctx: ActionCtx = {
    conn: chain.conn, erConn: chain.erConn, program: chain.program, erProgram: chain.erProgram,
    keeper: cfg.adminKeypair.publicKey, validator: cfg.validator, vrfQueue: cfg.vrfQueue,
    roundDurationSecs: cfg.roundDurationSecs, log,
  };
  let latest: FullSnapshot | null = null;
  let server: ReadServer | undefined;
  let running = false;

  const dispatch = async (action: CrankAction, s: { config: any; round: any }) => {
    switch (action) {
      case CrankAction.CreateRound:
        return createAndDelegate(ctx, s.config.currentRoundId + 1);
      case CrankAction.Settle:
        return requestSettle(ctx, s.round.roundId);
      case CrankAction.Finalize:
        return finalizeRound(s.round.roundId, liveFinalizeDeps(ctx, s.round.roundId));
      case CrankAction.Cancel:
        return cancelRound(ctx, s.round.roundId);
      case CrankAction.AwaitOracle:
      case CrankAction.Idle:
      default:
        return; // nothing to do this tick
    }
  };

  return {
    async start() {
      server = await startReadServer(cfg.httpPort, () => latest);
      log.info("keeper up", { httpPort: server.port, keeper: ctx.keeper.toBase58() });
      running = true;
      let state: TickState = { prevSnapshot: null, vrfPendingSinceSec: null };
      while (running) {
        try {
          state = await runTick({
            fetchConfig: () => fetchConfig(chain.program, configPda()),
            fetchRound: async () => {
              const cfgState = await fetchConfig(chain.program, configPda());
              return fetchRound(chain.program, roundPda(cfgState.currentRoundId)).catch(() => null);
            },
            fetchMiners: async (roundId) => {
              const wallets = await fetchStakerWallets(chain.conn, roundId);
              const rows = await Promise.all(wallets.map(async (w) => {
                const m = await fetchMiner(chain.program, minerPda(w));
                return m ? { wallet: w.toBase58(), blockStake: m.blockStake } : null;
              }));
              return rows.filter((r): r is NonNullable<typeof r> => r !== null);
            },
            dispatch,
            broadcast: (snap, events) => server!.broadcast(snap, events),
            getSnapshot: (snap) => { latest = snap; },
            nowSec: () => Math.floor(Date.now() / 1000),
            graceSecs: cfg.graceSecs,
          }, state);
        } catch (e) {
          log.error("tick failed", { err: String(e) });
        }
        await sleep(cfg.pollMs);
      }
    },
    async stop() { running = false; await server?.close(); },
  };
}
```

`keeper/src/main.ts`:
```ts
import { loadKeeperConfig, fsLoadKeypair } from "./env.js";
import { createService } from "./service.js";
import { makeLogger } from "./logger.js";

const log = makeLogger();
const cfg = loadKeeperConfig(process.env, fsLoadKeypair);
const service = createService(cfg, log);

process.on("SIGINT", () => { log.info("shutting down"); void service.stop().then(() => process.exit(0)); });
process.on("SIGTERM", () => { void service.stop().then(() => process.exit(0)); });

service.start().catch((e) => { log.error("keeper crashed", { err: String(e) }); process.exit(1); });
```

- [ ] **Step 5: Run the service test**

Run: `pnpm --filter @ansem/keeper test service`
Expected: PASS (3 passed).

- [ ] **Step 6: Full unit gate + typecheck**

Run:
```bash
pnpm --filter @ansem/sdk build
pnpm --filter @ansem/keeper test
pnpm --filter @ansem/keeper typecheck
```
Expected: all keeper unit tests pass (env 3, logger 2, decide 8, participants 4, snapshot 2, events 7, actions 2, server 2, service 3 = 33), typecheck exit 0.

- [ ] **Step 7: Commit**

```bash
git add keeper/src/chain.ts keeper/src/crank/loop.ts keeper/src/service.ts keeper/src/main.ts keeper/test/service.test.ts
git commit -m "feat(keeper): tick orchestrator + chain wiring + service/main entry"
```

---

## Task 11: Headless devnet integration test + README + root scripts (M4a verify)

**Files:**
- Create: `keeper/test/devnet-round.it.ts` (gated by `KEEPER_DEVNET_IT=1`), `keeper/README.md`
- Modify: root `package.json` (add `keeper:dev`, `keeper:it` scripts)

This is the spec §8 M4a **verify**: the keeper runs a full hands-off round on devnet with no UI while a scripted session-player stakes gaslessly, and the read snapshot reflects it. It is network-dependent and slow, so it is **excluded from the fast unit gate** (guarded by an env flag) and run explicitly.

- [ ] **Step 1: Write the gated integration test**

`keeper/test/devnet-round.it.ts`:
```ts
import { describe, it, expect } from "vitest";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { getAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";
import * as anchor from "@coral-xyz/anchor";
import { Wallet } from "@coral-xyz/anchor";
import { SessionTokenManager } from "@magicblock-labs/gum-sdk";
import {
  createProgram, createErProgram, configPda, roundPda, minerPda, escrowPda, playerAta,
  ansemMintPda, fetchConfig, fetchRound, RoundState, DLP_PROGRAM_ID, PROGRAM_ID,
  depositIx, initMinerIx, joinRoundIx, delegateMinerIx, stakeIx, claimIx,
  awaitOwnerIs, awaitEr, erRpcTolerant, l1Send, sleep,
} from "@ansem/sdk";
import { loadKeeperConfig, fsLoadKeypair } from "../src/env.js";
import { createService } from "../src/service.js";
import { makeLogger } from "../src/logger.js";

const RUN = process.env.KEEPER_DEVNET_IT === "1";
const d = RUN ? describe : describe.skip;

d("keeper drives a full hands-off devnet round (M4a verify)", () => {
  it("opens → gasless session stake → keeper settles+swaps → scripted claim; snapshot reflects it", async () => {
    // Requires `source scripts/devnet-env.sh` first (ANCHOR_PROVIDER_URL, DEVNET_WALLET, ER endpoints).
    const cfg = loadKeeperConfig(process.env, fsLoadKeypair);
    const log = makeLogger();
    const service = createService({ ...cfg, roundDurationSecs: 30, httpPort: 0 }, log);
    await service.start();
    try {
      // Wait for the keeper to open+delegate a fresh round.
      const conn = new Connection(cfg.rpcUrl, { commitment: "confirmed" });
      const program = createProgram(conn, new Wallet(cfg.adminKeypair));
      const erConn = new Connection(cfg.erEndpoint, { wsEndpoint: cfg.erWsEndpoint, commitment: "confirmed" });

      const openRound = await awaitEr(
        async () => fetchConfig(program, configPda()),
        (c) => !c.currentRoundFinalized, 60, 2000);
      const roundId = openRound.currentRoundId;
      await awaitOwnerIs(conn, roundPda(roundId), DLP_PROGRAM_ID.toBase58());

      // Scripted player: fund → deposit → init_miner → session mint → join → delegate → ER session stake.
      const player = Keypair.generate();
      await program.provider.sendAndConfirm!(
        new Transaction().add(SystemProgram.transfer({
          fromPubkey: cfg.adminKeypair.publicKey, toPubkey: player.publicKey, lamports: 0.1 * LAMPORTS_PER_SOL,
        })));
      const pProgram = createProgram(conn, new Wallet(player));
      const pErProgram = createErProgram(erConn, new Wallet(player));
      await depositIx(pProgram, player.publicKey, new anchor.BN(0.05 * LAMPORTS_PER_SOL)).signers([player]).rpc();
      await initMinerIx(pProgram, player.publicKey).signers([player]).rpc().catch(() => {});

      const gum = new SessionTokenManager(new Wallet(player), conn).program;
      const sessionKp = Keypair.generate();
      const [tokenPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("session_token_v2"), PROGRAM_ID.toBuffer(), sessionKp.publicKey.toBuffer(), player.publicKey.toBuffer()],
        gum.programId);
      await gum.methods.createSessionV2(false, new anchor.BN(Math.floor(Date.now() / 1000) + 900), null)
        .accountsPartial({ sessionToken: tokenPda, sessionSigner: sessionKp.publicKey, feePayer: player.publicKey, authority: player.publicKey, targetProgram: PROGRAM_ID })
        .signers([sessionKp]).rpc();

      await l1Send(() => joinRoundIx(pProgram, player.publicKey, roundId).signers([player]).rpc());
      await l1Send(() => delegateMinerIx(pProgram, player.publicKey, cfg.validator)
        .signers([player]).rpc({ skipPreflight: true, commitment: "confirmed" }));
      await awaitOwnerIs(conn, minerPda(player.publicKey), DLP_PROGRAM_ID.toBase58());

      const STAKE = new anchor.BN(0.02 * LAMPORTS_PER_SOL);
      for (let i = 0; i < 8; i++) {
        const m: any = await pErProgram.account.minerPosition.fetch(minerPda(player.publicKey)).catch(() => null);
        if (m && m.blockStake[0].toString() === STAKE.toString()) break;
        await erRpcTolerant(() => stakeIx(pErProgram, sessionKp.publicKey, player.publicKey, 0, STAKE, roundId, tokenPda)
          .signers([sessionKp]).rpc({ skipPreflight: true, commitment: "confirmed" }));
        await sleep(2500);
      }

      // The keeper (no UI) now settles + commits + reconciles + swaps hands-off. Wait for CLAIMABLE.
      const claimable = await awaitEr(
        () => fetchRound(program, roundPda(roundId)),
        (r) => r.state === RoundState.Claimable, 300, 2000);
      expect(claimable.state).toBe(RoundState.Claimable);

      // Scripted claim succeeds; player mints ANSEM.
      await l1Send(() => claimIx(pProgram, player.publicKey, roundId).signers([player]).rpc());
      const minted = await awaitEr(
        async () => Number((await getAccount(conn, playerAta(player.publicKey))).amount),
        (a) => a > 0, 25, 2000);
      expect(minted).toBeGreaterThan(0);
      log.info("M4a verify: keeper drove a full hands-off round", { roundId, minted });
    } finally {
      await service.stop();
    }
  }, 600_000);
});
```
> If `depositIx`/`initMinerIx`/`joinRoundIx`/`delegateMinerIx`/`stakeIx`/`claimIx`/`ansemMintPda` are not yet re-exported from the SDK barrel, they are (verified in `packages/sdk/src/index.ts` → `export * from "./instructions/player.js"`). `PROGRAM_ID`, `awaitOwnerIs`, `awaitEr`, `erRpcTolerant`, `l1Send`, `sleep` are all exported.

- [ ] **Step 2: Confirm the gated test is skipped by default**

Run: `pnpm --filter @ansem/keeper test`
Expected: the `.it.ts` suite shows as **skipped** (0 failures); all 33 unit tests still pass. (Vitest picks up `test/**/*.test.ts`; add `*.it.ts` to the include OR rename to `.test.ts` — see Step 3.)

- [ ] **Step 3: Wire the integration test into vitest under the env gate**

Edit `keeper/vitest.config.ts` to include integration files, but they self-skip via `describe.skip` unless `KEEPER_DEVNET_IT=1`:
```ts
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts", "test/**/*.it.ts"],
    testTimeout: 30_000,
  },
});
```
Run: `pnpm --filter @ansem/keeper test`
Expected: 33 unit pass, 1 integration **skipped**.

- [ ] **Step 4: Write `keeper/README.md`**

````markdown
# @ansem/keeper

Hands-off ANSEM Miner round runner + live read-layer for devnet.

## Run against devnet
```bash
source scripts/devnet-env.sh          # ANCHOR_PROVIDER_URL, DEVNET_WALLET (= config.admin), ER endpoints
pnpm --filter @ansem/sdk build        # keeper imports the built SDK
pnpm --filter @ansem/keeper dev       # tsx src/main.ts — opens rounds, settles, swaps, serves :8787
```
- REST snapshot: `curl http://127.0.0.1:8787/snapshot`
- WS live board: connect to `ws://127.0.0.1:8787` — receives `{ snapshot, events }` on connect + each tick.
- Health: `curl http://127.0.0.1:8787/health`

## Env knobs
`KEEPER_ROUND_SECS` (60), `KEEPER_GRACE_SECS` (180, oracle wait before cancel), `KEEPER_POLL_MS` (4000), `KEEPER_HTTP_PORT` (8787).

## M4a verification (full hands-off round on devnet)
```bash
source scripts/devnet-env.sh
pnpm --filter @ansem/sdk build
KEEPER_DEVNET_IT=1 pnpm --filter @ansem/keeper test devnet-round
```
Drives one round end-to-end with a scripted gasless session-player and asserts the keeper settles+swaps and a claim mints ANSEM — no UI.
````

- [ ] **Step 5: Add root scripts**

Modify root `package.json` `scripts` — add:
```json
    "keeper:dev": "pnpm --filter @ansem/keeper dev",
    "keeper:it": "KEEPER_DEVNET_IT=1 pnpm --filter @ansem/keeper test devnet-round"
```

- [ ] **Step 6: Final unit gate + typecheck + commit**

Run:
```bash
pnpm --filter @ansem/sdk build
pnpm --filter @ansem/keeper test
pnpm --filter @ansem/keeper typecheck
```
Expected: 33 unit pass, 1 skipped; typecheck exit 0.
```bash
git add keeper/test/devnet-round.it.ts keeper/vitest.config.ts keeper/README.md package.json
git commit -m "feat(keeper): gated devnet round integration test (M4a verify) + README + root scripts"
```

- [ ] **Step 7: (Manual, network) Run the devnet verification**

Run:
```bash
source scripts/devnet-env.sh
pnpm --filter @ansem/sdk build
pnpm run keeper:it
```
Expected: PASS — a round opens, the scripted player stakes gaslessly via a session key, the keeper settles + swaps hands-off, the scripted claim mints ANSEM > 0. This is the M4a backbone acceptance. (If devnet oracle latency or RPC throttling flakes, re-run — the flow is the same one proven green in `tests/ansem-miner-devnet.ts`.)

---

## Self-review

**1. Spec coverage** (spec §5.2 keeper = round loop + participant index + read-layer):
- **Round loop (crank):** Tasks 4 (decide) + 8 (actions) + 10 (loop/service). Covers create+delegate, deadline settle, oracle await, commit_miner×all→commit_round, reconcile×all, swap, and grace→cancel. ✓
- **Participant index:** Task 5 — joined roster (escrow memcmp, authoritative/L1) drives commit+reconcile; staker roster (miner memcmp) feeds leaderboard. Owner-state caveats documented. ✓
- **Read-layer:** Tasks 6 (snapshot+leaderboard) + 7 (typed events `round.open/stake/settling/revealed/claimable`) + 9 (ws push + REST snapshot) + 10 (wired into the tick). Clients never touch devnet RPC. ✓
- **M3 hardening reuse:** `retryPastDeadline`, `l1Send`, `erRpcTolerant`, `awaitOwnerIs`, `flushCommit`, regional ER endpoint — all consumed from the SDK in Task 8/10. ✓
- **Self-heal on boot:** the same `decideAction` state machine handles a stranded current round (OPEN past-deadline→settle, VRF_PENDING→await/cancel, SETTLED→finalize). Delegated-stranded commit-before-cancel is handled inside `commitRound`/`finalize` (owner check). ✓ *(Note: a round left fully delegated with no path to settle is the spec §12 M5 caveat — out of scope; the grace→cancel + commit-first covers the reachable cases.)*
- **Grace/stall policy:** `KEEPER_GRACE_SECS` → Cancel, logged not silent (Task 8 `cancelRound` logs `warn`). ✓
- **Verify (spec §8 M4a):** Task 11 gated devnet IT + `curl /snapshot` / ws in README. ✓

**2. Placeholder scan:** No `TODO`/`TBD`/"add error handling"/"similar to Task N". Every code step shows complete, ready-to-paste code with its exact file path; every run step gives the command + expected output.

**3. Type consistency:** `CrankAction`/`CrankState`/`CrankRoundView` (Task 4) reused verbatim in Tasks 8/10. `FullSnapshot`/`MinerRow`/`LeaderRow` (Task 6) reused in 7/9/10. `KeeperEvent` union (Task 7) reused in 6/9/10. `TickDeps`/`TickState` (Task 10) match the `service.ts` call site. `KeeperConfig` (Task 2) fields consumed in 10/11. SDK symbols verified against `packages/sdk/src/index.ts` exports. Account offsets (40/72) and sizes (249/89) verified against `state/{miner,escrow}.rs`. ✓

---

## Execution notes / risks

- **The read-layer polls** (reuses the proven tolerant helpers) rather than WS account-subscribing to devnet — the single-consumer keeper polling at `KEEPER_POLL_MS` is what M3 proved safe against 429s; browsers get WS *push* from the keeper. Account subscriptions are a later optimization, not required for M4a.
- **Live OPEN-round stakes:** during OPEN the round+miners are delegated (ER). Task 10's `fetchMiners` reads program-owned miners on L1 (empty until commit), so the leaderboard populates at settle. If a *live* pre-settle board is wanted for M4b polish, add an ER read path (`erProgram.account.round.fetch` / miner fetch) selected on `state===Open && L1 owner===DLP`; deferred to keep M4a's backbone focused and its verification deterministic. Flagged, not silent.
- **Actions coverage:** `finalizeRound`'s ordering/resilience is unit-tested; `createAndDelegate`/`requestSettle`/`cancelRound` are thin SDK-builder wrappers whose on-chain behavior is proven by the Task 11 devnet IT (the same instructions `tests/ansem-miner-devnet.ts` already runs green).
- **After execution:** update memory `m4-frontend-build.md` (Part 2 done) and proceed to the M4b web read path as its own writing-plans pass.
