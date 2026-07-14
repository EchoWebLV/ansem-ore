use solana_keccak_hasher::hashv;

use crate::constants::GRID_SIZE;

/// Per-square VRF fraction in basis points, uniform in [min_bps, max_bps]. In the
/// lottery model this is the RETURN fraction for a non-jackpot square (0..=5000
/// bps = 0..50%). `range = (max-min)+1 >= 1`, so `min == max` (e.g. 0,0) is safe.
pub fn multiplier_bps(randomness: &[u8; 32], square: u8, min_bps: u16, max_bps: u16) -> u16 {
    let h = hashv(&[randomness, &[square]]);
    let b = h.as_ref();
    let x = u16::from_le_bytes([b[0], b[1]]);
    let range = (max_bps - min_bps) as u32 + 1;
    min_bps + (x as u32 % range) as u16
}

/// Sum over NON-jackpot squares of `stake[j] * f_j(bps)`, where `f_j` is the
/// per-square return fraction. Excludes the jackpot square. u128 to avoid overflow.
pub fn return_weight(
    block_stake: &[u64; GRID_SIZE],
    r: &[u8; 32],
    jackpot_square: u8,
    min_bps: u16,
    max_bps: u16,
) -> u128 {
    let mut w = 0u128;
    for s in 0..GRID_SIZE {
        if s as u8 == jackpot_square {
            continue;
        }
        w += (block_stake[s] as u128) * (multiplier_bps(r, s as u8, min_bps, max_bps) as u128);
    }
    w
}

/// Non-jackpot ANSEM payout = `proceeds * weight / (pot * 10_000)`. Floors.
pub fn nonjackpot_payout(weight: u128, pot: u64, proceeds: u64) -> u64 {
    if pot == 0 {
        return 0;
    }
    ((proceeds as u128 * weight) / (pot as u128 * 10_000u128)) as u64
}

/// Pro-rata jackpot share = `pool * player_on_jackpot / total_on_jackpot`. Floors.
pub fn jackpot_share(pool: u64, player_on_jackpot: u64, total_on_jackpot: u64) -> u64 {
    if total_on_jackpot == 0 {
        return 0;
    }
    ((pool as u128 * player_on_jackpot as u128) / total_on_jackpot as u128) as u64
}

/// The one winning jackpot square in [0, GRID_SIZE). `domain` separates draws.
pub fn jackpot_block(randomness: &[u8; 32], domain: &[u8]) -> u8 {
    let h = hashv(&[randomness, domain]);
    (h.as_ref()[0] as usize % GRID_SIZE) as u8
}

// ---- BEEF emission/bonus math (all floors; see plan 2026-07-09-beef-vault-emission) ----

/// Bonus ticks accrued over [last_tick_ts, min(now, last_active_ts + window)],
/// one tick per `secs_per_tick`. Time past the activity window is dead (the
/// daily-streak gate); callers set last_tick_ts = now after accruing so a dead
/// gap is skipped, never re-scanned.
pub fn beef_ticks(now: i64, last_tick_ts: i64, last_active_ts: i64, window_secs: i64, secs_per_tick: i64) -> u64 {
    if secs_per_tick <= 0 {
        return 0;
    }
    let window_end = now.min(last_active_ts.saturating_add(window_secs));
    let secs = window_end.saturating_sub(last_tick_ts).max(0);
    (secs / secs_per_tick) as u64
}

/// Capped bonus increment: min(ticks * tick_bps, cap - current).
pub fn beef_bonus_delta(ticks: u64, tick_bps: u16, bonus_bps: u16, cap_bps: u16) -> u16 {
    let head = cap_bps.saturating_sub(bonus_bps) as u128;
    (ticks as u128).saturating_mul(tick_bps as u128).min(head) as u16
}

/// New liability created by a bonus increment on an unclaimed balance. Floors.
pub fn beef_owed_delta(unclaimed: u64, delta_bps: u16) -> u64 {
    ((unclaimed as u128 * delta_bps as u128) / 10_000u128) as u64
}

/// Weighted-average dilution when `share` new units join `unclaimed` held at
/// `bonus`: bonus' = bonus * unclaimed / (unclaimed + share). Conserves the
/// unclaimed*bonus product (floored DOWN — the solvency-safe direction), so a
/// late deposit can never ride an old multiplier.
pub fn beef_dilute(bonus_bps: u16, unclaimed: u64, share: u64) -> u16 {
    let total = unclaimed as u128 + share as u128;
    if total == 0 {
        return 0;
    }
    ((bonus_bps as u128 * unclaimed as u128) / total) as u16
}

