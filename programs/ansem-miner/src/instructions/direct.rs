use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Transfer as SolTransfer};
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer as TokenTransfer};

use crate::constants::*;
use crate::error::AnsemError;
use crate::math;
use crate::state::{Config, MinerPosition, Round, STATE_CLAIMABLE, STATE_CLOSED, STATE_OPEN};

// Direct-stake engine (the ORE model, verified against regolith-labs/ore deploy.rs):
// SOL moves straight from the signer's wallet to the pot INSIDE the stake tx —
// no escrow, no session key, no rollup delegation in the player path. Winnings
// are pull-claimed (also the ORE model). The escrow/session/ER instructions stay
// in the program untouched (future ORE-style "automation" mode).
//
// Idempotency WITHOUT new state: `claim_direct`/`refund_direct` zero the miner's
// block_stake after paying. A second call computes weight 0 and pays 0 by the
// existing floor math — no `claimed` flag, no account migration.

#[derive(Accounts)]
#[instruction(round_id: u64)]
pub struct StakeDirect<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.config_bump)]
    pub config: Box<Account<'info, Config>>,

    #[account(mut, seeds = [ROUND_SEED, round_id.to_le_bytes().as_ref()], bump = round.bump,
        constraint = round.round_id == round_id @ AnsemError::MinerRoundMismatch)]
    pub round: Box<Account<'info, Round>>,

    // Same persistent miner PDA as the escrow path — stamp-or-accumulate below.
    #[account(
        init_if_needed, payer = authority, space = 8 + MinerPosition::INIT_SPACE,
        seeds = [MINER_SEED, authority.key().as_ref()], bump
    )]
    pub miner: Box<Account<'info, MinerPosition>>,

    /// CHECK: SOL pot vault PDA
    #[account(mut, seeds = [POT_VAULT_SEED], bump = config.pot_vault_bump)]
    pub pot_vault: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn stake_direct_handler(ctx: Context<StakeDirect>, round_id: u64, block: u8, amount: u64) -> Result<()> {
    require!((block as usize) < GRID_SIZE, AnsemError::BadBlock);

    let cfg = &ctx.accounts.config;
    let round = &mut ctx.accounts.round;
    require!(round.state == STATE_OPEN, AnsemError::RoundNotOpen);
    let now = Clock::get()?.unix_timestamp;
    require!(now < round.deadline_ts, AnsemError::RoundEnded);
    require!(amount >= cfg.min_stake, AnsemError::StakeTooSmall);

    let miner = &mut ctx.accounts.miner;
    if miner.authority == Pubkey::default() {
        miner.authority = ctx.accounts.authority.key();
        miner.bump = ctx.bumps.miner;
    }
    require!(miner.authority == ctx.accounts.authority.key(), AnsemError::Unauthorized);
    // New-round entry: reset the persistent miner (same stamp as join_round/stake).
    if miner.round_id != round_id {
        miner.block_stake = [0u64; GRID_SIZE];
        miner.round_id = round_id;
    }

    let prior: u64 = miner.block_stake.iter().sum();
    let new_total = prior.checked_add(amount).ok_or(AnsemError::Overflow)?;
    require!(new_total <= cfg.max_stake_per_round, AnsemError::StakeTooLarge);

    // THE direct move: wallet -> pot vault, inside this tx (deposit.rs pattern,
    // no escrow bookkeeping — total_escrow_balance is untouched, so the swap
    // solvency gate `pot_vault >= total_escrow_balance + pot` stays balanced:
    // these lamports and the `pot` increment arrive together).
    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.key(),
            SolTransfer {
                from: ctx.accounts.authority.to_account_info(),
                to: ctx.accounts.pot_vault.to_account_info(),
            },
        ),
        amount,
    )?;

    miner.block_stake[block as usize] =
        miner.block_stake[block as usize].checked_add(amount).ok_or(AnsemError::Overflow)?;
    round.block_sol[block as usize] =
        round.block_sol[block as usize].checked_add(amount).ok_or(AnsemError::Overflow)?;
    round.pot = round.pot.checked_add(amount).ok_or(AnsemError::Overflow)?;
    Ok(())
}

