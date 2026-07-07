# ANSEM Miner — M4c: Write Path (the playable loop) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the live read-only board into a fully playable devnet dApp — connect wallet → deposit → enter a round in **one wallet popup** → stake gaslessly on bull tiles → claim ANSEM — verifiable by a human end-to-end on devnet.

**Architecture:** Add the browser write path on top of the verified M4b read app. Two Anchor `Program` instances are built from the connected wallet: **L1** (`createProgram`, over the devnet RPC in `ConnectionProvider`) for `deposit`/`withdraw`/`claim`/`refund` and the batched entry; **ER** (`createErProgram`, over the MagicBlock regional endpoint) whose provider wallet is the **ephemeral session keypair**, so `stake` is gasless (no per-stake popup). Round **entry is a single transaction** — `init_miner?` + gum `createSessionV2` + `join_round` + `delegate_miner` — wallet-signed (one popup) and session-key co-signed. The one-popup batch is **unproven** against this program + the MagicBlock DLP delegation CPI, so Task 4 proves it with a scriptable devnet spike **before** any UI is built on it. Pure seams are vitest-tested; the real on-chain loop is verified by a human devnet runbook (Task 15), which is the M4c gate.

**Tech Stack:** Next.js 14 App Router, React 18, TypeScript, Tailwind, `@solana/wallet-adapter-react`, `@coral-xyz/anchor` 0.32, `@magicblock-labs/{gum-sdk, ephemeral-rollups-sdk}`, `@ansem/sdk` (workspace), vitest + @testing-library/react + jsdom.

---

## Locked reference facts (verified against source, 2026-07-08)

**Program / SDK (`packages/sdk`):**
- `PROGRAM_ID = 8Q9EnK7ydn6ywo7ZxeqhubqYybf7FFNNwnz8JzJjXZjz`. `GUM_PROGRAM_ID = KeyspM2ssCJbqUhQ4k7sveSiY4WjnYsrXkC8oDbwde5`. `DEFAULT_ER_VALIDATOR = MUS3hc9TCw4cGC12vHNoYcCGzJG1txjgQLZWVoeNHNd`. `DEFAULT_ER_ENDPOINT = https://devnet-us.magicblock.app`, `DEFAULT_ER_WS_ENDPOINT = wss://devnet-us.magicblock.app`. `DLP_PROGRAM_ID = DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh`. (`packages/sdk/src/constants.ts`)
- Program factories (`packages/sdk/src/program.ts`): `createProgram(connection: Connection, wallet: Wallet): Program<AnsemMiner>` and `createErProgram(erConnection: Connection, wallet: Wallet): Program<AnsemMiner>`. `Wallet` is `@coral-xyz/anchor`'s. Provider commitment `"confirmed"`. IDL is bundled — no programId arg.
- Player ix builders (`packages/sdk/src/instructions/player.ts`) each return an **unresolved Anchor MethodsBuilder** — terminate with `.instruction()` (async → `TransactionInstruction`), `.transaction()`, or `.rpc()`:
  - `depositIx(p, wallet, lamports: BN)`, `withdrawIx(p, wallet, lamports: BN)` — `accountsPartial({ authority: wallet })`.
  - `initMinerIx(p, wallet)` — `accountsPartial({ authority: wallet })`.
  - `joinRoundIx(p, wallet, roundId: number)` — `accountsPartial({ authority: wallet, config, escrow })`.
  - `delegateMinerIx(p, wallet, validator: PublicKey)` — `accountsPartial({ payer: wallet, miner }).remainingAccounts([{ pubkey: validator, isSigner:false, isWritable:false }])`.
  - `stakeIx(p, authority, stakerWallet, square, amount: BN, roundId, sessionToken: PublicKey|null)` — the ONLY gasless action. `authority` = signing key (session pubkey), `stakerWallet` = owning wallet (seeds miner/escrow). Run on the ER program.
  - `claimIx(p, wallet, roundId)`, `refundIx(p, wallet, roundId)`.
- Session (`packages/sdk/src/session.ts`): `buildCreateSession(connection, ownerWallet: Wallet, validUntilSec, target?)` → `{ sessionSigner: Keypair, tokenPda, send }` where `send()` does `.signers([sessionSigner]).rpc()`. `isSessionValid(validUntil, nowSec, marginSec=30)`. `deriveSessionToken(sessionSigner, authorityWallet, target?)`. Session token PDA seeds `["session_token_v2", target, sessionSigner, authorityWallet]` under `GUM_PROGRAM_ID`.
- ER helpers (`packages/sdk/src/er.ts`): `erRpcTolerant(send)` swallows ER confirm-flake; `awaitOwnerIs(conn, pubkey, expectedBase58, tries=60, intervalMs=500)`; `awaitEr(fetchFn, pred, tries=60, intervalMs=500)`; `l1Send(fn, tries=6, baseMs=2000)`; `sleep(ms)`.
- Decoders (`packages/sdk/src/accounts.ts`): `fetchEscrow(program, escrowPda) → EscrowState|null` (`{balance:bigint, activeRound:number, reconciledRound:number, lastClaimedRound:number, ...}`); `fetchMiner(program, minerPda) → MinerState|null` (`{roundId:number, blockStake:bigint[25]}`); `fetchConfig(program, configPda) → ConfigState` (`{currentRoundId, currentRoundFinalized, minStake:bigint, maxStakePerRound:bigint, ...}`); `fetchRound(program, roundPda) → RoundStateData`. `RoundState { Open=0, VrfPending=1, Settled=2, Swapping=3, Claimable=4, Closed=5 }`.
- PDAs (`packages/sdk/src/pdas.ts`): `configPda()`, `roundPda(id)`, `minerPda(wallet)`, `escrowPda(wallet)`, `vaultAuthPda()`, `ansemMintPda()`, `payoutVault()`, `playerAta(wallet)`, `sessionTokenPda(sessionSigner, authorityWallet, target?)`.
- **`BN`**: import from `@ansem/sdk` (re-exported) or `packages/sdk/src/bn.ts` — never `anchor.BN`.

**Verified working write sequence** (from `tests/ansem-miner-devnet.ts` phase 4 + `keeper/test/devnet-round.it.ts`): onboarding `deposit` + `init_miner` (wallet-signed, `init_miner` idempotent — swallow `/already in use/`); session mint = gum `createSessionV2(false, new BN(validUntilSec), null)` co-signed by wallet (feePayer+authority) + session keypair; `join_round` then `awaitJoined` (escrow.activeRound==id); `delegate_miner` with `.rpc({ skipPreflight:true })` then `awaitOwnerIs(miner, DLP)`; ER `stake` loop signed by the session keypair with `skipPreflight:true` wrapped in `erRpcTolerant`, confirmed by re-reading `miner.blockStake[square]`; `claim` wallet-signed on L1, confirmed by polling the player ATA amount > 0. **In the tests these are separate txs** — Task 2 batches the entry ones into one tx; Task 4 proves that batch on devnet.

**App scaffold (M4b):**
- `app/src/components/Providers.tsx` mounts `ConnectionProvider` (endpoint `clusterApiUrl("devnet")`) + `WalletProvider` (`autoConnect`, empty wallets = wallet-standard auto-detect) + `WalletModalProvider`. The comment already says the endpoint is "only used by the M4c write path."
- `app/src/components/PlayBoard.tsx` renders `WalletBar` + keeper status + (when snapshot) `Hud`/`Board`/`Leaderboard`/`ActivityFeed`, in a `max-w-[520px]` mobile column. Read-only today.
- `useAnchorWallet()` (from `@solana/wallet-adapter-react`) returns `{ publicKey, signTransaction, signAllTransactions } | undefined` — structurally an anchor `Wallet` for `createProgram`.

**Skin tokens:** green `bull-green` `#35e07a` (staked/positive), gold `#e8c452` (jackpot), `bull-muted` for secondary text, near-black surfaces. Reuse existing Tailwind classes seen in `PlayBoard`/`Board`.

**Test commands:** SDK `pnpm --filter @ansem/sdk test`; app `pnpm --filter @ansem/app test`; app typecheck `pnpm --filter @ansem/app typecheck`; app build `pnpm --filter @ansem/app build`.

---

## File Structure

**SDK (`packages/sdk/src`)** — shared, testable write-path helpers:
- `session.ts` (modify): add `buildCreateSessionIx(...)` returning the `createSessionV2` `TransactionInstruction` (not just a `send()`), so it can be batched.
- `instructions/entry.ts` (create): `buildEntryInstructions(...)` — assembles the one-popup batch (compute budget + `init_miner?` + `createSessionV2` + `join_round` + `delegate_miner`) and returns `{ instructions, sessionSigner, tokenPda, validUntil }`.
- `index.ts` (modify): export `./instructions/entry.js`.

