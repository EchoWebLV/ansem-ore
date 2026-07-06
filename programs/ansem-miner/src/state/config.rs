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
    pub mult_min_bps: u16,
    pub mult_max_bps: u16,
    pub jackpot_odds: u32,
    pub jackpot_bps: u16,
    pub min_stake: u64,
    pub max_stake_per_round: u64,
    pub mock_rate: u64,
    pub config_bump: u8,
    pub pot_vault_bump: u8,
    pub treasury_bump: u8,
    pub vault_auth_bump: u8,
    pub mint_auth_bump: u8,
}
