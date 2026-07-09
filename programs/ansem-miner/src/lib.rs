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

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        instructions::initialize::initialize_handler(ctx)
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

    // DEVNET/TEST-ONLY migration tool — see instructions/admin.rs::close_config.
    pub fn close_config(ctx: Context<CloseConfig>) -> Result<()> {
        instructions::admin::close_config(ctx)
    }

    // DEVNET/TEST-ONLY migration tool — see instructions/admin.rs::set_round_cursor.
    pub fn set_round_cursor(ctx: Context<SetParams>, new_id: u64) -> Result<()> {
        instructions::admin::set_round_cursor(ctx, new_id)
    }

    pub fn execute_swap_mock(ctx: Context<ExecuteSwapMock>) -> Result<()> {
        instructions::swap::execute_swap_mock_handler(ctx)
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
        ctx: Context<InitBeef>, divisor: u64, tick_bps: u16, bonus_cap_bps: u16,
        activity_window_secs: i64, secs_per_tick: i64,
    ) -> Result<()> {
        instructions::beef::init_beef_handler(ctx, divisor, tick_bps, bonus_cap_bps, activity_window_secs, secs_per_tick)
    }

    pub fn set_beef_params(
        ctx: Context<SetBeefParams>, divisor: u64, tick_bps: u16, bonus_cap_bps: u16,
        activity_window_secs: i64, secs_per_tick: i64,
    ) -> Result<()> {
        instructions::beef::set_beef_params_handler(ctx, divisor, tick_bps, bonus_cap_bps, activity_window_secs, secs_per_tick)
    }

    pub fn stamp_beef(ctx: Context<StampBeef>, round_id: u64) -> Result<()> {
        instructions::beef::stamp_beef_handler(ctx, round_id)
    }
}
