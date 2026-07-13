use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Transfer as SolTransfer};
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, MintTo, Token, TokenAccount, Transfer as TokenTransfer};

use crate::constants::*;
use crate::error::AnsemError;
use crate::math;
use crate::state::{Config, Round, STATE_CLAIMABLE, STATE_SETTLED};

// Everything after the ANSEM proceeds (`ansem_out`) are known — identical for the mock
// (PDA-mint) and the real (keeper-inventory) swap: split losers' returns from the
// jackpot pool, carry or consume the rollover, freeze the round's entitlement ceiling,
// grow the obligations solvency ledger, flip the round to Claimable and re-arm the
// create_round serialization gate. Kept as one free function so both handlers share a
// single accounting path — the mock's direct-stake.ts asserts prove it byte-identical.
pub(crate) fn finalize_swap_accounting(
    round: &mut Round,
    config: &mut Config,
    ansem_out: u64,
    mult_min_bps: u16,
    mult_max_bps: u16,
    rollover_in: u64,
) -> Result<()> {
    round.swap_proceeds = ansem_out;

    // Split the proceeds into losers' returns + the jackpot pool (spec §3/§4). NJ_total
    // is the sum of the non-jackpot squares' 0-50% returns; the jackpot square's stakers
    // split everything left over.
    let jsq = round.jackpot_square as usize;
    let nj_weight = math::return_weight(
        &round.block_sol,
        &round.randomness,
        round.jackpot_square,
        mult_min_bps,
        mult_max_bps,
    );
    let nj_total = math::nonjackpot_payout(nj_weight, round.pot, ansem_out);
    let round_leftover = ansem_out.checked_sub(nj_total).ok_or(AnsemError::Overflow)?;
    let new_rollover: u64 = if round.block_sol[jsq] > 0 {
        // A winner staked the jackpot square: they split this round's leftover PLUS the
        // accumulated rollover; consume the rollover.
        round.jackpot_pool = round_leftover
            .checked_add(rollover_in)
            .ok_or(AnsemError::Overflow)?;
        0
    } else {
        // No winner: carry this round's leftover forward. It stays as unclaimed ANSEM in
        // payout_vault and grows the next round's jackpot.
        round.jackpot_pool = 0;
        rollover_in
            .checked_add(round_leftover)
            .ok_or(AnsemError::Overflow)?
    };

    // Freeze the ceiling this round's claimants can ever draw (nj returns + the jackpot
    // pool). close_round later forfeits (entitlement - claimed) to the rollover.
    round.entitlement_total = nj_total
        .checked_add(round.jackpot_pool)
        .ok_or(AnsemError::Overflow)?;

    round.state = STATE_CLAIMABLE;

    // Persist the rollover accounting + re-arm the create_round gate. Everything just
    // paid to this round is now owed to its claimants; add it to the solvency ledger
    // (claims subtract it back down as players withdraw).
    config.rollover_jackpot = new_rollover;
    config.ansem_obligations = config
        .ansem_obligations
        .checked_add(ansem_out)
        .ok_or(AnsemError::Overflow)?;
    config.current_round_finalized = true;
    Ok(())
}

#[derive(Accounts)]
pub struct ExecuteSwapMock<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    // Box'd to keep try_accounts under the 4KB BPF stack frame (anchor 1.0 +
    // the extra jackpot vault accounts overflow it otherwise).
    #[account(mut, seeds = [CONFIG_SEED], bump = config.config_bump)]
    pub config: Box<Account<'info, Config>>,

    #[account(mut, seeds = [ROUND_SEED, round.round_id.to_le_bytes().as_ref()], bump = round.bump)]
    pub round: Box<Account<'info, Round>>,

    #[account(mut, address = config.ansem_mint)]
    pub ansem_mint: Box<Account<'info, Mint>>,

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
    pub payout_vault: Box<Account<'info, TokenAccount>>,

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
    // Copy config scalars up front so we can hand `config` to finalize_swap_accounting
    // at the end without holding an outstanding immutable borrow of it across the CPIs.
    let swap_mode = ctx.accounts.config.swap_mode;
    let fee_bps = ctx.accounts.config.fee_bps;
    let mock_rate = ctx.accounts.config.mock_rate;
    let total_escrow_balance = ctx.accounts.config.total_escrow_balance;
    let pot_vault_bump = ctx.accounts.config.pot_vault_bump;
    let mint_auth_bump = ctx.accounts.config.mint_auth_bump;
    let mult_min_bps = ctx.accounts.config.mult_min_bps;
    let mult_max_bps = ctx.accounts.config.mult_max_bps;
    let rollover_in = ctx.accounts.config.rollover_jackpot;

    require!(swap_mode == SWAP_MODE_MOCK, AnsemError::WrongSwapMode);
    require!(ctx.accounts.round.state == STATE_SETTLED, AnsemError::BadRoundState);

    let pot = ctx.accounts.round.pot;
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
            ctx.accounts.system_program.key(),
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
            ctx.accounts.token_program.key(),
            MintTo {
                mint: ctx.accounts.ansem_mint.to_account_info(),
                to: ctx.accounts.payout_vault.to_account_info(),
                authority: ctx.accounts.mint_authority.to_account_info(),
            },
            &[ma_seeds],
        ),
        ansem_out,
    )?;

    // Everything after the proceeds are known is identical for mock and real.
    finalize_swap_accounting(
        &mut ctx.accounts.round,
        &mut ctx.accounts.config,
        ansem_out,
        mult_min_bps,
        mult_max_bps,
        rollover_in,
    )
}

