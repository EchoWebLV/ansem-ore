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
pub const JACKPOT_SM_AUTH_SEED: &[u8] = b"jackpot_sm_auth";
pub const JACKPOT_BIG_AUTH_SEED: &[u8] = b"jackpot_big_auth";

// Param defaults (see spec §2)
pub const DEFAULT_ROUND_DURATION_SECS: i64 = 60;
pub const DEFAULT_FEE_BPS: u16 = 100;
// Per-square RETURN band (lottery model, spec §3): non-jackpot squares return a
// VRF-random fraction in [RETURN_MIN_BPS, RETURN_MAX_BPS] of their stake. The
// band is admin-tunable via set_return_band; (0,0) => everything to the jackpot.
// Raise RETURN_MAX_BPS (the single cap) to ever allow >50% returns.
pub const RETURN_MIN_BPS: u16 = 0;
pub const RETURN_MAX_BPS: u16 = 5_000; // non-jackpot squares return at most 50%
pub const DEFAULT_MULT_MIN_BPS: u16 = RETURN_MIN_BPS; // return-band low  (0%)
pub const DEFAULT_MULT_MAX_BPS: u16 = RETURN_MAX_BPS;  // return-band high (50%)
pub const DEFAULT_MIN_STAKE: u64 = 10_000_000;              // 0.01 SOL
pub const DEFAULT_MAX_STAKE_PER_ROUND: u64 = 100 * LAMPORTS_PER_SOL;
// base units of ANSEM minted per 1 SOL: 2800 ANSEM * 10^6 decimals
pub const DEFAULT_MOCK_RATE: u64 = 2_800 * 1_000_000;
// Claims stay open this long after a round's deadline before close_round may
// reap it and forfeit the unclaimed remainder (ORE ONE_DAY precedent).
pub const DEFAULT_CLAIM_WINDOW_SECS: i64 = 86_400;

// swap modes
pub const SWAP_MODE_MOCK: u8 = 0;
pub const SWAP_MODE_JUPITER: u8 = 1;

// ---- BEEF emission layer (seeds) ----
pub const BEEF_CONFIG_SEED: &[u8] = b"beef_config";
pub const BEEF_MINER_SEED: &[u8] = b"beef_miner";
pub const BEEF_ROUND_SEED: &[u8] = b"beef_round";

// Mint-on-emission (spec 2026-07-14-beef-on-ansem-design): per-round mint =
// MAX_ROUND_MINT * pot/(pot + SAT). 6-decimal base units. Replaces the dormant
// vault-drip divisor model (BEEF is now the program's own classic-SPL mint).
pub const BEEF_MAX_ROUND_MINT: u64 = 210_000_000; // 210 BEEF
pub const BEEF_SAT_LAMPORTS: u64 = 1_000_000_000; // half-max at 1 SOL pot
pub const BEEF_HARD_CAP: u64 = 21_000_000_000_000; // 21,000,000 BEEF
pub const BEEF_TREASURY_BPS: u16 = 2_000; // 20% continuous treasury cut

pub const DEFAULT_BEEF_TICK_BPS: u16 = 0; // base-only rewards; bonus is unfunded
pub const DEFAULT_BEEF_BONUS_CAP_BPS: u16 = 0; // base-only rewards; bonus is unfunded
pub const DEFAULT_BEEF_ACTIVITY_WINDOW_SECS: i64 = 86_400; // daily-streak gate
pub const DEFAULT_BEEF_SECS_PER_TICK: i64 = 60; // one tick per round-length

// ---- Jackpot: random-trigger + bet-scaled cap (spec D6, Motherlode pattern) ----
pub const JACKPOT_CONFIG_SEED: &[u8] = b"jackpot_config";
pub const DEFAULT_JACKPOT_TRIGGER_ODDS: u16 = 25; // 1-in-25 winner rounds
pub const DEFAULT_JACKPOT_CAP_MULT: u16 = 100; // bite <= 100x winning-square stake value