#[derive(Accounts)]
#[instruction(round_id: u64)]
pub struct ClaimDirect<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    // Box'd: same 4KB BPF stack-frame reasoning as Claim.
    #[account(seeds = [CONFIG_SEED], bump = config.config_bump)]
    pub config: Box<Account<'info, Config>>,

    #[account(seeds = [ROUND_SEED, round_id.to_le_bytes().as_ref()], bump = round.bump,
        constraint = round.round_id == round_id @ AnsemError::MinerRoundMismatch)]
    pub round: Box<Account<'info, Round>>,

    #[account(mut, seeds = [MINER_SEED, authority.key().as_ref()], bump = miner.bump,
        constraint = miner.authority == authority.key() @ AnsemError::Unauthorized,
        constraint = miner.round_id == round_id @ AnsemError::MinerRoundMismatch)]
    pub miner: Box<Account<'info, MinerPosition>>,

    #[account(address = config.ansem_mint)]
    pub ansem_mint: Box<Account<'info, Mint>>,

    /// CHECK: vault authority PDA
    #[account(seeds = [VAULT_AUTH_SEED], bump = config.vault_auth_bump)]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(mut, associated_token::mint = ansem_mint, associated_token::authority = vault_authority)]
    pub payout_vault: Box<Account<'info, TokenAccount>>,

    #[account(init_if_needed, payer = authority,
        associated_token::mint = ansem_mint, associated_token::authority = authority)]
    pub player_ata: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn claim_direct_handler(ctx: Context<ClaimDirect>, _round_id: u64) -> Result<()> {
    let cfg = &ctx.accounts.config;
    let round = &ctx.accounts.round;
    require!(round.state == STATE_CLAIMABLE, AnsemError::BadRoundState);

    let miner = &mut ctx.accounts.miner;

    // Identical payout math to claim.rs — frozen round state, order-independent.
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
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                TokenTransfer {
                    from: ctx.accounts.payout_vault.to_account_info(),
                    to: ctx.accounts.player_ata.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                },
                &[va_seeds],
            ),
            amount,
        )?;
    }

    // Idempotency: zero the stakes — a re-claim computes weight 0 and pays 0.
    miner.block_stake = [0u64; GRID_SIZE];
    Ok(())
}

#[derive(Accounts)]
#[instruction(round_id: u64)]
pub struct RefundDirect<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.config_bump)]
    pub config: Box<Account<'info, Config>>,

    #[account(seeds = [ROUND_SEED, round_id.to_le_bytes().as_ref()], bump = round.bump,
        constraint = round.round_id == round_id @ AnsemError::MinerRoundMismatch)]
    pub round: Box<Account<'info, Round>>,

    #[account(mut, seeds = [MINER_SEED, authority.key().as_ref()], bump = miner.bump,
        constraint = miner.authority == authority.key() @ AnsemError::Unauthorized,
        constraint = miner.round_id == round_id @ AnsemError::MinerRoundMismatch)]
    pub miner: Box<Account<'info, MinerPosition>>,

    /// CHECK: SOL pot vault PDA
    #[account(mut, seeds = [POT_VAULT_SEED], bump = config.pot_vault_bump)]
    pub pot_vault: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn refund_direct_handler(ctx: Context<RefundDirect>, _round_id: u64) -> Result<()> {
    let round = &ctx.accounts.round;
    require!(round.state == STATE_CLOSED, AnsemError::BadRoundState);

    let miner = &mut ctx.accounts.miner;
    let amount: u64 = miner.block_stake.iter().sum();

    if amount > 0 {
        // The cancelled round never swapped, so its stakes still sit in the pot
        // vault — return the player's own lamports (withdraw.rs signed-PDA pattern).
        let bump = ctx.accounts.config.pot_vault_bump;
        let seeds: &[&[u8]] = &[POT_VAULT_SEED, &[bump]];
        system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.key(),
                SolTransfer {
                    from: ctx.accounts.pot_vault.to_account_info(),
                    to: ctx.accounts.authority.to_account_info(),
                },
                &[seeds],
            ),
            amount,
        )?;
    }

    // Idempotency: zero after refund — a second refund moves nothing.
    miner.block_stake = [0u64; GRID_SIZE];
    Ok(())
}