**Devnet spike (`keeper/test`)** — de-risk gate:
- `entry-batch.it.ts` (create): gated devnet script proving the batched entry lands on a keeper-opened round.

**App (`app/src`)** — the browser write path:
- `lib/anchor.ts` (create): `erConnection()`, `useL1Program()`, `erProgramForSession(erConn, sessionKp)` — build L1/ER programs from the adapter wallet / session keypair.
- `lib/session-store.ts` (create): persist/load/clear the session keypair (+ tokenPda, validUntil, owner) in `localStorage`, keyed by wallet.
- `lib/amount.ts` (create): `solToLamports(str) → BN|null`, `lamportsToSolStr(bigint)` for input parsing/formatting.
- `lib/writes.ts` (create): `signSendWalletTx(...)` (build tx from ixs, session co-sign, wallet sign = one popup, send skipPreflight, confirm) + `enterRound(...)` + `gaslessStake(...)` orchestration wrappers over SDK helpers.
- `hooks/use-player-state.ts` (create): poll `fetchEscrow`/`fetchMiner`/`fetchConfig` for the connected wallet → `{ escrow, miner, config, refresh }`.
- `hooks/use-session.ts` (create): `{ session, valid }` from the store + `isSessionValid`.
- `components/EscrowPanel.tsx` (create): balance + deposit/withdraw (wallet-signed; withdraw locked while `activeRound != 0`).
- `components/EntryPanel.tsx` (create): "Enter round · gasless" one-popup entry + session status/expiry.
- `components/StakeRail.tsx` (create): selected-square + amount + "Stake · gasless" (ER session stake).
- `components/ClaimPanel.tsx` (create): claim (and refund for CLOSED rounds).
- `components/Board.tsx` (modify): add optional `selectedSquare`/`onSelect` for stake selection.
- `components/PlayBoard.tsx` (modify): render the write column (gated on connected wallet), build L1/ER programs, add a "get devnet SOL" affordance.
- `components/Providers.tsx` (modify): allow `NEXT_PUBLIC_RPC_ENDPOINT` override.

**Docs:**
- `docs/superpowers/runbooks/2026-07-08-m4c-e2e-devnet.md` (create): the human end-to-end devnet runbook (the M4c gate).
- `app/README.md` (modify): document the write path + env.

---

## Task 1: SDK — `buildCreateSessionIx` (batchable session mint)

**Files:**
- Modify: `packages/sdk/src/session.ts`
- Test: `packages/sdk/test/session-ix.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/sdk/test/session-ix.test.ts
import { describe, it, expect } from "vitest";
import { Connection, Keypair } from "@solana/web3.js";
import { Wallet } from "@coral-xyz/anchor";
import { buildCreateSessionIx } from "../src/session.js";
import { GUM_PROGRAM_ID, PROGRAM_ID } from "../src/constants.js";
import { deriveSessionToken } from "../src/session.js";

describe("buildCreateSessionIx", () => {
  it("builds an offline gum createSessionV2 instruction with the right program + token PDA", async () => {
    const conn = new Connection("http://127.0.0.1:8899"); // never called — .instruction() is offline
    const owner = new Wallet(Keypair.generate());
    const validUntil = 1_900_000_000;
    const { sessionSigner, tokenPda, ix, validUntil: vu } = await buildCreateSessionIx(conn, owner, validUntil);
    expect(vu).toBe(validUntil);
    expect(ix.programId.equals(GUM_PROGRAM_ID)).toBe(true);
    expect(tokenPda.equals(deriveSessionToken(sessionSigner.publicKey, owner.publicKey, PROGRAM_ID))).toBe(true);
    // the token PDA must be one of the instruction's account metas
    expect(ix.keys.some((k) => k.pubkey.equals(tokenPda))).toBe(true);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL** (`buildCreateSessionIx` not exported)

Run: `pnpm --filter @ansem/sdk test session-ix`
Expected: FAIL — `buildCreateSessionIx is not a function` / import error.

- [ ] **Step 3: Implement**

Append to `packages/sdk/src/session.ts` (keep existing exports; add the `TransactionInstruction` import):

```ts
import { Connection, PublicKey, Keypair, TransactionInstruction } from "@solana/web3.js";
// ...existing imports...

/**
 * The gum `createSessionV2` instruction (not sent) so it can be batched into the
 * one-popup entry tx. The returned tx must be co-signed by `sessionSigner` and the
 * owner wallet (feePayer + authority).
 */
export async function buildCreateSessionIx(
  connection: Connection, ownerWallet: Wallet, validUntilSec: number, target = PROGRAM_ID,
): Promise<{ sessionSigner: Keypair; tokenPda: PublicKey; ix: TransactionInstruction; validUntil: number }> {
  const gum = new SessionTokenManager(ownerWallet, connection).program;
  const sessionSigner = Keypair.generate();
  const tokenPda = sessionTokenPda(sessionSigner.publicKey, ownerWallet.publicKey, target);
  const ix = await gum.methods.createSessionV2(false, new BN(validUntilSec), null)
    .accountsPartial({
      sessionToken: tokenPda, sessionSigner: sessionSigner.publicKey,
      feePayer: ownerWallet.publicKey, authority: ownerWallet.publicKey, targetProgram: target,
    })
    .instruction();
  return { sessionSigner, tokenPda, ix, validUntil: validUntilSec };
}
```

- [ ] **Step 4: Run it — expect PASS**

Run: `pnpm --filter @ansem/sdk test session-ix`
Expected: PASS. (If `SessionTokenManager` construction touches the network, switch the test `Connection` to a stub that throws on RPC to prove no call is made, and adjust — do not silence.)

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src/session.ts packages/sdk/test/session-ix.test.ts
git commit -m "M4c(sdk): buildCreateSessionIx — batchable gum createSessionV2 ix"
```

---

## Task 2: SDK — `buildEntryInstructions` (the one-popup batch)

**Files:**
- Create: `packages/sdk/src/instructions/entry.ts`
- Modify: `packages/sdk/src/index.ts`
- Test: `packages/sdk/test/entry.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/sdk/test/entry.test.ts
import { describe, it, expect } from "vitest";
import { Connection, Keypair, ComputeBudgetProgram } from "@solana/web3.js";
import { Wallet } from "@coral-xyz/anchor";
import { createProgram } from "../src/program.js";
import { buildEntryInstructions } from "../src/instructions/entry.js";
import { GUM_PROGRAM_ID, PROGRAM_ID, DEFAULT_ER_VALIDATOR } from "../src/constants.js";
import { deriveSessionToken } from "../src/session.js";

describe("buildEntryInstructions", () => {
  const conn = new Connection("http://127.0.0.1:8899"); // .instruction() is offline
  const wallet = new Wallet(Keypair.generate());
  const l1 = createProgram(conn, wallet);

  it("batches computeBudget + session + join + delegate (no init) into one ordered list", async () => {
    const entry = await buildEntryInstructions(l1, conn, wallet, 7, DEFAULT_ER_VALIDATOR, 1_900_000_000, { includeInitMiner: false });
    // compute-budget, createSessionV2(gum), join_round(miner prog), delegate_miner(miner prog)
    expect(entry.instructions).toHaveLength(4);
    expect(entry.instructions[0].programId.equals(ComputeBudgetProgram.programId)).toBe(true);
    expect(entry.instructions[1].programId.equals(GUM_PROGRAM_ID)).toBe(true);
    expect(entry.instructions[2].programId.equals(PROGRAM_ID)).toBe(true);
    expect(entry.instructions[3].programId.equals(PROGRAM_ID)).toBe(true);
    // delegate_miner carries the validator as a remaining account
    expect(entry.instructions[3].keys.some((k) => k.pubkey.equals(DEFAULT_ER_VALIDATOR))).toBe(true);
    expect(entry.tokenPda.equals(deriveSessionToken(entry.sessionSigner.publicKey, wallet.publicKey))).toBe(true);
  });

  it("prepends init_miner when includeInitMiner is true", async () => {
    const entry = await buildEntryInstructions(l1, conn, wallet, 7, DEFAULT_ER_VALIDATOR, 1_900_000_000, { includeInitMiner: true });
    expect(entry.instructions).toHaveLength(5); // computeBudget, initMiner, session, join, delegate
    expect(entry.instructions[1].programId.equals(PROGRAM_ID)).toBe(true); // init_miner (miner program)
    expect(entry.instructions[2].programId.equals(GUM_PROGRAM_ID)).toBe(true); // session
  });
});
```

