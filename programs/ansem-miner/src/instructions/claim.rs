use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

use crate::constants::*;
use crate::error::AnsemError;
use crate::math;
use crate::state::{Config, MinerPosition, PlayerEscrow, Round, STATE_CLAIMABLE};

#[derive(Accounts)]
#[instruction(round_id: u64)]
pub struct Claim<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.config_bump)]
    pub config: Account<'info, Config>,

    #[account(seeds = [ROUND_SEED, round_id.to_le_bytes().as_ref()], bump = round.bump,
        constraint = round.round_id == round_id @ AnsemError::MinerRoundMismatch)]
    pub round: Account<'info, Round>,

    #[account(mut, seeds = [MINER_SEED, authority.key().as_ref()], bump = miner.bump,
        constraint = miner.authority == authority.key() @ AnsemError::Unauthorized,
        constraint = miner.round_id == round_id @ AnsemError::MinerRoundMismatch)]
    pub miner: Account<'info, MinerPosition>,

    #[account(mut, seeds = [ESCROW_SEED, authority.key().as_ref()], bump = escrow.bump,
        constraint = escrow.authority == authority.key() @ AnsemError::Unauthorized)]
    pub escrow: Account<'info, PlayerEscrow>,

    #[account(address = config.ansem_mint)]
    pub ansem_mint: Account<'info, Mint>,

    /// CHECK: vault authority PDA
    #[account(seeds = [VAULT_AUTH_SEED], bump = config.vault_auth_bump)]
    pub vault_authority: UncheckedAccount<'info>,

    /// CHECK: jackpot authority PDA
    #[account(seeds = [JACKPOT_AUTH_SEED], bump = config.jackpot_auth_bump)]
    pub jackpot_authority: UncheckedAccount<'info>,

    #[account(mut, associated_token::mint = ansem_mint, associated_token::authority = vault_authority)]
    pub payout_vault: Account<'info, TokenAccount>,

    #[account(mut, associated_token::mint = ansem_mint, associated_token::authority = jackpot_authority)]
    pub jackpot_vault: Account<'info, TokenAccount>,

    #[account(init_if_needed, payer = authority,
        associated_token::mint = ansem_mint, associated_token::authority = authority)]
    pub player_ata: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn claim_handler(ctx: Context<Claim>, round_id: u64) -> Result<()> {
    let cfg = &ctx.accounts.config;
    let round = &ctx.accounts.round;
    require!(round.state == STATE_CLAIMABLE, AnsemError::BadRoundState);

    let escrow = &mut ctx.accounts.escrow;
    require!(escrow.last_claimed_round < round_id, AnsemError::AlreadyClaimed);

    let miner = &ctx.accounts.miner;

    // main payout
    let tw = math::total_weight(&round.block_sol, &round.randomness, cfg.mult_min_bps, cfg.mult_max_bps);
    let pw = math::player_weight(&miner.block_stake, &round.randomness, cfg.mult_min_bps, cfg.mult_max_bps);
    let amount = math::payout(pw, tw, round.swap_proceeds);

    if amount > 0 {
        let va_bump = cfg.vault_auth_bump;
        let va_seeds: &[&[u8]] = &[VAULT_AUTH_SEED, &[va_bump]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.payout_vault.to_account_info(),
                    to: ctx.accounts.player_ata.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                },
                &[va_seeds],
            ),
            amount,
        )?;
    }

    // jackpot payout (additive) if this round hit and the player staked the jackpot square
    if round.jackpot_hit {
        let jb = round.jackpot_block as usize;
        let block_total = round.block_sol[jb];
        let player_on_block = miner.block_stake[jb];
        if block_total > 0 && player_on_block > 0 {
            let pool = ctx.accounts.jackpot_vault.amount;
            let payout_pool = (pool as u128 * cfg.jackpot_bps as u128 / 10_000u128) as u64;
            let share = (payout_pool as u128 * player_on_block as u128 / block_total as u128) as u64;
            if share > 0 {
                let ja_bump = cfg.jackpot_auth_bump;
                let ja_seeds: &[&[u8]] = &[JACKPOT_AUTH_SEED, &[ja_bump]];
                token::transfer(
                    CpiContext::new_with_signer(
                        ctx.accounts.token_program.to_account_info(),
                        Transfer {
                            from: ctx.accounts.jackpot_vault.to_account_info(),
                            to: ctx.accounts.player_ata.to_account_info(),
                            authority: ctx.accounts.jackpot_authority.to_account_info(),
                        },
                        &[ja_seeds],
                    ),
                    share,
                )?;
            }
        }
    }

    // NOTE: claim intentionally does NOT touch Config.total_escrow_balance —
    // the staked SOL already left escrow (and total_escrow_balance) at stake
    // time, and claim only ever moves ANSEM (payout_vault/jackpot_vault),
    // never SOL/escrow lamports.
    escrow.last_claimed_round = round_id;
    escrow.active_round = 0;
    Ok(())
}
