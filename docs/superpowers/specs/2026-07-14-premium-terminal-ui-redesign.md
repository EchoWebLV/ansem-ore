# BullStake Premium Terminal UI Redesign

**Status:** Approved on 2026-07-14

## Goal

Redesign the BullStake application as a restrained premium betting terminal while preserving all existing gameplay, wallet, keeper, reveal, claim, refund, verification, accessibility, and responsive behavior.

The board remains the memorable product surface. Everything around it becomes quieter, more structured, and easier to scan.

## Scope

### In scope

- Replace the current neon crypto-arcade styling with a premium terminal visual system.
- Rework the desktop and mobile information hierarchy.
- Make the bet placement flow the obvious primary action.
- Consolidate repeated panel styling into shared design primitives.
- Reduce decorative animation and background effects.
- Improve typography, spacing, labels, inputs, buttons, and empty states.
- Keep the bull board, its selection states, and the reveal sequence visually prominent.
- Preserve current component behavior and public contracts.

### Out of scope

- Changes to Solana instructions, SDK behavior, keeper behavior, wallet behavior, or transaction construction.
- Changes to stake, claim, refund, reveal, jackpot, leaderboard, receipt, or countdown logic.
- New game mechanics, routes, persistent state, analytics, dependencies, or backend endpoints.
- Copy changes that alter the meaning of financial actions or on-chain outcomes.
- Removing verification or safety information.

## Design direction

The approved direction is the first visual companion mock, called **Premium Terminal**.

The interface uses charcoal surfaces, warm off-white text, one restrained green action color, and gold only for real jackpot information. It avoids animated grid floors, floating cards, cursor tilt, ambient dust, excessive glow, and decorative phase controls.

The intended character is confident, dense, and legible. It should feel like a purpose-built betting product rather than a collection of futuristic UI effects.

## Visual system

### Color

- Page background: near-black charcoal.
- Primary surface: slightly raised charcoal.
- Secondary surface: a subtle lighter charcoal for inputs and nested controls.
- Text: warm off-white.
- Muted text: neutral gray with accessible contrast.
- Primary action and active selection: soft electric green.
- Jackpot: muted gold, used only for jackpot value and jackpot outcomes.
- Errors and warnings: semantic red and amber, unchanged in meaning.

Glow is limited to short-lived reveal feedback and a subtle board selection halo. Static cards, navigation, wallet controls, and ordinary text do not glow.

### Typography

- Use the existing system sans-serif stack for navigation, headings, explanatory copy, labels, and buttons.
- Use monospace only for countdowns, token and SOL values, addresses, round identifiers, and transaction references.
- Use sentence case for actions and headings.
- Reserve uppercase tracking for small status labels only.
- Establish a clear type scale instead of composing most of the UI from 9 to 12 pixel uppercase text.

### Shape and depth

- Cards share one border, radius, background, and padding system.
- Primary controls use a medium radius rather than pills.
- Depth comes from tone and spacing, not large shadows.
- Dividers organize dense data without wrapping every fact in a separate card.

### Motion

Keep motion that communicates state:

- tile selection feedback;
- live stake updates;
- reveal cascade;
- jackpot finale;
- loading and transaction progress;
- ticker movement when enabled.

Remove motion that is purely atmospheric:

- drifting dust;
- scrolling perspective floor;
- persistent board floating;
- cursor-driven stage tilt and glare;
- persistent breathing on ordinary staked tiles.

All retained motion continues to respect `prefers-reduced-motion`.

## Desktop layout

The desktop application uses a compact header followed by a three-column terminal.

### Header

- BullStake brand at left.
- A restrained `Play` location label in the center. Do not add inactive navigation destinations in this delivery.
- Network status and wallet control at right.
- Remove the Phase I, Phase II, and Phase III segmented control from the primary header.

### Left rail

- Rolling jackpot card.
- Compact round statistics.
- Leaderboard.
- On-chain verification remains available below the leaderboard or through a compact expandable section.

### Center stage

- The bull board is the dominant surface.
- A compact board header contains the round identifier, state, pool, and countdown using the existing snapshot fields.
- The board retains all 25 tile identifiers and interaction states.
- The board footer contains the selection legend, replay action when available, and a provably fair or verify link.

### Right rail

- The betting controls become a clearly labeled bet slip.
- Selected tiles render as removable chips.
- Amount-per-tile input, quick amount actions, total stake, balance context, and transaction fee context are grouped together.
- The primary button uses explicit financial copy based on current state while preserving the existing single-transaction staking behavior.
- Claim and refund panels continue to replace or accompany the bet slip when the player has an unresolved prior round.
- Recent activity appears below the bet slip.

### Liveness

Keeper connection state remains visible but compact. The recent wins ticker can share the same strip without becoming the strongest element on the page.

