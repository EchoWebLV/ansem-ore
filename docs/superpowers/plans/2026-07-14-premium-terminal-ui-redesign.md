# BullStake Premium Terminal UI Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current neon crypto-arcade presentation with the approved premium betting terminal while preserving every existing game, wallet, keeper, reveal, claim, refund, receipt, and accessibility behavior.

**Architecture:** Keep all hooks, SDK calls, transaction builders, state gates, and public component props unchanged. Refactor only component markup and presentation classes, with shared terminal design tokens in Tailwind and `globals.css`; use existing component tests as behavioral regression gates and add focused accessible-output tests for intentional presentation changes.

**Tech Stack:** Next.js 14 App Router, React 18, TypeScript, Tailwind CSS 3, Vitest, Testing Library, Solana wallet adapter.

## Global Constraints

- Do not change Solana instructions, SDK behavior, keeper behavior, wallet behavior, or transaction construction.
- Do not change stake, claim, refund, reveal, jackpot, leaderboard, receipt, countdown, audio, or honest-outcome logic.
- Preserve public props, `data-testid` values, ARIA labels, disabled states, and keyboard behavior.
- Use system sans-serif for interface copy and monospace only for countdowns, amounts, addresses, round IDs, and transaction references.
- Use charcoal, warm off-white, one restrained green, and jackpot-only gold.
- Remove ambient dust, perspective grid, board floating, cursor tilt, glare, and continuous breathing effects.
- Retain stateful motion for selection, loading, reveal, and jackpot finale, with `prefers-reduced-motion` support.
- Do not add dependencies, routes, backend endpoints, game mechanics, analytics, or persistent state.
- Preserve the user's unrelated modifications in `tests/ansem-miner.ts`, `tests/direct-stake.ts`, and `tests/mainnet-path.ts`.

## File structure

- `app/tailwind.config.ts`: canonical premium-terminal color tokens.
- `app/src/app/globals.css`: shared terminal surfaces, buttons, typography, focus states, wallet overrides, and retained stateful animation.
- `app/src/components/PhaseNav.tsx`: compact product header with brand, current location, sound, and wallet controls.
- `app/src/components/Stage.tsx`: static board container with no pointer-driven transform.
- `app/src/components/PlayBoard.tsx`: responsive terminal composition and desktop grid placement.
- `app/src/components/Hud.tsx`: compact round, state, countdown/reveal, and pool header.
- `app/src/components/Board.tsx`: preserved board behavior with restrained static styling.
- `app/src/components/StakeRail.tsx`: bet-slip selection summary, amount field, total, and primary action.
- `app/src/components/PlayControls.tsx`: terminal framing for balance, gates, errors, and claim/refund surfaces without logic changes.
- `app/src/components/{JackpotMeter,Leaderboard,ActivityFeed,VerifyPanel,ClaimPanel,ListingBanner,WinTicker,SoundToggle}.tsx`: consistent secondary terminal presentation.
- `app/src/components/{PhaseNav,PlayBoard,Board,StakeRail,Panels,ClaimPanel}.test.tsx`: regression and intentional output contracts.

---

### Task 1: Establish terminal tokens and compact header

**Files:**
- Modify: `app/tailwind.config.ts`
- Modify: `app/src/app/globals.css`
- Modify: `app/src/components/PhaseNav.tsx`
- Modify: `app/src/components/PhaseNav.test.tsx`

**Interfaces:**
- Consumes: `PhaseNav({ children?: ReactNode })` and the existing `/bullstake-logo.svg` asset.
- Produces: unchanged `PhaseNav` props; shared CSS classes `terminal-panel`, `terminal-label`, `terminal-focus`, and `terminal-primary` for later tasks.

- [ ] **Step 1: Replace phase-roadmap tests with the compact-header contract**

Update `app/src/components/PhaseNav.test.tsx` so its behavioral assertions are:

```tsx
it("marks Play as the current product location without advertising unshipped phases", () => {
  render(<PhaseNav />);
  expect(screen.getByText("Play")).toHaveAttribute("aria-current", "page");
  expect(screen.queryByText(/phase ii/i)).toBeNull();
  expect(screen.queryByText(/phase iii/i)).toBeNull();
});

it("keeps the brand logo and renders sound/wallet children", () => {
  const { container } = render(<PhaseNav><button>WALLET</button></PhaseNav>);
  expect(container.querySelector('img[src="/bullstake-logo.svg"]')).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /wallet/i })).toBeInTheDocument();
});
```