- [ ] **Step 2: Run it — expect FAIL** (module missing)

Run: `pnpm --filter @ansem/sdk test entry`
Expected: FAIL — cannot resolve `../src/instructions/entry.js`.

- [ ] **Step 3: Implement**

```ts
// packages/sdk/src/instructions/entry.ts
import { Connection, PublicKey, Keypair, TransactionInstruction, ComputeBudgetProgram } from "@solana/web3.js";
import { Program, Wallet } from "@coral-xyz/anchor";
import { AnsemMiner } from "../idl/ansem_miner.js";
import { initMinerIx, joinRoundIx, delegateMinerIx } from "./player.js";
import { buildCreateSessionIx } from "../session.js";

export interface BatchedEntry {
  instructions: TransactionInstruction[];
  sessionSigner: Keypair;
  tokenPda: PublicKey;
  validUntil: number;
}

/**
 * Assemble the ONE-POPUP round entry as a single transaction's instructions, in order:
 *   [computeBudget, initMiner?, createSessionV2, joinRound, delegateMiner]
 * The caller builds a Transaction from these, sets feePayer = ownerWallet, co-signs with
 * `sessionSigner`, then wallet-signs (the single popup) and sends with skipPreflight.
 * `delegateMiner` mutates account ownership via a DLP CPI, so the send MUST use skipPreflight.
 */
export async function buildEntryInstructions(
  l1: Program<AnsemMiner>, connection: Connection, ownerWallet: Wallet,
  roundId: number, validator: PublicKey, validUntilSec: number,
  opts: { includeInitMiner: boolean; computeUnits?: number },
): Promise<BatchedEntry> {
  const owner = ownerWallet.publicKey;
  const { sessionSigner, tokenPda, ix: sessionIx, validUntil } =
    await buildCreateSessionIx(connection, ownerWallet, validUntilSec);
  const join = await joinRoundIx(l1, owner, roundId).instruction();
  const delegate = await delegateMinerIx(l1, owner, validator).instruction();

  const instructions: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: opts.computeUnits ?? 400_000 }),
  ];
  if (opts.includeInitMiner) instructions.push(await initMinerIx(l1, owner).instruction());
  instructions.push(sessionIx, join, delegate);

  return { instructions, sessionSigner, tokenPda, validUntil };
}
```

Add to `packages/sdk/src/index.ts` (after the player export):

```ts
export * from "./instructions/entry.js";
```

- [ ] **Step 4: Run it — expect PASS**

Run: `pnpm --filter @ansem/sdk test entry`
Expected: PASS (both cases).

- [ ] **Step 5: Verify the whole SDK still typechecks + tests green, then commit**

Run: `pnpm --filter @ansem/sdk test && pnpm --filter @ansem/sdk build`
Expected: all green.

```bash
git add packages/sdk/src/instructions/entry.ts packages/sdk/src/index.ts packages/sdk/test/entry.test.ts
git commit -m "M4c(sdk): buildEntryInstructions — one-popup batched round entry"
```

---

## Task 3: Keeper — reuse the SDK batch (keep the keeper's own entry consistent)

The keeper's participant flow does not enter rounds (players do), so no keeper code changes. This task only **confirms** the SDK build didn't break the keeper package.

**Files:** none (verification only).

- [ ] **Step 1: Typecheck + test the keeper against the updated SDK**

