use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Transfer};

use crate::constants::*;
use crate::error::AnsemError;
use crate::state::{Config, PlayerEscrow};

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.config_bump)]
    pub config: Account<'info, Config>,

    #[account(
        init_if_needed, payer = authority, space = 8 + PlayerEscrow::INIT_SPACE,
        seeds = [ESCROW_SEED, authority.key().as_ref()], bump
    )]
    pub escrow: Account<'info, PlayerEscrow>,

    /// CHECK: SOL pot vault PDA
    #[account(mut, seeds = [POT_VAULT_SEED], bump = config.pot_vault_bump)]
    pub pot_vault: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            Transfer {
                from: ctx.accounts.authority.to_account_info(),
                to: ctx.accounts.pot_vault.to_account_info(),
            },
        ),
        amount,
    )?;
    let e = &mut ctx.accounts.escrow;
    if e.authority == Pubkey::default() {
        e.authority = ctx.accounts.authority.key();
        e.bump = ctx.bumps.escrow;
    }
    e.balance = e.balance.checked_add(amount).ok_or(AnsemError::Overflow)?;
    e.deposited_total = e.deposited_total.checked_add(amount).ok_or(AnsemError::Overflow)?;
    Ok(())
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.config_bump)]
    pub config: Account<'info, Config>,

    #[account(
        mut, seeds = [ESCROW_SEED, authority.key().as_ref()], bump = escrow.bump,
        constraint = escrow.authority == authority.key() @ AnsemError::Unauthorized
    )]
    pub escrow: Account<'info, PlayerEscrow>,

    /// CHECK: SOL pot vault PDA
    #[account(mut, seeds = [POT_VAULT_SEED], bump = config.pot_vault_bump)]
    pub pot_vault: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
    let e = &mut ctx.accounts.escrow;
    // withdraw guard: no active unclaimed round
    require!(e.active_round == 0, AnsemError::WithdrawLocked);
    require!(amount <= e.balance, AnsemError::InsufficientBalance);

    let bump = ctx.accounts.config.pot_vault_bump;
    let seeds: &[&[u8]] = &[POT_VAULT_SEED, &[bump]];
    system_program::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.system_program.to_account_info(),
            Transfer {
                from: ctx.accounts.pot_vault.to_account_info(),
                to: ctx.accounts.authority.to_account_info(),
            },
            &[seeds],
        ),
        amount,
    )?;
    e.balance -= amount;
    e.withdrawn_total = e.withdrawn_total.checked_add(amount).ok_or(AnsemError::Overflow)?;
    Ok(())
}