Keep the existing BullStake wordmark test.

- [ ] **Step 2: Run the focused test and confirm it fails**

Run:

```bash
pnpm --filter @ansem/app test -- PhaseNav.test.tsx
```

Expected: FAIL because the old component still renders Phase I, Phase II, and Phase III and has no `Play` location label.

- [ ] **Step 3: Replace the phase selector with the compact product header**

Implement `PhaseNav` with this structure while keeping its signature unchanged:

```tsx
export function PhaseNav({ children }: { children?: ReactNode }) {
  return (
    <nav data-testid="phase-nav" aria-label="BullStake" className="terminal-topbar">
      <div className="flex min-w-0 items-center gap-3">
        <img src="/bullstake-logo.svg" alt="" width={36} height={36} aria-hidden className="shrink-0" />
        <div className="min-w-0">
          <div className="text-[16px] font-bold tracking-[-0.02em] text-bull-ink">
            Bull<span className="text-bull-green">Stake</span>
          </div>
          <div className="terminal-label mt-1">ANSEM MINER</div>
        </div>
      </div>
      <span aria-current="page" className="hidden text-[12px] font-semibold text-bull-ink sm:block">Play</span>
      <div className="flex items-center justify-end gap-2">{children}</div>
    </nav>
  );
}
```

Retain the existing `@next/next/no-img-element` exception comment immediately above the image.

- [ ] **Step 4: Define the terminal color and shared component tokens**

Change the `bull` palette in `app/tailwind.config.ts` to:

```ts
bull: {
  green: "#a8f080",
  gold: "#d6b75f",
  bg: "#0a0b0a",
  surface: "#111310",
  raised: "#161916",
  dim: "#344035",
  muted: "#92978f",
  edge: "#292d28",
  ink: "#f2f1e9",
},
```

In `globals.css`, set the page background and add these shared classes:

```css
:root { color-scheme: dark; }
html, body { background: #0a0b0a; color: #f2f1e9; }
body { font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }

@layer components {
  .terminal-topbar {
    @apply flex min-h-[60px] items-center justify-between gap-4 border-b border-bull-edge px-4 lg:px-0;
  }
  .terminal-panel { @apply rounded-[14px] border border-bull-edge bg-bull-surface; }
  .terminal-label { @apply text-[10px] font-semibold uppercase tracking-[0.14em] text-bull-muted; }
  .terminal-primary { @apply rounded-[10px] bg-bull-green px-4 py-3 text-[13px] font-bold text-[#0b1209] disabled:cursor-not-allowed disabled:opacity-40; }
}

:where(button, a, input, [data-square]):focus-visible {
  outline: 2px solid #a8f080;
  outline-offset: 3px;
}
```

Remove the `.abstract-bg`, `.bg-aura`, `.dust`, `.grid-floor`, `.vignette`, `.stage-glare`, `.board-float`, and their associated keyframes. Keep reveal, jackpot ring, gold finale, ticker, sound, and wallet-adapter rules, but change wallet buttons from pill-shaped to `10px` radius and remove their persistent glow shadow.

- [ ] **Step 5: Run header tests and the stylesheet syntax gate**

Run:

```bash
pnpm --filter @ansem/app test -- PhaseNav.test.tsx
pnpm --filter @ansem/app typecheck
```

Expected: both commands PASS.

- [ ] **Step 6: Commit the header and visual foundation**

```bash
git add app/tailwind.config.ts app/src/app/globals.css app/src/components/PhaseNav.tsx app/src/components/PhaseNav.test.tsx
git commit -m "feat(app): establish premium terminal visual system"
```

---

### Task 2: Recompose the responsive terminal shell and board HUD

**Files:**
- Modify: `app/src/components/Stage.tsx`
- Modify: `app/src/components/PlayBoard.tsx`
- Modify: `app/src/components/Hud.tsx`
- Modify: `app/src/components/PlayBoard.test.tsx`
- Modify: `app/src/components/Hud.test.tsx`

