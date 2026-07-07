# ANSEM Miner — M4b: Web Read Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the read-only Next.js dApp — a live bull-head board (25 tiles), round HUD + countdown, activity feed, and leaderboard — that renders real devnet rounds streamed from the keeper's WebSocket, with wallet connect wired but no staking yet.

**Architecture:** A new `app/` Next.js (App Router) package in the existing pnpm/turbo monorepo. The browser **never** touches devnet RPC: it subscribes to the keeper's WS (`{snapshot, events}` push) with a REST `/snapshot` cold-load fallback, and renders the shared `FullSnapshot`. Wire types (`FullSnapshot`, `KeeperEvent`, `WireSnapshot`) are lifted into `@ansem/sdk` so the keeper (producer) and app (consumer) share ONE definition — no drift. Board layout is the prototype's bull-head hex lattice; each on-chain square `i` (0–24) renders bull tile `generated/bulls/NN-name.png` (NN = i+1), downscaled to WebP at build.

**Tech Stack:** Next.js 14 (App Router) + React 18 + TypeScript + Tailwind CSS 3; `@solana/wallet-adapter-*` (connect only, read-only); `@ansem/sdk` (workspace) for types + constants; `sharp` prebuild for asset optimization; Vitest + @testing-library/react + jsdom for unit/component tests (network-free). Playwright-against-devnet e2e is **deferred to M4d** (spec §9) — M4b's tests use fake WS/fetch + jsdom for determinism; final acceptance is the §8 manual live-keeper verify.

---

## Grounded reference (verified against source, 2026-07-07)

**The wire contract (from `keeper/src/read/server.ts`):**
- WS: on connect the server sends `{ snapshot: <FullSnapshot>, events: [] }` if a snapshot exists; each tick it broadcasts `{ snapshot, events }`.
- REST `GET /snapshot` → 200 with the **bare** `FullSnapshot` object (NOT wrapped), or 503 `{ "error": "no snapshot yet" }`. Sets `access-control-allow-origin: *`.
- REST `GET /health` → 200 `"ok"`.
- **All bigints are serialized as strings** (`jsonSafe` replacer). So over the wire `pot`, `blockSol[i]`, `jackpotPool`, `rolloverJackpot`, `leaderboard[].totalStake` are **strings**. The app parses them at format time (never loses precision).

**`FullSnapshot` (in-memory, `keeper/src/read/snapshot.ts`) — extends `BoardSnapshot` + leaderboard + recentEvents:**
```ts
// BoardSnapshot (packages/sdk/src/accounts.ts)
roundId: number; state: RoundState; deadlineTs: number; pot: bigint;
blockSol: bigint[];        // length 25, per-square staked lamports
jackpotSquare: number | null;  // non-null only when state >= Settled
jackpotPool: bigint; rolloverJackpot: bigint; updatedAt: number;
// + FullSnapshot
leaderboard: { wallet: string; totalStake: bigint; squares: number[] }[]; // stake-desc
recentEvents: KeeperEvent[];
```

**`KeeperEvent` (`keeper/src/read/events.ts`) — already wire-safe (no bigint fields):**
```ts
| { type: "round.open"; roundId: number; deadlineTs: number }
| { type: "stake"; roundId: number; square: number; totalStake: string }
| { type: "round.settling"; roundId: number }
| { type: "round.revealed"; roundId: number; jackpotSquare: number }
| { type: "round.claimable"; roundId: number }
```

**`RoundState` (`packages/sdk/src/constants.ts`):** `Open=0, VrfPending=1, Settled=2, Swapping=3, Claimable=4, Closed=5`. `GRID_SIZE=25`. `ANSEM_DECIMALS=6`.

**Bull-head layout (from `docs/design/bull-board.html`, the approved prototype):** 25 cells built from a half-lattice mirrored across the center column. `(c,r)` → flat-top hex pixel: `x = c*1.5`, `y = r*√3 + (|c| odd ? √3/2 : 0)`. Eyes are the two `|c|==1 && r==0` cells. Cell `id` (push order) === on-chain square index 0–24.
```
HALF = [[0,0],[0,1],[0,2],[0,3],[0,4],  // center column (not mirrored)
        [1,-1],[1,0],[1,1],[1,2],        // inner face (row0 = eye)
        [2,0],[2,1],[2,2],               // cheeks
        [3,-1],[3,0],                    // lower horn
        [4,-1]]                          // horn tip
// push (c,r); if c!==0 also push (-c,r) → 5 + 10*2 = 25 cells, 2 eyes.
```

**Assets:** `generated/bulls/01-inferno.png … 25-stealth-assassin.png` (25 opaque PNGs ~1254px, ~41 MB tracked). Square `i` → file with prefix `String(i+1).padStart(2,'0')`.

**Skin tokens (prototype):** green `#35e07a` (staked/positive), gold `#e8c452` (jackpot), near-black bg `#0b0b0e`, dim `#2c4034`, muted text `#8a8a93`.

**Monorepo:** `pnpm-workspace.yaml` already globs `app`. Root `turbo.json` has `build`/`test`/`typecheck`/`lint`. Node 22, ESM. SDK is `@ansem/sdk` (workspace:*), keeper is `@ansem/keeper`.

**Env the app reads (client-exposed, `NEXT_PUBLIC_*`):**
- `NEXT_PUBLIC_KEEPER_WS` (default `ws://127.0.0.1:8787`)
- `NEXT_PUBLIC_KEEPER_HTTP` (default `http://127.0.0.1:8787`)
- `NEXT_PUBLIC_SOLANA_CLUSTER` (default `devnet`) — for wallet-adapter's ConnectionProvider (used by M4c writes; unused for reads).

**Out of scope for M4b (do NOT build):** deposit/withdraw, init_miner, the batched entry tx, gasless staking, claim (all M4c); the productionized ascending settle-reveal choreography + asset AVIF pipeline + responsive/mobile polish + Vercel deploy (all M4d). M4b's board reflects **live state** (dim → green by stake share → gold on the settled jackpot square); it does not choreograph the reveal.

---

## File Structure

**Modified (Task 1 — shared types):**
- `packages/sdk/src/wire.ts` (new) — `MinerRow`, `LeaderRow`, `FullSnapshot`, `KeeperEvent`, `WireSnapshot`, `WireMessage`.
- `packages/sdk/src/index.ts` — export `./wire.js`.
- `packages/sdk/test/wire.test.ts` (new) — wire round-trip.
- `keeper/src/read/snapshot.ts` — import + re-export the moved types from `@ansem/sdk`; keep `buildFullSnapshot`.
- `keeper/src/read/events.ts` — import + re-export `KeeperEvent` from `@ansem/sdk`; keep `diffEvents`.

**New (`app/`):**
- Config: `package.json`, `next.config.mjs`, `tsconfig.json`, `postcss.config.mjs`, `tailwind.config.ts`, `vitest.config.ts`, `.env.local.example`, `.gitignore`, `README.md`.
- Prebuild: `scripts/optimize-bulls.mjs` (+ `test/optimize-bulls.test.ts`).
- Lib (pure, framework-free): `src/lib/board-layout.ts`, `src/lib/format.ts`, `src/lib/keeper-client.ts` (+ `.test.ts` each).
- Hook: `src/hooks/use-keeper-snapshot.ts` (+ `.test.tsx`).
- Components: `src/components/{Board,Hud,Countdown,Leaderboard,ActivityFeed,WalletBar,Providers}.tsx` (+ tests for Board, Hud, Leaderboard, ActivityFeed).
- App Router: `src/app/{layout.tsx,page.tsx,globals.css}`.
- Test setup: `test/setup.ts` (jest-dom matchers).

Each file has one responsibility; pure logic (layout/format/client) is separated from React so it's unit-tested without a DOM, and components are thin.

---

## Task 1: Lift shared wire types into `@ansem/sdk`

The keeper produces `FullSnapshot`/`KeeperEvent`; the app consumes them. Today they live in `keeper/src/read/*`. Move the **type declarations** to the SDK (spec §5.1: "a normalized `BoardSnapshot` type shared with the keeper + app") so both sides share one definition. The keeper's `read/*.ts` re-export them, so all downstream keeper imports keep working unchanged. Functions (`buildFullSnapshot`, `diffEvents`) stay in the keeper.

