# ANSEM Miner — Mainnet Launch: Full Costs & Preparation

> Status (2026-07-09): program + BEEF layer green on devnet (`beef-vault-emission` branch,
> 12/12 + 7/7 + 22 cargo + 46 keeper tests). Mainnet is blocked on the **Phase 0 program
> work** below — money is not the gate, the missing economics layer is.
> All SOL figures verified 2026-07-09 (mainnet RPC `solana rent`, SOL ≈ $77).

---

## 1. TL;DR — the money

### Capital (one-time / revolving — mostly recoverable)

| Item | SOL | ~USD | Notes |
|---|---|---|---|
| Program rent (856 KB binary) | **5.96** | $460 | locked while deployed; refundable via `solana program close` |
| Deploy buffer (transient) | ~6.0 | — | needed during deploy, **refunded** after |
| Deploy tx + priority fees | ~0.2–0.4 | $25 | one-time |
| Initialize + PDAs + multisig + BEEF vault accounts | ~0.1 | $8 | one-time dust |
| Round-rent revolving float (24 h claim window @60s) | ~4.1 | $320 | recycles forever once `close_round` ships |
| Keeper fee float (buffer) | ~5 | $385 | working capital |
| ANSEM payout inventory buffer | ~1–2 | $100 | working capital for buyback swaps |
| **Liquid needed on deploy day** | **~22** | **~$1,700** | ~6 of it comes back (buffer) |

### Optional: the $BEEF buy (pump.fun, mainnet)

| Item | SOL | ~USD |
|---|---|---|
| Creation fee | 0.02 | $1.50 |
| Dev-buy 500M (50% of 1B) by curve math (30 virtual SOL / 1.073B tokens) | ~26.2 | $2,020 |
| 1% curve fee | ~0.26 | $20 |
| **BEEF subtotal** | **~26.5** | **~$2,040** |

**Grand total with 50% BEEF buy: ~50 SOL ≈ $3,850.** Smaller BEEF % scales that line down.

### Daily operating cost (after Phase 0 janitor ships)

| Cadence | Tx fees | VRF (0.0005 SOL/request, verified) | Total/day | ~USD/day |
|---|---|---|---|---|
| 60 s rounds | 0.045 | 0.72 | **~0.77 SOL** | ~$59 |
| 5-min rounds | 0.009 | 0.144 | **~0.15 SOL** | ~$12 |
| 5-min + admin-settle (no VRF) | 0.009 | 0 | **~0.01 SOL** | ~$1 |

⚠️ Without the `close_round` janitor, ADD rent burn: +4.1 SOL/day (60s) / +0.82 (5-min).
The 1% pot fee offsets: e.g. 60s+VRF is fully covered above ~77 SOL/day of stake volume.

### Monthly fiat (services)

| Service | ~USD/mo |
|---|---|
| RPC (Helius/Alchemy mainnet — free tier may survive 5-min cadence, verify request volume) | $0–50 |
| Railway (keeper) | $5–10 |
| Vercel (app) | $0–20 |
| **Total** | **~$5–80** |

### The honest extra line

| Item | ~USD | Notes |
|---|---|---|
| Security audit (market range for a program this size) | $10k–50k | not a quote; OtterSec/Neodyme/Sec3/Accretion tier. Alternative: launch capped + audit before uncapping |

---

## 2. HARD BLOCKERS — program work before any mainnet deploy (Phase 0)

Verified against `lib.rs` / `swap.rs` this session:

1. **Real-ANSEM payout layer.** `execute_swap_mock` MINTS a PDA mock token; it cannot pay
   real $ANSEM (`9cRCn9rGT8V2…`). `SWAP_MODE_JUPITER` is a reserved constant with no
   instruction. Build v1 = keeper buyback: treasury SOL → Jupiter-buy real ANSEM →
   deposit `payout_vault`; new `execute_swap_real` pays by **transfer** from inventory,
   proceeds = actual swap result (bounded/verifiable to limit keeper trust).
2. **Treasury exit.** Pot SOL flows into the `treasury` PDA and there is **no withdrawal
   instruction** — real SOL would strand. Add admin-gated sweep (feeds the buyback).
3. **`close_round` janitor + claim window.** Reclaim round rent (see table above);
   closing ends late claims — window must match the existing forfeit model (a player
   forfeits an unclaimed round anyway the moment they restake). Also: skip creating/
   stamping rounds when the previous round had `pot == 0` (quiet hours ≈ free).
4. **Settle path.** Verify MagicBlock VRF **mainnet** queue address (devnet queue constant
   `Cuj97ggr…` is devnet infra; cost verified 0.0005 SOL/request) — or add keeper
   admin-`settle` mode (free, but "trust the keeper" randomness; fine capped, weak later).
5. **Strip devnet-only instructions for the mainnet build**: `close_config`,
   `set_round_cursor` (admin-gated but pure attack surface on mainnet).
6. **Tests for all of the above + full regression** (same TDD loop as the BEEF layer).

## 3. DECISIONS needed (owner: you)

