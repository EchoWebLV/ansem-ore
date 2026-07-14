use anchor_lang::prelude::*;

// Jackpot params (spec 2026-07-14-beef-on-ansem-design D6): random-trigger +
// bet-scaled cap (Motherlode pattern). Lives in its OWN PDA — the live mainnet
// `Config` account must NOT change size, so these knobs cannot be added there.
// Admin-settable via set_jackpot_params.
#[account]
#[derive(InitSpace)]
pub struct JackpotConfig {
    /// 0|1 = every winner round pays the rollover (legacy). N>1 = 1-in-N: a round
    /// pays the jackpot only when the frozen-randomness draw passes 1-in-N odds.
    pub trigger_odds: u16,
    /// Bite ceiling = cap_mult x the winning-square stake's ANSEM value. 0 = uncapped
    /// (winner takes the whole rollover, legacy behavior). Default 100x.
    pub cap_mult: u16,
    pub bump: u8,
}