// ---- Mainnet real payout (plan 2026-07-14) ----
// The keeper quotes ANSEM off Jupiter, buys it into its OWN ATA, then calls this. Unlike
// the mock (mints from a PDA mint at a fixed rate), this PULLS an exact `ansem_out` of a
// pre-existing external mint out of the keeper's source ATA into payout_vault — the
// program holds no mint authority, so payouts are backed by real inventory, not printing.
// Admin-gated (config.admin == payer): only the keeper hot key can finalize a real round.
#[derive(Accounts)]
pub struct ExecuteSwapReal<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(mut, seeds = [CONFIG_SEED], bump = config.config_bump,
        constraint = config.admin == payer.key() @ AnsemError::Unauthorized)]
    pub config: Box<Account<'info, Config>>,

    #[account(mut, seeds = [ROUND_SEED, round.round_id.to_le_bytes().as_ref()], bump = round.bump)]
    pub round: Box<Account<'info, Round>>,

    #[account(address = config.ansem_mint)]
    pub ansem_mint: Box<Account<'info, Mint>>,

    /// CHECK: vault authority PDA (owner of payout vault)
    #[account(seeds = [VAULT_AUTH_SEED], bump = config.vault_auth_bump)]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(
        init_if_needed, payer = payer,
        associated_token::mint = ansem_mint,
        associated_token::authority = vault_authority
    )]
    pub payout_vault: Box<Account<'info, TokenAccount>>,

    // Keeper-owned inventory the round's proceeds are paid FROM (in-instruction transfer,
    // authorized by the keeper/payer — refundable by design: it is the keeper's own ATA).
    #[account(mut, token::mint = ansem_mint, token::authority = payer)]
    pub source_ata: Box<Account<'info, TokenAccount>>,

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

pub fn execute_swap_real_handler(ctx: Context<ExecuteSwapReal>, ansem_out: u64) -> Result<()> {
    // Scalar copies up front (same borrow discipline as the mock handler).
    let swap_mode = ctx.accounts.config.swap_mode;
    let fee_bps = ctx.accounts.config.fee_bps;
    let total_escrow_balance = ctx.accounts.config.total_escrow_balance;
    let pot_vault_bump = ctx.accounts.config.pot_vault_bump;
    let mult_min_bps = ctx.accounts.config.mult_min_bps;
    let mult_max_bps = ctx.accounts.config.mult_max_bps;
    let rollover_in = ctx.accounts.config.rollover_jackpot;
    let min_swap_rate = ctx.accounts.config.min_swap_rate;
    let obligations_before = ctx.accounts.config.ansem_obligations;

    require!(swap_mode == SWAP_MODE_JUPITER, AnsemError::WrongSwapMode);
    require!(ctx.accounts.round.state == STATE_SETTLED, AnsemError::BadRoundState);

    let pot = ctx.accounts.round.pot;
    let fee = (pot as u128 * fee_bps as u128 / 10_000u128) as u64;
    let net = pot.checked_sub(fee).ok_or(AnsemError::Overflow)?;

    // Same SOL solvency gate as the mock: never sweep escrow-owed lamports or another
    // round's unswapped pot; and pot_vault must actually hold this round's `pot`.
    let pot_vault_lamports = ctx.accounts.pot_vault.lamports();
    require!(pot_vault_lamports >= total_escrow_balance, AnsemError::Insolvent);
    let available_for_pots = pot_vault_lamports - total_escrow_balance;
    require!(available_for_pots >= pot, AnsemError::Insolvent);

    // Move the entire pot lamports out of pot_vault into treasury (identical CPI to mock).
    let pv_seeds: &[&[u8]] = &[POT_VAULT_SEED, &[pot_vault_bump]];
    system_program::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.system_program.key(),
            SolTransfer {
                from: ctx.accounts.pot_vault.to_account_info(),
                to: ctx.accounts.treasury.to_account_info(),
            },
            &[pv_seeds],
        ),
        pot,
    )?;

    // Rate floor: the keeper can never underpay a round below the admin-set market floor.
    // 0 disables it. Whole tx (incl. the pot transfer above) reverts if the floor is missed.
    if min_swap_rate > 0 {
        let floor = (net as u128 * min_swap_rate as u128 / LAMPORTS_PER_SOL as u128) as u64;
        require!(ansem_out >= floor, AnsemError::SwapRateTooLow);
    }

    // Pay the round's proceeds IN from keeper inventory — atomic, exact, no minting.
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            TokenTransfer {
                from: ctx.accounts.source_ata.to_account_info(),
                to: ctx.accounts.payout_vault.to_account_info(),
                authority: ctx.accounts.payer.to_account_info(),
            },
        ),
        ansem_out,
    )?;

    // Post-transfer solvency: the payout vault must now cover EVERYTHING owed to players
    // (prior obligations) PLUS this round's fresh entitlement. Guards a keeper that
    // finalizes without actually delivering the tokens it claims.
    ctx.accounts.payout_vault.reload()?;
    require!(
        ctx.accounts.payout_vault.amount
            >= obligations_before
                .checked_add(ansem_out)
                .ok_or(AnsemError::Overflow)?,
        AnsemError::Insolvent
    );

    // Shared accounting — identical to the mock path.
    finalize_swap_accounting(
        &mut ctx.accounts.round,
        &mut ctx.accounts.config,
        ansem_out,
        mult_min_bps,
        mult_max_bps,
        rollover_in,
    )
}
