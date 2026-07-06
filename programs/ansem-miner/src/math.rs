use solana_keccak_hasher::hashv;

use crate::constants::GRID_SIZE;

/// Per-square payout multiplier in basis points, uniform in [min_bps, max_bps].
pub fn multiplier_bps(randomness: &[u8; 32], square: u8, min_bps: u16, max_bps: u16) -> u16 {
    let h = hashv(&[randomness, &[square]]);
    let b = h.as_ref();
    let x = u16::from_le_bytes([b[0], b[1]]);
    let range = (max_bps - min_bps) as u32 + 1;
    min_bps + (x as u32 % range) as u16
}

/// Weight of one square = lamports * multiplier_bps (u128 to avoid overflow).
fn square_weight(sol: u64, mult_bps: u16) -> u128 {
    (sol as u128) * (mult_bps as u128)
}

pub fn total_weight(block_sol: &[u64; GRID_SIZE], r: &[u8; 32], min_bps: u16, max_bps: u16) -> u128 {
    let mut w = 0u128;
    for s in 0..GRID_SIZE {
        w += square_weight(block_sol[s], multiplier_bps(r, s as u8, min_bps, max_bps));
    }
    w
}

pub fn player_weight(block_stake: &[u64; GRID_SIZE], r: &[u8; 32], min_bps: u16, max_bps: u16) -> u128 {
    let mut w = 0u128;
    for s in 0..GRID_SIZE {
        w += square_weight(block_stake[s], multiplier_bps(r, s as u8, min_bps, max_bps));
    }
    w
}

/// Floored share of `proceeds` for `player_weight / total_weight`.
pub fn payout(player_weight: u128, total_weight: u128, proceeds: u64) -> u64 {
    if total_weight == 0 { return 0; }
    ((proceeds as u128 * player_weight) / total_weight) as u64
}

/// True with probability ~1/odds. `domain` separates independent rolls (the two
/// jackpot tiers use distinct domains so their hits are uncorrelated).
pub fn jackpot_hit(randomness: &[u8; 32], odds: u32, domain: &[u8]) -> bool {
    if odds == 0 { return false; }
    let h = hashv(&[randomness, domain]);
    let b = h.as_ref();
    let x = u32::from_le_bytes([b[0], b[1], b[2], b[3]]);
    x % odds == 0
}

/// Winning square in [0, GRID_SIZE). `domain` separates the two tiers' squares.
pub fn jackpot_block(randomness: &[u8; 32], domain: &[u8]) -> u8 {
    let h = hashv(&[randomness, domain]);
    (h.as_ref()[0] as usize % GRID_SIZE) as u8
}

#[cfg(test)]
mod tests {
    use super::*;

    const R: [u8; 32] = [7u8; 32];

    #[test]
    fn multiplier_in_band() {
        for s in 0..25u8 {
            let m = multiplier_bps(&R, s, 8000, 12000);
            assert!((8000..=12000).contains(&m), "square {s} -> {m}");
        }
    }

    #[test]
    fn multiplier_is_deterministic() {
        assert_eq!(multiplier_bps(&R, 3, 8000, 12000), multiplier_bps(&R, 3, 8000, 12000));
    }

    #[test]
    fn single_player_single_square_gets_all_proceeds() {
        let mut block_sol = [0u64; 25];
        let mut stake = [0u64; 25];
        block_sol[4] = 1_000_000_000;
        stake[4] = 1_000_000_000;
        let proceeds = 2_800_000_000u64;
        let tw = total_weight(&block_sol, &R, 8000, 12000);
        let pw = player_weight(&stake, &R, 8000, 12000);
        assert_eq!(payout(pw, tw, proceeds), proceeds);
    }

    #[test]
    fn payouts_sum_to_proceeds() {
        // three players across squares
        let mut block_sol = [0u64; 25];
        let players: [[u64; 25]; 3] = {
            let mut a = [0u64; 25]; a[0] = 300_000_000; a[1] = 200_000_000;
            let mut b = [0u64; 25]; b[1] = 500_000_000; b[7] = 100_000_000;
            let mut c = [0u64; 25]; c[7] = 900_000_000;
            [a, b, c]
        };
        for p in &players { for s in 0..25 { block_sol[s] += p[s]; } }
        let proceeds = 9_900_000_000u64;
        let tw = total_weight(&block_sol, &R, 8000, 12000);
        let sum: u64 = players.iter().map(|p| payout(player_weight(p, &R, 8000, 12000), tw, proceeds)).sum();
        // floor division => at most (num_players) base-unit dust short
        assert!(proceeds - sum <= players.len() as u64, "sum {sum} vs {proceeds}");
    }

    #[test]
    fn winner_square_gets_more_than_loser_square() {
        // Put equal stake on two squares; higher-multiplier square must pay more.
        let mut a = [0u64; 25]; a[2] = 1_000_000_000;
        let mut b = [0u64; 25]; b[9] = 1_000_000_000;
        let mut block_sol = [0u64; 25]; block_sol[2] = a[2]; block_sol[9] = b[9];
        let proceeds = 1_000_000_000u64;
        let tw = total_weight(&block_sol, &R, 8000, 12000);
        let pa = payout(player_weight(&a, &R, 8000, 12000), tw, proceeds);
        let pb = payout(player_weight(&b, &R, 8000, 12000), tw, proceeds);
        let (m2, m9) = (multiplier_bps(&R, 2, 8000, 12000), multiplier_bps(&R, 9, 8000, 12000));
        if m2 > m9 { assert!(pa > pb); } else if m9 > m2 { assert!(pb > pa); }
    }

    #[test]
    fn jackpot_probability_is_reasonable() {
        let mut hits = 0u32;
        let n = 20_000u32;
        for i in 0..n {
            let mut r = [0u8; 32];
            r[0..4].copy_from_slice(&i.to_le_bytes());
            if jackpot_hit(&r, 625, b"jackpot_big") { hits += 1; }
        }
        // expect ~32 over 20k; allow wide band
        assert!((10..70).contains(&hits), "hits={hits}");
    }

    #[test]
    fn jackpot_tiers_are_independent() {
        // The two tiers use distinct keccak domains, so a hit on one does not
        // imply a hit on the other, and their squares are drawn separately.
        let mut agree = 0u32;
        let n = 2_000u32;
        for i in 0..n {
            let mut r = [0u8; 32];
            r[0..4].copy_from_slice(&i.to_le_bytes());
            let sm = jackpot_block(&r, b"jkblock_sm");
            let big = jackpot_block(&r, b"jkblock_big");
            if sm == big { agree += 1; }
        }
        // If independent, squares coincide ~1/25 of the time; assert it's not
        // locked together (which would happen if they shared a domain).
        assert!(agree < n / 2, "tiers look correlated: agree={agree}/{n}");
    }

    #[test]
    fn jackpot_block_in_range() {
        assert!(jackpot_block(&R, b"jkblock_sm") < 25);
        assert!(jackpot_block(&R, b"jkblock_big") < 25);
    }
}
