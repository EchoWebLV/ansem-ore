use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{Mint, Token};

use crate::constants::*;
use crate::state::Config;

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        init, payer = admin, space = 8 + Config::INIT_SPACE,
        seeds = [CONFIG_SEED], bump
    )]
    pub config: Account<'info, Config>,

    /// CHECK: PDA that is the mock mint authority; not read/written here
    #[account(seeds = [MINT_AUTH_SEED], bump)]
    pub mint_authority: UncheckedAccount<'info>,

    // `init_if_needed` (not `init`): the ANSEM mint is a permanent PDA that must
    // survive a Config-layout migration. After an admin `close_config`, re-running
    // `initialize` recreates a fresh Config (still strict `init`) while REUSING the
    // existing mint instead of failing to allocate an address already in use.
    // Anchor validates the existing mint against these same decimals/authority, so
    // the reuse is safe; on a first-ever deploy this creates the mint normally.
    #[account(
        init_if_needed, payer = admin,
        seeds = [ANSEM_MINT_SEED], bump,
        mint::decimals = ANSEM_DECIMALS,
        mint::authority = mint_authority,
    )]
    pub ansem_mint: Account<'info, Mint>,

    /// CHECK: vault authority PDA (owns the payout token vault); ATA created lazily at swap
    #[account(seeds = [VAULT_AUTH_SEED], bump)]
    pub vault_authority: UncheckedAccount<'info>,

    /// CHECK: SOL pot vault PDA (system-owned lamport holder)
    #[account(seeds = [POT_VAULT_SEED], bump)]
    pub pot_vault: UncheckedAccount<'info>,

    /// CHECK: treasury PDA (SOL)
    #[account(seeds = [TREASURY_SEED], bump)]
    pub treasury: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn initialize_handler(ctx: Context<Initialize>) -> Result<()> {
    let c = &mut ctx.accounts.config;
    c.admin = ctx.accounts.admin.key();
    c.ansem_mint = ctx.accounts.ansem_mint.key();
    c.swap_mode = SWAP_MODE_MOCK;
    c.current_round_id = 0;
    c.round_duration_secs = DEFAULT_ROUND_DURATION_SECS;
    c.fee_bps = DEFAULT_FEE_BPS;
    c.mult_min_bps = DEFAULT_MULT_MIN_BPS;
    c.mult_max_bps = DEFAULT_MULT_MAX_BPS;
    c.min_stake = DEFAULT_MIN_STAKE;
    c.max_stake_per_round = DEFAULT_MAX_STAKE_PER_ROUND;
    c.mock_rate = DEFAULT_MOCK_RATE;
    c.total_escrow_balance = 0;
    c.rollover_jackpot = 0;
    // No round exists yet; treat as finalized so the first create_round passes.
    c.current_round_finalized = true;
    c.config_bump = ctx.bumps.config;
    c.pot_vault_bump = ctx.bumps.pot_vault;
    c.treasury_bump = ctx.bumps.treasury;
    c.vault_auth_bump = ctx.bumps.vault_authority;
    c.mint_auth_bump = ctx.bumps.mint_authority;
    Ok(())
}
