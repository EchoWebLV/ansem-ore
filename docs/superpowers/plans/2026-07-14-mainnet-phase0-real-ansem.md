# Mainnet Phase 0 — Real-ANSEM Payouts + Launch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship ANSEM Miner to Solana mainnet: players bet SOL on the 5×5 grid, VRF picks the winner-take-all square, winners are paid **real $ANSEM** bought on Jupiter; misses roll the jackpot. BEEF layer stays dormant inside the deployed program.

**Architecture:** Three program gaps close first (real-payout swap, treasury exit, round janitor), guarded by a new on-chain ANSEM solvency ledger (`ansem_obligations`, same pattern as BEEF's `total_owed`). Payout inventory lives in the keeper's own ATA — the program pulls the exact per-round amount at swap time (owner-refundable by design). Devnet-only instructions are stripped from the mainnet binary via a cargo feature. Keeper gains real-mode finalize (Jupiter quote → `execute_swap_real`), a buyback loop, and a janitor crank. Then: public repo → verified build → deploy → init → services → dust e2e go/no-go.

**Tech Stack:** Anchor 1.0.2 (toolchain pinned), ephemeral-vrf-sdk 0.4.1, TS SDK (`@ansem/sdk`), keeper (Node + vitest), Next.js 14 app, Jupiter swap API, Railway + Vercel + Helius.

**Branch:** `mainnet-phase0` (created off `beef-vault-emission`). Every task commits here.

**Locked decisions (owner confirmed 2026-07-13/14):**
- Randomness: MagicBlock VRF on mainnet (program `Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz` and SDK default queue `Cuj97ggrhhidhbu39TijNVqE74xvKJ69gDervRUXAxGh` verified to exist on mainnet 2026-07-13 via `getAccountInfo`). Admin `settle` stays compiled as emergency fallback.
- Upgrade authority: deploy wallet at launch → Squads soon after. `initialize_real` is gated to the upgrade authority (kills init-squat).
- Repo public at deploy (verified badge). GitHub account: EchoWebLV (gh CLI authed).
- Capped launch: `max_stake_per_round` = 1 SOL, `min_stake` = 0.01 SOL, cadence 300 s, WTA band (0,0), claim window 86 400 s (24 h — matches ORE's `ONE_DAY_SLOTS` forfeit window, verified in regolith-labs/ore `deploy.rs`/`checkpoint.rs`).
- Everything-refundable rule: inventory in keeper ATA (not program vaults), `sweep_treasury`, `sweep_beef_excess` (≤ `vault − total_owed`), `close_round` rent recycling. Wind-down leaves only fee dust + players' unclaimed obligations behind.

**HARD GATES (user, not workers):**
- **GATE A — real ANSEM mint CA.** Runbook records it only truncated (`9cRCn9rGT8V2…`). The user must confirm the exact mint address before `initialize_real` on mainnet; verify decimals + Jupiter route on-chain at that moment. NEVER guess a CA.
- **GATE B — deploy wallet funded** (~20 SOL liquid; ~6 refunds back post-deploy).
- **GATE C — mainnet dust e2e passes** (stake → VRF settle → swap real → claim lands real ANSEM) before any announcement.

---

## File map

| File | Change |
|---|---|
| `programs/ansem-miner/src/state/config.rs` | + `ansem_obligations`, `claim_window_secs`, `min_swap_rate` |
| `programs/ansem-miner/src/state/round.rs` | + `entitlement_total`, `claimed_proceeds` |
| `programs/ansem-miner/src/constants.rs` | + `DEFAULT_CLAIM_WINDOW_SECS` |
| `programs/ansem-miner/src/error.rs` | + `ClaimWindowOpen`, `RoundNotCloseable`, `SwapRateTooLow` |
| `programs/ansem-miner/src/instructions/swap.rs` | shared `finalize_swap_accounting` + `ExecuteSwapReal` |
| `programs/ansem-miner/src/instructions/initialize.rs` | + `InitializeReal` (upgrade-authority-gated, external mint) |
| `programs/ansem-miner/src/instructions/sweep.rs` | NEW: `sweep_treasury`, `sweep_beef_excess` |
| `programs/ansem-miner/src/instructions/janitor.rs` | NEW: `close_round` |
| `programs/ansem-miner/src/instructions/admin.rs` | + `set_claim_window`, `set_min_swap_rate` |
| `programs/ansem-miner/src/instructions/claim.rs` + `direct.rs` | obligations decrement + `claimed_proceeds` increment |
| `programs/ansem-miner/src/lib.rs` | new entrypoints; `#[cfg(feature = "devnet")]` gates |
| `programs/ansem-miner/Cargo.toml` | + `[features] devnet = []` |
| `tests/mainnet-path.ts` | NEW suite: initialize_real / swap_real / sweeps / close_round |
| `packages/sdk` | new builders + regenerated IDL/types |
| `keeper/src/` | `jupiter.ts`, `buyback.ts` NEW; real finalize; cancel-empty; janitor crank; env |
| `app/` | claim-deadline countdown; mainnet env; decimals-from-chain audit |

Execution order: Tasks 1→5 are the program chain (shared files — strictly sequential, one worker each). Task 6 (SDK) after 5. Tasks 7 (keeper) and 8 (app) after 6, parallel. Task 9 regression+devnet. Tasks 10–12 ops with the user.

---

### Task 1: Obligations ledger + claim-window state

**Files:** Modify `state/config.rs`, `state/round.rs`, `constants.rs`, `instructions/initialize.rs` (handler), `instructions/swap.rs` (mock handler), `instructions/claim.rs`, `instructions/direct.rs`. Test: extend `tests/direct-stake.ts`.

- [ ] **Step 1: Failing test.** In `tests/direct-stake.ts`, after the existing stake→settle→swap-mock flow, add asserts (mirror the suite's existing fetch helpers):

```ts
it("tracks obligations, entitlement and claimed_proceeds", async () => {
  const cfg = await program.account.config.fetch(configPda);
  const round = await program.account.round.fetch(roundPda);
  // swap just ran: everything minted is now owed
  assert.equal(cfg.ansemObligations.toString(), round.swapProceeds.toString());
  assert.equal(
    round.entitlementTotal.toString(),
    // nj_total + jackpot_pool: recompute exactly like the suite's payout asserts do
    expectedNjTotal.add(round.jackpotPool).toString()
  );
  // after claim_direct by the winner:
  //   claimed_proceeds grew by the paid amount, obligations shrank by it
});
```

Also assert post-claim: `cfgAfter.ansemObligations = cfgBefore.ansemObligations − paid`, `roundAfter.claimedProceeds = paid`.

- [ ] **Step 2: Run `anchor test`** — expect FAIL (`ansemObligations` undefined / field missing).
- [ ] **Step 3: State + constants.** `config.rs` — append before the bumps:

```rust
    // ---- Mainnet real-payout layer (plan 2026-07-14) ----
    // Total ANSEM (base units) sitting in payout_vault that is OWED to players:
    // rollover_jackpot plus every claimable round's remaining entitlement.
    // swap adds ansem_out; claims subtract what they pay; close_round moves a
    // round's forfeited remainder into rollover_jackpot (net zero here). This is
    // the solvency gate for execute_swap_real — free inventory is everything
    // above this number, and it is never spendable toward players twice.
    pub ansem_obligations: u64,
    // Seconds after a round's deadline during which claims stay open;
    // close_round refuses earlier. ORE precedent: ONE_DAY. Admin-tunable.
    pub claim_window_secs: i64,
    // execute_swap_real floor: ansem_out >= net * min_swap_rate / LAMPORTS_PER_SOL.
    // 0 disables; launch script sets it from a live Jupiter quote (×0.7).
    pub min_swap_rate: u64,
```

`round.rs` — append before `bump`:

```rust
    // Frozen at swap: nj_total + jackpot_pool — the most this round's claimants
    // can ever draw. claimed_proceeds accumulates actual payouts; the difference
    // is what close_round forfeits into the next jackpot.
    pub entitlement_total: u64,
    pub claimed_proceeds: u64,
```

`constants.rs`: `pub const DEFAULT_CLAIM_WINDOW_SECS: i64 = 86_400;`
`initialize_handler`: `c.ansem_obligations = 0; c.claim_window_secs = DEFAULT_CLAIM_WINDOW_SECS; c.min_swap_rate = 0;`

- [ ] **Step 4: Wire the mock swap.** In `execute_swap_mock_handler`, after the rollover branch (before `round.state = STATE_CLAIMABLE`):

```rust
    round.entitlement_total = nj_total
        .checked_add(round.jackpot_pool)
        .ok_or(AnsemError::Overflow)?;
```

and extend the closing config block:

```rust
    let cfg = &mut ctx.accounts.config;
    cfg.rollover_jackpot = new_rollover;
    cfg.ansem_obligations = cfg
        .ansem_obligations
        .checked_add(ansem_out)
        .ok_or(AnsemError::Overflow)?;
    cfg.current_round_finalized = true;
```

(The two-branch identity holds: winner case Δobligations = nj_total + leftover = ansem_out; no-winner case nj_total + leftover-into-rollover = ansem_out.)

- [ ] **Step 5: Wire both claim paths.** In `direct.rs` `ClaimDirect`: make `config` and `round` `mut`. In the handler after the transfer:

```rust
    let round = &mut ctx.accounts.round;
    round.claimed_proceeds = round.claimed_proceeds.saturating_add(amount);
    let cfg = &mut ctx.accounts.config;
    // saturating: a ledger drift must never block a player's claim.
    cfg.ansem_obligations = cfg.ansem_obligations.saturating_sub(amount);
```

Mirror identically in `claim.rs` (escrow path) — add `mut` where missing.

- [ ] **Step 6: `anchor test -- --features devnet`** (plain `anchor test` until Task 2 adds the feature) — expect PASS, all existing suites still green.
- [ ] **Step 7: Commit** `feat(program): ANSEM obligations ledger + claim-window state (round entitlement/claimed tracking)`

### Task 2: `devnet` feature gate + `initialize_real`

**Files:** Modify `programs/ansem-miner/Cargo.toml`, `lib.rs`, `instructions/initialize.rs`. Test: NEW `tests/mainnet-path.ts`.

- [ ] **Step 1: Failing test.** `tests/mainnet-path.ts`: create a plain SPL mint (6 decimals, payer = provider wallet) with `@solana/spl-token` `createMint`, then call `initializeReal` passing it + the PDAs + `program`/`programData` accounts; assert `config.swapMode == 1`, `config.ansemMint` equals the external mint, `mockRate == 0`. Negative: a random Keypair as `admin` signer → fails `Unauthorized`. (ProgramData address = PDA of `[programId]` under `BPFLoaderUpgradeab1e…`; anchor-deployed localnet programs are upgradeable with the provider wallet as authority.)
- [ ] **Step 2: Run** — FAIL (`initializeReal` not found).
- [ ] **Step 3: Feature + gates.** `Cargo.toml`: add `[features] devnet = []` (and keep existing feature blocks intact if present — check for `idl-build`). In `lib.rs`, prefix with `#[cfg(feature = "devnet")]` ONLY these four entrypoints: `initialize` (mock-mint), `execute_swap_mock`, `close_config`, `set_round_cursor`. Admin `settle` stays ungated (VRF-stall fallback, runbook decision).
- [ ] **Step 4: `InitializeReal`** in `initialize.rs`:

```rust
#[derive(Accounts)]
pub struct InitializeReal<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(init, payer = admin, space = 8 + Config::INIT_SPACE, seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, Config>,
    // The REAL ANSEM mint — pre-existing, we hold no authority over it.
    pub ansem_mint: Account<'info, Mint>,
    /// CHECK: mint authority PDA — bump recorded for layout parity; unused in real mode
    #[account(seeds = [MINT_AUTH_SEED], bump)]
    pub mint_authority: UncheckedAccount<'info>,
    /// CHECK: vault authority PDA (owns the payout ATA, created lazily at swap)
    #[account(seeds = [VAULT_AUTH_SEED], bump)]
    pub vault_authority: UncheckedAccount<'info>,
    /// CHECK: SOL pot vault PDA
    #[account(seeds = [POT_VAULT_SEED], bump)]
    pub pot_vault: UncheckedAccount<'info>,
    /// CHECK: treasury PDA (SOL)
    #[account(seeds = [TREASURY_SEED], bump)]
    pub treasury: UncheckedAccount<'info>,
    // Init-squat guard: only the program's upgrade authority may initialize.
    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ AnsemError::Unauthorized)]
    pub program: Program<'info, crate::program::AnsemMiner>,
    #[account(constraint = program_data.upgrade_authority_address == Some(admin.key()) @ AnsemError::Unauthorized)]
    pub program_data: Account<'info, ProgramData>,
    pub system_program: Program<'info, System>,
}
```

Handler signature: `initialize_real_handler(ctx, keeper_admin: Pubkey)` — body = `initialize_handler` with: `c.admin = keeper_admin` (NOT the signer: the signer is the upgrade authority / deploy wallet, which stays cold in Phantom; `keeper_admin` is the Railway hot key that cranks admin-gated ixs), `swap_mode = SWAP_MODE_JUPITER`, `mock_rate = 0`, same defaults otherwise, bumps from `ctx.bumps`. Entrypoint in `lib.rs` (ungated). Key-separation escape hatch: there is deliberately no `set_admin` ix — if the hot key leaks, the upgrade authority ships a one-line upgrade to rotate `config.admin`. Test addition: `initializeReal(keeperAdmin)` with a fresh pubkey → `config.admin == keeperAdmin`, and admin-gated ixs signed by the deployer now FAIL `Unauthorized` while the keeper key succeeds.

- [ ] **Step 5: Run** `anchor test -- --features devnet` — PASS (new suite + all legacy suites, which need the mock `initialize` and therefore the feature).
- [ ] **Step 6: Update `scripts/deploy-devnet.sh`** to build with `--features devnet`. Verify `anchor build` (no features) compiles clean — that is the mainnet binary.
- [ ] **Step 7: Commit** `feat(program): devnet feature gate + initialize_real (upgrade-authority-gated, external ANSEM mint)`

### Task 3: `execute_swap_real`

**Files:** Modify `instructions/swap.rs`, `instructions/admin.rs` (`set_min_swap_rate`), `error.rs`, `lib.rs`. Test: extend `tests/mainnet-path.ts`.

- [ ] **Step 1: Failing tests.** In `mainnet-path.ts` (real-mode config from Task 2): mint external-token supply to an admin ATA (simulated Jupiter buy), run `stake_direct` (two wallets, different squares) → `settle` (admin randomness) → `executeSwapReal(ansemOut)` where `ansemOut` = an arbitrary market-ish number. Assert: pot lamports moved pot_vault→treasury; payout_vault delta == ansemOut (came FROM the admin ATA, not minted); `round.swapProceeds == ansemOut`; `cfg.ansemObligations` grew by ansemOut; state CLAIMABLE; winner `claimDirect` receives real tokens. Negatives: (a) non-admin payer → `Unauthorized`; (b) after `setMinSwapRate(hugeRate)` → `SwapRateTooLow`; (c) admin ATA balance < ansemOut → SPL transfer failure.
- [ ] **Step 2: Run** — FAIL (`executeSwapReal` not found).
- [ ] **Step 3: Refactor shared accounting.** Extract from the mock handler into (same file):

```rust
// Everything after proceeds are known — identical for mock and real:
// jackpot split, rollover carry, entitlement freeze, obligations, state flip.
pub(crate) fn finalize_swap_accounting(
    round: &mut Round,
    config: &mut Config,
    ansem_out: u64,
    mult_min_bps: u16,
    mult_max_bps: u16,
    rollover_in: u64,
) -> Result<()> {
    round.swap_proceeds = ansem_out;
    let jsq = round.jackpot_square as usize;
    let nj_weight = math::return_weight(&round.block_sol, &round.randomness,
        round.jackpot_square, mult_min_bps, mult_max_bps);
    let nj_total = math::nonjackpot_payout(nj_weight, round.pot, ansem_out);
    let round_leftover = ansem_out.checked_sub(nj_total).ok_or(AnsemError::Overflow)?;
    let new_rollover: u64 = if round.block_sol[jsq] > 0 {
        round.jackpot_pool = round_leftover.checked_add(rollover_in).ok_or(AnsemError::Overflow)?;
        0
    } else {
        round.jackpot_pool = 0;
        rollover_in.checked_add(round_leftover).ok_or(AnsemError::Overflow)?
    };
    round.entitlement_total = nj_total.checked_add(round.jackpot_pool).ok_or(AnsemError::Overflow)?;
    round.state = STATE_CLAIMABLE;
    config.rollover_jackpot = new_rollover;
    config.ansem_obligations = config.ansem_obligations.checked_add(ansem_out).ok_or(AnsemError::Overflow)?;
    config.current_round_finalized = true;
    Ok(())
}
```

Mock handler now: mode/state/solvency checks → pot transfer → mint → `finalize_swap_accounting(...)`. Behavior byte-identical (Task 1 asserts prove it).

- [ ] **Step 4: `ExecuteSwapReal`.** Accounts = `ExecuteSwapMock` minus `ansem_mint`-as-PDA/mint_authority assumptions, plus the keeper source ATA and an admin gate:

```rust
#[derive(Accounts)]
pub struct ExecuteSwapReal<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.config_bump,
        constraint = config.admin == payer.key() @ AnsemError::Unauthorized)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [ROUND_SEED, round.round_id.to_le_bytes().as_ref()], bump = round.bump)]
    pub round: Box<Account<'info, Round>>,
    #[account(address = config.ansem_mint)]
    pub ansem_mint: Box<Account<'info, Mint>>,
    /// CHECK: vault authority PDA (owner of payout vault)
    #[account(seeds = [VAULT_AUTH_SEED], bump = config.vault_auth_bump)]
    pub vault_authority: UncheckedAccount<'info>,
    #[account(init_if_needed, payer = payer,
        associated_token::mint = ansem_mint, associated_token::authority = vault_authority)]
    pub payout_vault: Box<Account<'info, TokenAccount>>,
    // Keeper-owned inventory the round's proceeds are paid FROM (in-ix transfer).
    #[account(mut, token::mint = ansem_mint, token::authority = payer)]
    pub source_ata: Box<Account<'info, TokenAccount>>,
    /// CHECK: SOL pot vault PDA
    #[account(mut, seeds = [POT_VAULT_SEED], bump = config.pot_vault_bump)]
    pub pot_vault: UncheckedAccount<'info>,
    /// CHECK: treasury PDA (SOL)
    #[account(mut, seeds = [TREASURY_SEED], bump = config.treasury_bump)]
    pub treasury: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}
```

Handler `execute_swap_real_handler(ctx, ansem_out: u64)`:

```rust
    // scalar copies as in mock …
    require!(swap_mode == SWAP_MODE_JUPITER, AnsemError::WrongSwapMode);
    require!(round.state == STATE_SETTLED, AnsemError::BadRoundState);
    let pot = round.pot;
    let fee = (pot as u128 * fee_bps as u128 / 10_000u128) as u64;
    let net = pot.checked_sub(fee).ok_or(AnsemError::Overflow)?;
    // same SOL solvency gate as mock (escrow liabilities + this pot)
    // … pot_vault -> treasury transfer, identical CPI …
    // Rate floor: keeper can never underpay below the admin-set market floor.
    if min_swap_rate > 0 {
        let floor = (net as u128 * min_swap_rate as u128 / LAMPORTS_PER_SOL as u128) as u64;
        require!(ansem_out >= floor, AnsemError::SwapRateTooLow);
    }
    // Pay the round's proceeds in from keeper inventory — atomic, exact.
    token::transfer(CpiContext::new(
        ctx.accounts.token_program.to_account_info(),
        TokenTransfer { from: source_ata, to: payout_vault, authority: payer }), ansem_out)?;
    // Post-transfer solvency: vault must cover EVERYTHING owed incl. this round.
    ctx.accounts.payout_vault.reload()?;
    require!(
        ctx.accounts.payout_vault.amount >= obligations_before.checked_add(ansem_out).ok_or(AnsemError::Overflow)?,
        AnsemError::Insolvent
    );
    finalize_swap_accounting(round, config, ansem_out, mult_min_bps, mult_max_bps, rollover_in)
```

- [ ] **Step 5: `set_min_swap_rate`** in `admin.rs` (SetParams pattern): `config.min_swap_rate = rate;`. Errors: add `SwapRateTooLow`. Entrypoints in `lib.rs` (ungated).
- [ ] **Step 6: Run** `anchor test -- --features devnet` — PASS (incl. Task 1 asserts, proving mock behavior unchanged).
- [ ] **Step 7: Commit** `feat(program): execute_swap_real — keeper-inventory payout with rate floor + obligations solvency`

### Task 4: `sweep_treasury` + `sweep_beef_excess`

**Files:** NEW `instructions/sweep.rs`; modify `instructions/mod.rs`, `lib.rs`, `error.rs` (reuse `InsufficientBalance`). Test: extend `tests/mainnet-path.ts` + `tests/direct-beef.ts`.

- [ ] **Step 1: Failing tests.** (a) after a real swap: `sweepTreasury(amount, dest)` moves lamports treasury→dest; over-sweep (more than balance − rent-min) fails; non-admin fails. (b) BEEF suite: fund vault, stamp+roll so `total_owed > 0`, `sweepBeefExcess(vault.amount − total_owed)` succeeds to an admin ATA; sweeping 1 more unit fails; non-admin fails.
- [ ] **Step 2: Run** — FAIL (unknown instruction).
- [ ] **Step 3: Implement** `sweep.rs`:

```rust
#[derive(Accounts)]
pub struct SweepTreasury<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.config_bump,
        constraint = config.admin == admin.key() @ AnsemError::Unauthorized)]
    pub config: Account<'info, Config>,
    /// CHECK: treasury PDA
    #[account(mut, seeds = [TREASURY_SEED], bump = config.treasury_bump)]
    pub treasury: UncheckedAccount<'info>,
    /// CHECK: any destination the admin names
    #[account(mut)]
    pub destination: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub fn sweep_treasury_handler(ctx: Context<SweepTreasury>, amount: u64) -> Result<()> {
    // Keep the PDA alive: never sweep below rent-exemption for a 0-data account.
    let rent_min = Rent::get()?.minimum_balance(0);
    let available = ctx.accounts.treasury.lamports().saturating_sub(rent_min);
    require!(amount <= available, AnsemError::InsufficientBalance);
    let seeds: &[&[u8]] = &[TREASURY_SEED, &[ctx.accounts.config.treasury_bump]];
    system_program::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.system_program.to_account_info(),
            SolTransfer { from: ctx.accounts.treasury.to_account_info(),
                          to: ctx.accounts.destination.to_account_info() },
            &[seeds]),
        amount)
}

#[derive(Accounts)]
pub struct SweepBeefExcess<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.config_bump,
        constraint = config.admin == admin.key() @ AnsemError::Unauthorized)]
    pub config: Account<'info, Config>,
    #[account(seeds = [BEEF_CONFIG_SEED], bump = beef_config.bump)]
    pub beef_config: Account<'info, BeefConfig>,
    /// CHECK: vault authority PDA — owner of beef_vault
    #[account(seeds = [VAULT_AUTH_SEED], bump = config.vault_auth_bump)]
    pub vault_authority: UncheckedAccount<'info>,
    #[account(mut, address = beef_config.beef_vault @ AnsemError::BadBeefVault)]
    pub beef_vault: Account<'info, TokenAccount>,
    #[account(mut, token::mint = beef_config.beef_mint)]
    pub destination_ata: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

pub fn sweep_beef_excess_handler(ctx: Context<SweepBeefExcess>, amount: u64) -> Result<()> {
    // Refundability rule: only supply ABOVE the player solvency ledger may leave.
    let free = ctx.accounts.beef_vault.amount
        .saturating_sub(ctx.accounts.beef_config.total_owed);
    require!(amount <= free, AnsemError::InsufficientBalance);
    let seeds: &[&[u8]] = &[VAULT_AUTH_SEED, &[ctx.accounts.config.vault_auth_bump]];
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            TokenTransfer { from: ctx.accounts.beef_vault.to_account_info(),
                            to: ctx.accounts.destination_ata.to_account_info(),
                            authority: ctx.accounts.vault_authority.to_account_info() },
            &[seeds]),
        amount)
}
```

- [ ] **Step 4: Run** — PASS. **Step 5: Commit** `feat(program): sweep_treasury + sweep_beef_excess (solvency-bounded owner exits)`

### Task 5: `close_round` janitor + `set_claim_window`

**Files:** NEW `instructions/janitor.rs`; modify `admin.rs`, `error.rs`, `mod.rs`, `lib.rs`. Test: extend `tests/mainnet-path.ts`.

- [ ] **Step 1: Failing tests.** Use `setRoundDuration(3)` + `setClaimWindow(3)` so real sleeps work: (a) claimable round, winner claims part → after window, permissionless `closeRound` by a random wallet: Round account gone, rent landed on `config.admin`, `rollover_jackpot` grew by `entitlement_total − claimed_proceeds`, `ansem_obligations` unchanged; (b) `closeRound` before window → `ClaimWindowOpen`; (c) OPEN round → `RoundNotCloseable`; (d) cancelled round with `pot == 0` closes instantly; (e) cancelled round with `pot > 0` refuses (refund path must stay alive).
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** `janitor.rs`:

```rust
#[derive(Accounts)]
pub struct CloseRound<'info> {
    pub caller: Signer<'info>, // permissionless — the gates are time + state
    #[account(mut, seeds = [CONFIG_SEED], bump = config.config_bump)]
    pub config: Account<'info, Config>,
    #[account(mut, close = admin_dest,
        seeds = [ROUND_SEED, round.round_id.to_le_bytes().as_ref()], bump = round.bump)]
    pub round: Account<'info, Round>,
    /// CHECK: rent refund target — pinned to the admin (keeper funded the rent)
    #[account(mut, address = config.admin @ AnsemError::Unauthorized)]
    pub admin_dest: UncheckedAccount<'info>,
}

pub fn close_round_handler(ctx: Context<CloseRound>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let round = &ctx.accounts.round;
    let cfg = &mut ctx.accounts.config;
    if round.state == STATE_CLAIMABLE {
        require!(
            now >= round.deadline_ts.saturating_add(cfg.claim_window_secs),
            AnsemError::ClaimWindowOpen
        );
        // Forfeit the unclaimed remainder into the next jackpot. Pure earmark
        // move inside ansem_obligations: rollover grows, obligations unchanged.
        let forfeited = round.entitlement_total.saturating_sub(round.claimed_proceeds);
        cfg.rollover_jackpot = cfg.rollover_jackpot
            .checked_add(forfeited).ok_or(AnsemError::Overflow)?;
    } else if round.state == STATE_CLOSED {
        // Cancelled rounds: only EMPTY ones may be reaped — a non-empty
        // cancelled round still owes refund_direct its block_stake data.
        require!(round.pot == 0, AnsemError::RoundNotCloseable);
    } else {
        return err!(AnsemError::RoundNotCloseable);
    }
    Ok(())
}
```

`admin.rs`: `pub fn set_claim_window(ctx: Context<SetParams>, secs: i64) -> Result<()> { require!(secs >= 0, AnsemError::BadBeefParams); ctx.accounts.config.claim_window_secs = secs; Ok(()) }` (no floor — devnet tests use seconds; mainnet launch script sets 86 400). Errors: `ClaimWindowOpen`, `RoundNotCloseable`.

- [ ] **Step 4: Run** — PASS. **Step 5:** `cd programs/ansem-miner && cargo test` — PASS. **Step 6: Commit** `feat(program): close_round janitor (window forfeit -> jackpot, empty-cancel reap) + set_claim_window`

### Task 6: IDL + SDK builders

**Files:** `generated/` (regen), `packages/sdk` (follow existing builder file pattern exactly).

- [ ] `anchor build -- --features devnet` → refresh IDL/types wherever `generated/` sources them (inspect how the repo wires this — `package.json` scripts or manual copy).
- [ ] Add builders mirroring the existing ones: `initializeReal`, `executeSwapReal(ansemOut)`, `sweepTreasury(amount)`, `sweepBeefExcess(amount)`, `closeRound(roundId)`, `setClaimWindow(secs)`, `setMinSwapRate(rate)`. Typed `ConfigState`/`RoundStateData` gain the new fields.
- [ ] `pnpm --filter @ansem/sdk build` green; commit `feat(sdk): mainnet-path builders + regenerated IDL`.

### Task 7: Keeper — real finalize, buyback, cancel-empty, janitor

**Files:** NEW `keeper/src/jupiter.ts`, `keeper/src/buyback.ts`, `keeper/src/janitor.ts`; modify `keeper/src/env.ts`, `keeper/src/crank/decide.ts`, `keeper/src/crank/actions.ts`, `keeper/src/service.ts`; tests in `keeper/test/` (vitest, follow existing stub style — 46 tests are the template).

- [ ] **env.ts:** `SWAP_MODE` (`mock` | `real`, default mock), `JUP_BASE_URL` (default `https://lite-api.jup.ag/swap/v1` — verify current free-tier host at build time), `SLIPPAGE_BPS=100`, `BUYBACK_MIN_SOL=0.05`, `TREASURY_KEEP_SOL=0.01`, `INVENTORY_MIN` (alert floor).
- [ ] **jupiter.ts:** `quoteSolToAnsem(lamports): Promise<bigint>` (GET `/quote`, SOL mint `So11111111111111111111111111111111111111112` → `config.ansem_mint`), `swapSolToAnsem(lamports)` (POST `/swap`, sign with keeper keypair, send+confirm). Injectable fetch for tests; `SWAP_MODE=mock` never touches it.
- [ ] **decide.ts — cancel-empty:** past-deadline OPEN round with `pot == 0` → `CrankAction.Cancel` (never `Settle` — zero VRF spend on quiet hours). Test: decide table case.
- [ ] **actions.ts — real finalize:** in `finalizeSettled` when `SWAP_MODE=real`: `net = pot − fee_bps cut`; `ansemOut = await quoteSolToAnsem(net)`; if keeper ATA balance < ansemOut → log `CRITICAL inventory short` and return (tick retries); else send `executeSwapReal(ansemOut)`. `stamp_beef` call unchanged after it.
- [ ] **buyback.ts:** every N ticks: treasury lamports > `BUYBACK_MIN_SOL` → `sweepTreasury(balance − TREASURY_KEEP_SOL)` to keeper wallet → `swapSolToAnsem(sweep × (1 − fee_bps/10⁴))` (fee share stays SOL = ops runway) → inventory refilled. Log every leg.
- [ ] **janitor.ts:** every ~12 ticks: `getProgramAccounts` (Round discriminator memcmp), filter closeable per Task 5 rules using on-chain clock, send up to 20 `closeRound` per pass.
- [ ] `pnpm --filter keeper test` (vitest) green incl. new units; commit `feat(keeper): real-swap finalize + Jupiter buyback + empty-cancel + close_round janitor`.

### Task 8: App — claim countdown + mainnet env

**Files:** `app/` (worker locates exact components), `keeper/src/read/snapshot.ts` (+`claimWindowSecs`).

- [ ] Snapshot exposes `claimWindowSecs`; app shows "claim by HH:MM" countdown on any unclaimed claimable round for the connected wallet; expired → hidden.
- [ ] Audit token-decimal handling: display must read decimals from the mint (mock = 6; real ANSEM decimals VERIFY on-chain at GATE A — do not hardcode).
- [ ] Enumerate `.env.production`: `NEXT_PUBLIC_RPC` (Helius), cluster `mainnet-beta`, program `8Q9EnK7ydn6ywo7ZxeqhubqYybf7FFNNwnz8JzJjXZjz`, keeper read URL (Railway), Solscan explorer links.
- [ ] `pnpm --filter @ansem/app build` green; commit.

### Task 9: Full regression + devnet redeploy + soak

- [ ] `cargo test` (program) + `anchor test -- --features devnet` (all localnet suites) + keeper vitest — all green.
- [ ] `anchor build` (NO features) — the mainnet binary compiles; record `.so` size; `solana rent <size>` refresh.
- [ ] Devnet: `scripts/deploy-devnet.sh` (devnet feature) → `close_config` → `initialize` (mock) → `set_round_cursor <slot>` → `_config.mjs --launch-defaults` → `set_claim_window 60` (soak-fast) → run keeper (`KEEPER_DIRECT_MODE=1 SWAP_MODE=mock`) → observe ≥2 full cycles incl. a `close_round` reap and an empty-round cancel. Then `set_claim_window 86400`.
- [ ] Commit any fixes; push branch.

### Task 10: Mainnet deploy (ops — CTO + user)

- [ ] Merge `mainnet-phase0` → `main` locally; `gh repo create EchoWebLV/ansem-ore --public --source . --push` (confirm repo name with user first).
- [ ] `solana-verify build --library-name ansem_miner` (Docker required — deploy THIS `.so`, never a local `anchor build`).
- [ ] **GATE B** — fund deploy wallet (~20 SOL). `solana program deploy -u <HELIUS_RPC> target/deploy/ansem_miner.so --program-id 8Q9EnK7ydn6ywo7ZxeqhubqYybf7FFNNwnz8JzJjXZjz` (upgrade authority = deploy wallet, per decision).
- [ ] `solana-verify verify-from-repo -u <RPC> --program-id 8Q9En… https://github.com/EchoWebLV/ansem-ore --commit-hash <sha> --library-name ansem_miner --mount-path programs/ansem-miner` → `solana-verify remote submit-job …` → badge.
- [ ] **GATE A** — user confirms real ANSEM CA (candidate verified 2026-07-14: `9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump`, 6 decimals, mint+freeze authority renounced, ~$2.3M Meteora liquidity). `solana-keygen new -o keeper-mainnet.json` (fresh hot key for Railway). `initialize_real(keeper_admin = <keeper pubkey>)` signed by the DEPLOY wallet (`lazer-probe.json` / FP39zt…, Phantom-imported); then, signed by the KEEPER key: `set_return_band 0 0`, `set_round_duration 300`, `set_claim_window 86400`, `set_min_swap_rate <0.7 × live Jupiter quote>`, `min_stake` default 0.01 stays, `max_stake_per_round` → 1 SOL.

### Task 11: Services

- [ ] Helius mainnet key (user creates; free tier vs poll volume check). Keeper → Railway: `KEEPER_DIRECT_MODE=1 SWAP_MODE=real RPC=… VRF_BASE_QUEUE=Cuj97ggrhhidhbu39TijNVqE74xvKJ69gDervRUXAxGh` + the FRESH `keeper-mainnet.json` (= `config.admin`, holds only ~5 SOL float + ANSEM inventory). The deploy wallet's key NEVER goes to Railway.
- [ ] Buy initial ANSEM inventory (~1–2 SOL via Jupiter) into the keeper ATA.
- [ ] App → Vercel prod with Task 8 env.

### Task 12: GATE C — dust e2e + announce

- [ ] User wallet: stake 0.01 SOL on ALL 25 squares (guaranteed jackpot hit) → VRF settles on mainnet → `execute_swap_real` runs → claim → **real ANSEM lands in the user ATA**. Verify a rollover round too (single-square miss). Watch keeper logs one full hour.
- [ ] Trust page per runbook §4 Phase 4 (badge link, authority plan — never say "unruggable"), announcement from `docs/launch/announcement-draft.md`. Loosen caps only with data.

---

## Self-review notes

- Obligations identity proven in Task 1 asserts for both jackpot branches; saturating decrements chosen so ledger drift can never block claims (bias: over-count obligations = safer).
- Restake-forfeit (existing) temporarily over-counts obligations until `close_round` releases the remainder — conservative direction, documented here, not a bug.
- Non-empty cancelled rounds keep their accounts forever (rare; refund path must live) — post-launch cleanup item, logged in runbook §7.
- `initialize` (mock) is devnet-feature-gated, so the mainnet binary's only init path is the upgrade-authority-gated `initialize_real`.
