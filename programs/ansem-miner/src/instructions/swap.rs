use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Transfer as SolTransfer};
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, MintTo, Token, TokenAccount};

use crate::constants::*;
use crate::error::AnsemError;
use crate::state::{Config, Round, STATE_CLAIMABLE, STATE_SETTLED};

#[derive(Accounts)]
pub struct ExecuteSwapMock<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.config_bump)]
    pub config: Account<'info, Config>,

    #[account(mut, seeds = [ROUND_SEED, round.round_id.to_le_bytes().as_ref()], bump = round.bump)]
    pub round: Account<'info, Round>,

    #[account(mut, address = config.ansem_mint)]
    pub ansem_mint: Account<'info, Mint>,

    /// CHECK: mint authority PDA
    #[account(seeds = [MINT_AUTH_SEED], bump = config.mint_auth_bump)]
    pub mint_authority: UncheckedAccount<'info>,

    /// CHECK: vault authority PDA (owner of payout vault)
    #[account(seeds = [VAULT_AUTH_SEED], bump = config.vault_auth_bump)]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(
        init_if_needed, payer = payer,
        associated_token::mint = ansem_mint,
        associated_token::authority = vault_authority
    )]
    pub payout_vault: Account<'info, TokenAccount>,

    /// CHECK: SOL pot vault PDA
    #[account(mut, seeds = [POT_VAULT_SEED], bump = config.pot_vault_bump)]
    pub pot_vault: UncheckedAccount<'info>,

    /// CHECK: treasury PDA (SOL)
    #[account(mut, seeds = [TREASURY_SEED], bump = config.treasury_bump)]
    pub treasury: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<ExecuteSwapMock>) -> Result<()> {
    let cfg = &ctx.accounts.config;
    require!(cfg.swap_mode == SWAP_MODE_MOCK, AnsemError::WrongSwapMode);
    let round = &mut ctx.accounts.round;
    require!(round.state == STATE_SETTLED, AnsemError::BadRoundState);

    let pot = round.pot;
    let fee = (pot as u128 * cfg.fee_bps as u128 / 10_000u128) as u64;
    let net = pot - fee;

    // Simulate the sale: move the entire pot lamports out of pot_vault into treasury.
    let pv_bump = cfg.pot_vault_bump;
    let pv_seeds: &[&[u8]] = &[POT_VAULT_SEED, &[pv_bump]];
    system_program::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.system_program.to_account_info(),
            SolTransfer {
                from: ctx.accounts.pot_vault.to_account_info(),
                to: ctx.accounts.treasury.to_account_info(),
            },
            &[pv_seeds],
        ),
        pot,
    )?;

    // Mint ANSEM proceeds to the payout vault.
    let ansem_out = (net as u128 * cfg.mock_rate as u128 / LAMPORTS_PER_SOL as u128) as u64;
    let ma_bump = cfg.mint_auth_bump;
    let ma_seeds: &[&[u8]] = &[MINT_AUTH_SEED, &[ma_bump]];
    token::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            MintTo {
                mint: ctx.accounts.ansem_mint.to_account_info(),
                to: ctx.accounts.payout_vault.to_account_info(),
                authority: ctx.accounts.mint_authority.to_account_info(),
            },
            &[ma_seeds],
        ),
        ansem_out,
    )?;

    round.swap_proceeds = ansem_out;
    round.state = STATE_CLAIMABLE;
    Ok(())
}
