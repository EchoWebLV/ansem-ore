use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Transfer as SolTransfer};

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

// Test-support seam (M1 only): pot_vault is a single commingled system-owned
// PDA, so nothing in the public instruction surface can ever desync its
// lamport balance from `total_escrow_balance + Σ unswapped round.pot` -
// deposit/withdraw/stake keep that invariant exactly in lockstep. That makes
// the Insolvent guard in execute_swap_mock (see swap.rs) unreachable through
// legitimate instruction sequences, so an integration test has no way to
// force it to fire. This admin-gated instruction exists solely to let tests
// simulate an externally-drained vault (e.g. a hypothetical bug or future
// instruction that under-collateralizes pot_vault) so the Insolvent
// require!s in execute_swap_mock can be proven to actually revert. It is not
// part of the game's economic surface and mutates no accounting field other
// than pot_vault's own lamports.
#[derive(Accounts)]
pub struct DebugDrainPotVault<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.config_bump,
        constraint = config.admin == admin.key() @ AnsemError::Unauthorized)]
    pub config: Account<'info, Config>,
    /// CHECK: SOL pot vault PDA; drained on purpose by this debug-only ix
    #[account(mut, seeds = [POT_VAULT_SEED], bump = config.pot_vault_bump)]
    pub pot_vault: UncheckedAccount<'info>,
    /// CHECK: arbitrary admin-controlled destination for the drained lamports
    #[account(mut)]
    pub sink: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub fn debug_drain_pot_vault(ctx: Context<DebugDrainPotVault>, amount: u64) -> Result<()> {
    let bump = ctx.accounts.config.pot_vault_bump;
    let seeds: &[&[u8]] = &[POT_VAULT_SEED, &[bump]];
    system_program::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.system_program.to_account_info(),
            SolTransfer {
                from: ctx.accounts.pot_vault.to_account_info(),
                to: ctx.accounts.sink.to_account_info(),
            },
            &[seeds],
        ),
        amount,
    )?;
    Ok(())
}
