use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
// Token-2022-compatible payout: transfer_checked (mint + decimals) over interface types.
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

use crate::constants::*;
use crate::error::AnsemError;
use crate::math;
use crate::state::{Config, MinerPosition, PlayerEscrow, Round, STATE_CLAIMABLE};

#[derive(Accounts)]
#[instruction(round_id: u64)]
pub struct Claim<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    // Accounts are Box'd to keep Claim::try_accounts under the 4KB BPF stack
    // frame limit (deserializing this many token/state accounts on the stack
    // overflows it — a silent overflow manifests as bogus CPI privilege errors).
    #[account(mut, seeds = [CONFIG_SEED], bump = config.config_bump)]
    pub config: Box<Account<'info, Config>>,

    #[account(mut, seeds = [ROUND_SEED, round_id.to_le_bytes().as_ref()], bump = round.bump,
        constraint = round.round_id == round_id @ AnsemError::MinerRoundMismatch)]
    pub round: Box<Account<'info, Round>>,

    #[account(mut, seeds = [MINER_SEED, authority.key().as_ref()], bump = miner.bump,
        constraint = miner.authority == authority.key() @ AnsemError::Unauthorized,
        constraint = miner.round_id == round_id @ AnsemError::MinerRoundMismatch)]
    pub miner: Box<Account<'info, MinerPosition>>,

    #[account(mut, seeds = [ESCROW_SEED, authority.key().as_ref()], bump = escrow.bump,
        constraint = escrow.authority == authority.key() @ AnsemError::Unauthorized)]
    pub escrow: Box<Account<'info, PlayerEscrow>>,

    #[account(address = config.ansem_mint)]
    pub ansem_mint: Box<InterfaceAccount<'info, Mint>>,

    /// CHECK: vault authority PDA
    #[account(seeds = [VAULT_AUTH_SEED], bump = config.vault_auth_bump)]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(mut, associated_token::mint = ansem_mint, associated_token::authority = vault_authority,
        associated_token::token_program = token_program)]
    pub payout_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(init_if_needed, payer = authority,
        associated_token::mint = ansem_mint, associated_token::authority = authority,
        associated_token::token_program = token_program)]
    pub player_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn claim_handler(ctx: Context<Claim>, round_id: u64) -> Result<()> {
    // transfer_checked needs the mint decimals; scalar copy up front (Token-2022 shape).
    let ansem_decimals = ctx.accounts.ansem_mint.decimals;
    let cfg = &ctx.accounts.config;
    let round = &ctx.accounts.round;
    require!(round.state == STATE_CLAIMABLE, AnsemError::BadRoundState);

    let escrow = &mut ctx.accounts.escrow;
    require!(escrow.last_claimed_round < round_id, AnsemError::AlreadyClaimed);

    let miner = &ctx.accounts.miner;

    // Payout = non-jackpot returns (0-50% per square) + this player's pro-rata
    // share of the jackpot pool if they staked the jackpot square. Both are paid
    // from the single payout_vault; every input is frozen round state, so the
    // amount is independent of claim order.
    let jsq = round.jackpot_square as usize;
    let nj_weight = math::return_weight(
        &miner.block_stake,
        &round.randomness,
        round.jackpot_square,
        cfg.mult_min_bps,
        cfg.mult_max_bps,
    );
    let nj_amount = math::nonjackpot_payout(nj_weight, round.pot, round.swap_proceeds);
    let jp_amount =
        math::jackpot_share(round.jackpot_pool, miner.block_stake[jsq], round.block_sol[jsq]);
    let amount = nj_amount.checked_add(jp_amount).ok_or(AnsemError::Overflow)?;

    if amount > 0 {
        let va_bump = cfg.vault_auth_bump;
        let va_seeds: &[&[u8]] = &[VAULT_AUTH_SEED, &[va_bump]];
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.payout_vault.to_account_info(),
                    mint: ctx.accounts.ansem_mint.to_account_info(),
                    to: ctx.accounts.player_ata.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                },
                &[va_seeds],
            ),
            amount,
            ansem_decimals,
        )?;
    }

    // Ledger: this round paid out `amount` of its entitlement — record it and
    // draw down the config solvency total by the same.
    let round = &mut ctx.accounts.round;
    round.claimed_proceeds = round.claimed_proceeds.saturating_add(amount);
    let cfg = &mut ctx.accounts.config;
    // saturating: a ledger drift must never block a player's claim.
    cfg.ansem_obligations = cfg.ansem_obligations.saturating_sub(amount);

    // NOTE: claim intentionally does NOT touch Config.total_escrow_balance —
    // the staked SOL already left escrow (and total_escrow_balance) at
    // reconcile_miner time (M2a reconcile-at-commit), and claim only ever moves
    // ANSEM (payout_vault/jackpot_vault), never SOL/escrow lamports.
    // active_round was already cleared by reconcile_miner; re-zeroing it here is
    // redundant-but-harmless (keeps claim correct if ever called pre-reconcile).
    escrow.last_claimed_round = round_id;
    escrow.active_round = 0;
    Ok(())
}
