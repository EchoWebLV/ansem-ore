use anchor_lang::prelude::*;

// BEEF vault emission layer. All-new accounts — Config/Round/MinerPosition are
// deliberately untouched (zero migrations; the ANSEM path cannot be affected).

#[account]
#[derive(InitSpace)]
pub struct BeefConfig {
    pub beef_mint: Pubkey,
    /// SPL token account holding the emission supply. Owner = the existing
    /// vault_authority PDA. Ops-side this sits at a vanity BEEF... address;
    /// the program only cares that this pubkey matches.
    pub beef_vault: Pubkey,
    /// emission_per_round = free_vault / divisor (free = vault - total_owed).
    pub divisor: u64,
    pub tick_bps: u16,
    pub bonus_cap_bps: u16,
    pub activity_window_secs: i64,
    pub secs_per_tick: i64,
    /// Solvency ledger: every stamped emission and accrued bonus is recognized
    /// here the moment it becomes claimable; claims subtract their payout.
    /// free_vault = vault.amount - total_owed can never go negative-spendable.
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