/// Player's slice of a round's stamped emission = emission * stake / pot. Floors.
pub fn beef_share(emission: u64, stake_sum: u64, pot: u64) -> u64 {
    if pot == 0 {
        return 0;
    }
    ((emission as u128 * stake_sum as u128) / pot as u128) as u64
}

/// Claim payout = unclaimed * (10_000 + bonus) / 10_000. Floors.
pub fn beef_payout(unclaimed: u64, bonus_bps: u16) -> u64 {
    ((unclaimed as u128 * (10_000u128 + bonus_bps as u128)) / 10_000u128) as u64
}

// ---- Mint-on-emission curve + jackpot trigger (spec 2026-07-14-beef-on-ansem) ----

/// Pot-scaled saturating emission with ZINC-style continuous difficulty decay
/// (spec D2, updated d458f72):
///
///   emission = (max_round_mint * pot / (pot + sat)) * (hard_cap - minted_total) / hard_cap
///
/// The first factor is the pot-scaled saturating curve; the second is the decay
/// — every BEEF mined makes the next round leaner, asymptotically toward the cap
/// (no halving cliff; launch week is provably the richest window). At
/// minted_total == 0 the decay factor is exactly 1 (remaining == hard_cap), so
/// genesis emission equals the bare curve. Floors. Returns 0 at pot 0, cap 0, or
/// minted_total >= hard_cap.
///
/// BOTH multiplications use u128 intermediates: `max * pot` AND
/// `curve * (hard_cap - minted_total)` each overflow u64 at realistic values
/// (curve up to ~210e6, remaining up to ~21e12 -> product ~4.4e21 >> u64::MAX).
/// Proven no-panic even at u64::MAX inputs — see emission_no_overflow_at_extremes.
pub fn beef_emission(
    pot_lamports: u64,
    max_round_mint: u64,
    sat_lamports: u64,
    minted_total: u64,
    hard_cap: u64,
) -> u64 {
    if pot_lamports == 0 || max_round_mint == 0 || hard_cap == 0 || minted_total >= hard_cap {
        return 0;
    }
    let curve = (max_round_mint as u128 * pot_lamports as u128)
        / (pot_lamports as u128 + sat_lamports as u128);
    let remaining = (hard_cap - minted_total) as u128;
    ((curve * remaining) / hard_cap as u128) as u64
}