**Interfaces:**
- Consumes: existing `PlayBoardProps`, keeper snapshot state, `RevealView`, wallet/program gates, and all current child component props.
- Produces: unchanged props and data flow; stable landmarks `data-testid="terminal-shell"`, `aria-label="Round board"`, `aria-label="Betting and claims"`, and `aria-label="Round information"`.

- [ ] **Step 1: Add shell and ambient-removal regression assertions**

In `PlayBoard.test.tsx`, replace the abstract-backdrop test with:

```tsx
it("renders the terminal shell without the removed ambient layers", () => {
  const factory = (): KeeperClient => ({ start: () => {}, stop: () => {} });
  render(<PlayBoard wsUrl="ws://x" httpUrl="http://x" clientFactory={factory} />);
  expect(screen.getByTestId("terminal-shell")).toBeInTheDocument();
  expect(screen.queryByTestId("abstract-bg")).toBeNull();
});
```

In the connected write-column test, also assert:

```tsx
expect(screen.getByLabelText("Betting and claims")).toBeInTheDocument();
```

Keep every existing keeper, board, wallet-gating, replay, countdown, liveness, and verification assertion.

- [ ] **Step 2: Run shell and HUD tests and confirm the new shell test fails**

Run:

```bash
pnpm --filter @ansem/app test -- PlayBoard.test.tsx Hud.test.tsx
```

Expected: FAIL because `terminal-shell` and the betting landmark do not exist and `abstract-bg` is still rendered.

- [ ] **Step 3: Make `Stage` a static wrapper**

Replace the pointer-tracking implementation with:

```tsx
import type { ReactNode } from "react";

export function Stage({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={`stage ${className ?? ""}`}>{children}</div>;
}
```

No pointer events, animation frame, inline transform, or glare element remains.

- [ ] **Step 4: Recompose `PlayBoard` without changing its state or callbacks**

Keep every hook, local state value, `addReceipt`, `toggleSquare`, reveal override, and child prop unchanged. Replace only the returned layout with this hierarchy:

```tsx
<main data-testid="terminal-shell" className="mx-auto flex min-h-screen max-w-[1430px] flex-col gap-3 px-4 pb-8 text-bull-ink lg:px-7">
  <PhaseNav><SoundToggle /><WalletBar /></PhaseNav>
  <ListingBanner />
  {snapshot ? (
    <>
      <div className="terminal-status-strip flex items-center gap-3 border-b border-bull-edge py-2">
        <div className="flex shrink-0 items-center gap-2">
          <span className={`h-1.5 w-1.5 rounded-full ${liveness.dot}${liveness.pulse ? " animate-pulse" : ""}`} aria-hidden />
          <span className="terminal-label">{liveness.label}</span>
        </div>
        <div className="h-4 w-px shrink-0 bg-bull-edge" aria-hidden />
        <WinTicker events={events.length ? events : snapshot.recentEvents} />
      </div>
      <div className="grid items-start gap-3 lg:grid-cols-[minmax(190px,232px)_minmax(520px,1fr)_minmax(284px,326px)]">
        <section aria-label="Round board" className="lg:col-start-2 lg:row-start-1 lg:row-span-4">
          <Stage className="w-full">
            <div className="terminal-panel overflow-hidden">
              <Hud snapshot={reveal.snapshotOverride ?? snapshot} nowMs={nowMs} reveal={reveal} />
              <Board
                snapshot={reveal.snapshotOverride ?? snapshot}
                selectedSquares={selected}
                onSelect={reveal.snapshotOverride ? undefined : canPlay ? toggleSquare : undefined}
                revealed={reveal.revealed}
                jackpotShown={reveal.jackpotShown}
                revealMode={reveal.mode}
              />
              {reveal.canReplay && reveal.revealed === null && (
                <div className="border-t border-bull-edge p-3 text-center">
                  <button onClick={reveal.replay} className="rounded-[9px] border border-bull-edge bg-bull-raised px-4 py-2 text-[12px] font-semibold text-bull-ink hover:border-bull-green">
                    Replay reveal
                  </button>
                </div>
              )}
            </div>
          </Stage>
        </section>
        {canPlay && (
          <section aria-label="Betting and claims" className="lg:col-start-3 lg:row-start-1">
            <PlayControls l1={l1!} wallet={wallet as unknown as WalletAdapter} snapshot={snapshot} selectedSquares={selected} onStaked={() => setSelected([])} onReceipt={addReceipt} />
          </section>
        )}
        <div className="lg:col-start-1 lg:row-start-1"><JackpotMeter rolloverJackpot={snapshot.rolloverJackpot} triggerOdds={snapshot.jackpotTriggerOdds} /></div>
        <div className="lg:col-start-1 lg:row-start-2"><Leaderboard leaderboard={snapshot.leaderboard} /></div>
        <div className={canPlay ? "lg:col-start-3 lg:row-start-2" : "lg:col-start-3 lg:row-start-1"}><ActivityFeed events={events.length ? events : snapshot.recentEvents} /></div>
        <div className="lg:col-start-1 lg:row-start-3"><VerifyPanel roundId={snapshot.roundId} receipts={receipts} /></div>
      </div>
    </>
  ) : (
    <section aria-label="Round board">
      <Stage className="mx-auto w-full max-w-[680px]">
        <div className="terminal-panel overflow-hidden">
          <header className="grid min-h-[78px] grid-cols-[1fr_auto_1fr] items-center border-b border-bull-edge px-4 py-3">
            <div><span className="terminal-label">Round</span><strong className="mt-1 block font-mono text-[14px]">— · CONNECTING</strong></div>
            <div className="text-center"><span className="terminal-label">Linking</span><div className="mt-1 animate-pulse font-mono text-[28px]">--:--</div></div>
            <div className="text-right"><span className="terminal-label">Pool</span><strong className="mt-1 block font-mono text-[14px]">—</strong></div>
          </header>
          <Board snapshot={SKELETON_SNAP} />
        </div>
      </Stage>
    </section>
  )}
</main>
```