## Mobile layout

Mobile uses the same information hierarchy in one column:

1. Compact brand, status, sound, and wallet header.
2. Current round summary.
3. Bull board.
4. Bet slip or claim/refund action.
5. Jackpot and secondary statistics.
6. Leaderboard, activity, and verification in compact expandable sections.

The header must not wrap into a large phase-selector block. The board remains usable at 320 CSS pixels. Tap targets remain at least 44 CSS pixels where practical, and the wallet adapter modal remains visually compatible.

## Component mapping

The redesign keeps the existing component boundaries unless a purely presentational extraction reduces duplication.

| Existing component | Redesign responsibility |
|---|---|
| `PlayBoard` | New terminal grid and responsive ordering; no data-flow changes. |
| `PhaseNav` | Compact product header; remove unreleased phase controls. |
| `Stage` | Remains the board container, with cursor tilt and glare disabled. |
| `Hud` | Compact pool, countdown, and round-state header. |
| `Board` | Preserve tile IDs and state logic; update static appearance and reduce continuous effects. |
| `PlayControls` | Preserve all gates and transaction callbacks; present content as a bet slip. |
| `StakeRail` | Selected chips, amount field, total, and primary action hierarchy. |
| `ClaimPanel` / `EscrowPanel` | Restyle only; preserve state and action semantics. |
| `JackpotMeter` | Restrained jackpot card with gold reserved for the jackpot value. |
| `Leaderboard` | Dense ranked table. |
| `ActivityFeed` / `WinTicker` | Quieter secondary live information. |
| `VerifyPanel` | Compact verification surface; all links and receipts remain available. |
| `WalletBar` / `SoundToggle` | Compact header controls with existing behavior. |

## Functionality preservation contract

The redesign must not change:

- keeper snapshot and WebSocket handling;
- wallet connection and wallet adapter integration;
- square selection and multi-select behavior;
- amount parsing and lamport conversion;
- wallet balance polling and fee headroom checks;
- stake eligibility gates;
- direct stake transaction construction;
- receipt creation and explorer links;
- prior unresolved round detection;
- win/no-win determination;
- claim and refund transaction construction;
- claim deadline calculation;
- reveal timing, replay eligibility, and honest outcome rules;
- jackpot data interpretation;
- audio behavior and sound preference;
- all public props used by tests;
- existing `data-testid`, ARIA labels, disabled states, and keyboard behavior unless a test-backed equivalent is introduced.

Presentational refactors must keep business logic in the current hooks and libraries. The UI may derive display labels and totals from existing values but must not reimplement financial or state-machine logic.

## Error, loading, and disconnected states

- The real board geometry remains visible during the initial keeper connection.
- Disconnection never hides the last valid snapshot.
- Reconnecting status is visible without turning the whole page into an error state.
- Wallet, staking, claim, and refund errors remain adjacent to the relevant action.
- Disabled buttons explain why the action is unavailable through existing nearby state copy.
- Long addresses, transaction errors, and token values wrap or truncate without breaking the terminal grid.

## Accessibility

- Preserve semantic buttons, links, headings, regions, and form labels.
- Maintain a visible keyboard focus state on every interactive control.
- Do not communicate selected, jackpot, error, or connection states by color alone.
- Meet WCAG AA contrast for ordinary text and controls.
- Preserve the board's accessible name and tile interaction semantics.
- Respect reduced motion and touch input.

## Testing and verification

### Automated

- Keep the existing app component and hook tests passing.
- Add or update focused tests for the new header, layout contracts, bet-slip labels, and responsive ordering only where behavior or accessible output changes.
- Run app tests, type checking, and production build.
- Run `pnpm --filter @ansem/app test`, `pnpm --filter @ansem/app typecheck`, and `pnpm --filter @ansem/app build` from the repository root.

### Manual

- Compare the implementation with the approved premium terminal mock at desktop and mobile widths.
- Verify disconnected keeper, live open round, settling, reveal, replay, jackpot, empty leaderboard, connected wallet, disconnected wallet, stake error, unresolved prior round, claimable win, no-win clear, and refundable round states.
- Verify tile selection, amount entry, staking, wallet modal, sound toggle, claim, refund, explorer links, and reduced motion.

## Acceptance criteria

- The visual hierarchy clearly prioritizes the board and the current player action.
- The interface no longer relies on ambient neon effects for its identity.
- Desktop reads as a coherent three-column terminal.
- Mobile reaches the board and primary action quickly without a wrapping phase header.
- Gold appears only for jackpot information and outcomes.
- Existing gameplay, wallet, reveal, claim, refund, verification, and keeper functionality remains intact.
- Existing automated tests pass, with focused updates only for intentional presentation changes.
- Type checking and production build pass.
