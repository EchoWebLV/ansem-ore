use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, MintTo, Token, TokenAccount};

use crate::constants::*;
use crate::error::AnsemError;
use crate::state::Config;

#[derive(Accounts)]
pub struct SetParams<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.config_bump,
        constraint = config.admin == admin.key() @ AnsemError::Unauthorized)]
    pub config: Account<'info, Config>,
}

pub fn set_round_duration(ctx: Context<SetParams>, secs: i64) -> Result<()> {
    ctx.accounts.config.round_duration_secs = secs;
    Ok(())
}

pub fn set_jackpot_odds(ctx: Context<SetParams>, odds: u32) -> Result<()> {
    ctx.accounts.config.jackpot_odds = odds;
    Ok(())
}

/// Admin-only test/ops helper: mints ANSEM directly to the jackpot vault via
/// the MINT_AUTH PDA, exactly like execute_swap_mock mints proceeds to the
/// payout vault. This does not move any already-escrowed player funds — it
/// mints new ANSEM supply, the same authority path the mock swap already
/// uses — so it introduces no new fund-moving surface over what
/// execute_swap_mock can already do.
#[derive(Accounts)]
pub struct SeedJackpot<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.config_bump,
        constraint = config.admin == admin.key() @ AnsemError::Unauthorized)]
    pub config: Account<'info, Config>,
    #[account(mut, address = config.ansem_mint)]
    pub ansem_mint: Account<'info, Mint>,
    /// CHECK: mint authority PDA
    #[account(seeds = [MINT_AUTH_SEED], bump = config.mint_auth_bump)]
    pub mint_authority: UncheckedAccount<'info>,
    /// CHECK: jackpot authority PDA
    #[account(seeds = [JACKPOT_AUTH_SEED], bump = config.jackpot_auth_bump)]
    pub jackpot_authority: UncheckedAccount<'info>,
    #[account(init_if_needed, payer = admin,
        associated_token::mint = ansem_mint, associated_token::authority = jackpot_authority)]
    pub jackpot_vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn seed_jackpot(ctx: Context<SeedJackpot>, amount: u64) -> Result<()> {
    let bump = ctx.accounts.config.mint_auth_bump;
    let seeds: &[&[u8]] = &[MINT_AUTH_SEED, &[bump]];
    token::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            MintTo {
                mint: ctx.accounts.ansem_mint.to_account_info(),
                to: ctx.accounts.jackpot_vault.to_account_info(),
                authority: ctx.accounts.mint_authority.to_account_info(),
            },
            &[seeds],
        ),
        amount,
    )?;
    Ok(())
}