**Files:**
- Create: `packages/sdk/src/wire.ts`
- Create: `packages/sdk/test/wire.test.ts`
- Modify: `packages/sdk/src/index.ts`
- Modify: `keeper/src/read/snapshot.ts`
- Modify: `keeper/src/read/events.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/sdk/test/wire.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { RoundState, GRID_SIZE } from "../src/constants.js";
import type { FullSnapshot, WireSnapshot } from "../src/wire.js";

// The keeper serializes with this exact replacer (see keeper/src/read/server.ts).
const jsonSafe = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);

describe("wire snapshot contract", () => {
  it("serializes bigints to strings and preserves the 25-square grid", () => {
    const snap: FullSnapshot = {
      roundId: 42, state: RoundState.Open, deadlineTs: 1_700_000_000, pot: 1234n,
      blockSol: Array.from({ length: GRID_SIZE }, (_, i) => BigInt(i)),
      jackpotSquare: null, jackpotPool: 0n, rolloverJackpot: 500n, updatedAt: 1_700_000_001,
      leaderboard: [{ wallet: "abc", totalStake: 999n, squares: [3, 7] }],
      recentEvents: [{ type: "round.open", roundId: 42, deadlineTs: 1_700_000_000 }],
    };
    const wire = JSON.parse(JSON.stringify(snap, jsonSafe)) as WireSnapshot;
    expect(typeof wire.pot).toBe("string");
    expect(wire.pot).toBe("1234");
    expect(wire.blockSol).toHaveLength(GRID_SIZE);
    expect(typeof wire.blockSol[5]).toBe("string");
    expect(typeof wire.leaderboard[0].totalStake).toBe("string");
    expect(wire.leaderboard[0].squares).toEqual([3, 7]);
    expect(wire.recentEvents[0].type).toBe("round.open");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ansem/sdk exec vitest run wire`
Expected: FAIL — cannot resolve `../src/wire.js`.

- [ ] **Step 3: Create the wire types**

Create `packages/sdk/src/wire.ts`:
```ts
import type { BoardSnapshot } from "./accounts.js";
import type { RoundState } from "./constants.js";

/** A staker's per-square stake snapshot (in-memory, keeper-side). */
export interface MinerRow { wallet: string; blockStake: bigint[]; }

/** One leaderboard entry (in-memory, keeper-side). */
export interface LeaderRow { wallet: string; totalStake: bigint; squares: number[]; }

/** Typed keeper events for a prev -> next board transition (already wire-safe: no bigint fields). */
export type KeeperEvent =
  | { type: "round.open"; roundId: number; deadlineTs: number }
  | { type: "stake"; roundId: number; square: number; totalStake: string }
  | { type: "round.settling"; roundId: number }
  | { type: "round.revealed"; roundId: number; jackpotSquare: number }
  | { type: "round.claimable"; roundId: number };

/** The full live board state the keeper holds in memory and serves to browsers. */
export interface FullSnapshot extends BoardSnapshot {
  leaderboard: LeaderRow[];
  recentEvents: KeeperEvent[];
}

/**
 * The JSON shape actually received over WS/REST: identical to FullSnapshot but with
 * every bigint serialized to a decimal string (keeper's jsonSafe replacer). Consumers
 * parse these with BigInt(...) at format time (no precision loss).
 */
export interface WireSnapshot {
  roundId: number; state: RoundState; deadlineTs: number;
  pot: string; blockSol: string[]; jackpotSquare: number | null;
  jackpotPool: string; rolloverJackpot: string; updatedAt: number;
  leaderboard: { wallet: string; totalStake: string; squares: number[] }[];
  recentEvents: KeeperEvent[];
}

/** A live WS push frame. */
export interface WireMessage { snapshot: WireSnapshot; events: KeeperEvent[]; }
```

- [ ] **Step 4: Export from the SDK barrel**

In `packages/sdk/src/index.ts`, add after the `./accounts.js` export:
```ts
export * from "./wire.js";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @ansem/sdk exec vitest run wire`
Expected: PASS.

- [ ] **Step 6: Repoint the keeper at the moved types (re-export to avoid churn)**

In `keeper/src/read/events.ts`, replace the local `KeeperEvent` declaration with a re-export from the SDK, keeping `diffEvents` unchanged:
```ts
import { RoundState, BoardSnapshot } from "@ansem/sdk";
import type { KeeperEvent } from "@ansem/sdk";
export type { KeeperEvent } from "@ansem/sdk";

/** Typed events for the transition prev -> next. `prev = null` on cold start. */
export function diffEvents(prev: BoardSnapshot | null, next: BoardSnapshot): KeeperEvent[] {
  // ... unchanged body ...
}
```
(Keep the existing `diffEvents` body exactly as-is; only the `KeeperEvent` type source changes.)

In `keeper/src/read/snapshot.ts`, replace the local `MinerRow`/`LeaderRow`/`FullSnapshot` declarations with SDK imports + re-exports, keeping `buildFullSnapshot` unchanged:
```ts
import { toBoardSnapshot, RoundStateData, ConfigState } from "@ansem/sdk";
import type { MinerRow, LeaderRow, FullSnapshot, KeeperEvent } from "@ansem/sdk";
export type { MinerRow, LeaderRow, FullSnapshot } from "@ansem/sdk";

const sum = (xs: bigint[]): bigint => xs.reduce((a, b) => a + b, 0n);

export function buildFullSnapshot(
  round: RoundStateData, config: ConfigState, miners: MinerRow[],
  recentEvents: KeeperEvent[], updatedAt: number,
): FullSnapshot {
  // ... unchanged body ...
}
```
(`read/server.ts`, `service.ts`, `crank/loop.ts` import these via `./snapshot.js` / `./events.js`, which now re-export them — no further edits needed.)

- [ ] **Step 7: Verify the keeper still builds + all its tests pass**

Run: `pnpm --filter @ansem/sdk build && pnpm --filter @ansem/keeper typecheck && pnpm --filter @ansem/keeper test`
Expected: SDK builds; keeper typecheck clean; all 38 keeper unit tests PASS (the network-free suite; the gated devnet IT stays skipped).

- [ ] **Step 8: Commit**

```bash
git add packages/sdk/src/wire.ts packages/sdk/src/index.ts packages/sdk/test/wire.test.ts keeper/src/read/snapshot.ts keeper/src/read/events.ts
git commit -m "M4b: lift FullSnapshot/KeeperEvent wire types into @ansem/sdk (shared by keeper + app)"
```

---

## Task 2: Scaffold the Next.js `app/` package

Stand up a minimal, buildable Next.js 14 App Router package wired into the workspace, with Tailwind + the skin tokens and a placeholder page. The "test" is a clean typecheck/build.

**Files:**
- Create: `app/package.json`, `app/next.config.mjs`, `app/tsconfig.json`, `app/postcss.config.mjs`, `app/tailwind.config.ts`, `app/.gitignore`, `app/.env.local.example`
- Create: `app/src/app/layout.tsx`, `app/src/app/page.tsx`, `app/src/app/globals.css`

- [ ] **Step 1: Create `app/package.json`**
```json
{
  "name": "@ansem/app",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "predev": "node scripts/optimize-bulls.mjs",
    "dev": "next dev -p 3000",
    "prebuild": "node scripts/optimize-bulls.mjs",
    "build": "next build",
    "start": "next start -p 3000",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "lint": "next lint"
  },
  "dependencies": {
    "@ansem/sdk": "workspace:*",
    "@solana/wallet-adapter-base": "^0.9.23",
    "@solana/wallet-adapter-react": "^0.15.35",
    "@solana/wallet-adapter-react-ui": "^0.9.35",
    "@solana/wallet-adapter-wallets": "^0.19.32",
    "@solana/web3.js": "^1.95.0",
    "next": "^14.2.5",
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "@testing-library/jest-dom": "^6.4.8",
    "@testing-library/react": "^16.0.0",
    "@types/react": "^18.3.3",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.1",
    "autoprefixer": "^10.4.19",
    "eslint": "^8.57.0",
    "eslint-config-next": "^14.2.5",
    "jsdom": "^25.0.0",
    "postcss": "^8.4.40",
    "sharp": "^0.33.4",
    "tailwindcss": "^3.4.7",
    "typescript": "^5.4.2",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Create `app/next.config.mjs`**
```js
/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // @ansem/sdk ships TS/ESM; let Next transpile the workspace package.
  transpilePackages: ["@ansem/sdk"],
};
export default nextConfig;
```

- [ ] **Step 3: Create `app/tsconfig.json`**
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["dom", "dom.iterable", "ES2022"],
    "allowJs": true,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "types": ["node", "@testing-library/jest-dom"],
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./src/*"] }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

- [ ] **Step 4: Create `app/postcss.config.mjs` and `app/tailwind.config.ts`**

`app/postcss.config.mjs`:
```js
export default { plugins: { tailwindcss: {}, autoprefixer: {} } };
```

`app/tailwind.config.ts`:
```ts
import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bull: {
          green: "#35e07a",
          gold: "#e8c452",
          bg: "#0b0b0e",
          dim: "#2c4034",
          muted: "#8a8a93",
          edge: "#23232a",
        },
      },
      fontFamily: {
        mono: ["ui-monospace", "Menlo", "monospace"],
      },
    },
  },
  plugins: [],
};
export default config;
```

- [ ] **Step 5: Create `app/.gitignore` and `app/.env.local.example`**

`app/.gitignore`:
```
/.next/
/out/
/node_modules
next-env.d.ts
.env.local
# generated by scripts/optimize-bulls.mjs at (pre)build:
/public/bulls/
```

`app/.env.local.example`:
```
# The keeper's read-layer endpoints (see keeper/src/read/server.ts).
NEXT_PUBLIC_KEEPER_WS=ws://127.0.0.1:8787
NEXT_PUBLIC_KEEPER_HTTP=http://127.0.0.1:8787
# Wallet-adapter cluster (used by M4c write path; unused for M4b reads).
NEXT_PUBLIC_SOLANA_CLUSTER=devnet
```

- [ ] **Step 6: Create the App Router root + placeholder page + globals**

`app/src/app/globals.css`:
```css
@tailwind base;
@tailwind components;
@tailwind utilities;