The mobile DOM order must be board, `PlayControls` when connected, jackpot, leaderboard, activity, verification. Desktop grid placement restores the approved left, center, and right rails. Remove all ambient layer elements and `board-float` wrappers. Keep the gold finale element because it communicates a real jackpot result.

- [ ] **Step 5: Convert `Hud` to the compact board header**

Use the current `open`, `settling`, `gold`, countdown, state label, reveal counter, and reveal sub values unchanged. Render them in:

```tsx
<header className="grid min-h-[78px] grid-cols-[1fr_auto_1fr] items-center border-b border-bull-edge px-4 py-3" aria-label="Round information">
  <div>
    <span className="terminal-label">Round</span>
    <strong className="mt-1 block font-mono text-[14px] font-semibold">#{snapshot.roundId} · {stateLabel(snapshot.state)}</strong>
  </div>
  <div className="text-center">
    <span className="terminal-label">{open ? "Closes in" : settling ? "Settling" : "Result"}</span>
    <div className="mt-1 font-mono text-[28px] font-medium tabular-nums" style={{ color: gold ? "#d6b75f" : "#f2f1e9" }}>
      {reveal?.counter ?? (open ? <Countdown deadlineTs={snapshot.deadlineTs} nowMs={nowMs} /> : "—")}
    </div>
    {reveal?.sub && <div className="mt-1 text-[10px] text-bull-muted">{reveal.sub.text}</div>}
  </div>
  <div className="text-right">
    <span className="terminal-label">Pool</span>
    <strong className="mt-1 block font-mono text-[14px] font-semibold">{formatSol(snapshot.pot)}</strong>
  </div>
</header>
```

For settling without reveal copy, render `the bull awaits…` beneath the center value. Do not render jackpot values in `Hud`.

- [ ] **Step 6: Run shell and HUD regression tests**

Run:

```bash
pnpm --filter @ansem/app test -- PlayBoard.test.tsx Hud.test.tsx
pnpm --filter @ansem/app typecheck
```

Expected: both commands PASS with one countdown, one liveness surface, intact replay behavior, and unchanged wallet gating.

- [ ] **Step 7: Commit the responsive shell**

```bash
git add app/src/components/Stage.tsx app/src/components/PlayBoard.tsx app/src/components/Hud.tsx app/src/components/PlayBoard.test.tsx app/src/components/Hud.test.tsx
git commit -m "feat(app): compose premium terminal play layout"
```

