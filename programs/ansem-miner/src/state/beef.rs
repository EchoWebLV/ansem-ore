use anchor_lang::prelude::*;

// BEEF mint-on-emission layer (spec 2026-07-14-beef-on-ansem-design). All-new
// accounts — Config/Round/MinerPosition are deliberately untouched (zero
// migrations; the ANSEM path cannot be affected). BeefConfig is NOT initialized
// on live mainnet (verified 2026-07-14), so this struct changed freely.

#[account]
#[derive(InitSpace)]
pub struct BeefConfig {
    pub beef_mint: Pubkey,
    /// Player-emission buffer. Owner = vault_authority PDA, which is ALSO the
    /// beef mint authority — stamp mints into here, claims transfer out.
    pub beef_vault: Pubkey,
    /// Treasury ATA (20% cut minted straight here). Pinned at init.
    pub beef_treasury: Pubkey,
    /// emission_total_per_round = max_round_mint * pot/(pot + sat_lamports),
    /// times the ZINC-style decay factor (hard_cap - minted_total)/hard_cap.
    pub max_round_mint: u64,
    pub sat_lamports: u64,
    /// Emission stops forever at the cap. minted_total counts BOTH shares
    /// (players + treasury) — it is the supply meter; the cap is init-pinned.
    pub hard_cap: u64,
    pub minted_total: u64,
    /// Continuous treasury cut in bps (init-pinned; 20% at launch).
    pub treasury_bps: u16,
    pub tick_bps: u16,
    pub bonus_cap_bps: u16,
    pub activity_window_secs: i64,
    pub secs_per_tick: i64,
    /// Solvency ledger for the PLAYERS' buffered share: every stamped players'
    /// emission and accrued bonus is recognized here the moment it becomes
    /// claimable; claims subtract their payout. free_vault = vault.amount -
    /// total_owed can never go negative-spendable.
    pub total_owed: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct BeefMiner {
    pub authority: Pubkey,
    /// Rolled-in, not-yet-claimed BEEF (base units).
    pub unclaimed: u64,
    /// Hold-to-grow bonus in bps (0..=cap). Payout = unclaimed*(10000+bonus)/10000.
    pub bonus_bps: u16,
    /// Accrual cursor: ticks are counted from here; every touch sets it to now
    /// (dead gate-closed gaps are skipped, never re-scanned).
    pub last_tick_ts: i64,
    /// Last stake-accompanied touch (roll_beef). The activity gate: ticks stop
    /// accruing past last_active_ts + activity_window_secs.
    pub last_active_ts: i64,
    /// Monotonic double-roll guard (rounds are strictly increasing and a
    /// MinerPosition only ever holds one round at a time).
    pub last_rolled_round_id: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct BeefRound {
    pub round_id: u64,
    /// Frozen at stamp time (order-independent claims, same pattern as
    /// Round.jackpot_pool). Shares divide this against Round.pot.
    pub emission: u64,
    pub bump: u8,
}