:root { color-scheme: dark; }
html, body { background: #000; color: #e6e6ea; }
body { font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; margin: 0; }
```

`app/src/app/layout.tsx`:
```tsx
import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ANSEM Miner — Bull Board",
  description: "Live devnet bull board (read-only).",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
```

`app/src/app/page.tsx`:
```tsx
export default function Page() {
  return (
    <main className="min-h-screen bg-bull-bg flex items-center justify-center">
      <p className="text-bull-muted text-sm tracking-widest">ANSEM MINER — BOOTING…</p>
    </main>
  );
}
```

- [ ] **Step 7: Install workspace deps and verify the app typechecks + builds**

Run: `pnpm install`
Then create a throwaway empty `app/public/bulls/.gitkeep` so `next build` has the dir (Task 4 replaces this):
Run: `mkdir -p app/public/bulls && touch app/public/bulls/.gitkeep`
Run: `pnpm --filter @ansem/app exec next build`
Expected: build completes; a static `/` route is emitted. (If `next build` complains about the missing prebuild script, temporarily skip it — Task 4 adds `scripts/optimize-bulls.mjs`; for this step run `next build` directly as shown, not `pnpm --filter @ansem/app build`.)

- [ ] **Step 8: Commit**
```bash
git add app/package.json app/next.config.mjs app/tsconfig.json app/postcss.config.mjs app/tailwind.config.ts app/.gitignore app/.env.local.example app/src/app pnpm-lock.yaml
git commit -m "M4b: scaffold Next.js app package (App Router + Tailwind skin + workspace wiring)"
```

---

## Task 3: Bull-head board layout (pure)

Port the prototype's bull-head lattice to a pure, tested function returning normalized `[0,1]` positions the DOM board places tiles at.

**Files:**
- Create: `app/src/lib/board-layout.ts`
- Test: `app/src/lib/board-layout.test.ts`

- [ ] **Step 1: Write the failing test**

Create `app/src/lib/board-layout.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { bullCells } from "./board-layout.js";

describe("bullCells", () => {
  const cells = bullCells();

  it("produces exactly 25 cells with unique ids 0..24 in order", () => {
    expect(cells).toHaveLength(25);
    expect(cells.map((c) => c.id)).toEqual(Array.from({ length: 25 }, (_, i) => i));
  });

  it("marks exactly two eye cells (|c|==1, r==0)", () => {
    expect(cells.filter((c) => c.eye)).toHaveLength(2);
  });

  it("normalizes every position into [0,1] x [0,1]", () => {
    for (const c of cells) {
      expect(c.left).toBeGreaterThanOrEqual(0);
      expect(c.left).toBeLessThanOrEqual(1);
      expect(c.top).toBeGreaterThanOrEqual(0);
      expect(c.top).toBeLessThanOrEqual(1);
    }
  });

  it("is left-right symmetric about the center column", () => {
    // The center column cells sit at left ~= 0.5.
    const center = cells.filter((c) => Math.abs(c.left - 0.5) < 1e-9);
    expect(center.length).toBe(5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ansem/app exec vitest run board-layout`
Expected: FAIL — cannot resolve `./board-layout.js`.

- [ ] **Step 3: Implement `bullCells`**

Create `app/src/lib/board-layout.ts`:
```ts
/** One bull tile's placement on the board. `id` === on-chain square index 0..24. */
export interface BullCell {
  id: number;
  left: number; // normalized [0,1] center x within the board box
  top: number;  // normalized [0,1] center y within the board box
  eye: boolean; // the two glowing-eye cells (|c|==1, r==0)
}

const S3 = Math.sqrt(3);

// Half-lattice (col >= 0), mirrored across the center column -> 25 symmetric cells.
// (c,r) -> flat-top hex pixel: x = c*1.5 ; y = r*sqrt3 + (|c| odd ? sqrt3/2 : 0).
const HALF: Array<[number, number]> = [
  [0, 0], [0, 1], [0, 2], [0, 3], [0, 4], // center column: poll -> chin
  [1, -1], [1, 0], [1, 1], [1, 2],        // inner face (row0 = eye)
  [2, 0], [2, 1], [2, 2],                 // cheeks
  [3, -1], [3, 0],                        // lower horn
  [4, -1],                                // horn tip
];

/** Deterministic bull-head layout: 25 cells with normalized positions. */
export function bullCells(): BullCell[] {
  const raw: Array<{ c: number; r: number }> = [];
  for (const [c, r] of HALF) {
    raw.push({ c, r });
    if (c !== 0) raw.push({ c: -c, r });
  }
  const pts = raw.map(({ c, r }) => ({
    c, r,
    x: c * 1.5,
    y: r * S3 + (Math.abs(c) % 2 === 1 ? S3 / 2 : 0),
  }));
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;
  return pts.map((p, id) => ({
    id,
    left: (p.x - minX) / spanX,
    top: (p.y - minY) / spanY,
    eye: Math.abs(p.c) === 1 && p.r === 0,
  }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @ansem/app exec vitest run board-layout`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**
```bash
git add app/src/lib/board-layout.ts app/src/lib/board-layout.test.ts
git commit -m "M4b: bull-head board layout (pure, 25 normalized cells)"
```

---

## Task 4: Asset optimize prebuild (`sharp` → WebP)

Downscale the 25 source PNGs into small WebP tiles under `app/public/bulls/NN.webp` at build time. Keep full-res originals in `generated/`.

**Files:**
- Create: `app/scripts/optimize-bulls.mjs`
- Test: `app/test/optimize-bulls.test.ts`

- [ ] **Step 1: Write the failing test**

Create `app/test/optimize-bulls.test.ts`:
```ts
import { describe, it, expect, beforeAll } from "vitest";
import { readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import sharp from "sharp";
import { optimizeBulls } from "../scripts/optimize-bulls.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, "../public/bulls");

describe("optimizeBulls", () => {
  beforeAll(async () => { await optimizeBulls(); }, 60_000);

  it("emits 25 webp tiles named NN.webp", () => {
    const files = readdirSync(outDir).filter((f) => f.endsWith(".webp")).sort();
    expect(files).toHaveLength(25);
    expect(files[0]).toBe("01.webp");
    expect(files[24]).toBe("25.webp");
  });

  it("downscales each tile to <= 256px on the long edge", async () => {
    const meta = await sharp(resolve(outDir, "01.webp")).metadata();
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(256);
  });

  it("is idempotent (re-running does not throw)", async () => {
    await expect(optimizeBulls()).resolves.not.toThrow();
    expect(existsSync(resolve(outDir, "13.webp"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ansem/app exec vitest run optimize-bulls`
Expected: FAIL — cannot resolve `../scripts/optimize-bulls.mjs`.

- [ ] **Step 3: Implement the optimize script (exports a function + runs as CLI)**

Create `app/scripts/optimize-bulls.mjs`:
```js
import { readdirSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import sharp from "sharp";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(here, "../../generated/bulls");   // repo-root generated/bulls
const OUT = resolve(here, "../public/bulls");
const MAX = 256;

/** Downscale generated/bulls/NN-name.png -> public/bulls/NN.webp (<=256px). Idempotent. */
export async function optimizeBulls() {
  mkdirSync(OUT, { recursive: true });
  const pngs = readdirSync(SRC).filter((f) => /^\d{2}-.*\.png$/.test(f)).sort();
  if (pngs.length !== 25) {
    throw new Error(`expected 25 source bull PNGs in ${SRC}, found ${pngs.length}`);
  }
  await Promise.all(pngs.map(async (file) => {
    const nn = file.slice(0, 2); // "01".."25"
    await sharp(join(SRC, file))
      .resize(MAX, MAX, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: 82 })
      .toFile(join(OUT, `${nn}.webp`));
  }));
  return pngs.length;
}

// Run as a CLI when invoked directly (npm predev/prebuild).
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  optimizeBulls()
    .then((n) => console.log(`optimized ${n} bull tiles -> public/bulls`))
    .catch((e) => { console.error(e); process.exit(1); });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @ansem/app exec vitest run optimize-bulls`
Expected: PASS (3 tests); `app/public/bulls/01.webp … 25.webp` now exist.

- [ ] **Step 5: Verify the CLI form works (used by predev/prebuild)**

Run: `node app/scripts/optimize-bulls.mjs`
Expected: prints `optimized 25 bull tiles -> public/bulls`.

- [ ] **Step 6: Commit** (do NOT commit `public/bulls/` — it's gitignored and generated)
```bash
git add app/scripts/optimize-bulls.mjs app/test/optimize-bulls.test.ts
git commit -m "M4b: sharp prebuild — downscale 25 bull PNGs to public/bulls/NN.webp"
```

---

## Task 5: Format helpers (pure)

Small, tested formatters the components share: lamports→SOL, ANSEM amounts, countdown, state labels, event→text, short address.

**Files:**
- Create: `app/src/lib/format.ts`
- Test: `app/src/lib/format.test.ts`

- [ ] **Step 1: Write the failing test**

Create `app/src/lib/format.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { RoundState } from "@ansem/sdk";
import { lamportsToSol, formatSol, stateLabel, secondsLeft, formatCountdown, shortAddr, eventToText } from "./format.js";

describe("format helpers", () => {
  it("lamportsToSol parses stringified lamports without precision loss", () => {
    expect(lamportsToSol("1000000000")).toBeCloseTo(1);
    expect(lamportsToSol("20000000")).toBeCloseTo(0.02);
    expect(lamportsToSol("0")).toBe(0);
  });

  it("formatSol renders a trimmed SOL string", () => {
    expect(formatSol("1000000000")).toBe("1 SOL");
    expect(formatSol("20000000")).toBe("0.02 SOL");
  });

  it("stateLabel maps each RoundState", () => {
    expect(stateLabel(RoundState.Open)).toBe("OPEN");
    expect(stateLabel(RoundState.VrfPending)).toBe("SETTLING");
    expect(stateLabel(RoundState.Settled)).toBe("REVEALED");
    expect(stateLabel(RoundState.Claimable)).toBe("CLAIMABLE");
    expect(stateLabel(RoundState.Closed)).toBe("VOID");
  });

  it("secondsLeft clamps at zero and formatCountdown renders mm:ss", () => {
    expect(secondsLeft(1_000, 500_000)).toBe(500); // deadline 1000s, now 500s
    expect(secondsLeft(1_000, 2_000_000)).toBe(0); // past deadline -> clamped
    expect(formatCountdown(65)).toBe("01:05");
    expect(formatCountdown(0)).toBe("00:00");
  });

  it("shortAddr abbreviates a base58 pubkey", () => {
    expect(shortAddr("ABCDEFGHIJKLMNOP")).toBe("ABCD…MNOP");
  });

  it("eventToText renders each keeper event", () => {
    expect(eventToText({ type: "round.open", roundId: 5, deadlineTs: 0 })).toBe("Round 5 opened");
    expect(eventToText({ type: "stake", roundId: 5, square: 3, totalStake: "20000000" })).toContain("Bull #4");
    expect(eventToText({ type: "round.settling", roundId: 5 })).toBe("Round 5 settling…");
    expect(eventToText({ type: "round.revealed", roundId: 5, jackpotSquare: 6 })).toContain("Bull #7");
    expect(eventToText({ type: "round.claimable", roundId: 5 })).toBe("Round 5 claimable");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ansem/app exec vitest run format`
Expected: FAIL — cannot resolve `./format.js`.

- [ ] **Step 3: Implement the formatters**

Create `app/src/lib/format.ts`:
```ts
import { RoundState, type KeeperEvent } from "@ansem/sdk";

const LAMPORTS_PER_SOL = 1_000_000_000;

/** Parse stringified lamports (wire form) into a SOL number. */
export function lamportsToSol(lamports: string): number {
  return Number(BigInt(lamports)) / LAMPORTS_PER_SOL;
}

/** Trim trailing zeros to <=4 decimals and suffix " SOL". */
export function formatSol(lamports: string): string {
  const sol = lamportsToSol(lamports);
  const s = sol.toFixed(4).replace(/\.?0+$/, "");
  return `${s} SOL`;
}

export function stateLabel(state: RoundState): string {
  switch (state) {
    case RoundState.Open: return "OPEN";
    case RoundState.VrfPending: return "SETTLING";
    case RoundState.Settled: return "REVEALED";
    case RoundState.Swapping: return "SWAPPING";
    case RoundState.Claimable: return "CLAIMABLE";
    case RoundState.Closed: return "VOID";
    default: return "—";
  }
}

/** Whole seconds until `deadlineTs` (unix secs), given `nowMs` (ms). Clamped at 0. */
export function secondsLeft(deadlineTs: number, nowMs: number): number {
  return Math.max(0, deadlineTs - Math.floor(nowMs / 1000));
}

export function formatCountdown(totalSecs: number): string {
  const s = Math.max(0, Math.floor(totalSecs));
  const mm = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

export function shortAddr(addr: string, head = 4, tail = 4): string {
  if (addr.length <= head + tail) return addr;
  return `${addr.slice(0, head)}…${addr.slice(-tail)}`;
}

/** One human-readable line per keeper event (square i -> "Bull #(i+1)"). */
export function eventToText(e: KeeperEvent): string {
  switch (e.type) {
    case "round.open": return `Round ${e.roundId} opened`;
    case "stake": return `Bull #${e.square + 1} staked → ${formatSol(e.totalStake)}`;
    case "round.settling": return `Round ${e.roundId} settling…`;
    case "round.revealed": return `Jackpot: Bull #${e.jackpotSquare + 1} struck the big pot`;
    case "round.claimable": return `Round ${e.roundId} claimable`;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @ansem/app exec vitest run format`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add app/src/lib/format.ts app/src/lib/format.test.ts
git commit -m "M4b: pure format helpers (SOL, countdown, state labels, event text)"
```

---

## Task 6: Keeper WS/REST client (framework-free)

A dependency-injected client that cold-loads the REST snapshot, connects the WS, forwards `{snapshot, events}` frames, and reconnects with backoff. No React, no real network in tests (inject `WebSocket` + `fetch`).

**Files:**
- Create: `app/src/lib/keeper-client.ts`
- Test: `app/src/lib/keeper-client.test.ts`

- [ ] **Step 1: Write the failing test**

Create `app/src/lib/keeper-client.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { createKeeperClient, type KeeperStatus } from "./keeper-client.js";
import type { WireSnapshot } from "@ansem/sdk";

// Minimal fake WebSocket we can drive from the test.
class FakeWS {
  static instances: FakeWS[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  readyState = 0;
  constructor(public url: string) { FakeWS.instances.push(this); }
  close() { this.readyState = 3; this.onclose?.(); }
  open() { this.readyState = 1; this.onopen?.(); }
  emit(obj: unknown) { this.onmessage?.({ data: JSON.stringify(obj) }); }
}

const wireSnap = (roundId: number): WireSnapshot => ({
  roundId, state: 0, deadlineTs: 0, pot: "0", blockSol: Array(25).fill("0"),
  jackpotSquare: null, jackpotPool: "0", rolloverJackpot: "0", updatedAt: 1,
  leaderboard: [], recentEvents: [],
});

function setup(overrides: { fetchImpl?: typeof fetch } = {}) {
  FakeWS.instances = [];
  const snapshots: WireSnapshot[] = [];
  const statuses: KeeperStatus[] = [];
  const fetchImpl = overrides.fetchImpl ??
    (vi.fn().mockResolvedValue({ ok: true, json: async () => wireSnap(1) }) as unknown as typeof fetch);
  const client = createKeeperClient({
    wsUrl: "ws://x", httpUrl: "http://x",
    WebSocketImpl: FakeWS as unknown as typeof WebSocket,
    fetchImpl,
    reconnectMs: 10,
    onSnapshot: (s) => snapshots.push(s),
    onStatus: (s) => statuses.push(s),
  });
  return { client, snapshots, statuses, fetchImpl };
}

describe("createKeeperClient", () => {
  it("cold-loads the REST snapshot on start", async () => {
    const { client, snapshots } = setup();
    client.start();
    await vi.waitFor(() => expect(snapshots).toContainEqual(expect.objectContaining({ roundId: 1 })));
    client.stop();
  });

  it("forwards WS {snapshot, events} frames", async () => {
    const { client, snapshots } = setup();
    client.start();
    await vi.waitFor(() => expect(FakeWS.instances).toHaveLength(1));
    FakeWS.instances[0].open();
    FakeWS.instances[0].emit({ snapshot: wireSnap(2), events: [] });
    await vi.waitFor(() => expect(snapshots).toContainEqual(expect.objectContaining({ roundId: 2 })));
    client.stop();
  });

  it("reports connected/disconnected status and reconnects on close", async () => {
    const { client, statuses } = setup();
    client.start();
    await vi.waitFor(() => expect(FakeWS.instances).toHaveLength(1));
    FakeWS.instances[0].open();
    await vi.waitFor(() => expect(statuses).toContain("connected"));
    FakeWS.instances[0].close();
    await vi.waitFor(() => expect(statuses).toContain("disconnected"));
    // backoff should spin up a fresh socket
    await vi.waitFor(() => expect(FakeWS.instances.length).toBeGreaterThanOrEqual(2));
    client.stop();
  });

  it("stop() closes the socket and suppresses further reconnects", async () => {
    const { client } = setup();
    client.start();
    await vi.waitFor(() => expect(FakeWS.instances).toHaveLength(1));
    client.stop();
    const countAfterStop = FakeWS.instances.length;
    FakeWS.instances[0].close();
    await new Promise((r) => setTimeout(r, 30));
    expect(FakeWS.instances).toHaveLength(countAfterStop); // no reconnect after stop
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ansem/app exec vitest run keeper-client`
Expected: FAIL — cannot resolve `./keeper-client.js`.

- [ ] **Step 3: Implement the client**

Create `app/src/lib/keeper-client.ts`:
```ts
import type { WireSnapshot, KeeperEvent } from "@ansem/sdk";

export type KeeperStatus = "connecting" | "connected" | "disconnected";

export interface KeeperClientOpts {
  wsUrl: string;
  httpUrl: string;
  onSnapshot: (snap: WireSnapshot) => void;
  onEvents?: (events: KeeperEvent[]) => void;
  onStatus?: (status: KeeperStatus) => void;
  reconnectMs?: number;
  WebSocketImpl?: typeof WebSocket;
  fetchImpl?: typeof fetch;
}

export interface KeeperClient { start: () => void; stop: () => void; }

/**
 * Read-only keeper client: REST cold-load + WS live push with reconnect.
 * All I/O is injectable so it is fully unit-tested without a network.
 */
export function createKeeperClient(opts: KeeperClientOpts): KeeperClient {
  const WS = opts.WebSocketImpl ?? WebSocket;
  const doFetch = opts.fetchImpl ?? fetch;
  const reconnectMs = opts.reconnectMs ?? 2000;
  let ws: WebSocket | null = null;
  let stopped = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const setStatus = (s: KeeperStatus) => opts.onStatus?.(s);

  async function coldLoad() {
    try {
      const res = await doFetch(`${opts.httpUrl}/snapshot`);
      if (res.ok) opts.onSnapshot((await res.json()) as WireSnapshot);
    } catch { /* WS will deliver the next frame; ignore cold-load miss */ }
  }

  function connect() {
    if (stopped) return;
    setStatus("connecting");
    const sock = new WS(opts.wsUrl);
    ws = sock;
    sock.onopen = () => setStatus("connected");
    sock.onmessage = (ev: MessageEvent) => {
      try {
        const frame = JSON.parse(String(ev.data)) as { snapshot?: WireSnapshot; events?: KeeperEvent[] };
        if (frame.snapshot) opts.onSnapshot(frame.snapshot);
        if (frame.events && frame.events.length) opts.onEvents?.(frame.events);
      } catch { /* ignore malformed frame */ }
    };
    sock.onerror = () => { try { sock.close(); } catch { /* noop */ } };
    sock.onclose = () => {
      setStatus("disconnected");
      if (!stopped) reconnectTimer = setTimeout(connect, reconnectMs);
    };
  }

  return {
    start() {
      stopped = false;
      void coldLoad();
      connect();
    },
    stop() {
      stopped = true;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      if (ws) { try { ws.close(); } catch { /* noop */ } ws = null; }
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @ansem/app exec vitest run keeper-client`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**
```bash
git add app/src/lib/keeper-client.ts app/src/lib/keeper-client.test.ts
git commit -m "M4b: framework-free keeper WS/REST client (injectable I/O, reconnect)"
```

---

## Task 7: `useKeeperSnapshot` React hook + vitest DOM setup

Wrap the client in a hook that returns `{ snapshot, events, status }`, keeping the last N events. This task also adds the jsdom/testing-library config the component tests need.

**Files:**
- Create: `app/vitest.config.ts`
- Create: `app/test/setup.ts`
- Create: `app/src/hooks/use-keeper-snapshot.ts`
- Test: `app/src/hooks/use-keeper-snapshot.test.tsx`

- [ ] **Step 1: Add vitest config + jsdom setup**

Create `app/vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}", "test/**/*.test.{ts,tsx}"],
    globals: true,
  },
});
```

Create `app/test/setup.ts`:
```ts
import "@testing-library/jest-dom/vitest";
```

- [ ] **Step 2: Write the failing test**

Create `app/src/hooks/use-keeper-snapshot.test.tsx`:
```tsx
import { describe, it, expect, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useKeeperSnapshot } from "./use-keeper-snapshot.js";
import type { KeeperClient, KeeperClientOpts } from "../lib/keeper-client.js";
import type { WireSnapshot } from "@ansem/sdk";

const wireSnap = (roundId: number): WireSnapshot => ({
  roundId, state: 0, deadlineTs: 0, pot: "0", blockSol: Array(25).fill("0"),
  jackpotSquare: null, jackpotPool: "0", rolloverJackpot: "0", updatedAt: 1,
  leaderboard: [], recentEvents: [],
});

describe("useKeeperSnapshot", () => {
  it("exposes the latest snapshot and status from an injected client factory", async () => {
    let captured: KeeperClientOpts | null = null;
    const factory = vi.fn((opts: KeeperClientOpts): KeeperClient => {
      captured = opts;
      return { start: () => {}, stop: () => {} };
    });

    const { result } = renderHook(() =>
      useKeeperSnapshot({ wsUrl: "ws://x", httpUrl: "http://x", clientFactory: factory }));

    expect(result.current.status).toBe("connecting");
    expect(result.current.snapshot).toBeNull();

    act(() => { captured!.onStatus?.("connected"); captured!.onSnapshot(wireSnap(9)); });
    await waitFor(() => expect(result.current.snapshot?.roundId).toBe(9));
    expect(result.current.status).toBe("connected");
  });

  it("accumulates events newest-first, capped", async () => {
    let captured: KeeperClientOpts | null = null;
    const factory = (opts: KeeperClientOpts): KeeperClient => { captured = opts; return { start: () => {}, stop: () => {} }; };
    const { result } = renderHook(() =>
      useKeeperSnapshot({ wsUrl: "ws://x", httpUrl: "http://x", clientFactory: factory, maxEvents: 3 }));

    act(() => { captured!.onEvents?.([{ type: "round.open", roundId: 1, deadlineTs: 0 }]); });
    act(() => { captured!.onEvents?.([{ type: "round.claimable", roundId: 1 }]); });
    await waitFor(() => expect(result.current.events).toHaveLength(2));
    expect(result.current.events[0].type).toBe("round.claimable"); // newest first
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @ansem/app exec vitest run use-keeper-snapshot`
Expected: FAIL — cannot resolve `./use-keeper-snapshot.js`.

- [ ] **Step 4: Implement the hook**

Create `app/src/hooks/use-keeper-snapshot.ts`:
```ts
"use client";
import { useEffect, useRef, useState } from "react";
import type { WireSnapshot, KeeperEvent } from "@ansem/sdk";
import { createKeeperClient, type KeeperClient, type KeeperClientOpts, type KeeperStatus } from "../lib/keeper-client.js";

export interface UseKeeperOpts {
  wsUrl: string;
  httpUrl: string;
  maxEvents?: number;
  /** Injectable for tests; defaults to the real client. */
  clientFactory?: (opts: KeeperClientOpts) => KeeperClient;
}

export interface KeeperView {
  snapshot: WireSnapshot | null;
  events: KeeperEvent[];
  status: KeeperStatus;
}

export function useKeeperSnapshot(opts: UseKeeperOpts): KeeperView {
  const { wsUrl, httpUrl, maxEvents = 30, clientFactory = createKeeperClient } = opts;
  const [snapshot, setSnapshot] = useState<WireSnapshot | null>(null);
  const [events, setEvents] = useState<KeeperEvent[]>([]);
  const [status, setStatus] = useState<KeeperStatus>("connecting");
  const factoryRef = useRef(clientFactory);

  useEffect(() => {
    const client = factoryRef.current({
      wsUrl, httpUrl,
      onSnapshot: setSnapshot,
      onEvents: (incoming) => setEvents((prev) => [...incoming.slice().reverse(), ...prev].slice(0, maxEvents)),
      onStatus: setStatus,
    });
    client.start();
    return () => client.stop();
  }, [wsUrl, httpUrl, maxEvents]);

  return { snapshot, events, status };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @ansem/app exec vitest run use-keeper-snapshot`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**
```bash
git add app/vitest.config.ts app/test/setup.ts app/src/hooks/use-keeper-snapshot.ts app/src/hooks/use-keeper-snapshot.test.tsx
git commit -m "M4b: useKeeperSnapshot hook + vitest/jsdom test setup"
```

---

## Task 8: `Board` component (live bull-head)

Render the 25 positioned bull tiles from `bullCells()`, driven by a `WireSnapshot`: dim idle → green (intensity ∝ this square's stake share of the pot) → gold on the settled jackpot square; persistent green eyes.

**Files:**
- Create: `app/src/components/Board.tsx`
- Test: `app/src/components/Board.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `app/src/components/Board.test.tsx`:
```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { RoundState } from "@ansem/sdk";
import { Board } from "./Board.js";
import type { WireSnapshot } from "@ansem/sdk";

const snap = (over: Partial<WireSnapshot> = {}): WireSnapshot => ({
  roundId: 1, state: RoundState.Open, deadlineTs: 0, pot: "100",
  blockSol: Array(25).fill("0"), jackpotSquare: null, jackpotPool: "0",
  rolloverJackpot: "0", updatedAt: 1, leaderboard: [], recentEvents: [], ...over,
});

describe("Board", () => {
  it("renders 25 tiles keyed by on-chain square", () => {
    render(<Board snapshot={snap()} />);
    for (let i = 0; i < 25; i++) {
      expect(screen.getByTestId(`tile-${i}`)).toBeInTheDocument();
    }
  });

  it("lights a staked square green (data-lit)", () => {
    const blockSol = Array(25).fill("0"); blockSol[3] = "60"; blockSol[8] = "40";
    render(<Board snapshot={snap({ blockSol, pot: "100" })} />);
    expect(screen.getByTestId("tile-3")).toHaveAttribute("data-lit", "true");
    expect(screen.getByTestId("tile-0")).toHaveAttribute("data-lit", "false");
  });

  it("flags the jackpot square gold only once settled", () => {
    const settled = snap({ state: RoundState.Settled, jackpotSquare: 7 });
    render(<Board snapshot={settled} />);
    expect(screen.getByTestId("tile-7")).toHaveAttribute("data-jackpot", "true");
  });

  it("renders nothing-jackpot while still open", () => {
    render(<Board snapshot={snap({ state: RoundState.Open, jackpotSquare: null })} />);
    expect(screen.getByTestId("tile-7")).toHaveAttribute("data-jackpot", "false");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ansem/app exec vitest run Board`
Expected: FAIL — cannot resolve `./Board.js`.

- [ ] **Step 3: Implement the Board**

Create `app/src/components/Board.tsx`:
```tsx
"use client";
import Image from "next/image";
import { RoundState, type WireSnapshot } from "@ansem/sdk";
import { bullCells } from "../lib/board-layout.js";

const CELLS = bullCells();

function tileNo(id: number): string { return String(id + 1).padStart(2, "0"); }

export interface BoardProps { snapshot: WireSnapshot; }

export function Board({ snapshot }: BoardProps) {
  const pot = BigInt(snapshot.pot || "0");
  const settled = snapshot.state >= RoundState.Settled;
  return (
    <div className="relative w-full aspect-[400/340] mx-auto max-w-[460px]">
      {CELLS.map((cell) => {
        const stake = BigInt(snapshot.blockSol[cell.id] ?? "0");
        const lit = stake > 0n;
        const jackpot = settled && snapshot.jackpotSquare === cell.id;
        // stake share [0,1] -> glow opacity; guard div-by-zero.
        const share = pot > 0n ? Number((stake * 1000n) / pot) / 1000 : 0;
        const glow = jackpot ? "0 0 18px 4px #e8c452" : lit ? `0 0 ${6 + share * 22}px 2px #35e07a` : "none";
        return (
          <div
            key={cell.id}
            data-testid={`tile-${cell.id}`}
            data-lit={lit ? "true" : "false"}
            data-jackpot={jackpot ? "true" : "false"}
            className="absolute -translate-x-1/2 -translate-y-1/2 rounded-md overflow-hidden transition-all duration-300"
            style={{
              left: `${cell.left * 100}%`,
              top: `${cell.top * 100}%`,
              width: "17%",
              boxShadow: glow,
              outline: jackpot ? "2px solid #e8c452" : lit ? "1px solid #35e07a" : "1px solid #2c4034",
              opacity: lit || jackpot ? 1 : 0.5,
            }}
          >
            <Image
              src={`/bulls/${tileNo(cell.id)}.webp`}
              alt={`Bull #${cell.id + 1}`}
              width={128}
              height={128}
              className="w-full h-auto block"
            />
            {cell.eye && (
              <span className="absolute inset-0 m-auto h-1/4 w-1/4 rounded-full bg-bull-green/80 blur-[1px]" />
            )}
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @ansem/app exec vitest run Board`
Expected: PASS (4 tests). (`next/image` renders a plain `<img>` under jsdom; the `data-*` assertions don't depend on the actual asset loading.)

- [ ] **Step 5: Commit**
```bash
git add app/src/components/Board.tsx app/src/components/Board.test.tsx
git commit -m "M4b: Board component — 25 live bull tiles (green by stake share, gold jackpot)"
```

---

## Task 9: `Hud` + `Countdown` components

Round header: round #, state label, pot (SOL), jackpot pool + rollover, and a live mm:ss countdown from `deadlineTs`.

**Files:**
- Create: `app/src/components/Countdown.tsx`
- Create: `app/src/components/Hud.tsx`
- Test: `app/src/components/Hud.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `app/src/components/Hud.test.tsx`:
```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { RoundState, type WireSnapshot } from "@ansem/sdk";
import { Hud } from "./Hud.js";

const snap = (over: Partial<WireSnapshot> = {}): WireSnapshot => ({
  roundId: 12, state: RoundState.Open, deadlineTs: 1_000, pot: "1000000000",
  blockSol: Array(25).fill("0"), jackpotSquare: null, jackpotPool: "500000000",
  rolloverJackpot: "0", updatedAt: 1, leaderboard: [], recentEvents: [], ...over,
});

describe("Hud", () => {
  it("shows round number, state and pot", () => {
    // Pin now so the countdown is deterministic: deadline 1000s, now 900s -> 100s left.
    render(<Hud snapshot={snap()} nowMs={900_000} />);
    expect(screen.getByText(/Round 12/i)).toBeInTheDocument();
    expect(screen.getByText("OPEN")).toBeInTheDocument();
    expect(screen.getByText(/1 SOL/)).toBeInTheDocument();
    expect(screen.getByText("01:40")).toBeInTheDocument(); // 100s
  });

  it("labels the settled state as REVEALED", () => {
    render(<Hud snapshot={snap({ state: RoundState.Settled, jackpotSquare: 4 })} nowMs={900_000} />);
    expect(screen.getByText("REVEALED")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ansem/app exec vitest run Hud`
Expected: FAIL — cannot resolve `./Hud.js`.

- [ ] **Step 3: Implement `Countdown` then `Hud`**

Create `app/src/components/Countdown.tsx`:
```tsx
"use client";
import { useEffect, useState } from "react";
import { secondsLeft, formatCountdown } from "../lib/format.js";

/** Live mm:ss to `deadlineTs`. `nowMs` (optional) pins the clock for tests. */
export function Countdown({ deadlineTs, nowMs }: { deadlineTs: number; nowMs?: number }) {
  const [tick, setTick] = useState(() => nowMs ?? Date.now());
  useEffect(() => {
    if (nowMs !== undefined) return; // pinned: no timer
    const id = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, [nowMs]);
  const now = nowMs ?? tick;
  return <span className="font-mono tabular-nums">{formatCountdown(secondsLeft(deadlineTs, now))}</span>;
}
```

Create `app/src/components/Hud.tsx`:
```tsx
"use client";
import { type WireSnapshot } from "@ansem/sdk";
import { formatSol, stateLabel } from "../lib/format.js";
import { Countdown } from "./Countdown.js";

export interface HudProps { snapshot: WireSnapshot; nowMs?: number; }

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center px-3">
      <span className="text-[10px] tracking-widest text-bull-muted">{label}</span>
      <span className="text-lg font-mono text-bull-green">{children}</span>
    </div>
  );
}

export function Hud({ snapshot, nowMs }: HudProps) {
  return (
    <div className="flex flex-wrap items-center justify-center gap-y-2 rounded-xl border border-bull-edge bg-bull-bg py-3">
      <Stat label="ROUND">#{snapshot.roundId}</Stat>
      <Stat label="STATE">{stateLabel(snapshot.state)}</Stat>
      <Stat label="POOL">{formatSol(snapshot.pot)}</Stat>
      <Stat label="JACKPOT">{formatSol(snapshot.jackpotPool)}</Stat>
      <Stat label="ENDS IN"><Countdown deadlineTs={snapshot.deadlineTs} nowMs={nowMs} /></Stat>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @ansem/app exec vitest run Hud`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**
```bash
git add app/src/components/Countdown.tsx app/src/components/Hud.tsx app/src/components/Hud.test.tsx
git commit -m "M4b: Hud + live Countdown (round/state/pool/jackpot/ends-in)"
```

---

## Task 10: `Leaderboard` + `ActivityFeed` components

Two panels off the snapshot: the stake-sorted leaderboard (`snapshot.leaderboard`) and a live activity feed (streamed events + `snapshot.recentEvents`).

**Files:**
- Create: `app/src/components/Leaderboard.tsx`
- Create: `app/src/components/ActivityFeed.tsx`
- Test: `app/src/components/Panels.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `app/src/components/Panels.test.tsx`:
```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import type { WireSnapshot, KeeperEvent } from "@ansem/sdk";
import { Leaderboard } from "./Leaderboard.js";
import { ActivityFeed } from "./ActivityFeed.js";

const leaderboard: WireSnapshot["leaderboard"] = [
  { wallet: "AAAAAAAAAAAAAAAA", totalStake: "50000000", squares: [1, 2] },
  { wallet: "BBBBBBBBBBBBBBBB", totalStake: "20000000", squares: [3] },
];

describe("Leaderboard", () => {
  it("renders each staker with short address, SOL and square count", () => {
    render(<Leaderboard leaderboard={leaderboard} />);
    expect(screen.getByText("AAAA…AAAA")).toBeInTheDocument();
    expect(screen.getByText(/0.05 SOL/)).toBeInTheDocument();
    expect(screen.getByText(/2 bulls/)).toBeInTheDocument();
  });

  it("shows an empty state when nobody has staked", () => {
    render(<Leaderboard leaderboard={[]} />);
    expect(screen.getByText(/no stakers yet/i)).toBeInTheDocument();
  });
});

describe("ActivityFeed", () => {
  it("renders one line per event, newest first", () => {
    const events: KeeperEvent[] = [
      { type: "round.claimable", roundId: 5 },
      { type: "round.open", roundId: 5, deadlineTs: 0 },
    ];
    render(<ActivityFeed events={events} />);
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("Round 5 claimable");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ansem/app exec vitest run Panels`
Expected: FAIL — cannot resolve `./Leaderboard.js`.

- [ ] **Step 3: Implement both panels**

Create `app/src/components/Leaderboard.tsx`:
```tsx
"use client";
import { type WireSnapshot } from "@ansem/sdk";
import { formatSol, shortAddr } from "../lib/format.js";

export function Leaderboard({ leaderboard }: { leaderboard: WireSnapshot["leaderboard"] }) {
  return (
    <div className="rounded-xl border border-bull-edge bg-bull-bg p-3">
      <h2 className="text-[10px] tracking-widest text-bull-muted mb-2">LEADERBOARD</h2>
      {leaderboard.length === 0 ? (
        <p className="text-bull-muted text-sm">No stakers yet.</p>
      ) : (
        <ol className="space-y-1">
          {leaderboard.map((row, i) => (
            <li key={row.wallet} className="flex items-center justify-between text-sm font-mono">
              <span className="text-bull-muted">{i + 1}. {shortAddr(row.wallet)}</span>
              <span className="text-bull-green">
                {formatSol(row.totalStake)} · {row.squares.length} bulls
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
```

Create `app/src/components/ActivityFeed.tsx`:
```tsx
"use client";
import { type KeeperEvent } from "@ansem/sdk";
import { eventToText } from "../lib/format.js";

export function ActivityFeed({ events }: { events: KeeperEvent[] }) {
  return (
    <div className="rounded-xl border border-bull-edge bg-bull-bg p-3">
      <h2 className="text-[10px] tracking-widest text-bull-muted mb-2">ACTIVITY</h2>
      {events.length === 0 ? (
        <p className="text-bull-muted text-sm">Waiting for the bull…</p>
      ) : (
        <ul className="space-y-1">
          {events.map((e, i) => (
            <li key={i} className="text-sm text-bull-muted">{eventToText(e)}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @ansem/app exec vitest run Panels`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**
```bash
git add app/src/components/Leaderboard.tsx app/src/components/ActivityFeed.tsx app/src/components/Panels.test.tsx
git commit -m "M4b: Leaderboard + ActivityFeed panels"
```

---

## Task 11: Wallet connect (read-only) + Providers

Mount `@solana/wallet-adapter` providers client-side and a connect button. No transactions — this only de-risks M4c. The gate here is a clean typecheck + build (wallet-adapter's context is heavy to unit-test; the render smoke lives in the page integration test in Task 12).

**Files:**
- Create: `app/src/components/Providers.tsx`
- Create: `app/src/components/WalletBar.tsx`

- [ ] **Step 1: Implement `Providers` (client-only wallet context)**

Create `app/src/components/Providers.tsx`:
```tsx
"use client";
import { useMemo } from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { clusterApiUrl } from "@solana/web3.js";
import "@solana/wallet-adapter-react-ui/styles.css";

const cluster = (process.env.NEXT_PUBLIC_SOLANA_CLUSTER ?? "devnet") as "devnet" | "mainnet-beta" | "testnet";

export function Providers({ children }: { children: React.ReactNode }) {
  // Endpoint is only used by the M4c write path; reads go through the keeper WS.
  const endpoint = useMemo(() => clusterApiUrl(cluster), []);
  // Empty wallet list = wallet-standard auto-detect (Phantom/Backpack inject themselves).
  const wallets = useMemo(() => [], []);
  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
```

- [ ] **Step 2: Implement `WalletBar`**

Create `app/src/components/WalletBar.tsx`:
```tsx
"use client";
import dynamic from "next/dynamic";

// Load the button client-only to avoid SSR hydration mismatch from wallet state.
const WalletMultiButton = dynamic(
  () => import("@solana/wallet-adapter-react-ui").then((m) => m.WalletMultiButton),
  { ssr: false },
);

export function WalletBar() {
  return (
    <div className="flex items-center justify-between">
      <span className="font-mono text-bull-green tracking-widest text-sm">ANSEM · MINER</span>
      <WalletMultiButton />
    </div>
  );
}
```

- [ ] **Step 3: Verify typecheck passes**

Run: `pnpm --filter @ansem/app typecheck`
Expected: PASS (no type errors across the new components).

- [ ] **Step 4: Commit**
```bash
git add app/src/components/Providers.tsx app/src/components/WalletBar.tsx
git commit -m "M4b: wallet-adapter providers + connect button (read-only, de-risks M4c)"
```

---

## Task 12: Compose the Play page

Wire the hook + all components into `/`, with connecting/disconnected and no-snapshot states. An integration test renders the page-body with an injected client factory emitting a scripted snapshot and asserts the board + HUD + panels reflect it.

**Files:**
- Create: `app/src/components/PlayBoard.tsx` (the client body — testable)
- Modify: `app/src/app/page.tsx`
- Modify: `app/src/app/layout.tsx` (wrap in `Providers`)
- Test: `app/src/components/PlayBoard.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `app/src/components/PlayBoard.test.tsx`:
```tsx
import { describe, it, expect } from "vitest";
import { render, screen, act, waitFor } from "@testing-library/react";
import { RoundState, type WireSnapshot } from "@ansem/sdk";
import { PlayBoard } from "./PlayBoard.js";
import type { KeeperClient, KeeperClientOpts } from "../lib/keeper-client.js";

const wireSnap = (over: Partial<WireSnapshot> = {}): WireSnapshot => ({
  roundId: 77, state: RoundState.Open, deadlineTs: 1_000, pot: "1000000000",
  blockSol: Array(25).fill("0"), jackpotSquare: null, jackpotPool: "0",
  rolloverJackpot: "0", updatedAt: 1,
  leaderboard: [{ wallet: "ZZZZZZZZZZZZZZZZ", totalStake: "1000000000", squares: [5] }],
  recentEvents: [], ...over,
});

describe("PlayBoard", () => {
  it("renders the live board + HUD + leaderboard from streamed snapshots", async () => {
    let captured: KeeperClientOpts | null = null;
    const factory = (opts: KeeperClientOpts): KeeperClient => { captured = opts; return { start: () => {}, stop: () => {} }; };

    render(<PlayBoard wsUrl="ws://x" httpUrl="http://x" nowMs={900_000} clientFactory={factory} />);
    // Before any snapshot: a waiting state.
    expect(screen.getByText(/waiting for the keeper/i)).toBeInTheDocument();

    act(() => { captured!.onStatus?.("connected"); captured!.onSnapshot(wireSnap()); });

    await waitFor(() => expect(screen.getByText(/Round 77/i)).toBeInTheDocument());
    expect(screen.getByTestId("tile-5")).toBeInTheDocument();
    expect(screen.getByText("ZZZZ…ZZZZ")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ansem/app exec vitest run PlayBoard`
Expected: FAIL — cannot resolve `./PlayBoard.js`.

- [ ] **Step 3: Implement `PlayBoard`**

Create `app/src/components/PlayBoard.tsx`:
```tsx
"use client";
import { useKeeperSnapshot } from "../hooks/use-keeper-snapshot.js";
import type { KeeperClientOpts, KeeperClient } from "../lib/keeper-client.js";
import { Board } from "./Board.js";
import { Hud } from "./Hud.js";
import { Leaderboard } from "./Leaderboard.js";
import { ActivityFeed } from "./ActivityFeed.js";
import { WalletBar } from "./WalletBar.js";

export interface PlayBoardProps {
  wsUrl: string;
  httpUrl: string;
  /** Pins the countdown clock for tests. */
  nowMs?: number;
  /** Injectable keeper client (tests). */
  clientFactory?: (opts: KeeperClientOpts) => KeeperClient;
}

export function PlayBoard({ wsUrl, httpUrl, nowMs, clientFactory }: PlayBoardProps) {
  const { snapshot, events, status } = useKeeperSnapshot({ wsUrl, httpUrl, clientFactory });

  return (
    <main className="min-h-screen bg-black text-white px-4 py-4 flex flex-col gap-4 max-w-[520px] mx-auto">
      <WalletBar />
      <div className="text-[10px] tracking-widest text-bull-muted text-right">
        KEEPER: {status.toUpperCase()}
      </div>
      {snapshot ? (
        <>
          <Hud snapshot={snapshot} nowMs={nowMs} />
          <Board snapshot={snapshot} />
          <Leaderboard leaderboard={snapshot.leaderboard} />
          <ActivityFeed events={events.length ? events : snapshot.recentEvents} />
        </>
      ) : (
        <div className="flex-1 flex items-center justify-center">
          <p className="text-bull-muted text-sm tracking-widest">WAITING FOR THE KEEPER…</p>
        </div>
      )}
    </main>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @ansem/app exec vitest run PlayBoard`
Expected: PASS.

- [ ] **Step 5: Wire the real page + providers**

Replace `app/src/app/page.tsx`:
```tsx
import { PlayBoard } from "../components/PlayBoard.js";

const WS = process.env.NEXT_PUBLIC_KEEPER_WS ?? "ws://127.0.0.1:8787";
const HTTP = process.env.NEXT_PUBLIC_KEEPER_HTTP ?? "http://127.0.0.1:8787";

export default function Page() {
  return <PlayBoard wsUrl={WS} httpUrl={HTTP} />;
}
```

Update `app/src/app/layout.tsx` to wrap children in `Providers`:
```tsx
import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "../components/Providers.js";

export const metadata: Metadata = {
  title: "ANSEM Miner — Bull Board",
  description: "Live devnet bull board (read-only).",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
```

- [ ] **Step 6: Verify the whole app typechecks, tests pass, and production build succeeds**

Run: `pnpm --filter @ansem/app typecheck`
Run: `pnpm --filter @ansem/app test`
Run: `pnpm --filter @ansem/app build`
Expected: typecheck clean; all vitest suites PASS; `next build` completes (the `prebuild` optimize step regenerates `public/bulls/`). If `next build` warns about `metadataBase` or image sizing, those are non-blocking for M4b.

- [ ] **Step 7: Commit**
```bash
git add app/src/components/PlayBoard.tsx app/src/components/PlayBoard.test.tsx app/src/app/page.tsx app/src/app/layout.tsx
git commit -m "M4b: compose the Play page (board + HUD + panels off the keeper WS)"
```

---

## Task 13: Live devnet read verify + README + final review

The §8 M4b acceptance: point the app at a keeper on live devnet and watch a real round render. Document the runbook and add root scripts, then run a final code review.

**Files:**
- Create: `app/README.md`
- Modify: root `package.json` (add `app:dev`)

- [ ] **Step 1: Add root convenience script**

In root `package.json` `scripts`, add:
```json
"app:dev": "pnpm --filter @ansem/app dev"
```

- [ ] **Step 2: Write `app/README.md`**
````markdown
# @ansem/app — ANSEM Miner web (M4b: read-only)

Live bull-head board that renders real devnet rounds streamed from the keeper.
The browser never touches devnet RPC — it reads the keeper's WS (`{snapshot, events}`)
with a REST `/snapshot` cold-load fallback. No staking yet (that's M4c).

## Run locally against devnet

1. Start the keeper (serves the read-layer on `:8787`):
   ```bash
   source scripts/devnet-env.sh
   pnpm --filter @ansem/sdk build
   pnpm run keeper:dev
   ```
2. In another terminal, start the web app:
   ```bash
   cp app/.env.local.example app/.env.local   # defaults point at 127.0.0.1:8787
   pnpm run app:dev
   ```
3. Open http://localhost:3000 — the board fills as the keeper opens a round,
   stakes light green, the countdown ticks, and settle flips the jackpot bull gold.

## Env
- `NEXT_PUBLIC_KEEPER_WS` (default `ws://127.0.0.1:8787`)
- `NEXT_PUBLIC_KEEPER_HTTP` (default `http://127.0.0.1:8787`)
- `NEXT_PUBLIC_SOLANA_CLUSTER` (default `devnet`, wallet-adapter only; unused for reads)

## Test
```bash
pnpm --filter @ansem/app test        # unit + jsdom component tests (network-free)
pnpm --filter @ansem/app build       # regenerates public/bulls/ via sharp prebuild
```
````

- [ ] **Step 3: Live acceptance run (manual, the §8 M4b verify)**

Start the keeper against devnet and the app, then confirm in a browser:
```bash
source scripts/devnet-env.sh && pnpm --filter @ansem/sdk build && pnpm run keeper:dev
# (new terminal)
cp app/.env.local.example app/.env.local && pnpm run app:dev
```
Expected in the browser at http://localhost:3000:
- "KEEPER: CONNECTED" appears; a round HUD shows with a ticking countdown.
- As the keeper opens/stakes/settles a round, tiles light green, the activity feed streams `round.open`/`round.settling`/`round.revealed`/`round.claimable`, and the settled jackpot bull flashes gold.
- Reconnect works: stop the keeper → status flips to DISCONNECTED; restart → it reconnects and re-renders.

Record the observed round id + a one-line result in the commit message.

- [ ] **Step 4: Commit**
```bash
git add app/README.md package.json
git commit -m "M4b: app runbook + app:dev script; live devnet read verified (round <id>)"
```

- [ ] **Step 5: Final code review**

Dispatch a code-review subagent over the full M4b diff (Tasks 1–13) against this plan and spec §8/§5.3. Focus areas: the wire-type refactor didn't break the keeper (re-run `pnpm --filter @ansem/keeper test`); the client's reconnect/stop lifecycle has no leak; the board's stake-share math handles `pot==0`; no devnet-RPC calls sneak into the browser read path; no secrets in client code. Address any Critical/Important findings before considering M4b done.

---

## Self-Review (author checklist)

**1. Spec coverage (§8 M4b = "Next.js app, wallet connect, live bull-head board (25 optimized tiles) + HUD + countdown + activity feed + leaderboard off the keeper WS"):**
- Next.js app scaffold → Task 2. Wallet connect → Task 11. 25 optimized tiles → Tasks 3+4+8. Live board off keeper WS → Tasks 6+7+8+12. HUD + countdown → Task 9. Activity feed + leaderboard → Task 10. Read-only (no staking) → enforced (no write ix anywhere). Verify "watch real devnet rounds live" → Task 13. ✓ All covered.

**2. Placeholder scan:** No TBD/TODO/"add error handling"/"similar to Task N". Every code step shows complete file contents. ✓

**3. Type consistency:** `WireSnapshot`/`KeeperEvent`/`FullSnapshot` defined once in Task 1 (`@ansem/sdk`) and consumed by name everywhere (`keeper-client`, hook, all components). `bullCells()`→`BullCell{id,left,top,eye}` consistent across Tasks 3/8. `KeeperClientOpts`/`KeeperClient`/`KeeperStatus` names match across Tasks 6/7/12. `nowMs` test-injection prop consistent across `Countdown`/`Hud`/`PlayBoard`. Tile asset path `/bulls/NN.webp` (NN=id+1) consistent across Tasks 4/8. ✓

**Deviations from spec, called out (no silent cuts):**
- The **ascending settle-reveal choreography** (unveil smallest→largest, jackpot finale) is spec §6/§8-**M4d** ("Reveal polish"); M4b's board reflects live state only. Stated in the Grounded Reference.
- **Playwright e2e** (spec §9) is deferred to M4d; M4b tests use fake WS/fetch + jsdom for determinism, with the §8 manual live verify as acceptance. Stated up front.
- **AVIF + responsive/mobile polish + Vercel deploy** are §8-M4d; M4b ships WebP tiles + a desktop-first single-column layout.