---

### Task 3: Restrain the board while preserving all tile and reveal behavior

**Files:**
- Modify: `app/src/components/Board.tsx`
- Modify: `app/src/app/globals.css`
- Modify: `app/src/components/Board.test.tsx`

**Interfaces:**
- Consumes: unchanged `BoardProps`, `svgCells()`, and sound functions.
- Produces: unchanged tile IDs, `data-*` state attributes, click callbacks, reveal cascade, jackpot ring, and audio side effects; adds `data-testid="bull-board"` to the SVG.

- [ ] **Step 1: Add the restrained-board contract**

Add to `Board.test.tsx`:

```tsx
it("uses the terminal board surface without continuous live breathing", () => {
  const blockSol = Array(25).fill("0"); blockSol[3] = "60";
  render(<Board snapshot={snap({ blockSol })} />);
  expect(screen.getByTestId("bull-board")).toBeInTheDocument();
  expect(screen.getByTestId("tile-3").querySelector(".glow-live")).toBeNull();
});
```

Keep all existing 25-tile, staked, jackpot, extrusion, selection, reveal, and audio tests.

- [ ] **Step 2: Run the board test and confirm it fails**

Run:

```bash
pnpm --filter @ansem/app test -- Board.test.tsx
```

Expected: FAIL because the SVG does not have the new test ID and a staked tile still receives `glow-live`.

- [ ] **Step 3: Apply the restrained board surface**

In `Board.tsx`:

- Add `data-testid="bull-board"` to the root SVG.
- Change the SVG classes to `block w-full select-none touch-manipulation bg-[#0e100e] px-2 py-4 lg:px-5 lg:py-6`.
- Remove `className={revealSet === null && lit ? "glow-live" : undefined}` from the halo polygon.
- Keep `data-depth`, `cell-face`, `lift`, `pop`, `burst`, `jackpot-ring`, `onClick`, sound effects, and every state calculation unchanged.
- Use warm white for selected strokes, `#a8f080` for live stake, `#d6b75f` for real jackpot, `#344035` for idle borders, and reduce halo opacity by using `rgba(168,240,128,0.55)`.

In `globals.css`, remove `.glow-live` and `@keyframes glow-live`. Keep `.cell-face.pop`, `.cell-face.burst`, `.jackpot-ring`, and `.bull-eye`, but reduce the eye animation to a static `opacity: .62` declaration. Update the reduced-motion selector to list only retained animated classes.

- [ ] **Step 4: Run the board and reveal regressions**

Run:

```bash
pnpm --filter @ansem/app test -- Board.test.tsx PlayBoard.test.tsx use-reveal.test.tsx SoundToggle.test.tsx
```

Expected: PASS, including selection callbacks, jackpot-vs-rollover audio, persistent replay, and honest reveal behavior.

- [ ] **Step 5: Commit the board polish**

```bash
git add app/src/components/Board.tsx app/src/app/globals.css app/src/components/Board.test.tsx
git commit -m "feat(app): refine bull board for terminal UI"
```

---

### Task 4: Present existing staking and resolution actions as a bet slip

**Files:**
- Modify: `app/src/components/StakeRail.tsx`
- Modify: `app/src/components/PlayControls.tsx`
- Modify: `app/src/components/ClaimPanel.tsx`
- Modify: `app/src/components/StakeRail.test.tsx`
- Modify: `app/src/components/PlayBoard.test.tsx`
- Test: `app/src/components/ClaimPanel.test.tsx`
- Test: `app/src/components/PlayControls.test.tsx`

**Interfaces:**
- Consumes: unchanged `StakeRailProps`, `PlayControlsProps`, `ClaimPanelProps`, amount helpers, and transaction callbacks.
- Produces: unchanged callback values and gates; accessible primary copy `Place bet · one approval`.

- [ ] **Step 1: Update the bet-slip output contract without weakening callback assertions**

In `StakeRail.test.tsx`, change the primary button query to `/place bet · one approval/i` and add:

```tsx
expect(screen.getByText("#05")).toBeInTheDocument();
expect(screen.getByText("#10")).toBeInTheDocument();
expect(screen.getByText(/0.04 SOL total/i)).toBeInTheDocument();
```

