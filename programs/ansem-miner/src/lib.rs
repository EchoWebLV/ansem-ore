use anchor_lang::prelude::*;

pub mod constants;
pub mod error;
pub mod math;
pub mod state;
pub mod instructions;

use instructions::*;
use ephemeral_rollups_sdk::anchor::ephemeral;

declare_id!("8Q9EnK7ydn6ywo7ZxeqhubqYybf7FFNNwnz8JzJjXZjz");

// #[ephemeral] auto-injects `process_undelegation` + `InitializeAfterUndelegation`
// so delegated Round/MinerPosition PDAs can be undelegated back to L1.
#[ephemeral]
#[program]
pub mod ansem_miner {
    use super::*;

    // Devnet/test-only: mints a PDA ANSEM mint and self-assigns the signer as admin.
    // Stripped from the mainnet binary (see Cargo.toml `devnet` feature); mainnet
    // initializes via `initialize_real` (upgrade-authority-gated, external mint).
    #[cfg(feature = "devnet")]
    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        instructions::initialize::initialize_handler(ctx)
    }

    // Mainnet init: gated to the program's upgrade authority (kills init-squatting)
    // and binds a pre-existing external ANSEM mint. The signer is only the upgrade
    // authority; `keeper_admin` (the Railway hot key) becomes `config.admin`.
    pub fn initialize_real(ctx: Context<InitializeReal>, keeper_admin: Pubkey) -> Result<()> {
        instructions::initialize::initialize_real_handler(ctx, keeper_admin)
    }

    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        instructions::escrow::deposit(ctx, amount)
    }

    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        instructions::escrow::withdraw(ctx, amount)
    }

    pub fn create_round(ctx: Context<CreateRound>) -> Result<()> {
        instructions::round::create_round_handler(ctx)
    }

    pub fn init_miner(ctx: Context<InitMiner>) -> Result<()> {
        instructions::miner::init_miner_handler(ctx)
    }

    pub fn stake(ctx: Context<Stake>, block: u8, amount: u64) -> Result<()> {
        instructions::stake::stake_handler(ctx, block, amount)
    }

    pub fn settle(ctx: Context<Settle>, randomness: [u8; 32]) -> Result<()> {
        instructions::settle::settle_handler(ctx, randomness)
    }

    // ---- M2b: Ephemeral VRF settle (admin-gated request + VRF-identity callback).
    // Keeps `settle` above as a devnet/test fallback; both paths write the same
    // Round fields → STATE_SETTLED. ----
    pub fn request_settle(ctx: Context<RequestSettle>, client_seed: u8) -> Result<()> {
        instructions::vrf_settle::request_settle_handler(ctx, client_seed)
    }

    pub fn settle_callback(ctx: Context<SettleCallback>, randomness: [u8; 32]) -> Result<()> {
        instructions::vrf_settle::settle_callback_handler(ctx, randomness)
    }

    pub fn set_round_duration(ctx: Context<SetParams>, secs: i64) -> Result<()> {
        instructions::admin::set_round_duration(ctx, secs)
    }

    pub fn set_return_band(ctx: Context<SetParams>, min_bps: u16, max_bps: u16) -> Result<()> {
        instructions::admin::set_return_band(ctx, min_bps, max_bps)
    }

    // Mainnet real-swap payout floor (see instructions/admin.rs::set_min_swap_rate).
    // Ungated; admin-gated via SetParams.
    pub fn set_min_swap_rate(ctx: Context<SetParams>, rate: u64) -> Result<()> {
        instructions::admin::set_min_swap_rate(ctx, rate)
    }

    // Mainnet claim-window tuner (see instructions/admin.rs::set_claim_window).
    // Ungated; admin-gated via SetParams. Launch script sets 86_400 (24h).
    pub fn set_claim_window(ctx: Context<SetParams>, secs: i64) -> Result<()> {
        instructions::admin::set_claim_window(ctx, secs)
    }

    // Launch stake-cap tuner (see instructions/admin.rs::set_stake_limits). Ungated;
    // admin-gated via SetParams. Lets the launch policy cap max_stake at 1 SOL and
    // retune both bounds later without a program upgrade.
    pub fn set_stake_limits(
        ctx: Context<SetParams>,
        min_stake: u64,
        max_stake_per_round: u64,
    ) -> Result<()> {
        instructions::admin::set_stake_limits(ctx, min_stake, max_stake_per_round)
    }

    // Fee dial (spec D5): set the pot fee in bps (launch 500 = 5%; hard cap 2000).
    // Ungated; admin-gated via SetParams.
    pub fn set_fee_bps(ctx: Context<SetParams>, fee_bps: u16) -> Result<()> {
        instructions::admin::set_fee_bps(ctx, fee_bps)
    }

    // Jackpot params PDA (spec D6). init_jackpot_config seeds the trigger/cap PDA
    // (must run in the same sitting as the program upgrade — swaps fail until it
    // exists); set_jackpot_params tunes it. Both admin-gated.
    pub fn init_jackpot_config(ctx: Context<InitJackpotConfig>) -> Result<()> {
        instructions::admin::init_jackpot_config(ctx)
    }

    pub fn set_jackpot_params(
        ctx: Context<SetJackpotParams>,
        trigger_odds: u16,
        cap_mult: u16,
    ) -> Result<()> {
        instructions::admin::set_jackpot_params(ctx, trigger_odds, cap_mult)
    }

    // DEVNET/TEST-ONLY migration tool — see instructions/admin.rs::close_config.
    #[cfg(feature = "devnet")]
    pub fn close_config(ctx: Context<CloseConfig>) -> Result<()> {
        instructions::admin::close_config(ctx)
    }

    // DEVNET/TEST-ONLY migration tool — see instructions/admin.rs::set_round_cursor.
    #[cfg(feature = "devnet")]
    pub fn set_round_cursor(ctx: Context<SetParams>, new_id: u64) -> Result<()> {
        instructions::admin::set_round_cursor(ctx, new_id)
    }

    // Devnet/test-only: mints proceeds from the PDA mint at a fixed mock rate. The
    // mainnet payout path is `execute_swap_real` (Jupiter inventory). Gated out of
    // the mainnet binary with the rest of the mock/migration surface.
    #[cfg(feature = "devnet")]
    pub fn execute_swap_mock(ctx: Context<ExecuteSwapMock>) -> Result<()> {
        instructions::swap::execute_swap_mock_handler(ctx)
    }

    // Mainnet payout: pull the keeper-quoted `ansem_out` of REAL ANSEM out of the
    // keeper's own ATA into payout_vault (no minting), pot -> treasury. Ungated (this
    // is the live mainnet path); admin-gated on config.admin inside the accounts.
    pub fn execute_swap_real(ctx: Context<ExecuteSwapReal>, ansem_out: u64) -> Result<()> {
        instructions::swap::execute_swap_real_handler(ctx, ansem_out)
    }

    pub fn claim(ctx: Context<Claim>, round_id: u64) -> Result<()> {
        instructions::claim::claim_handler(ctx, round_id)
    }

    pub fn cancel_round(ctx: Context<CancelRound>) -> Result<()> {
        instructions::recovery::cancel_round_handler(ctx)
    }

    pub fn refund(ctx: Context<Refund>, round_id: u64) -> Result<()> {
        instructions::recovery::refund_handler(ctx, round_id)
    }

    // ---- M2a: ER delegation lifecycle ----
    pub fn delegate_round(ctx: Context<DelegateRound>, round_id: u64) -> Result<()> {
        instructions::delegation::delegate_round_handler(ctx, round_id)
    }

    pub fn delegate_miner(ctx: Context<DelegateMiner>) -> Result<()> {
        instructions::delegation::delegate_miner_handler(ctx)
    }

    pub fn commit_round(ctx: Context<CommitRound>) -> Result<()> {
        instructions::delegation::commit_round_handler(ctx)
    }

    pub fn commit_miner(ctx: Context<CommitMiner>) -> Result<()> {
        instructions::delegation::commit_miner_handler(ctx)
    }

    // ---- M2a: L1 round-entry accounting ----
    pub fn join_round(ctx: Context<JoinRound>, round_id: u64) -> Result<()> {
        instructions::round_entry::join_round_handler(ctx, round_id)
    }

    pub fn reconcile_miner(ctx: Context<ReconcileMiner>, round_id: u64) -> Result<()> {
        instructions::round_entry::reconcile_miner_handler(ctx, round_id)
    }

    // ---- Direct-stake engine (ORE model): wallet -> pot in the stake tx; no
    // escrow, no session, no delegation in the player path. Pull-claims. ----
    pub fn stake_direct(ctx: Context<StakeDirect>, round_id: u64, block: u8, amount: u64) -> Result<()> {
        instructions::direct::stake_direct_handler(ctx, round_id, block, amount)
    }

    pub fn claim_direct(ctx: Context<ClaimDirect>, round_id: u64) -> Result<()> {
        instructions::direct::claim_direct_handler(ctx, round_id)
    }

    pub fn refund_direct(ctx: Context<RefundDirect>, round_id: u64) -> Result<()> {
        instructions::direct::refund_direct_handler(ctx, round_id)
    }

    // ---- BEEF vault emission layer: per-round vault emission to all stakers,
    // hold-to-grow bonus. All-new accounts; the ANSEM path takes no BEEF
    // accounts and cannot be blocked by this layer. ----
    pub fn init_beef(
        ctx: Context<InitBeef>, max_round_mint: u64, sat_lamports: u64, hard_cap: u64,
        treasury_bps: u16, tick_bps: u16, bonus_cap_bps: u16,
        activity_window_secs: i64, secs_per_tick: i64,
    ) -> Result<()> {
        instructions::beef::init_beef_handler(
            ctx, max_round_mint, sat_lamports, hard_cap, treasury_bps,
            tick_bps, bonus_cap_bps, activity_window_secs, secs_per_tick,
        )
    }

    pub fn set_beef_params(
        ctx: Context<SetBeefParams>, max_round_mint: u64, sat_lamports: u64, tick_bps: u16,
        bonus_cap_bps: u16, activity_window_secs: i64, secs_per_tick: i64,
    ) -> Result<()> {
        instructions::beef::set_beef_params_handler(
            ctx, max_round_mint, sat_lamports, tick_bps, bonus_cap_bps,
            activity_window_secs, secs_per_tick,
        )
    }

    pub fn stamp_beef(ctx: Context<StampBeef>, round_id: u64) -> Result<()> {
        instructions::beef::stamp_beef_handler(ctx, round_id)
    }

    pub fn roll_beef(ctx: Context<RollBeef>, round_id: u64) -> Result<()> {
        instructions::beef::roll_beef_handler(ctx, round_id)
    }

    pub fn claim_beef(ctx: Context<ClaimBeef>) -> Result<()> {
        instructions::beef::claim_beef_handler(ctx)
    }

    // ---- Task 4: solvency-bounded owner exits (mainnet wind-down) ----
    // Ungated (live mainnet paths, present in the no-feature binary). Both are
    // admin-gated on config.admin inside their account structs. sweep_treasury moves
    // treasury SOL to any destination while keeping the PDA rent-alive; sweep_beef_excess
    // moves BEEF above the total_owed solvency floor to an admin-named ATA.
    pub fn sweep_treasury(ctx: Context<SweepTreasury>, amount: u64) -> Result<()> {
        instructions::sweep::sweep_treasury_handler(ctx, amount)
    }

    pub fn sweep_beef_excess(ctx: Context<SweepBeefExcess>, amount: u64) -> Result<()> {
        instructions::sweep::sweep_beef_excess_handler(ctx, amount)
    }

    // ---- Task 5: permissionless round janitor (mainnet rent recycling) ----
    // Ungated (a live mainnet path; present in the no-feature binary). Permissionless:
    // gated only on time + state inside the accounts/handler. Reaps a window-expired
    // CLAIMABLE round (forfeiting its unclaimed remainder into rollover_jackpot) or an
    // empty cancelled round; rent always refunds to config.admin.
    pub fn close_round(ctx: Context<CloseRound>) -> Result<()> {
        instructions::janitor::close_round_handler(ctx)
    }
}
