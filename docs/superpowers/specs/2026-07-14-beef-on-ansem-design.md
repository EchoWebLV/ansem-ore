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

### D10 — Listing: BEEF/ANSEM pool on Meteora DAMM v2 (LIST DAY, date = operator's call)
Verified feasible 2026-07-14:
- DAMM v2 supports custom quote mints (docs) and permissionless Token-2022 with metadata-pointer/transfer-fee extensions.
- ANSEM's only extensions: `metadataPointer` + `tokenMetadata` (on-chain check) → inside permissionless support.
- ANSEM depth: 20 SOL quote ≈ 0.02% price impact through 3 Meteora DLMM pools.

Mechanics: single-sided **BEEF** seed from the treasury's mined share → fee scheduler armed (high start, decaying — anti-snipe) → **burn/permanently lock the LP position**. Net effect: every SOL↔BEEF trade routes through ANSEM; ANSEM accumulating in the burned pool is locked forever. Honest coupling note: buys route through ANSEM *and sells route back out* — fates chained both directions; accepted as thesis alignment.

Build-time verifications: fee-scheduler on custom-quote pool configs, single-sided create parameters, Jupiter new-pool indexing lag (day-one trades go direct on Meteora).

### D11 — LATER menu (explicitly out of launch scope; each an independent ship)
- **Referral system (top priority — ZINC-proven growth loop):** share-link codes; referrer earns a slice of the referee's BEEF mints, paid from the treasury's 20% cut (no new inflation, no program change — keeper-tracked ledger + periodic treasury payouts; on-chain memo tag on stakes for attribution).
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
6. Seed jackpot ~2 SOL via stake-and-roll.
7. Announce: mining live + listing date; build-in-public thread.
8. LIST DAY: pool script (create DAMM v2 BEEF/ANSEM custom-quote pool, single-sided treasury seed, fee scheduler, burn LP). Verify Jupiter routing after indexing.

## Operator cost

2 SOL jackpot seed + transaction fees (≈0.1 SOL buffer). Everything else is minted or revenue-funded.

## Open items pinned to build

- One-VRF-request-per-round invariant (verify in code; fairness claim depends on it).
- Idle-round cost at 60s cadence (confirm empty rounds skip VRF).
- Meteora custom-quote + fee-scheduler + single-sided exact config (script dry-run).
- BEEF name/symbol/logo asset from operator.