/// Jackpot-round draw from the round's frozen randomness. Reads bytes 16..24 LE
/// as the draw and fires when `draw % odds == 0`.
///
/// VERIFICATION (Task 3 Step 1, spec D6 fairness claim — confirmed against
/// settle.rs / vrf_settle.rs 2026-07-14):
/// (a) DISJOINT FROM THE WINNING-SQUARE DRAW. The winning square is
///     `jackpot_block(&randomness, b"jackpot")` = keccak256(randomness ++
///     "jackpot")[0] % 25, and return multipliers are keccak256(randomness ++
///     [square])[0..2]. Both consume DOMAIN-SEPARATED HASHES of the full 32
///     bytes and take bytes off the HASH OUTPUT — neither slices raw bytes
///     16..24. So this trigger's raw-byte draw is independent of the square/return
///     draws by construction (domain separation) AND by disjoint extraction. No
///     move to bytes 24..32 is needed.
/// (b) EXACTLY ONE RANDOMNESS WRITE PER ROUND (no keeper re-roll / fishing). A
///     Round is `init`'d to STATE_OPEN once (round.rs, per-round_id PDA). From
///     OPEN the only randomness writers are `settle` (OPEN -> SETTLED) and the
///     VRF path `request_settle` (OPEN -> VRF_PENDING) + `settle_callback`
///     (VRF_PENDING -> SETTLED); each guards on its inbound state and flips it,
///     so `round.randomness` is written exactly once. Nothing ever writes
///     STATE_OPEN except round creation, and `cancel_round` only moves a round to
///     the terminal STATE_CLOSED — there is no path back to OPEN or a second
///     request. The trigger is computed post-settle from the immutable frozen
///     randomness, so the keeper cannot re-request to fish for a favourable draw.
///     (On mainnet the fairness rests on the VRF `settle_callback` path being the
///     one used, exactly as the winning-square draw already does; the admin
///     `settle` fallback lets the admin choose randomness for the square AND this
///     trigger equally — a pre-existing M1 trust property, not introduced here.)
///
/// odds semantics: 0 or 1 = every winner round pays (legacy behavior); N>1 = 1-in-N.
pub fn jackpot_triggered(randomness: &[u8; 32], odds: u16) -> bool {
    if odds <= 1 {
        return true;
    }
    let draw = u64::from_le_bytes(randomness[16..24].try_into().unwrap());
    draw % odds as u64 == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    const R: [u8; 32] = [7u8; 32];

    #[test]
    fn return_fraction_in_0_50_band() {
        for s in 0..25u8 {
            let f = multiplier_bps(&R, s, 0, 5000);
            assert!(f <= 5000, "square {s} -> {f}");
        }
    }

    #[test]
    fn multiplier_is_deterministic() {
        assert_eq!(multiplier_bps(&R, 3, 0, 5000), multiplier_bps(&R, 3, 0, 5000));
    }

    #[test]
    fn zero_band_returns_all_to_jackpot() {
        // max_bps == 0 => every non-jackpot square returns 0 => NJ_total == 0.
        let mut stake = [0u64; 25];
        stake[3] = 1_000_000_000;
        stake[8] = 500_000_000;
        let jsq = jackpot_block(&R, b"jackpot");
        let w = return_weight(&stake, &R, jsq, 0, 0);
        assert_eq!(w, 0);
        assert_eq!(nonjackpot_payout(w, 1_500_000_000, 1_500_000_000), 0);
    }

    #[test]
    fn split_conserves_proceeds() {
        // One round with no rollover: NJ_total + leftover == proceeds, and the
        // non-jackpot returns never exceed ~half (each f_j <= 50%).
        let mut block_sol = [0u64; 25];
        block_sol[1] = 3_000_000_000; // loser
        block_sol[4] = 2_000_000_000; // loser
        let jsq = 9u8;
        block_sol[jsq as usize] = 1_000_000_000; // jackpot square
        let pot: u64 = block_sol.iter().sum();
        let proceeds = pot; // rate 1:1 for the test
        let njw = return_weight(&block_sol, &R, jsq, 0, 5000);
        let nj = nonjackpot_payout(njw, pot, proceeds);
        let pool = proceeds - nj; // this-round leftover (no rollover)
        assert!(nj <= proceeds / 2 + 25, "NJ must be <= ~half: {nj}");
        assert_eq!(nj + pool, proceeds);
    }

    #[test]
    fn jackpot_share_is_prorata() {
        assert_eq!(jackpot_share(1000, 750, 1000), 750);
        assert_eq!(jackpot_share(1000, 250, 1000), 250);
        assert_eq!(jackpot_share(1000, 0, 1000), 0);
        assert_eq!(jackpot_share(1000, 5, 0), 0); // nobody staked => 0
    }

    #[test]
    fn jackpot_square_in_range() {
        assert!(jackpot_block(&R, b"jackpot") < 25);
    }

    // ---- BEEF emission/bonus math ----

    #[test]
    fn beef_ticks_respects_activity_window() {
        // active till t=1000+100; last tick at 1000; now way past the window:
        // only the in-window 100s accrue -> 100/60 = 1 tick.
        assert_eq!(beef_ticks(5_000, 1_000, 1_000, 100, 60), 1);
        // gate open (now inside window): 120s -> 2 ticks
        assert_eq!(beef_ticks(1_120, 1_000, 1_100, 86_400, 60), 2);
        // clock going backwards / zero elapsed -> 0
        assert_eq!(beef_ticks(999, 1_000, 1_000, 86_400, 60), 0);
        // degenerate secs_per_tick -> 0 (never panics)
        assert_eq!(beef_ticks(2_000, 1_000, 1_000, 86_400, 0), 0);
    }

    #[test]
    fn beef_bonus_delta_caps() {
        assert_eq!(beef_bonus_delta(10, 3, 0, 30_000), 30);
        assert_eq!(beef_bonus_delta(1_000_000, 3, 0, 30_000), 30_000); // clamps to cap
        assert_eq!(beef_bonus_delta(10, 3, 29_990, 30_000), 10);       // clamps to headroom
        assert_eq!(beef_bonus_delta(0, 3, 100, 30_000), 0);
    }

    #[test]
    fn beef_owed_delta_floors() {
        assert_eq!(beef_owed_delta(1_000_000, 30), 3_000); // 0.3%
        assert_eq!(beef_owed_delta(3, 30), 0);             // floors to zero
    }

    #[test]
    fn beef_dilute_conserves_product() {
        // 4x bonus on 100 units, 300 new units join -> 30_000*100/400 = 7_500
        assert_eq!(beef_dilute(30_000, 100, 300), 7_500);
        assert_eq!(beef_dilute(30_000, 0, 500), 0);   // empty balance -> reset
        assert_eq!(beef_dilute(1_234, 777, 0), 1_234); // no new share -> unchanged
        assert_eq!(beef_dilute(30_000, 0, 0), 0);      // zero/zero -> 0, no panic
    }

    #[test]
    fn beef_share_is_prorata_and_floors() {
        assert_eq!(beef_share(1_000_000, 300_000_000, 400_000_000), 750_000);
        assert_eq!(beef_share(1_000_000, 0, 400_000_000), 0);
        assert_eq!(beef_share(1_000_000, 100, 0), 0); // empty pot -> 0, no panic
    }

    #[test]
    fn beef_payout_applies_bonus() {
        assert_eq!(beef_payout(1_000_000, 0), 1_000_000);
        assert_eq!(beef_payout(1_000_000, 30_000), 4_000_000); // the 4x cap
        assert_eq!(beef_payout(3, 3_333), 3);                  // floors
    }

    // ---- Mint-on-emission curve + jackpot trigger (spec 2026-07-14-beef-on-ansem) ----

    // Genesis fixtures: minted_total == 0 -> decay factor is exactly 1, so these
    // (from the base plan) hold unchanged against the decayed formula.
    const HC: u64 = 21_000_000_000_000; // 21,000,000 BEEF @6dp

    #[test]
    fn emission_zero_pot_is_zero() {
        assert_eq!(beef_emission(0, 210_000_000, 1_000_000_000, 0, HC), 0);
    }
    #[test]
    fn emission_half_max_at_saturation_pot() {
        // pot == S -> MAX/2
        assert_eq!(beef_emission(1_000_000_000, 210_000_000, 1_000_000_000, 0, HC), 105_000_000);
    }
    #[test]
    fn emission_approaches_max() {
        let e = beef_emission(100_000_000_000, 210_000_000, 1_000_000_000, 0, HC);
        assert!(e > 207_000_000 && e < 210_000_000);
    }
    #[test]
    fn emission_dust_pot_mints_dust() {
        // 0.01 SOL pot -> ~1% of half... exact: 210e6 * 1e7 / (1e7 + 1e9) = 2_079_207
        assert_eq!(beef_emission(10_000_000, 210_000_000, 1_000_000_000, 0, HC), 2_079_207);
    }
    #[test]
    fn emission_no_overflow_at_extremes() {
        // first multiply (max * pot) at u64::MAX
        assert!(beef_emission(u64::MAX, u64::MAX, 1, 0, HC) <= u64::MAX);
        // second multiply (curve * (hard_cap - minted)) at u64::MAX hard_cap
        assert!(beef_emission(u64::MAX, u64::MAX, 1, 0, u64::MAX) <= u64::MAX);
    }
    #[test]
    fn emission_decay_halves_at_half_cap() {
        // minted_total == hard_cap/2 -> 1-SOL-pot emission is exactly half genesis.
        assert_eq!(beef_emission(1_000_000_000, 210_000_000, 1_000_000_000, HC / 2, HC), 52_500_000);
    }
    #[test]
    fn emission_zero_at_or_past_cap() {
        assert_eq!(beef_emission(1_000_000_000, 210_000_000, 1_000_000_000, HC, HC), 0);
        assert_eq!(beef_emission(100_000_000_000, 210_000_000, 1_000_000_000, HC + 1, HC), 0);
    }
    #[test]
    fn emission_zero_cap_no_divide_by_zero() {
        assert_eq!(beef_emission(1_000_000_000, 210_000_000, 1_000_000_000, 0, 0), 0);
    }
    #[test]
    fn trigger_odds_one_always_fires() {
        assert!(jackpot_triggered(&[0u8; 32], 1));
        assert!(jackpot_triggered(&[7u8; 32], 0)); // 0 treated as always (disabled gate)
    }
    #[test]
    fn trigger_uses_bytes_16_24_le() {
        let mut r = [0u8; 32];
        // draw = 25 -> 25 % 25 == 0 -> fires at odds 25
        r[16] = 25;
        assert!(jackpot_triggered(&r, 25));
        r[16] = 26; // 26 % 25 == 1 -> no fire
        assert!(!jackpot_triggered(&r, 25));
    }
}
