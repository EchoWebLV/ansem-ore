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

    // Accounts are Box'd to keep Claim::try_accounts under the 4KB BPF stack
    // frame limit (deserializing this many token/state accounts on the stack
    // overflows it — a silent overflow manifests as bogus CPI privilege errors).
    #[account(seeds = [CONFIG_SEED], bump = config.config_bump)]
    pub config: Box<Account<'info, Config>>,

    #[account(seeds = [ROUND_SEED, round_id.to_le_bytes().as_ref()], bump = round.bump,
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
    pub ansem_mint: Box<Account<'info, Mint>>,

    /// CHECK: vault authority PDA
    #[account(seeds = [VAULT_AUTH_SEED], bump = config.vault_auth_bump)]
    pub vault_authority: UncheckedAccount<'info>,

    /// CHECK: small jackpot authority PDA
    #[account(seeds = [JACKPOT_SM_AUTH_SEED], bump = config.small_jackpot_auth_bump)]
    pub small_jackpot_authority: UncheckedAccount<'info>,

    /// CHECK: big jackpot authority PDA
    #[account(seeds = [JACKPOT_BIG_AUTH_SEED], bump = config.big_jackpot_auth_bump)]
    pub big_jackpot_authority: UncheckedAccount<'info>,

    #[account(mut, associated_token::mint = ansem_mint, associated_token::authority = vault_authority)]
    pub payout_vault: Box<Account<'info, TokenAccount>>,

    // Both jackpot vaults are created at initialize, so they always exist and a
    // non-jackpot claim never fails on a missing vault (fixes the audit's DoS).
    #[account(mut, associated_token::mint = ansem_mint, associated_token::authority = small_jackpot_authority)]
    pub small_jackpot_vault: Box<Account<'info, TokenAccount>>,

    #[account(mut, associated_token::mint = ansem_mint, associated_token::authority = big_jackpot_authority)]
    pub big_jackpot_vault: Box<Account<'info, TokenAccount>>,

    #[account(init_if_needed, payer = authority,
        associated_token::mint = ansem_mint, associated_token::authority = authority)]
    pub player_ata: Box<Account<'info, TokenAccount>>,

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
                ctx.accounts.token_program.key(),
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

    // Jackpot payouts (additive). Each tier pays the player's pro-rata share of
    // the tier's SNAPSHOTTED pool (frozen at swap time in round.*_jackpot_pool),
    // never the live vault balance — so a claimant's share depends only on their
    // stake share, not on claim order (the audit's order-dependence fix).
    if round.small_jackpot_hit {
        let jb = round.small_jackpot_block as usize;
        let block_total = round.block_sol[jb];
        let player_on_block = miner.block_stake[jb];
        if block_total > 0 && player_on_block > 0 {
            let share =
                (round.small_jackpot_pool as u128 * player_on_block as u128 / block_total as u128) as u64;
            if share > 0 {
                let sj_bump = cfg.small_jackpot_auth_bump;
                let sj_seeds: &[&[u8]] = &[JACKPOT_SM_AUTH_SEED, &[sj_bump]];
                token::transfer(
                    CpiContext::new_with_signer(
                        ctx.accounts.token_program.key(),
                        Transfer {
                            from: ctx.accounts.small_jackpot_vault.to_account_info(),
                            to: ctx.accounts.player_ata.to_account_info(),
                            authority: ctx.accounts.small_jackpot_authority.to_account_info(),
                        },
                        &[sj_seeds],
                    ),
                    share,
                )?;
            }
        }
    }

    if round.big_jackpot_hit {
        let jb = round.big_jackpot_block as usize;
        let block_total = round.block_sol[jb];
        let player_on_block = miner.block_stake[jb];
        if block_total > 0 && player_on_block > 0 {
            let share =
                (round.big_jackpot_pool as u128 * player_on_block as u128 / block_total as u128) as u64;
            if share > 0 {
                let bj_bump = cfg.big_jackpot_auth_bump;
                let bj_seeds: &[&[u8]] = &[JACKPOT_BIG_AUTH_SEED, &[bj_bump]];
                token::transfer(
                    CpiContext::new_with_signer(
                        ctx.accounts.token_program.key(),
                        Transfer {
                            from: ctx.accounts.big_jackpot_vault.to_account_info(),
                            to: ctx.accounts.player_ata.to_account_info(),
                            authority: ctx.accounts.big_jackpot_authority.to_account_info(),
                        },
                        &[bj_seeds],
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