Keep the assertion that `onStake` receives `[4, 9]` and exactly `20000000` lamports per square. In `PlayBoard.test.tsx`, update only the visible stake-button queries from `/stake · one approval/i` to `/place bet · one approval/i`.

- [ ] **Step 2: Run staking tests and confirm the new copy/chip assertions fail**

Run:

```bash
pnpm --filter @ansem/app test -- StakeRail.test.tsx PlayControls.test.tsx PlayBoard.test.tsx ClaimPanel.test.tsx
```

Expected: FAIL because the current action says `Stake · one approval` and selected tile chips are not rendered.

- [ ] **Step 3: Restyle `StakeRail` as the bet slip without changing amount state or `onStake`**

Keep `amount`, `solToLamports`, `n`, `canStake`, and `onStake(selectedSquares, parsed!)` unchanged. Render:

```tsx
<section className="terminal-panel p-4">
  <div className="mb-4 flex items-center justify-between">
    <h2 className="text-[14px] font-semibold text-bull-ink">Bet slip</h2>
    <span className="terminal-label">{n} {n === 1 ? "tile" : "tiles"}</span>
  </div>
  <div className="flex min-h-8 flex-wrap gap-1.5">
    {selectedSquares.length === 0
      ? <span className="text-[11px] text-bull-muted">Select tiles on the board</span>
      : selectedSquares.map((square) => <span key={square} className="rounded-[7px] border border-bull-dim bg-bull-raised px-2 py-1 font-mono text-[11px] text-bull-green">#{String(square + 1).padStart(2, "0")}</span>)}
  </div>
  <label htmlFor="stake-amount" className="mb-2 mt-4 block text-[11px] text-bull-muted">Amount per tile</label>
  <div className="flex items-center rounded-[10px] border border-bull-edge bg-bull-bg px-3 focus-within:border-bull-green">
    <input id="stake-amount" inputMode="decimal" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} className="min-w-0 flex-1 bg-transparent py-3 font-mono text-[18px] text-bull-ink outline-none" />
    <span className="text-[11px] font-semibold text-bull-muted">SOL</span>
  </div>
  {n > 0 && parsed && <p className="mt-3 flex justify-between text-[11px] text-bull-muted"><span>{n} × {amount} SOL</span><strong className="font-mono text-bull-ink">{formatSol(parsed.muln(n).toString())} total</strong></p>}
  <button disabled={!canStake} onClick={() => canStake && onStake(selectedSquares, parsed!)} className="terminal-primary mt-4 w-full">Place bet · one approval</button>
</section>
```

- [ ] **Step 4: Restyle `PlayControls` and `ClaimPanel` without moving logic**

In `PlayControls`, keep every effect, calculation, gate, and handler unchanged. Replace its return with:

```tsx
return (
  <div className="flex flex-col gap-3">
    {walletLamports !== null && (
      <div className="flex items-center justify-between px-1 text-[10px] text-bull-muted">
        <span>Wallet balance</span>
        <span className="font-mono">{lamportsToSolStr(walletLamports)} SOL</span>
      </div>
    )}
    <StakeRail selectedSquares={selectedSquares} enabled={!stakeBlocked} busy={busy} onStake={doStake} />
    {!loaded ? (
      <p className="px-1 text-[10px] text-bull-muted">Checking your prior round…</p>
    ) : priorUnresolved ? (
      <p className="px-1 text-[10px] text-amber-400">{gateCopy}</p>
    ) : snapshot.state !== RoundState.Open ? (
      <p className="px-1 text-[10px] text-bull-muted">Round is settling. Betting opens with the next round.</p>
    ) : null}
    {offerable && stakedRoundState !== null && (
      <ClaimPanel roundId={stakedRound} roundState={stakedRoundState} lastClaimedRound={0} claimByTs={claimByTs} won={won} busy={busy} onClaim={doClaim} onRefund={doRefund} />
    )}
    {CLUSTER !== "mainnet-beta" && (
      <a href="https://faucet.solana.com" target="_blank" rel="noreferrer" className="self-end text-[10px] text-bull-muted underline">Get devnet SOL</a>
    )}
    {err && <p role="alert" className="break-words px-1 text-xs text-red-400">{err}</p>}
  </div>
);
```