Run: `pnpm --filter @ansem/keeper typecheck && pnpm --filter @ansem/keeper test`
Expected: green (38 keeper tests still pass; the new SDK exports don't conflict).

- [ ] **Step 2: No commit needed** (no files changed). If the keeper failed to typecheck, stop and fix the SDK export before proceeding.

---

## Task 4: Devnet spike — PROVE the one-popup batch lands (de-risk gate)

This is a **verification gate, not TDD**. It proves `buildEntryInstructions` produces a transaction that the real program + MagicBlock DLP accept, before any UI depends on it. It mirrors the proven harness in `keeper/test/devnet-round.it.ts` (read that file first — reuse its admin/config load, the "wait for a keeper-opened OPEN+delegated round" logic, and the `step`/`l1Send`/`fundFromAdmin` helpers verbatim) and swaps only the entry section.

**Files:**
- Create: `keeper/test/entry-batch.it.ts`

- [ ] **Step 1: Write the gated spike**

Reuse the setup from `keeper/test/devnet-round.it.ts` (admin keypair, `conn`, `cfg`, keeper-open wait, a fresh funded `player` Keypair, `deposit`). Replace the `session mint → join → delegate` section with the batched entry, then assert the three post-conditions:

```ts
// keeper/test/entry-batch.it.ts  (gated: only runs with ENTRY_BATCH_IT=1)
import { describe, it, expect } from "vitest";
import { Connection, Keypair, Transaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { Wallet } from "@coral-xyz/anchor";
import {
  createProgram, buildEntryInstructions, fetchEscrow, fetchMiner,
  escrowPda, minerPda, sessionTokenPda, awaitEr, awaitOwnerIs, l1Send, DLP_PROGRAM_ID,
} from "@ansem/sdk";
// ...import the same env/admin/config/keeper-open helpers used by devnet-round.it.ts...

const RUN = process.env.ENTRY_BATCH_IT === "1";
(RUN ? describe : describe.skip)("one-popup batched entry (devnet)", () => {
  it("session mint + join + delegate in ONE tx lands on a keeper-opened round", async () => {
    // --- setup (mirror devnet-round.it.ts) ---
    const conn = new Connection(process.env.ANCHOR_PROVIDER_URL!, "confirmed");
    // load admin, wait for keeper-opened OPEN+delegated round -> roundId, validator
    // fund a fresh player and deposit (wallet-signed), as in the IT:
    const player = Keypair.generate();
    // await fundFromAdmin(player.publicKey, 0.1 * LAMPORTS_PER_SOL);
    const pWallet = new Wallet(player);
    const l1 = createProgram(conn, pWallet);
    // await l1Send(() => depositIx(l1, player.publicKey, new BN(0.05 * LAMPORTS_PER_SOL)).signers([player]).rpc());
    const noMiner = (await fetchMiner(l1, minerPda(player.publicKey))) === null;

    // --- the batched ONE-POPUP entry ---
    const roundId = /* keeper-opened round id */ 0;
    const validator = /* cfg.validator */ (await import("@ansem/sdk")).DEFAULT_ER_VALIDATOR;
    const entry = await buildEntryInstructions(
      l1, conn, pWallet, roundId, validator, Math.floor(Date.now() / 1000) + 3600,
      { includeInitMiner: noMiner },
    );
    const tx = new Transaction().add(...entry.instructions);
    tx.feePayer = player.publicKey;
    tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
    tx.partialSign(entry.sessionSigner);   // session co-signs
    tx.partialSign(player);                // in the spike the "wallet" is a Keypair; in-browser this is wallet.signTransaction
    await l1Send(() => conn.sendRawTransaction(tx.serialize(), { skipPreflight: true }));

    // --- assertions: the batch actually did all three things ---
    const esc = await awaitEr(() => fetchEscrow(l1, escrowPda(player.publicKey)), (e) => e?.activeRound === roundId, 30, 1000);
    expect(esc?.activeRound).toBe(roundId);                         // join_round
    await awaitOwnerIs(conn, minerPda(player.publicKey), DLP_PROGRAM_ID.toBase58()); // delegate_miner
    const token = await conn.getAccountInfo(sessionTokenPda(entry.sessionSigner.publicKey, player.publicKey));
    expect(token).not.toBeNull();                                  // createSessionV2
  }, 240_000);
});
```

Add a script to `keeper/package.json`: `"entry-it": "ENTRY_BATCH_IT=1 vitest run test/entry-batch.it.ts"`.

- [ ] **Step 2: Run the spike against devnet** (keeper must be running to open rounds — start it per `app/README.md`)

Run: `source scripts/devnet-env.sh; export ANCHOR_PROVIDER_URL=https://api.devnet.solana.com; pnpm --filter @ansem/keeper entry-it`
Expected: PASS — escrow.activeRound == round, miner owned by DLP, session token exists.

- [ ] **Step 3: If it FAILS on tx size (`too large`) or compute**, do NOT split into multiple popups. Convert the entry to a **VersionedTransaction with an address-lookup table** (still one signature): build a v0 message with `TransactionMessage.compileToV0Message([lookupTable])`, `partialSign(sessionSigner)`, then wallet-sign. Re-run until green. Record the outcome (legacy vs v0) — Task 8's `enterRound` must use the proven shape.

- [ ] **Step 4: Commit the spike + record the result**

```bash
git add keeper/test/entry-batch.it.ts keeper/package.json
git commit -m "M4c(spike): devnet gate proving one-popup batched entry lands"
```

**Do not proceed to the UI tasks until this spike is green.** It is the whole reason the write path is safe to build on one popup.

---

## Task 5: App — session keypair persistence (`lib/session-store.ts`)

**Files:**
- Create: `app/src/lib/session-store.ts`
- Test: `app/src/lib/session-store.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// app/src/lib/session-store.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { Keypair } from "@solana/web3.js";
import { saveSession, loadSession, clearSession, type StoredSession } from "./session-store.js";

function fakeStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k), clear: () => m.clear(),
    key: (i) => [...m.keys()][i] ?? null, get length() { return m.size; },
  } as Storage;
}

describe("session-store", () => {
  let store: Storage;
  beforeEach(() => { store = fakeStorage(); });

  it("round-trips a session keyed by owner wallet", () => {
    const owner = Keypair.generate().publicKey.toBase58();
    const signer = Keypair.generate();
    const s: StoredSession = { owner, secretKey: Array.from(signer.secretKey), tokenPda: "TokenPda111", validUntil: 1_900_000_000 };
    saveSession(store, s);
    const back = loadSession(store, owner);
    expect(back?.tokenPda).toBe("TokenPda111");
    expect(back?.validUntil).toBe(1_900_000_000);
    expect(back?.secretKey).toEqual(s.secretKey);
  });

  it("returns null for a different owner and after clear", () => {
    const owner = Keypair.generate().publicKey.toBase58();
    const signer = Keypair.generate();
    saveSession(store, { owner, secretKey: Array.from(signer.secretKey), tokenPda: "T", validUntil: 1 });
    expect(loadSession(store, "OtherOwner")).toBeNull();
    clearSession(store, owner);
    expect(loadSession(store, owner)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it — expect FAIL** (module missing)

Run: `pnpm --filter @ansem/app test session-store`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// app/src/lib/session-store.ts
export interface StoredSession {
  owner: string;        // owner wallet base58
  secretKey: number[];  // session Keypair secret (64 bytes) — devnet only
  tokenPda: string;     // gum session token PDA base58
  validUntil: number;   // unix seconds
}

const key = (owner: string) => `ansem.session.${owner}`;

export function saveSession(store: Storage, s: StoredSession): void {
  store.setItem(key(s.owner), JSON.stringify(s));
}
export function loadSession(store: Storage, owner: string): StoredSession | null {
  const raw = store.getItem(key(owner));
  if (!raw) return null;
  try { return JSON.parse(raw) as StoredSession; } catch { return null; }
}
export function clearSession(store: Storage, owner: string): void {
  store.removeItem(key(owner));
}
```

- [ ] **Step 4: Run it — expect PASS**

Run: `pnpm --filter @ansem/app test session-store`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/session-store.ts app/src/lib/session-store.test.ts
git commit -m "M4c(app): localStorage session-keypair persistence"
```

---

## Task 6: App — amount parsing (`lib/amount.ts`)

**Files:**
- Create: `app/src/lib/amount.ts`
- Test: `app/src/lib/amount.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// app/src/lib/amount.test.ts
import { describe, it, expect } from "vitest";
import { solToLamports, lamportsToSolStr } from "./amount.js";

describe("amount", () => {
  it("parses SOL strings to a lamports BN", () => {
    expect(solToLamports("1")?.toString()).toBe("1000000000");
    expect(solToLamports("0.05")?.toString()).toBe("50000000");
    expect(solToLamports("0.000000001")?.toString()).toBe("1"); // 1 lamport
  });
  it("rejects junk / non-positive / over-precise input", () => {
    expect(solToLamports("")).toBeNull();
    expect(solToLamports("abc")).toBeNull();
    expect(solToLamports("0")).toBeNull();
    expect(solToLamports("-1")).toBeNull();
    expect(solToLamports("0.0000000001")).toBeNull(); // sub-lamport precision
  });
  it("formats lamports back to a trimmed SOL string", () => {
    expect(lamportsToSolStr(1_000_000_000n)).toBe("1");
    expect(lamportsToSolStr(50_000_000n)).toBe("0.05");
    expect(lamportsToSolStr(0n)).toBe("0");
  });
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `pnpm --filter @ansem/app test amount`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// app/src/lib/amount.ts
import { BN } from "@ansem/sdk";

const LAMPORTS_PER_SOL = 1_000_000_000n;

/** Parse a SOL string to a lamports BN. Returns null for junk, non-positive, or sub-lamport precision. */
export function solToLamports(input: string): BN | null {
  const s = input.trim();
  if (!/^\d*\.?\d*$/.test(s) || s === "" || s === ".") return null;
  const [whole, frac = ""] = s.split(".");
  if (frac.length > 9) return null; // sub-lamport precision not representable
  const lamports = BigInt(whole || "0") * LAMPORTS_PER_SOL + BigInt((frac + "000000000").slice(0, 9));
  if (lamports <= 0n) return null;
  return new BN(lamports.toString());
}

/** Format lamports as a trimmed SOL string (no trailing zeros). */
export function lamportsToSolStr(lamports: bigint): string {
  const whole = lamports / LAMPORTS_PER_SOL;
  const frac = (lamports % LAMPORTS_PER_SOL).toString().padStart(9, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}
```

- [ ] **Step 4: Run it — expect PASS**

Run: `pnpm --filter @ansem/app test amount`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/amount.ts app/src/lib/amount.test.ts
git commit -m "M4c(app): SOL<->lamports parsing helpers"
```

---

## Task 7: App — program factories (`lib/anchor.ts`)

**Files:**
- Create: `app/src/lib/anchor.ts`
- Test: `app/src/lib/anchor.test.ts`

- [ ] **Step 1: Write the failing test** (test the pure, network-free parts)

```ts
// app/src/lib/anchor.test.ts
import { describe, it, expect } from "vitest";
import { Connection, Keypair } from "@solana/web3.js";
import { erConnection, erProgramForSession } from "./anchor.js";
import { DEFAULT_ER_ENDPOINT } from "@ansem/sdk";

describe("anchor factories", () => {
  it("erConnection targets the MagicBlock regional endpoint", () => {
    const c = erConnection();
    expect(c.rpcEndpoint).toBe(DEFAULT_ER_ENDPOINT);
  });
  it("erProgramForSession builds a Program whose provider wallet is the session key (gasless fee payer)", () => {
    const sessionKp = Keypair.generate();
    const p = erProgramForSession(new Connection(DEFAULT_ER_ENDPOINT), sessionKp);
    expect(p.provider.publicKey?.equals(sessionKp.publicKey)).toBe(true);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `pnpm --filter @ansem/app test anchor`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// app/src/lib/anchor.ts
"use client";
import { useMemo } from "react";
import { Connection, Keypair } from "@solana/web3.js";
import { Wallet, type Program } from "@coral-xyz/anchor";
import { useConnection } from "@solana/wallet-adapter-react";
import { useAnchorWallet } from "@solana/wallet-adapter-react";
import {
  createProgram, createErProgram, DEFAULT_ER_ENDPOINT, DEFAULT_ER_WS_ENDPOINT, type AnsemMiner,
} from "@ansem/sdk";

/** A dedicated Connection to the MagicBlock ER (never the router — writes need the regional endpoint). */
export function erConnection(): Connection {
  const url = process.env.NEXT_PUBLIC_ER_ENDPOINT ?? DEFAULT_ER_ENDPOINT;
  const ws = process.env.NEXT_PUBLIC_ER_WS_ENDPOINT ?? DEFAULT_ER_WS_ENDPOINT;
  return new Connection(url, { wsEndpoint: ws, commitment: "confirmed" });
}

/** L1 program bound to the connected adapter wallet. `undefined` until a wallet connects. */
export function useL1Program(): Program<AnsemMiner> | undefined {
  const { connection } = useConnection();
  const wallet = useAnchorWallet();
  return useMemo(
    () => (wallet ? createProgram(connection, wallet as unknown as Wallet) : undefined),
    [connection, wallet],
  );
}

/** ER program whose provider wallet IS the session keypair → session pays fees → gasless stake, no popup. */
export function erProgramForSession(erConn: Connection, sessionKp: Keypair): Program<AnsemMiner> {
  return createErProgram(erConn, new Wallet(sessionKp));
}
```

- [ ] **Step 4: Run it — expect PASS**

Run: `pnpm --filter @ansem/app test anchor`
Expected: PASS. (`useL1Program` is a hook — not unit-tested here; it is exercised in the wiring task + runbook.)

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/anchor.ts app/src/lib/anchor.test.ts
git commit -m "M4c(app): L1/ER Anchor program factories (ER fee payer = session key)"
```

---

## Task 8: App — write orchestration (`lib/writes.ts`)

**Files:**
- Create: `app/src/lib/writes.ts`
- Test: `app/src/lib/writes.test.ts`

`enterRound` and `gaslessStake` are thin orchestrations over SDK helpers. Unit-test the **transaction assembly + signing order** (the one-popup contract) with a fake wallet + fake connection; the real network path is runbook-verified.

- [ ] **Step 1: Write the failing test**

```ts
// app/src/lib/writes.test.ts
import { describe, it, expect, vi } from "vitest";
import { Connection, Keypair, Transaction, PublicKey } from "@solana/web3.js";
import { Wallet } from "@coral-xyz/anchor";
import { createProgram, DEFAULT_ER_VALIDATOR } from "@ansem/sdk";
import { enterRound } from "./writes.js";

describe("enterRound (one-popup contract)", () => {
  it("builds ONE tx, session-co-signs, then calls wallet.signTransaction exactly once, sends skipPreflight", async () => {
    const conn = new Connection("http://127.0.0.1:8899");
    // stub the network calls used by enterRound:
    vi.spyOn(conn, "getLatestBlockhash").mockResolvedValue({ blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1 } as any);
    const sendRaw = vi.spyOn(conn, "sendRawTransaction").mockResolvedValue("sig123" as any);
    vi.spyOn(conn, "confirmTransaction").mockResolvedValue({ value: { err: null } } as any);

    const walletKp = Keypair.generate();
    const signTransaction = vi.fn(async (tx: Transaction) => { tx.partialSign(walletKp); return tx; });
    const adapter = { publicKey: walletKp.publicKey, signTransaction } as any;
    const l1 = createProgram(conn, new Wallet(walletKp));

    const res = await enterRound({
      l1, connection: conn, wallet: adapter, roundId: 7,
      validator: DEFAULT_ER_VALIDATOR, includeInitMiner: false, validUntilSec: 1_900_000_000,
      waitJoined: async () => {}, waitDelegated: async () => {}, // skip on-chain polls in the unit test
    });

    expect(signTransaction).toHaveBeenCalledTimes(1);          // ONE popup
    expect(sendRaw).toHaveBeenCalledTimes(1);
    expect(sendRaw.mock.calls[0][1]).toMatchObject({ skipPreflight: true });
    expect(res.sessionSigner).toBeInstanceOf(Keypair);
    expect(res.tokenPda).toBeInstanceOf(PublicKey);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `pnpm --filter @ansem/app test writes`
Expected: FAIL.

- [ ] **Step 3: Implement** (use the transaction shape proven green by Task 4 — legacy shown; switch to v0+ALT if Task 4 required it)

```ts
// app/src/lib/writes.ts
"use client";
import { Connection, PublicKey, Keypair, Transaction, TransactionInstruction } from "@solana/web3.js";
import type { Program } from "@coral-xyz/anchor";
import {
  buildEntryInstructions, stakeIx, escrowPda, minerPda, fetchEscrow, fetchMiner,
  awaitEr, awaitOwnerIs, erRpcTolerant, DLP_PROGRAM_ID, BN, type AnsemMiner,
} from "@ansem/sdk";

interface WalletAdapter {
  publicKey: PublicKey;
  signTransaction: <T extends Transaction>(tx: T) => Promise<T>;
}

export interface EnterRoundArgs {
  l1: Program<AnsemMiner>; connection: Connection; wallet: WalletAdapter;
  roundId: number; validator: PublicKey; includeInitMiner: boolean; validUntilSec: number;
  waitJoined?: (esc: () => Promise<unknown>) => Promise<void>;
  waitDelegated?: () => Promise<void>;
}

/** ONE-POPUP entry: build the batch, session co-sign, wallet sign (single popup), send skipPreflight, wait. */
export async function enterRound(a: EnterRoundArgs): Promise<{ sessionSigner: Keypair; tokenPda: PublicKey; validUntil: number; signature: string }> {
  const entry = await buildEntryInstructions(
    a.l1, a.connection, { publicKey: a.wallet.publicKey } as any,
    a.roundId, a.validator, a.validUntilSec, { includeInitMiner: a.includeInitMiner },
  );
  const tx = new Transaction().add(...(entry.instructions as TransactionInstruction[]));
  tx.feePayer = a.wallet.publicKey;
  tx.recentBlockhash = (await a.connection.getLatestBlockhash("confirmed")).blockhash;
  tx.partialSign(entry.sessionSigner);              // session co-signs (programmatic)
  const signed = await a.wallet.signTransaction(tx); // THE single wallet popup
  const signature = await a.connection.sendRawTransaction(signed.serialize(), { skipPreflight: true });
  await a.connection.confirmTransaction(signature, "confirmed");

  // propagation waits before the first ER stake
  if (a.waitJoined) await a.waitJoined(() => fetchEscrow(a.l1, escrowPda(a.wallet.publicKey)));
  else await awaitEr(() => fetchEscrow(a.l1, escrowPda(a.wallet.publicKey)), (e) => (e?.activeRound ?? -1) === a.roundId, 30, 1000);
  if (a.waitDelegated) await a.waitDelegated();
  else await awaitOwnerIs(a.connection, minerPda(a.wallet.publicKey), DLP_PROGRAM_ID.toBase58());

  return { sessionSigner: entry.sessionSigner, tokenPda: entry.tokenPda, validUntil: entry.validUntil, signature };
}

export interface GaslessStakeArgs {
  er: Program<AnsemMiner>; ownerWallet: PublicKey; sessionSigner: Keypair; tokenPda: PublicKey;
  square: number; amount: BN; roundId: number;
}

/** Gasless ER stake: session-signed, skipPreflight, confirmed by re-reading miner.blockStake[square]. */
export async function gaslessStake(a: GaslessStakeArgs): Promise<void> {
  const target = a.amount.toString();
  for (let i = 0; i < 12; i++) {
    const m = await fetchMiner(a.er, minerPda(a.ownerWallet));
    if (m && m.blockStake[a.square]?.toString() === target && m.roundId === a.roundId) return;
    await erRpcTolerant(() =>
      stakeIx(a.er, a.sessionSigner.publicKey, a.ownerWallet, a.square, a.amount, a.roundId, a.tokenPda)
        .rpc({ skipPreflight: true, commitment: "confirmed" }),
    );
    await new Promise((r) => setTimeout(r, 2500));
  }
  await awaitEr(() => fetchMiner(a.er, minerPda(a.ownerWallet)), (m) => m?.blockStake[a.square]?.toString() === target, 20, 2000);
}
```

- [ ] **Step 4: Run it — expect PASS**

Run: `pnpm --filter @ansem/app test writes`
Expected: PASS (one `signTransaction` call; `skipPreflight:true`).

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/writes.ts app/src/lib/writes.test.ts
git commit -m "M4c(app): enterRound (one popup) + gaslessStake orchestration"
```

---

## Task 9: App — player-state + session hooks

**Files:**
- Create: `app/src/hooks/use-player-state.ts`, `app/src/hooks/use-session.ts`
- Test: `app/src/hooks/use-player-state.test.tsx`

- [ ] **Step 1: Write the failing test** (inject a fake program so no network is needed)

```tsx
// app/src/hooks/use-player-state.test.tsx
import { describe, it, expect } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { Keypair } from "@solana/web3.js";
import { usePlayerState } from "./use-player-state.js";

describe("usePlayerState", () => {
  it("loads escrow + miner + config via injected fetchers", async () => {
    const wallet = Keypair.generate().publicKey;
    const fakeProgram = {} as any;
    const fetchers = {
      escrow: async () => ({ balance: 50_000_000n, activeRound: 7, reconciledRound: 0, lastClaimedRound: 0 } as any),
      miner: async () => ({ roundId: 7, blockStake: Array(25).fill(0n) } as any),
      config: async () => ({ currentRoundId: 7, currentRoundFinalized: false, minStake: 1000n, maxStakePerRound: 10n ** 12n } as any),
    };
    const { result } = renderHook(() => usePlayerState({ program: fakeProgram, wallet, pollMs: 0, fetchers }));
    await waitFor(() => expect(result.current.escrow?.activeRound).toBe(7));
    expect(result.current.miner?.roundId).toBe(7);
    expect(result.current.config?.currentRoundId).toBe(7);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `pnpm --filter @ansem/app test use-player-state`
Expected: FAIL.

- [ ] **Step 3: Implement both hooks**

```ts
// app/src/hooks/use-player-state.ts
"use client";
import { useEffect, useState, useCallback } from "react";
import { PublicKey } from "@solana/web3.js";
import type { Program } from "@coral-xyz/anchor";
import {
  fetchEscrow, fetchMiner, fetchConfig, escrowPda, minerPda, configPda,
  type EscrowState, type MinerState, type ConfigState, type AnsemMiner,
} from "@ansem/sdk";

interface Fetchers {
  escrow: () => Promise<EscrowState | null>;
  miner: () => Promise<MinerState | null>;
  config: () => Promise<ConfigState>;
}
export interface PlayerStateArgs {
  program: Program<AnsemMiner>; wallet: PublicKey; pollMs?: number; fetchers?: Fetchers;
}
export interface PlayerState {
  escrow: EscrowState | null; miner: MinerState | null; config: ConfigState | null; refresh: () => void;
}

export function usePlayerState({ program, wallet, pollMs = 6000, fetchers }: PlayerStateArgs): PlayerState {
  const [escrow, setEscrow] = useState<EscrowState | null>(null);
  const [miner, setMiner] = useState<MinerState | null>(null);
  const [config, setConfig] = useState<ConfigState | null>(null);

  const f: Fetchers = fetchers ?? {
    escrow: () => fetchEscrow(program, escrowPda(wallet)),
    miner: () => fetchMiner(program, minerPda(wallet)),
    config: () => fetchConfig(program, configPda()),
  };

  const refresh = useCallback(() => {
    f.escrow().then(setEscrow).catch(() => {});
    f.miner().then(setMiner).catch(() => {});
    f.config().then(setConfig).catch(() => {});
  }, [program, wallet]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    refresh();
    if (!pollMs) return;
    const id = setInterval(refresh, pollMs);
    return () => clearInterval(id);
  }, [refresh, pollMs]);

  return { escrow, miner, config, refresh };
}
```

```ts
// app/src/hooks/use-session.ts
"use client";
import { useCallback, useEffect, useState } from "react";
import { Keypair } from "@solana/web3.js";
import { isSessionValid } from "@ansem/sdk";
import { loadSession, saveSession, clearSession, type StoredSession } from "../lib/session-store.js";

export interface SessionInfo { session: StoredSession | null; signer: Keypair | null; valid: boolean; }

export function useSession(owner: string | undefined): SessionInfo & {
  persist: (s: StoredSession) => void; clear: () => void;
} {
  const [session, setSession] = useState<StoredSession | null>(null);

  const read = useCallback(() => {
    if (typeof window === "undefined" || !owner) { setSession(null); return; }
    setSession(loadSession(window.localStorage, owner));
  }, [owner]);

  useEffect(() => { read(); }, [read]);

  const persist = useCallback((s: StoredSession) => {
    if (typeof window !== "undefined") saveSession(window.localStorage, s);
    setSession(s);
  }, []);
  const clear = useCallback(() => {
    if (typeof window !== "undefined" && owner) clearSession(window.localStorage, owner);
    setSession(null);
  }, [owner]);

  const nowSec = Math.floor((typeof Date !== "undefined" ? Date.now() : 0) / 1000);
  const valid = !!session && isSessionValid(session.validUntil, nowSec);
  const signer = session ? Keypair.fromSecretKey(Uint8Array.from(session.secretKey)) : null;

  return { session, signer, valid, persist, clear };
}
```

- [ ] **Step 4: Run it — expect PASS**

Run: `pnpm --filter @ansem/app test use-player-state`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/hooks/use-player-state.ts app/src/hooks/use-session.ts app/src/hooks/use-player-state.test.tsx
git commit -m "M4c(app): usePlayerState + useSession hooks"
```

---

## Task 10: App — Escrow panel (deposit / withdraw)

**Files:**
- Create: `app/src/components/EscrowPanel.tsx`
- Test: `app/src/components/EscrowPanel.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// app/src/components/EscrowPanel.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { EscrowPanel } from "./EscrowPanel.js";

describe("EscrowPanel", () => {
  it("shows the escrow balance in SOL", () => {
    render(<EscrowPanel balanceLamports={50_000_000n} locked={false} onDeposit={vi.fn()} onWithdraw={vi.fn()} busy={false} />);
    expect(screen.getByText(/0\.05/)).toBeInTheDocument();
  });
  it("calls onDeposit with a parsed BN when Deposit is clicked", () => {
    const onDeposit = vi.fn();
    render(<EscrowPanel balanceLamports={0n} locked={false} onDeposit={onDeposit} onWithdraw={vi.fn()} busy={false} />);
    fireEvent.change(screen.getByPlaceholderText(/amount/i), { target: { value: "0.1" } });
    fireEvent.click(screen.getByRole("button", { name: /deposit/i }));
    expect(onDeposit).toHaveBeenCalledTimes(1);
    expect(onDeposit.mock.calls[0][0].toString()).toBe("100000000");
  });
  it("disables Withdraw while the escrow is round-locked", () => {
    render(<EscrowPanel balanceLamports={50_000_000n} locked onDeposit={vi.fn()} onWithdraw={vi.fn()} busy={false} />);
    expect(screen.getByRole("button", { name: /withdraw/i })).toBeDisabled();
  });
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `pnpm --filter @ansem/app test EscrowPanel`
Expected: FAIL.

- [ ] **Step 3: Implement**

```tsx
// app/src/components/EscrowPanel.tsx
"use client";
import { useState } from "react";
import type { BN } from "@ansem/sdk";
import { solToLamports, lamportsToSolStr } from "../lib/amount.js";

export interface EscrowPanelProps {
  balanceLamports: bigint; locked: boolean; busy: boolean;
  onDeposit: (lamports: BN) => void; onWithdraw: (lamports: BN) => void;
}

export function EscrowPanel({ balanceLamports, locked, busy, onDeposit, onWithdraw }: EscrowPanelProps) {
  const [amount, setAmount] = useState("");
  const parsed = solToLamports(amount);
  return (
    <section className="rounded-lg border border-white/10 p-3 flex flex-col gap-2">
      <div className="flex items-center justify-between text-sm">
        <span className="text-bull-muted tracking-widest text-[10px]">ESCROW</span>
        <span className="font-mono text-bull-green">{lamportsToSolStr(balanceLamports)} SOL</span>
      </div>
      <input
        inputMode="decimal" placeholder="amount (SOL)" value={amount}
        onChange={(e) => setAmount(e.target.value)}
        className="bg-black border border-white/15 rounded px-2 py-1 font-mono text-sm"
      />
      <div className="flex gap-2">
        <button
          disabled={busy || !parsed} onClick={() => parsed && onDeposit(parsed)}
          className="flex-1 rounded bg-bull-green/20 text-bull-green py-1 text-sm disabled:opacity-40"
        >Deposit</button>
        <button
          disabled={busy || locked || !parsed} onClick={() => parsed && onWithdraw(parsed)}
          title={locked ? "Locked while a round is active" : undefined}
          className="flex-1 rounded border border-white/15 py-1 text-sm disabled:opacity-40"
        >Withdraw</button>
      </div>
      {locked && <p className="text-[10px] text-bull-muted">Withdraw unlocks after the round finalizes.</p>}
    </section>
  );
}
```

- [ ] **Step 4: Run it — expect PASS**

Run: `pnpm --filter @ansem/app test EscrowPanel`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/components/EscrowPanel.tsx app/src/components/EscrowPanel.test.tsx
git commit -m "M4c(app): EscrowPanel (deposit/withdraw, round-lock)"
```

---

## Task 11: App — Board square selection

**Files:**
- Modify: `app/src/components/Board.tsx`
- Test: `app/src/components/Board.test.tsx` (extend existing)

- [ ] **Step 1: Add a failing test to `Board.test.tsx`**

```tsx
it("calls onSelect with the square id when a tile is clicked and highlights the selection", () => {
  const onSelect = vi.fn();
  const { container, rerender } = render(<Board snapshot={demoSnapshot} onSelect={onSelect} selectedSquare={null} />);
  const tiles = container.querySelectorAll("[data-square]");
  fireEvent.click(tiles[3]);
  expect(onSelect).toHaveBeenCalledWith(3);
  rerender(<Board snapshot={demoSnapshot} onSelect={onSelect} selectedSquare={3} />);
  expect(container.querySelector('[data-square="3"]')?.getAttribute("data-selected")).toBe("true");
});
```

(Use the existing test's `demoSnapshot`/imports; add `vi`, `fireEvent` to the imports if absent.)

- [ ] **Step 2: Run it — expect FAIL**

Run: `pnpm --filter @ansem/app test Board`
Expected: FAIL (no `onSelect`/`data-square`/`data-selected`).

- [ ] **Step 3: Implement** — add optional props to `Board.tsx` without breaking existing read-only usage:

- Extend `BoardProps` with `selectedSquare?: number | null; onSelect?: (id: number) => void;`.
- On each tile's wrapper element add `data-square={cell.id}`, `data-selected={selectedSquare === cell.id}`, and (when `onSelect`) `onClick={() => onSelect(cell.id)}` + `cursor-pointer`.
- When `selectedSquare === cell.id`, add a ring class (e.g. `ring-2 ring-bull-green`).

- [ ] **Step 4: Run it — expect PASS** (and the existing Board tests stay green)

Run: `pnpm --filter @ansem/app test Board`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/components/Board.tsx app/src/components/Board.test.tsx
git commit -m "M4c(app): Board square selection (onSelect/selected)"
```

---

## Task 12: App — Stake rail (gasless)

**Files:**
- Create: `app/src/components/StakeRail.tsx`
- Test: `app/src/components/StakeRail.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// app/src/components/StakeRail.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { StakeRail } from "./StakeRail.js";

describe("StakeRail", () => {
  it("disables Stake until a square is selected and a valid amount is entered", () => {
    const onStake = vi.fn();
    const { rerender } = render(<StakeRail selectedSquare={null} sessionValid busy={false} onStake={onStake} />);
    expect(screen.getByRole("button", { name: /stake/i })).toBeDisabled();
    rerender(<StakeRail selectedSquare={4} sessionValid busy={false} onStake={onStake} />);
    fireEvent.change(screen.getByPlaceholderText(/amount/i), { target: { value: "0.02" } });
    const btn = screen.getByRole("button", { name: /stake/i });
    expect(btn).not.toBeDisabled();
    fireEvent.click(btn);
    expect(onStake).toHaveBeenCalledWith(4, expect.objectContaining({ toString: expect.any(Function) }));
    expect(onStake.mock.calls[0][1].toString()).toBe("20000000");
  });
  it("prompts to enter the round when the session is invalid", () => {
    render(<StakeRail selectedSquare={4} sessionValid={false} busy={false} onStake={vi.fn()} />);
    expect(screen.getByText(/enter the round/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `pnpm --filter @ansem/app test StakeRail`
Expected: FAIL.

- [ ] **Step 3: Implement**

```tsx
// app/src/components/StakeRail.tsx
"use client";
import { useState } from "react";
import type { BN } from "@ansem/sdk";
import { solToLamports } from "../lib/amount.js";

export interface StakeRailProps {
  selectedSquare: number | null; sessionValid: boolean; busy: boolean;
  onStake: (square: number, amount: BN) => void;
}

export function StakeRail({ selectedSquare, sessionValid, busy, onStake }: StakeRailProps) {
  const [amount, setAmount] = useState("");
  const parsed = solToLamports(amount);
  const canStake = sessionValid && selectedSquare !== null && !!parsed && !busy;
  return (
    <section className="rounded-lg border border-white/10 p-3 flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-bull-muted tracking-widest text-[10px]">STAKE · GASLESS</span>
        <span className="font-mono text-xs text-bull-muted">
          {selectedSquare === null ? "pick a tile" : `tile #${selectedSquare + 1}`}
        </span>
      </div>
      {!sessionValid && <p className="text-[10px] text-bull-muted">Enter the round to open a gasless session.</p>}
      <input
        inputMode="decimal" placeholder="amount (SOL)" value={amount}
        onChange={(e) => setAmount(e.target.value)}
        className="bg-black border border-white/15 rounded px-2 py-1 font-mono text-sm"
      />
      <button
        disabled={!canStake} onClick={() => canStake && onStake(selectedSquare!, parsed!)}
        className="rounded bg-bull-green/20 text-bull-green py-1 text-sm disabled:opacity-40"
      >Stake · gasless</button>
    </section>
  );
}
```

- [ ] **Step 4: Run it — expect PASS**

Run: `pnpm --filter @ansem/app test StakeRail`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/components/StakeRail.tsx app/src/components/StakeRail.test.tsx
git commit -m "M4c(app): StakeRail (gasless stake input)"
```

---

## Task 13: App — Claim panel

**Files:**
- Create: `app/src/components/ClaimPanel.tsx`
- Test: `app/src/components/ClaimPanel.test.tsx`

Claimable = the player's `escrow.activeRound` (or the round they staked) reached `RoundState.Claimable` and `escrow.lastClaimedRound < roundId`. Refund = round `Closed`.

- [ ] **Step 1: Write the failing test**

```tsx
// app/src/components/ClaimPanel.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ClaimPanel } from "./ClaimPanel.js";
import { RoundState } from "@ansem/sdk";

describe("ClaimPanel", () => {
  it("offers Claim for a Claimable round the player hasn't claimed", () => {
    const onClaim = vi.fn();
    render(<ClaimPanel roundId={7} roundState={RoundState.Claimable} lastClaimedRound={0} busy={false} onClaim={onClaim} onRefund={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /claim/i }));
    expect(onClaim).toHaveBeenCalledWith(7);
  });
  it("offers Refund for a Closed round", () => {
    const onRefund = vi.fn();
    render(<ClaimPanel roundId={7} roundState={RoundState.Closed} lastClaimedRound={0} busy={false} onClaim={vi.fn()} onRefund={onRefund} />);
    fireEvent.click(screen.getByRole("button", { name: /refund/i }));
    expect(onRefund).toHaveBeenCalledWith(7);
  });
  it("shows nothing actionable before Claimable", () => {
    render(<ClaimPanel roundId={7} roundState={RoundState.Open} lastClaimedRound={0} busy={false} onClaim={vi.fn()} onRefund={vi.fn()} />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `pnpm --filter @ansem/app test ClaimPanel`
Expected: FAIL.

- [ ] **Step 3: Implement**

```tsx
// app/src/components/ClaimPanel.tsx
"use client";
import { RoundState } from "@ansem/sdk";

export interface ClaimPanelProps {
  roundId: number; roundState: RoundState; lastClaimedRound: number; busy: boolean;
  onClaim: (roundId: number) => void; onRefund: (roundId: number) => void;
}

export function ClaimPanel({ roundId, roundState, lastClaimedRound, busy, onClaim, onRefund }: ClaimPanelProps) {
  const claimable = roundState === RoundState.Claimable && lastClaimedRound < roundId;
  const refundable = roundState === RoundState.Closed;
  if (!claimable && !refundable) return null;
  return (
    <section className="rounded-lg border border-bull-gold/30 p-3 flex items-center justify-between">
      <span className="text-bull-muted tracking-widest text-[10px]">
        ROUND #{roundId} {claimable ? "· WON" : "· VOIDED"}
      </span>
      {claimable ? (
        <button disabled={busy} onClick={() => onClaim(roundId)}
          className="rounded bg-bull-gold/25 text-bull-gold px-4 py-1 text-sm disabled:opacity-40">Claim ANSEM</button>
      ) : (
        <button disabled={busy} onClick={() => onRefund(roundId)}
          className="rounded border border-white/15 px-4 py-1 text-sm disabled:opacity-40">Refund</button>
      )}
    </section>
  );
}
```

(If `bull-gold` isn't a Tailwind token yet, add `gold: "#e8c452"` under the `bull` colors in `app/tailwind.config.ts` in this task and reference `bull-gold`.)

- [ ] **Step 4: Run it — expect PASS**

Run: `pnpm --filter @ansem/app test ClaimPanel`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/components/ClaimPanel.tsx app/src/components/ClaimPanel.test.tsx app/tailwind.config.ts
git commit -m "M4c(app): ClaimPanel (claim / refund)"
```

---

## Task 14: App — wire the write column into PlayBoard

**Files:**
- Modify: `app/src/components/PlayBoard.tsx`, `app/src/components/Providers.tsx`
- Test: `app/src/components/PlayBoard.test.tsx` (extend)

- [ ] **Step 1: Allow an RPC override in Providers**

In `app/src/components/Providers.tsx`, change the endpoint line:

```tsx
const endpoint = useMemo(
  () => process.env.NEXT_PUBLIC_RPC_ENDPOINT ?? clusterApiUrl(cluster),
  [],
);
```

- [ ] **Step 2: Add a failing PlayBoard test** — the write column mounts only when a wallet is connected. Mock `useAnchorWallet` to return `undefined`, assert the write column is absent; then mock a connected wallet and assert the escrow panel appears. (Follow the existing `PlayBoard.test.tsx` pattern that already mocks `WalletBar`; add a mock for `@solana/wallet-adapter-react`'s `useAnchorWallet`/`useConnection`, and for `../lib/anchor.js` `useL1Program` to avoid real RPC.)

```tsx
it("hides the write column when no wallet is connected", () => {
  // useL1Program mocked to return undefined
  render(<PlayBoard wsUrl="ws://x" httpUrl="http://x" clientFactory={fakeClientWithSnapshot} />);
  expect(screen.queryByText(/ESCROW/)).toBeNull();
});
```

- [ ] **Step 3: Run it — expect FAIL**

Run: `pnpm --filter @ansem/app test PlayBoard`
Expected: FAIL (until the write column + gating exist).

- [ ] **Step 4: Implement the write column**

In `PlayBoard.tsx`:
- Call `const l1 = useL1Program();` and `useAnchorWallet()`.
- When `l1` + wallet exist, render a `<PlayControls l1={l1} wallet={wallet} snapshot={snapshot} />` block below the `Board` (create `PlayControls` inline in this file or as `components/PlayControls.tsx`) that:
  - `usePlayerState({ program: l1, wallet: wallet.publicKey })` → escrow/miner/config.
  - `useSession(wallet.publicKey.toBase58())` → session/valid/persist/clear.
  - Renders `EscrowPanel` (deposit → `depositIx(...).rpc()` via wallet; withdraw likewise; `locked = (escrow?.activeRound ?? 0) !== 0`).
  - Renders an **Enter round** button when `!sessionValid || escrow?.activeRound !== snapshot.roundId`: on click, `enterRound({...})` with `includeInitMiner: miner === null`, then `persist({ owner, secretKey: [...sessionSigner.secretKey], tokenPda, validUntil })` and `refresh()`.
  - Passes `selectedSquare`/`setSelectedSquare` to `Board` and renders `StakeRail`; on stake, build the ER program `erProgramForSession(erConnection(), signer!)` and call `gaslessStake({...})`, then `refresh()`.
  - Renders `ClaimPanel` for `snapshot.roundId`/player's staked round using `escrow.lastClaimedRound`; claim → `claimIx(l1, wallet.publicKey, roundId).rpc()`; refund → `refundIx(...).rpc()`.
  - A `busy` state guards buttons during each async action; surface errors in a small inline `<p className="text-red-400 text-xs">`.
- Add a "Get devnet SOL" link (`https://faucet.solana.com`) in the wallet area for onboarding.

Keep deposit/withdraw/claim/refund as **individual wallet popups** (they are separate user actions); only entry is batched to one popup.

- [ ] **Step 5: Run tests + typecheck + build**

Run: `pnpm --filter @ansem/app test && pnpm --filter @ansem/app typecheck && pnpm --filter @ansem/app build`
Expected: all green; production build succeeds.

- [ ] **Step 6: Commit**

```bash
git add app/src/components/PlayBoard.tsx app/src/components/Providers.tsx app/src/components/PlayControls.tsx app/src/components/PlayBoard.test.tsx
git commit -m "M4c(app): wire write column (escrow/entry/stake/claim) into PlayBoard"
```

---

## Task 15: Human end-to-end devnet runbook (the M4c gate)

**Files:**
- Create: `docs/superpowers/runbooks/2026-07-08-m4c-e2e-devnet.md`
- Modify: `app/README.md`

- [ ] **Step 1: Write the runbook** — a numbered checklist the human executes, each step with the exact command/action and the observable **PASS** condition:

```markdown
# M4c — human end-to-end devnet runbook

Prereqs: a Phantom/Backpack wallet set to **devnet**, and a fresh wallet with 0 SOL for the real test.

## 0. Start the backend + app
- [ ] Keeper (public RPC to dodge Helius 429):
      `source scripts/devnet-env.sh; export ANCHOR_PROVIDER_URL=https://api.devnet.solana.com WS_ENDPOINT=wss://api.devnet.solana.com; pnpm run keeper:dev`
      PASS: logs show a round OPEN + delegated.
- [ ] App: `pnpm run app:dev` → open the printed URL (`.claude/launch.json` "app" = :3100).
      PASS: board renders, "KEEPER: CONNECTED".

## 1. Connect a FRESH wallet
- [ ] Click Connect, pick your devnet wallet (a freshly created one).
      PASS: address shows; board still live.
- [ ] Fund it: use the "Get devnet SOL" link to airdrop ~0.2 SOL.
      PASS: wallet shows a devnet SOL balance.

## 2. Deposit
- [ ] Enter `0.05` in ESCROW → Deposit → approve the popup.
      PASS: ESCROW shows `0.05 SOL` after confirm.

## 3. Enter the round — ONE popup
- [ ] Click "Enter round".
      PASS: EXACTLY ONE wallet approval appears. After it confirms, session status shows "gasless · valid".

## 4. Stake — gasless (zero popups)
- [ ] Click a bull tile (it highlights) → enter `0.02` → "Stake · gasless".
      PASS: NO wallet popup. Within a few seconds the tile lights green and the pot/HUD updates live.
- [ ] Stake a second tile.
      PASS: still no popups; second tile lights.

## 5. Settle + reveal
- [ ] Wait for the deadline. Watch the keeper logs settle the round (real VRF).
      PASS: board plays the reveal; a gold jackpot flash appears on the winning tile.

## 6. Claim
- [ ] When ROUND shows "· WON", click "Claim ANSEM" → approve the popup.
      PASS: ANSEM balance appears in the wallet (import the mint if needed); ClaimPanel clears.

## 7. Recovery sanity (optional)
- [ ] If a round ever voids (Closed), the panel offers "Refund"; click → approve.
      PASS: escrow SOL is restored (withdrawable again).

## Result
All PASS = M4c done → proceed to M4d (reveal polish + deploy).
```

- [ ] **Step 2: Update `app/README.md`** — add a "Write path (M4c)" section: the env vars (`NEXT_PUBLIC_RPC_ENDPOINT`, `NEXT_PUBLIC_ER_ENDPOINT`), the one-popup entry model, gasless staking, and a pointer to the runbook.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/runbooks/2026-07-08-m4c-e2e-devnet.md app/README.md
git commit -m "M4c: human e2e devnet runbook + README write-path docs"
```

- [ ] **Step 4: Execute the runbook yourself** (the human gate). This is the verification the user asked for before M4d. If any PASS condition fails, stop and fix before declaring M4c done.

---

## Task 16: Final review + suite

- [ ] **Step 1:** `pnpm --filter @ansem/sdk test && pnpm --filter @ansem/keeper test && pnpm --filter @ansem/app test && pnpm --filter @ansem/app typecheck && pnpm --filter @ansem/app build` — all green.
- [ ] **Step 2:** Dispatch a `superpowers:code-reviewer` subagent over the M4c diff (SDK entry batch, `writes.ts` signing order, session storage, the write column). Address Critical/Important findings.
- [ ] **Step 3:** Announce completion via `superpowers:finishing-a-development-branch` (branch stays `m4-frontend`; M4d continues on it).

---

## Self-review notes (author)

- **Spec §8 M4c coverage:** deposit/withdraw (T10), `init_miner` (folded into T2/T8 entry, idempotent), batched L1 entry (T2/T4/T8 — one popup per the user's locked decision), gasless session staking (T8/T12), claim (T13). Human e2e (T15) = the spec's "a human connects a fresh wallet, funds it, stakes gaslessly, and claims ANSEM" acceptance.
- **Deviation from spec §2 wording:** spec says "one batched L1 popup"; the working tests do 3 separate txs. Per the user (2026-07-08), one popup is non-negotiable, so T2 batches them and T4 proves the batch on devnet before UI. If the batch can't fit a legacy tx, T4 escalates to v0+ALT (still one popup) — never a split.
- **Gasless fee-payer:** ER program provider wallet = the session keypair (T7), so `stake` needs no wallet popup. Verified live in T15 step 4; if the ER rejects a zero-balance session fee payer, dust-fund the session key inside `enterRound` (add a `SystemProgram.transfer` ix to the entry batch) — noted here so it stays one popup.
- **Type consistency:** `BatchedEntry`/`enterRound`/`gaslessStake`/`usePlayerState`/`useSession`/`EscrowPanelProps`/`StakeRailProps`/`ClaimPanelProps` names are used consistently across tasks. `solToLamports`/`lamportsToSolStr` names match between T6 and T10/T12.
