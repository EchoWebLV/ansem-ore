use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Transfer as SolTransfer};
// Token-2022-compatible BEEF sweep: transfer_checked (mint + decimals) over interface types.
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

use crate::constants::*;
use crate::error::AnsemError;
use crate::state::{BeefConfig, Config};

// ---- Solvency-bounded owner exits (plan 2026-07-14, Task 4) ----
// Two admin-gated wind-down paths. Each may remove only value that is NOT owed to
// players: sweep_treasury keeps the treasury PDA rent-alive; sweep_beef_excess keeps
// the BEEF vault covering `total_owed`. Together with the everything-refundable design
// (payout inventory in the keeper ATA, close_round rent recycling) they let the owner
// unwind the deployment leaving only fee dust + players' unclaimed obligations behind.

#[derive(Accounts)]
pub struct SweepTreasury<'info> {
    pub admin: Signer<'info>,

    #[account(
        seeds = [CONFIG_SEED], bump = config.config_bump,
        constraint = config.admin == admin.key() @ AnsemError::Unauthorized
    )]
    pub config: Account<'info, Config>,

    /// CHECK: treasury PDA (SOL only, no data). System-owned; we sign with its seeds.
    #[account(mut, seeds = [TREASURY_SEED], bump = config.treasury_bump)]
    pub treasury: UncheckedAccount<'info>,

    /// CHECK: any destination the admin names — validated only as a lamport sink.
    #[account(mut)]
    pub destination: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn sweep_treasury_handler(ctx: Context<SweepTreasury>, amount: u64) -> Result<()> {
    // Keep the PDA alive: never sweep below rent-exemption for a 0-data account, so the
    // treasury address can never be reaped out from under the program.
    let rent_min = Rent::get()?.minimum_balance(0);
    let available = ctx.accounts.treasury.lamports().saturating_sub(rent_min);
    require!(amount <= available, AnsemError::InsufficientBalance);

    // PDA-signed system transfer, same CPI idiom as the pot_vault -> treasury/player
    // transfers (swap.rs / direct.rs). anchor-lang 1.0's CpiContext takes the program id.
    let seeds: &[&[u8]] = &[TREASURY_SEED, &[ctx.accounts.config.treasury_bump]];
    system_program::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.system_program.key(),
            SolTransfer {
                from: ctx.accounts.treasury.to_account_info(),
                to: ctx.accounts.destination.to_account_info(),
            },
            &[seeds],
        ),
        amount,
    )
}

#[derive(Accounts)]
pub struct SweepBeefExcess<'info> {
    pub admin: Signer<'info>,

    #[account(
        seeds = [CONFIG_SEED], bump = config.config_bump,
        constraint = config.admin == admin.key() @ AnsemError::Unauthorized
    )]
    pub config: Account<'info, Config>,

    #[account(seeds = [BEEF_CONFIG_SEED], bump = beef_config.bump)]
    pub beef_config: Account<'info, BeefConfig>,

    /// CHECK: vault authority PDA — owner of beef_vault; signs the token transfer.
    #[account(seeds = [VAULT_AUTH_SEED], bump = config.vault_auth_bump)]
    pub vault_authority: UncheckedAccount<'info>,

    // Pinned to beef_config.beef_mint — transfer_checked needs the mint account + decimals.
    #[account(address = beef_config.beef_mint @ AnsemError::BadBeefVault)]
    pub beef_mint: InterfaceAccount<'info, Mint>,

    #[account(mut, address = beef_config.beef_vault @ AnsemError::BadBeefVault)]
    pub beef_vault: InterfaceAccount<'info, TokenAccount>,

    #[account(mut, token::mint = beef_config.beef_mint)]
    pub destination_ata: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
}

pub fn sweep_beef_excess_handler(ctx: Context<SweepBeefExcess>, amount: u64) -> Result<()> {
    // Refundability rule: only supply ABOVE the player solvency ledger may leave. The
    // saturating_sub means a drifted/over-counted total_owed only ever shrinks the free
    // surplus (conservative — it can never let owed BEEF be swept).
    let free = ctx
        .accounts
        .beef_vault
        .amount
        .saturating_sub(ctx.accounts.beef_config.total_owed);
    require!(amount <= free, AnsemError::InsufficientBalance);

    // vault_authority-signed SPL transfer, same idiom as claim_direct / claim_beef.
    // transfer_checked (mint + decimals) so a Token-2022 BEEF mint settles correctly.
    let decimals = ctx.accounts.beef_mint.decimals;
    let seeds: &[&[u8]] = &[VAULT_AUTH_SEED, &[ctx.accounts.config.vault_auth_bump]];
    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.beef_vault.to_account_info(),
                mint: ctx.accounts.beef_mint.to_account_info(),
                to: ctx.accounts.destination_ata.to_account_info(),
                authority: ctx.accounts.vault_authority.to_account_info(),
            },
            &[seeds],
        ),
        amount,
        decimals,
    )
}
