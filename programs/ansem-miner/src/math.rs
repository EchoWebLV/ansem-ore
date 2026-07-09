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
}