In `ClaimPanel`, keep `claimable`, `refundable`, `tag`, callbacks, and labels unchanged. Replace its return with:

```tsx
return (
  <section className={`terminal-panel flex flex-col gap-3 p-4 ${won === true && claimable ? "border-bull-gold/50" : ""}`}>
    <span className="terminal-label">Round #{roundId} {tag}</span>
    {claimable ? (
      <div className="flex flex-wrap items-center justify-between gap-3">
        {claimByTs !== undefined && <ClaimCountdown deadlineTs={claimByTs} nowMs={nowMs} />}
        {won === false ? (
          <button disabled={busy} onClick={() => onClaim(roundId)} className="rounded-[9px] border border-bull-edge bg-bull-raised px-4 py-2 text-sm disabled:opacity-40">Clear round</button>
        ) : (
          <button disabled={busy} onClick={() => onClaim(roundId)} className={won === true ? "rounded-[9px] bg-bull-gold px-4 py-2 text-sm font-bold text-[#141109] disabled:opacity-40" : "rounded-[9px] border border-bull-edge bg-bull-raised px-4 py-2 text-sm disabled:opacity-40"}>Claim ANSEM</button>
        )}
      </div>
    ) : (
      <button disabled={busy} onClick={() => onRefund(roundId)} className="self-start rounded-[9px] border border-bull-edge bg-bull-raised px-4 py-2 text-sm disabled:opacity-40">Refund</button>
    )}
  </section>
);
```

- [ ] **Step 5: Run staking, claim, refund, and gate tests**

Run:

```bash
pnpm --filter @ansem/app test -- StakeRail.test.tsx PlayControls.test.tsx PlayBoard.test.tsx ClaimPanel.test.tsx
pnpm --filter @ansem/app typecheck
```

Expected: PASS, including exact lamport conversion, disabled-state behavior, prior-round gate, honest no-win copy, claim callback, and refund callback.

- [ ] **Step 6: Commit the bet slip**

```bash
git add app/src/components/StakeRail.tsx app/src/components/PlayControls.tsx app/src/components/ClaimPanel.tsx app/src/components/StakeRail.test.tsx app/src/components/PlayBoard.test.tsx
git commit -m "feat(app): present staking as a focused bet slip"
```

---

### Task 5: Unify secondary panels and responsive details

**Files:**
- Modify: `app/src/components/JackpotMeter.tsx`
- Modify: `app/src/components/Leaderboard.tsx`
- Modify: `app/src/components/ActivityFeed.tsx`
- Modify: `app/src/components/VerifyPanel.tsx`
- Modify: `app/src/components/ListingBanner.tsx`
- Modify: `app/src/components/WinTicker.tsx`
- Modify: `app/src/components/SoundToggle.tsx`
- Modify: `app/src/components/Panels.test.tsx`
- Test: `app/src/components/JackpotMeter.test.tsx`
- Test: `app/src/components/ListingBanner.test.tsx`
- Test: `app/src/components/WinTicker.test.tsx`
- Test: `app/src/components/SoundToggle.test.tsx`

**Interfaces:**
- Consumes: current component props and formatting helpers.
- Produces: unchanged text, links, events, odds, sound callback, and ticker filtering; consistent `terminal-panel` presentation.

- [ ] **Step 1: Add semantic table-style panel assertions**

In `Panels.test.tsx`, keep existing content assertions and add:

```tsx
expect(screen.getByRole("heading", { name: "Leaderboard" })).toBeInTheDocument();
expect(screen.getByRole("heading", { name: "Recent activity" })).toBeInTheDocument();
```

Rename the rendered `ActivityFeed` heading from `ACTIVITY` to `Recent activity`; do not change event ordering or `eventToText`.

- [ ] **Step 2: Run panel tests and confirm the renamed activity heading fails**

Run:

```bash
pnpm --filter @ansem/app test -- Panels.test.tsx JackpotMeter.test.tsx ListingBanner.test.tsx WinTicker.test.tsx SoundToggle.test.tsx
```

Expected: FAIL because the current activity heading is `ACTIVITY`.

