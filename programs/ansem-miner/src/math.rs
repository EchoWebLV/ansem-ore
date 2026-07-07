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
}
