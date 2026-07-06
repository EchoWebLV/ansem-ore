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

    #[account(mut, seeds = [CONFIG_SEED], bump = config.config_bump)]
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

pub fn execute_swap_mock_handler(ctx: Context<ExecuteSwapMock>) -> Result<()> {
    // Copy config scalars up front so we can mutate config (current_round_finalized)
    // at the end without holding an outstanding immutable borrow of it.
    let swap_mode = ctx.accounts.config.swap_mode;
    let fee_bps = ctx.accounts.config.fee_bps;
    let mock_rate = ctx.accounts.config.mock_rate;
    let total_escrow_balance = ctx.accounts.config.total_escrow_balance;
    let pot_vault_bump = ctx.accounts.config.pot_vault_bump;
    let mint_auth_bump = ctx.accounts.config.mint_auth_bump;

    require!(swap_mode == SWAP_MODE_MOCK, AnsemError::WrongSwapMode);
    let round = &mut ctx.accounts.round;
    require!(round.state == STATE_SETTLED, AnsemError::BadRoundState);

    let pot = round.pot;
    let fee = (pot as u128 * fee_bps as u128 / 10_000u128) as u64;
    // defensive: fee is <= pot only while fee_bps <= 10_000 (no setter exists in
    // M1, but any future set_fee_bps MUST bound fee_bps <= 10_000).
    let net = pot.checked_sub(fee).ok_or(AnsemError::Overflow)?;

    // Solvency check: pot_vault is a single commingled PDA holding both idle
    // PlayerEscrow balances and every round's (unswapped) pot. Draining this
    // round's `pot` lamports out to treasury must never dip into lamports
    // still owed to depositors (total_escrow_balance) or to other rounds
    // that haven't swapped yet. We can't separately account "other rounds'
    // pots" without a per-round vault, but we CAN guarantee this swap never
    // touches escrow-owed funds, and that pot_vault actually holds at least
    // `pot` lamports for the amount we are about to move.
    let pot_vault_lamports = ctx.accounts.pot_vault.lamports();
    require!(pot_vault_lamports >= total_escrow_balance, AnsemError::Insolvent);
    let available_for_pots = pot_vault_lamports - total_escrow_balance;
    require!(available_for_pots >= pot, AnsemError::Insolvent);

    // Simulate the sale: move the entire pot lamports out of pot_vault into treasury.
    let pv_seeds: &[&[u8]] = &[POT_VAULT_SEED, &[pot_vault_bump]];
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
    let ansem_out = (net as u128 * mock_rate as u128 / LAMPORTS_PER_SOL as u128) as u64;
    let ma_seeds: &[&[u8]] = &[MINT_AUTH_SEED, &[mint_auth_bump]];
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

    // The round is now finalized (Claimable). Under the create_round
    // serialization gate the only non-finalized round is always the current
    // one, so re-arming this flag unblocks the next create_round.
    ctx.accounts.config.current_round_finalized = true;
    Ok(())
}