- [ ] **Step 3: Apply the shared terminal panel hierarchy**

For `JackpotMeter`, `Leaderboard`, `ActivityFeed`, and `VerifyPanel`:

- root: `terminal-panel p-4`;
- heading: sentence case, `text-[12px] font-semibold text-bull-ink`;
- metadata: `terminal-label`;
- rows: `border-b border-bull-edge/70 py-2 last:border-0`;
- addresses and values remain monospace;
- jackpot value remains gold, with no shadow;
- empty states remain visible and keep their current meaning;
- verification links and every receipt remain unchanged.

For `ListingBanner`, use a thin gold-accented terminal notice with no emoji and retain the configured-time and expiry conditions. For `WinTicker`, keep event filtering and marquee behavior but reduce its contrast and stop the marquee under `prefers-reduced-motion`. For `SoundToggle`, retain its pressed state and click callback while using a compact square bordered button with the same accessible name.

- [ ] **Step 4: Run all secondary-panel regression tests**

Run:

```bash
pnpm --filter @ansem/app test -- Panels.test.tsx JackpotMeter.test.tsx ListingBanner.test.tsx WinTicker.test.tsx SoundToggle.test.tsx VerifyPanel.test.tsx
```

Expected: PASS with unchanged formatting, event order, countdown retirement, ticker filtering, sound state, and explorer links.

- [ ] **Step 5: Commit the secondary surfaces**

```bash
git add app/src/components/JackpotMeter.tsx app/src/components/Leaderboard.tsx app/src/components/ActivityFeed.tsx app/src/components/VerifyPanel.tsx app/src/components/ListingBanner.tsx app/src/components/WinTicker.tsx app/src/components/SoundToggle.tsx app/src/components/Panels.test.tsx
git commit -m "feat(app): unify terminal information panels"
```

---

### Task 6: Verify the complete player story and production build

**Files:**
- Modify only if a verification failure identifies a regression in an app file already listed above.

**Interfaces:**
- Consumes: the completed premium terminal UI.
- Produces: evidence that automated behavior, production compilation, desktop hierarchy, mobile ordering, and disconnected state all work.

- [ ] **Step 1: Run the complete app test suite**

Run:

```bash
pnpm --filter @ansem/app test
```

Expected: all app Vitest files PASS with zero failures.

- [ ] **Step 2: Run type checking**

Run:

```bash
pnpm --filter @ansem/app typecheck
```

Expected: exit code 0 and no TypeScript errors.

- [ ] **Step 3: Run the production build**

Run:

```bash
pnpm --filter @ansem/app build
```

Expected: exit code 0 and a successful Next.js production build.

- [ ] **Step 4: Inspect the live UI at desktop and mobile widths**

Start the app with `pnpm --filter @ansem/app dev`. Use a local read-only mock keeper snapshot on port 8787 containing round 142, an open deadline, a nonzero pool, selected live tiles, a jackpot, leaderboard rows, and no wallet mutation. Inspect at 1440 × 1000 and 390 × 844.

Verify:

- desktop has a compact header and left/center/right terminal hierarchy;
- mobile order is board, betting action when connected, jackpot, leaderboard, activity, verification;
- the 25 tile board is fully visible with no horizontal overflow;
- the disconnected keeper state preserves the last snapshot and shows one reconnection status;
- no dust, grid floor, board tilt, glare, or continuous breathing is visible;
- wallet modal, sound toggle, tile selection, amount input, disabled state, replay, claim/refund surfaces, and explorer links remain reachable;
- selected tiles use green and actual jackpot state alone uses gold;
- focus rings are visible and reduced motion disables retained nonessential animation.

- [ ] **Step 5: Review the final diff for scope and user-owned changes**

Run:

```bash
git diff HEAD~5 -- app
git status --short
```

Expected: only presentation and intentional accessible-copy changes under `app/`; the pre-existing modified root test files remain modified but unstaged and uncommitted.

- [ ] **Step 6: Commit any verification-only corrections**

If Step 1 through Step 5 required corrections, stage only the corrected app files and commit:

```bash
git commit -m "fix(app): close premium terminal verification gaps"
```

If no corrections were needed, do not create an empty commit.
