use anchor_lang::prelude::*;

pub const GRID_SIZE: usize = 25;
pub const ANSEM_DECIMALS: u8 = 6;
pub const LAMPORTS_PER_SOL: u64 = 1_000_000_000;

// PDA seeds
pub const CONFIG_SEED: &[u8] = b"config";
pub const ROUND_SEED: &[u8] = b"round";
pub const MINER_SEED: &[u8] = b"miner";
pub const ESCROW_SEED: &[u8] = b"escrow";
pub const POT_VAULT_SEED: &[u8] = b"pot_vault";
pub const TREASURY_SEED: &[u8] = b"treasury";
pub const VAULT_AUTH_SEED: &[u8] = b"vault_auth";
pub const MINT_AUTH_SEED: &[u8] = b"mint_auth";
pub const ANSEM_MINT_SEED: &[u8] = b"ansem_mint";
pub const JACKPOT_AUTH_SEED: &[u8] = b"jackpot_auth";

// Param defaults (see spec §2)
pub const DEFAULT_ROUND_DURATION_SECS: i64 = 60;
pub const DEFAULT_FEE_BPS: u16 = 100;
pub const DEFAULT_MULT_MIN_BPS: u16 = 8000;
pub const DEFAULT_MULT_MAX_BPS: u16 = 12000;
pub const DEFAULT_JACKPOT_ODDS: u32 = 625;
pub const DEFAULT_JACKPOT_BPS: u16 = 1000;
pub const DEFAULT_MIN_STAKE: u64 = 10_000_000;              // 0.01 SOL
pub const DEFAULT_MAX_STAKE_PER_ROUND: u64 = 100 * LAMPORTS_PER_SOL;
// base units of ANSEM minted per 1 SOL: 2800 ANSEM * 10^6 decimals
pub const DEFAULT_MOCK_RATE: u64 = 2_800 * 1_000_000;

// swap modes
pub const SWAP_MODE_MOCK: u8 = 0;
pub const SWAP_MODE_JUPITER: u8 = 1;
