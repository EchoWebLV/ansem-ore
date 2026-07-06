use anchor_lang::prelude::*;
use session_keys::{session_auth_or, Session, SessionError, SessionTokenV2};

use crate::constants::*;
use crate::error::AnsemError;
use crate::state::{Config, MinerPosition, PlayerEscrow, Round, STATE_OPEN};

// M2c: `stake` is the ONLY session-gated instruction. A browser mints one
// SessionTokenV2 on L1 (one wallet popup, via the bundled gum program), then
// signs a burst of ER stakes with the ephemeral session key — no popup per tile.
// `deposit`/`withdraw`/`claim` still require the real wallet, so a leaked session
// key can never move value OUT of escrow; its blast radius is at most one round's
// `max_stake_per_round`, and it expires (≤ 7 days).
//
// KEY: `miner`/`escrow` are seeded on `miner.authority` (the WALLET), NOT on
// `authority.key()` (the SIGNER — which is the session key when session-signed).
// The signer↔wallet binding is enforced by the session gate (the SessionTokenV2
// PDA binds target_program + session_signer + authority), not by the seeds.
#[derive(Accounts, Session)]
pub struct Stake<'info> {
    // The signer: the ephemeral session key OR the real player wallet. Not `mut`:
    // the handler never writes it, and on the ER the Magic program rejects any
    // writable account that is neither delegated nor the fee payer. The signer is
    // always the fee payer here (self-pay / session-key submit), so it is writable
    // at the tx level regardless — no need to mark it `mut`.
    pub authority: Signer<'info>,

    // Read-only clone in the ER — used only to read caps/budget, never written.
    #[account(seeds = [CONFIG_SEED], bump = config.config_bump)]
    pub config: Account<'info, Config>,

    // Delegated in the ER (writable there).
    #[account(mut, seeds = [ROUND_SEED, round.round_id.to_le_bytes().as_ref()], bump = round.bump)]
    pub round: Account<'info, Round>,

    // Delegated in the ER (writable there). Seeded on the STORED wallet
    // (miner.authority) so a session-key signer resolves the correct PDA. The
    // "signer is the owner" check for the wallet path moves to `session_auth_or`.
    #[account(mut, seeds = [MINER_SEED, miner.authority.as_ref()], bump = miner.bump)]
    pub miner: Account<'info, MinerPosition>,

    // Read-only clone — soft budget check only (no `mut`; no debit here). Bound to
    // the same wallet as the miner.
    #[account(
        seeds = [ESCROW_SEED, miner.authority.as_ref()], bump = escrow.bump,
        constraint = escrow.authority == miner.authority @ AnsemError::Unauthorized
    )]
    pub escrow: Account<'info, PlayerEscrow>,

    // Optional session token. When present, the `session_auth_or` gate validates
    // it: PDA-binds [ "session_token_v2", our_program, session_signer=authority,
    // authority=miner.authority ] and checks `now < valid_until`. A token for
    // another program, another wallet, another signer, or an expired one all fail.
    #[session(
        signer = authority,                 // the Signer<'info> field above
        authority = miner.authority.key()   // the real wallet that created the session
    )]
    pub session_token: Option<Account<'info, SessionTokenV2>>,
}

// ctx MUST be named `ctx` — the session_auth_or macro hardcodes that identifier.
// Gate: session-signed ⇒ a valid SessionTokenV2 (checked by the macro); else the
// fallback ⇒ the signer must BE the miner's wallet.
#[session_auth_or(
    ctx.accounts.miner.authority.key() == ctx.accounts.authority.key(),
    SessionError::InvalidToken
)]
pub fn stake_handler(ctx: Context<Stake>, block: u8, amount: u64) -> Result<()> {
    require!((block as usize) < GRID_SIZE, AnsemError::BadBlock);

    let min_stake = ctx.accounts.config.min_stake;
    let max_stake_per_round = ctx.accounts.config.max_stake_per_round;
    let escrow_balance = ctx.accounts.escrow.balance;
    let escrow_active_round = ctx.accounts.escrow.active_round;

    let round = &mut ctx.accounts.round;
    let miner = &mut ctx.accounts.miner;

    require!(round.state == STATE_OPEN, AnsemError::RoundNotOpen);
    // Must have joined THIS round on L1 first (soft check against the read-only
    // escrow clone). Beyond enforcing join-before-stake, this closes a
    // self-inflicted under-debit: once reconcile_miner clears active_round, a
    // player cannot re-stake into the same round and dodge the escrow debit
    // (reconciled_round would skip the second debit).
    require!(escrow_active_round == round.round_id, AnsemError::NotCurrentRound);
    let now = Clock::get()?.unix_timestamp;
    require!(now < round.deadline_ts, AnsemError::RoundEnded);
    require!(amount >= min_stake, AnsemError::StakeTooSmall);

    // New-round entry: reset the persistent miner. The L1 `join_round` already
    // set escrow.active_round and enforced "prior round reconciled/clean", so
    // the ER path does NOT read/write escrow. (Reconciliation is tracked on the
    // escrow's reconciled_round, set by the L1 reconcile_miner.)
    if miner.round_id != round.round_id {
        miner.block_stake = [0u64; GRID_SIZE];
        miner.round_id = round.round_id;
    }

    // Per-round cap AND soft budget check against the (read-only) escrow clone.
    // The clone can be slightly stale, but escrow.balance only decreases via
    // withdraw — which is locked all round by active_round — so it is a safe
    // upper bound. The HARD accounting is L1 reconcile_miner.
    let prior: u64 = miner.block_stake.iter().sum();
    let new_total = prior.checked_add(amount).ok_or(AnsemError::Overflow)?;
    require!(new_total <= max_stake_per_round, AnsemError::StakeTooLarge);
    require!(new_total <= escrow_balance, AnsemError::InsufficientBalance);

    miner.block_stake[block as usize] =
        miner.block_stake[block as usize].checked_add(amount).ok_or(AnsemError::Overflow)?;
    round.block_sol[block as usize] =
        round.block_sol[block as usize].checked_add(amount).ok_or(AnsemError::Overflow)?;
    round.pot = round.pot.checked_add(amount).ok_or(AnsemError::Overflow)?;
    // NOTE: escrow debit + total_escrow_balance decrement intentionally removed —
    // relocated to L1 reconcile_miner (see round_entry.rs).
    Ok(())
}
