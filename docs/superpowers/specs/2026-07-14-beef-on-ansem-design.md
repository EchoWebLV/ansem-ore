# $BEEF on $ANSEM — mined-token launch design

Date: 2026-07-14 · Status: user-approved in conversation · Repo: ansem-ore (mainnet program live)

## Summary

ANSEM Miner adds a second token, **$BEEF**, mined by playing. **$ANSEM stays the prize** — winners are paid in market-bought ANSEM (live today, unchanged). BEEF **mints fresh every round** to everyone who staked, pro-rata, on a pot-scaled saturating curve with an on-chain hard cap. Launch is **mine-first**: no pool at day 0; BEEF lists days later against **ANSEM** (not SOL) on Meteora DAMM v2 with a single-sided seed, anti-snipe fee scheduler, and a **burned LP**. The rollover jackpot becomes a randomly-triggered **jackpot round** event with a bet-scaled cap. Game fee rises 1% → 5%.

Player story (the whole game):
1. Bet SOL on the grid → hit the block → paid in ANSEM.
2. Every round you play mines you BEEF.
3. Misses feed the jackpot; random jackpot rounds pay it out big.

## Decisions (each user-approved)

### D1 — Engine: mint-on-emission (ORE/ZINC model)
Program PDA (`vault_authority`) holds the BEEF mint authority forever. The "mint authority enabled" scanner flag is **accepted** — verified comps carry it at scale (ORE ~$38.9M mcap; ZINC $18M deployed in 2 weeks). Counter-story: open source + OtterSec-verified build + cap enforced on-chain.

### D2 — Emission curve (pot-scaled, saturating)
Per-round emission:

```
emission = (MAX_ROUND_MINT * pot / (pot + S)) * (HARD_CAP - minted_total) / HARD_CAP
// integer math, u128 intermediates; the second factor is the ZINC-style
// continuous difficulty decay: every BEEF mined makes the next round leaner.
// At genesis the factor is 1 (full emission); it decays asymptotically toward
// the cap — no halving cliff, and launch week is provably the richest window.
```

- `MAX_ROUND_MINT = 210 BEEF` (210_000_000 base units)
- `S = 1 SOL` (1_000_000_000 lamports) — half-max at 1 SOL pot
- `HARD_CAP = 21_000_000 BEEF` — minting stops at cap; `emission = min(emission, cap_remaining)`
- Decimals: **6**. Classic SPL token (both comps classic; widest tooling compat).
- Dust rounds mint dust → min-bet farming of emission is worthless by construction.
- Constants live on-chain in BeefConfig; `beef_minted_total` tracks cap usage.

### D3 — Split at mint: 80% players / 20% treasury
- 80% of each round's emission → that round's stakers **pro-rata by stake** (winners included; existing `beef_share` math retained).
- 20% → treasury ATA, minted at stamp time. **Continuous cut**: no genesis bag, no vesting program, treasury grows only as the game runs. 100% of supply is mined.
- Existing hold-to-grow bonus retained unchanged.

### D4 — Minimal-diff mint mechanics
`stamp_beef` (keeper crank, per round) mints the round's emission: players' 80% into the program BEEF vault, treasury's 20% straight to the treasury ATA, then stamps the round exactly as the dormant vault-drip design did. `roll_beef` / `claim_beef` and the roll-ordering invariant **stay as built** — claims transfer from the vault buffer. Only the vault's funding source changes (mint CPI instead of pre-funded balance). `sweep_beef_excess` is removed or gated (no pre-funded excess exists in the minted model).

### D5 — Fee: 1% → 5% + dial
- New `set_fee_bps` admin ix (missing today — fee currently needs an upgrade to change).
- Set to 500 bps at launch. Comps: ZINC 11%, ORE ~12% — "lowest rake in the genre" stays true.

### D6 — Jackpot: random-trigger + bet-scaled cap (Motherlode pattern)
Replaces "any winner drains the whole rollover every round" (current code), which is blanket-farmable: cover 25 squares at 0.02 SOL → guaranteed full 2 SOL take for ~0.025 SOL fee. Fix:

- **Trigger**: a round pays the jackpot only if a VRF-derived draw (from the round's existing randomness bytes, sampled post-close) passes. Default odds **1-in-25**. Non-trigger rounds: rollover untouched, keeps growing from misses/forfeits (existing behavior).
- **Bite cap**: jackpot take = `min(rollover, JACKPOT_CAP_MULT × stake_on_winning_square)`. Default **100×**. Remainder keeps rolling.
- Both dials admin-settable via `set_jackpot_params`.
- Farm math (spec-level proof): guaranteeing the pot requires blanketing **every** round at full size (trigger unknowable pre-close); at 1-in-25 odds + 5% fee, expected cost ≈ 2.5 SOL per 2 SOL extracted → unprofitable at any jackpot size, scaling with the jackpot itself.
- Invariant to verify at build: **exactly one randomness request per round** is possible on-chain (no keeper re-roll fishing). The fairness claim depends on it.

### D7 — Jackpot seed
~2 SOL worth of ANSEM seeded at launch by the operator via **stake-and-roll** (stake rounds, let misses roll in — zero new code; ~96% expected transfer). A permissionless `seed_jackpot` donate ix + UI button is LATER-menu. Jackpot is denominated in ANSEM (verified in `finalize_swap_accounting`): seeding = public ANSEM market-buy.

### D8 — Liveness package
- Round duration 300s → **60s** (`setRoundDuration`, admin call). Verify idle-round cost at 60s cadence first (empty rounds cancel + reap without VRF — confirm).
- App: jackpot odometer (ANSEM + USD), round countdown, live win ticker (snapshot `recentEvents` already exists), BEEF drip counter, listing-countdown banner.
- Kill the "public devnet transaction" copy in VerifyPanel (mainnet app says "devnet" today).

### D9 — Keeper: stale-floor auto-refresh (live bug, pre-BEEF)
`min_swap_rate` is a static floor set at init (182,446,494 ANSEM/SOL) while market moved (~285M measured 2026-07-14): players guaranteed only ~64% of market, and an ANSEM pump would force keeper overpayment or halt settlement. Fix: keeper loop quotes Jupiter periodically and calls `set_min_swap_rate` (keeper IS config.admin) when drift exceeds a threshold (e.g. floor kept at 90–95% of market, updated when off by >5%).

### D10 — Listing: BEEF/ANSEM pool on Meteora DAMM v2 (pool created DAY 0, trading self-opens on LIST DAY)
Verified feasible 2026-07-14 — all claims below checked against the deployed damm-v2 program source + installed `@meteora-ag/cp-amm-sdk@1.4.5` (dry-runs in `scripts/meteora-list.mjs`):
- Custom-quote (ANSEM) customizable pools are permissionless; ANSEM's only Token-2022 extensions (`metadataPointer` + `tokenMetadata`) sit inside the program's extension allowlist.
- Fee scheduler is a pool-creation param; single-sided base-only seed supported (`initSqrtPrice == sqrtMinPrice`); **permanent lock is irreversible on-chain and atomic with creation** (`isLockLiquidity: true` — zero unlock window). Fees on locked liquidity stay claimable forever (treasury revenue).
- ANSEM depth: 20 SOL quote ≈ 0.02% price impact through 3 Meteora DLMM pools.

**Squat risk + fix (day-0 creation with future activation):** Meteora allows exactly ONE customizable pool per pair (PDA from sorted mints). Mine-first makes the BEEF mint public on day 0 while listing waits — that gap would let anyone squat the canonical BEEF/ANSEM pool. Fix, all verified in program source: create the pool **on day 0** with `activationPoint` = list-day timestamp — swaps are rejected on-chain until activation (we run no alpha vault, so no early window exists); positions CAN be created/added/permanently-locked pre-activation while nobody (including us) can remove liquidity pre-activation; the fee-scheduler decay clock anchors at ACTIVATION, so list day opens at the full anti-snipe cliff. Constraint: activation ≤ **31 days** after creation (program max) — the listing date must be fixed before day 0 (it was being announced day 0 anyway; the app countdown banner uses the same timestamp). Timing detail that makes us structurally first: the treasury receives its 20% BEEF directly at the first round's stamp — before any player can complete a claim — so the pool (dust seed, permanent-locked) is created minutes into launch, before anyone else can hold BEEF. Pre-list, the treasury's accumulated mined BEEF is added as a second permanently-locked single-sided position (`--add-locked-position`, refuses if any ANSEM would be required). LIST DAY needs no action: the pool self-activates.

Mechanics recap: single-sided **BEEF** seed from the treasury's mined share → fee scheduler armed (default 50%→1% over 1h; do not raise start above 5000 bps without checking the live pool's `fee_version` cap) → permanently locked LP. Net effect: every SOL↔BEEF trade routes through ANSEM; ANSEM accumulating in the locked pool is locked forever. Honest coupling note: buys route through ANSEM *and sells route back out* — fates chained both directions; accepted as thesis alignment.

Remaining list-day verification: Jupiter new-pool indexing lag (day-one trades go direct on Meteora).