| Decision | Recommendation |
|---|---|
| Payout model green-light | keeper-buyback v1 (above) |
| Round cadence at launch | **5-min** on mainnet day 1 (cuts VRF+fees 5×), tighten with volume |
| Claim window before round close | 24–72 h |
| Repo public (required for verified badge) | yes, at deploy time — repo currently has **no GitHub remote at all** |
| Audit vs capped launch | launch capped (max_stake ~0.5–1 SOL, small vault fill), audit before uncapping |
| BEEF dev-buy size | your call — 50% = ~26.5 SOL all-in at current curve |
| Multisig signers (Squads) | ≥2-of-3, hardware keys, publish address |
| Launch caps | `min_stake` 0.01 SOL, `max_stake_per_round` LOW (not the 100 SOL default) |

## 4. LAUNCH SEQUENCE (one by one)

### Phase 0 — build (blockers above)
- [ ] Write + execute implementation plan (swap layer, treasury exit, janitor, settle, strip devnet ixs)
- [ ] Full devnet regression green; deploy to devnet; soak with the beta

### Phase 1 — program to mainnet
- [ ] Merge `beef-vault-emission` (done building; already green)
- [ ] Create GitHub repo, push, make **public**; confirm `Cargo.lock` committed (✅ tracked)
- [ ] Create Squads multisig; collect signer keys
- [ ] Fund deploy wallet ~22 SOL liquid
- [ ] `solana-verify build --library-name ansem_miner` (Docker; deploy THIS .so, never `anchor build`)
- [ ] `solana program deploy -u <MAINNET_RPC> target/deploy/ansem_miner.so --program-id 8Q9En…`
- [ ] `solana program set-upgrade-authority … --new-upgrade-authority <SQUADS>`
- [ ] `solana-verify verify-from-repo … --commit-hash <sha> --library-name ansem_miner --mount-path programs/ansem-miner` → PDA upload
- [ ] `solana-verify remote submit-job …` → **Verified badge** (before any future freeze — ORE lesson: their frozen program has no badge)
- [ ] `initialize`; `_config.mjs --launch-defaults` (band 0,0 WTA, cadence per decision); set launch caps

### Phase 2 — services
- [ ] Mainnet RPC key (Helius/Alchemy); check request volume vs tier
- [ ] Keeper → Railway: mainnet env (`KEEPER_DIRECT_MODE=1`, RPC, funded keeper wallet, VRF queue or settle mode)
- [ ] App → Vercel: mainnet cluster env (RPC, program ID, explorer links — every `NEXT_PUBLIC_*`)
- [ ] **Dust e2e with your own wallet: stake → settle → swap → claim REAL ANSEM lands. Go/no-go gate.**

### Phase 3 — $BEEF (needs Phase 1 done first — the vault must exist on mainnet)
- [ ] `solana-keygen grind --starts-with BEEF:1`
- [ ] Pump.fun: create $BEEF (0.02 SOL) + dev-buy in the creation block
- [ ] `RPC=<MAINNET> ADMIN_KEYPAIR=<admin> node scripts/beef-init.mjs --vault-keypair <ground.json> --beef-mint <CA>`
- [ ] Transfer the dev-buy BEEF into the printed vault address (plain SPL transfer)
- [ ] **DELETE the ground keypair**; restart keeper → log "BEEF emission enabled"
- [ ] Verify first stamp: `BeefRound.emission ≈ vault/1.8M`, `total_owed` grew

### Phase 4 — announce
- [ ] Trust page: verified-badge link, multisig address, vault→PDA-owner→program chain, freeze plan
- [ ] Never say "unruggable" while the upgrade key lives; say "verified + multisig + freeze plan"
- [ ] Soak capped; loosen caps / tune BEEF params with data

## 5. Wallet map (who holds / pays what)

| Wallet | Role | Holds |
|---|---|---|
| Deploy wallet | one-time deploy + init | ~22 SOL liquid on deploy day |
| Squads multisig | upgrade authority + admin ixs | signing power only |
| Keeper hot wallet | round cranking, rent float, VRF fees | ~10 SOL revolving |
| Pump.fun dev wallet | BEEF create + dev-buy | ~27 SOL on BEEF day |
| `treasury` PDA | receives pot SOL | program-owned (exit ix = Phase 0) |
| `payout_vault` | real ANSEM inventory | program-pays claims |
| BEEF vault (`BEEF…`) | emission supply | keyless — owner = `vault_authority` PDA |

## 6. Verify-before-launch checklist (unknowns pinned)

- [ ] MagicBlock VRF **mainnet** queue address + confirm 0.0005 SOL/request live
- [ ] RPC free-tier request limits vs keeper poll volume at chosen cadence
- [ ] Pump.fun curve constants on launch day (creation 0.02 / 1% fee / ~26.2 SOL per 500M verified 2026-07-09)
- [ ] Jupiter route + slippage for per-round ANSEM buys at expected pot sizes ($3.6M liquidity verified earlier)
- [ ] `solana rent` re-check if binary size changes after Phase 0

## 7. Post-launch roadmap (trust hardening)

1. Re-run `verify-from-repo` + `submit-job` after EVERY upgrade (stale badge = worse than none)
2. Buyback crank (rake → market-buy BEEF → vault deposit — pure ops, deposits permissionless)
3. Split vault+emission into a minimal separate program → **badge it, then freeze it**
   (`Authority: none`) — ORE's exact two-program pattern, verified on-chain 2026-07-09
4. Audit before uncapping stakes / large vault fills

---
*Numbers verified 2026-07-09: `solana rent` on mainnet RPC; MagicBlock VRF pricing
(magicblock.xyz blog); pump.fun fees (pump.fun/docs/fees). SOL/USD at ~$77 — refresh
before wiring real amounts.*
