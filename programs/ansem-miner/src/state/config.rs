use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    pub ansem_mint: Pubkey,
    pub swap_mode: u8,
    pub current_round_id: u64,
    pub round_duration_secs: i64,
    pub fee_bps: u16,
    pub mult_min_bps: u16,   // return-band low  (bps)
    pub mult_max_bps: u16,   // return-band high (bps)
    pub min_stake: u64,
    pub max_stake_per_round: u64,
    pub mock_rate: u64,
    // Sum of all PlayerEscrow.balance across every player. Tracks the
    // lamports in `pot_vault` that are owed back to depositors (idle escrow
    // not currently staked into any round's pot) so that execute_swap_mock
    // can verify it isn't sweeping funds that belong to escrow rather than
    // to the round being swapped. See stake.rs / escrow.rs for updates.
    pub total_escrow_balance: u64,
    // Accumulated ANSEM jackpot carried across rounds where nobody staked the
    // jackpot square. Physically = unclaimed ANSEM sitting in payout_vault.
    pub rollover_jackpot: u64,
    // Round-lifecycle gate: true when the newest round has reached a terminal
    // state (Claimable via swap, or Closed via cancel_round). create_round
    // requires this to be true (or current_round_id == 0), forbidding a new
    // round from opening while the prior one is still Open/Settled. This
    // serializes rounds so a mis-ordered or abandoned settle cannot silently
    // strand a growing set of stakers, and keeps the commingled pot_vault
    // safe (never more than one unswapped pot at a time). See spec §2.
    pub current_round_finalized: bool,
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
    pub config_bump: u8,
    pub pot_vault_bump: u8,
    pub treasury_bump: u8,
    pub vault_auth_bump: u8,
    pub mint_auth_bump: u8,
}