### D11 — LATER menu (explicitly out of launch scope; each an independent ship)
- **Referral system (top priority — ZINC-proven growth loop):** share-link codes; referrer earns a slice of the referee's BEEF mints, paid from the treasury's 20% cut (no new inflation, no program change — keeper-tracked ledger + periodic treasury payouts; on-chain memo tag on stakes for attribution).
- **Winnings→BEEF button (post-listing):** claim panel offers one-tap ANSEM→BEEF through our own DAMM v2 pool — winnings become BEEF buying power instead of routing back to SOL, and the ANSEM side accrues in the burned LP. Client-side swap only, no program change. Guardrail: never ship a winnings→SOL button in our own UI — the ANSEM game selling ANSEM from its own app is unacceptable optics.
- **Direct ANSEM staking (program upgrade, data-gated):** the structural fix for winner re-bet friction — accept ANSEM stakes straight into the payout pool (it is already the prize currency: no swap, no sell pressure), valued at lamport-equivalents via the keeper-refreshed `min_swap_rate` floor (D9). Adds a second currency-unit bridge through pot/emission/jackpot math (the bug class D6's cap needed), so it ships only if the winner repeat-stake metric (keeper-tracked: claim → next-stake per wallet) shows winners aren't coming back.
- Buyback crank: fee SOL → SOL→ANSEM→BEEF (buys ANSEM by construction — replaced the tithe design) → **90% burn / 10% stakers**.
- BEEF staking (no-lockup, revenue-funded yield).
- `seed_jackpot` permissionless donate ix + "Feed the Jackpot" UI + donor ticker.
- Treasury dashboard (SOL / ANSEM / BEEF balances public).
- Claim-rescue bounty (anyone can checkpoint a player's unclaimed round in the final hours for a tiny fee — ORE pattern; today unclaimed forfeits to rollover at 24h).
- Bonus-draw sink (pay BEEF to enter a second lottery — ZINC Stockpile pattern).
- LST (Jito/Marinade) on idle treasury SOL.

### D12 — Trust guardrails
- Prize vault / player obligations are never deployed into yield. House never farms money it may owe.
- Emission constants + verified-build links published. Player-facing copy never surfaces mint plumbing or session lifecycle.

## Program changes (single upgrade)

1. BEEF mint layer: mint CPI in `stamp_beef` (vault 80% / treasury ATA 20%), cap accounting (`beef_minted_total ≤ HARD_CAP`), emission formula, BeefConfig fields (constants + treasury pubkey).
2. `set_fee_bps` admin ix.
3. Jackpot trigger + bite cap in the `finalize_swap_accounting` path + config fields + `set_jackpot_params` admin ix.
4. Devnet-feature mock paths stay green (mock mint flows for tests).
5. TDD throughout; extend mainnet-path suite: mint correctness, cap invariant, 80/20 split, trigger draw determinism, bite cap, fee change.
6. Ship: `cargo build-sbf --arch v3 --tools-version v1.54` → upgrade → OtterSec re-verify → IDL regen → SDK update.

## SDK / keeper / app changes

- SDK: BEEF ixs against the real minted model; jackpot params; fee setter; export new config fields.
- Keeper: floor auto-refresh loop (D9); BEEF stamp crank per round; snapshot additions (BEEF per round, jackpot odds, cap, listing timestamp).
- App: BEEF balance + claim (bundle `rollBeef` first — ordering invariant), jackpot odometer + jackpot-round reveal, countdown, ticker, listing banner, devnet copy fix.

## Launch checklist (ordered)

1. Program upgrade: built (TDD green) → deployed → OtterSec-verified.
2. BEEF mint created via init ix (classic SPL, 6 decimals, authority = program PDA); metadata + logo set (**logo asset needed from operator**).
3. Init BeefConfig; `set_fee_bps 500`; `setRoundDuration 60`; `set_jackpot_params (25, 100)`.
4. Keeper redeploy (Railway) with new cranks; app redeploy (Vercel).
5. Mainnet dust-round E2E: stake → settle → BEEF minted 80/20 → claim lands. (Jackpot trigger force-tested on devnet only.)
6. **Immediately after the first stamped round** (treasury holds BEEF before any player claim is possible): `meteora-list.mjs` with `ACTIVATION_TS` = list-day timestamp — dust-seed pool created + permanently locked, canonical BEEF/ANSEM address secured, trading dead until activation. Listing date must be fixed by now (≤ 31 days out).
7. Seed jackpot ~2 SOL via stake-and-roll.
8. Announce: mining live + listing date; build-in-public thread.
9. Day before LIST DAY: `meteora-list.mjs --add-locked-position` — treasury's mined BEEF added single-sided + permanently locked (script refuses if any ANSEM would be pulled).
10. LIST DAY: nothing to run — pool self-activates at `ACTIVATION_TS` with the full fee cliff. Verify Jupiter routing after indexing.

## Operator cost

2 SOL jackpot seed + transaction fees (≈0.1 SOL buffer). Everything else is minted or revenue-funded.

## Open items pinned to build

- One-VRF-request-per-round invariant (verify in code; fairness claim depends on it).
- Idle-round cost at 60s cadence (confirm empty rounds skip VRF).
- ~~Meteora custom-quote + fee-scheduler + single-sided exact config~~ — VERIFIED 2026-07-14 (see D10; scripts committed and dry-run tested).
- BEEF name/symbol/logo asset from operator.
- **Listing date from operator — now required BEFORE day 0** (baked into the pool's activation point; ≤ 31 days after creation).
