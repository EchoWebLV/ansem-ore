use anchor_lang::prelude::*;
use ephemeral_vrf_sdk::anchor::vrf;
use ephemeral_vrf_sdk::instructions::{create_request_randomness_ix, RequestRandomnessParams};
use ephemeral_vrf_sdk::types::SerializableAccountMeta;

use crate::constants::*;
use crate::error::AnsemError;
use crate::instruction;
use crate::math;
use crate::state::{Config, Round, STATE_OPEN, STATE_SETTLED, STATE_VRF_PENDING};

// ============================================================================
// M2b — Ephemeral VRF settle. Replaces the *source* of the 32-byte randomness
// (M1's admin-injected `settle` arg) with a MagicBlock ephemeral VRF draw. The
// jackpot math is byte-identical to `settle.rs`; only where the randomness comes
// from changes. Runs inside the ER against the delegated Round; the oracle CPIs
// `settle_callback` with the drawn randomness, proven by an injected
// VRF_PROGRAM_IDENTITY signer. Admin `settle` is kept as a devnet/test fallback.
// ============================================================================

// ---- Request (ER, admin-gated crank). #[vrf] injects program_identity,
// vrf_program, slot_hashes, system_program + the invoke_signed_vrf() method. ----
#[vrf]
#[derive(Accounts)]
pub struct RequestSettle<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(mut, seeds = [ROUND_SEED, round.round_id.to_le_bytes().as_ref()], bump = round.bump)]
    pub round: Account<'info, Round>,

    // Admin gate inherited from M1 `settle` — also neutralizes queue griefing on
    // this crank (a permissionless caller could post a request to a bogus queue
    // and strand the round in VrfPending).
    #[account(seeds = [CONFIG_SEED], bump = config.config_bump,
        constraint = config.admin == payer.key() @ AnsemError::Unauthorized)]
    pub config: Account<'info, Config>,

    /// CHECK: VRF queue the ER oracle services. Client/env-supplied because the
    /// local test queue (Sc9MJU…) differs from the SDK default (5hBR571…).
    /// Integrity is enforced by the callback's VRF_PROGRAM_IDENTITY signer, never
    /// by which queue the request is posted to: a wrong queue yields no callback
    /// (round recoverable via cancel_round), it cannot forge randomness.
    #[account(mut)]
    pub oracle_queue: UncheckedAccount<'info>,
}

pub fn request_settle_handler(ctx: Context<RequestSettle>, client_seed: u8) -> Result<()> {
    require!(ctx.accounts.round.state == STATE_OPEN, AnsemError::BadRoundState);
    let now = Clock::get()?.unix_timestamp;
    require!(now >= ctx.accounts.round.deadline_ts, AnsemError::RoundNotEnded);

    // Capture keys before mutating so borrows stay disjoint.
    let round_id = ctx.accounts.round.round_id;
    let round_key = ctx.accounts.round.key();
    let config_key = ctx.accounts.config.key();
    let payer_key = ctx.accounts.payer.key();
    let queue_key = ctx.accounts.oracle_queue.key();

    ctx.accounts.round.state = STATE_VRF_PENDING;

    // Mix round_id into the caller seed so distinct rounds request distinct draws.
    let mut caller_seed = [client_seed; 32];
    caller_seed[..8].copy_from_slice(&round_id.to_le_bytes());

    let ix = create_request_randomness_ix(RequestRandomnessParams {
        payer: payer_key,
        oracle_queue: queue_key,
        callback_program_id: crate::ID,
        callback_discriminator: instruction::SettleCallback::DISCRIMINATOR.to_vec(),
        caller_seed,
        // Order MUST match SettleCallback's fields AFTER vrf_program_identity.
        accounts_metas: Some(vec![
            SerializableAccountMeta { pubkey: round_key, is_signer: false, is_writable: true },
            SerializableAccountMeta { pubkey: config_key, is_signer: false, is_writable: false },
        ]),
        ..Default::default()
    });
    ctx.accounts
        .invoke_signed_vrf(&ctx.accounts.payer.to_account_info(), &ix)?;
    Ok(())
}

// ---- Callback (ER, VRF identity only). Plain derive: no #[vrf_callback], no
// #[commit] — we write state to the already-delegated Round; the later
// commit_round undelegates it. The address constraint is the ONLY authorizer. ----
#[derive(Accounts)]
pub struct SettleCallback<'info> {
    #[account(address = ephemeral_vrf_sdk::consts::VRF_PROGRAM_IDENTITY)]
    pub vrf_program_identity: Signer<'info>,

    #[account(mut, seeds = [ROUND_SEED, round.round_id.to_le_bytes().as_ref()], bump = round.bump)]
    pub round: Account<'info, Round>,

    #[account(seeds = [CONFIG_SEED], bump = config.config_bump)]
    pub config: Account<'info, Config>,
}

pub fn settle_callback_handler(ctx: Context<SettleCallback>, randomness: [u8; 32]) -> Result<()> {
    let cfg = &ctx.accounts.config;
    let round = &mut ctx.accounts.round;
    // One-shot guard: only a VrfPending round accepts randomness → blocks replay /
    // a second oracle fire from overwriting a settled draw.
    require!(round.state == STATE_VRF_PENDING, AnsemError::BadRoundState);

    round.randomness = randomness;
    round.small_jackpot_hit = math::jackpot_hit(&randomness, cfg.small_jackpot_odds, b"jackpot_sm");
    round.small_jackpot_block = math::jackpot_block(&randomness, b"jkblock_sm");
    round.big_jackpot_hit = math::jackpot_hit(&randomness, cfg.big_jackpot_odds, b"jackpot_big");
    round.big_jackpot_block = math::jackpot_block(&randomness, b"jkblock_big");
    round.state = STATE_SETTLED;
    Ok(())
}
