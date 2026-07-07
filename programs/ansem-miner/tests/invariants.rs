//! Stress / property harness for the ANSEM Miner payout & jackpot math.
//!
//! HOST tests (`cargo test`), test-only, touching NO production code. They hammer
//! the pure invariant functions in `ansem_miner::math` with tens of thousands of
//! adversarial random configurations to prove the crown-jewel "solvency by
//! construction" claim: the sum of everything paid out can never exceed the
//! pot / pool it is paid from.
//!
//! Run: `cargo test -p ansem-miner --test invariants -- --nocapture`

use ansem_miner::constants::GRID_SIZE;
use ansem_miner::math::{
    jackpot_block, jackpot_hit, multiplier_bps, payout, player_weight, total_weight,
};

const MIN: u16 = 8000; // devnet multiplier band (spec §2)
const MAX: u16 = 12000;
const SOL: u64 = 1_000_000_000;
const MAX_STAKE_PER_ROUND: u64 = 100 * SOL; // config.max_stake_per_round default
const MIN_STAKE: u64 = 10_000_000; // config.min_stake default (0.01 SOL)

// ---- deterministic PRNG (splitmix64) so any failure reproduces exactly ----
struct Rng(u64);
impl Rng {
    fn new(seed: u64) -> Self {
        Rng(seed)
    }
    fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    /// Uniform in `[0, n)`; returns 0 when `n == 0`.
    fn below(&mut self, n: u64) -> u64 {
        if n == 0 {
            0
        } else {
            self.next_u64() % n
        }
    }
    fn r32(&mut self) -> [u8; 32] {
        let mut r = [0u8; 32];
        for i in 0..4 {
            r[i * 8..i * 8 + 8].copy_from_slice(&self.next_u64().to_le_bytes());
        }
        r
    }
}

/// Build a random round: `nplayers` players scattering stakes across squares,
/// plus the exact per-square totals (block_sol). Amounts are bounded so the
/// per-square u64 totals never overflow (max ≈ 8 players × 25 adds × 100 SOL).
fn random_round(rng: &mut Rng, max_players: u64) -> (Vec<[u64; GRID_SIZE]>, [u64; GRID_SIZE]) {
    let nplayers = 1 + rng.below(max_players) as usize;
    let mut players: Vec<[u64; GRID_SIZE]> = Vec::with_capacity(nplayers);
    let mut block_sol = [0u64; GRID_SIZE];
    for _ in 0..nplayers {
        let mut p = [0u64; GRID_SIZE];
        let nsq = 1 + rng.below(GRID_SIZE as u64) as usize;
        for _ in 0..nsq {
            let sq = rng.below(GRID_SIZE as u64) as usize;
            let amt = MIN_STAKE + rng.below(MAX_STAKE_PER_ROUND);
            p[sq] += amt;
            block_sol[sq] += amt;
        }
        players.push(p);
    }
    (players, block_sol)
}

/// Mock swap: proceeds (in ANSEM base units) = net(pot) * mock_rate / 1 SOL,
/// with fee_bps = 100 (1%) and mock_rate = 2800e6 — mirrors execute_swap_mock.
fn mock_proceeds(pot: u64) -> u64 {
    let fee = pot / 100;
    let net = pot - fee;
    ((net as u128) * 2_800_000_000u128 / SOL as u128) as u64
}

// ---------------------------------------------------------------------------
// INVARIANT 1 — Main-payout solvency (the pot can never be over-paid).
// Σ_players payout(pw_p, tw, proceeds) ≤ proceeds, and floor-division dust is
// bounded by the number of paid players.
// ---------------------------------------------------------------------------
#[test]
fn main_payout_never_exceeds_proceeds_50k_configs() {
    let mut rng = Rng::new(0x00A1_1CE0_u64);
    let mut worst_dust: u128 = 0;
    for iter in 0..50_000u64 {
        let r = rng.r32();
        let (players, block_sol) = random_round(&mut rng, 8);
        let pot: u64 = block_sol.iter().copied().sum();
        let proceeds = mock_proceeds(pot);

        let tw = total_weight(&block_sol, &r, MIN, MAX);
        let mut sum: u128 = 0;
        for p in &players {
            let pw = player_weight(p, &r, MIN, MAX);
            sum += payout(pw, tw, proceeds) as u128;
        }
        assert!(
            sum <= proceeds as u128,
            "iter {iter}: OVER-PAID pot: Σ={sum} > proceeds={proceeds} (INSOLVENT)"
        );
        let dust = proceeds as u128 - sum;
        assert!(
            dust <= players.len() as u128,
            "iter {iter}: dust {dust} exceeds player count {}",
            players.len()
        );
        worst_dust = worst_dust.max(dust);
    }
    println!("[inv1] 50k configs: no over-pay; worst floor-dust = {worst_dust} base units");
}

// ---------------------------------------------------------------------------
// INVARIANT 2 — Jackpot solvency (a tier's pool can never be over-paid).
// On the hit block: Σ_players floor(pool * player_on_block / block_total) ≤ pool.
// Mirrors the per-tier share math in claim_handler.
// ---------------------------------------------------------------------------
#[test]
fn jackpot_shares_never_exceed_pool_50k_configs() {
    let mut rng = Rng::new(0xB0B_u64);
    for iter in 0..50_000u64 {
        let nplayers = 1 + rng.below(8) as usize;
        let mut stakes: Vec<u64> = Vec::with_capacity(nplayers);
        let mut block_total: u64 = 0;
        for _ in 0..nplayers {
            let s = rng.below(MAX_STAKE_PER_ROUND); // 0..100 SOL on the hit block
            stakes.push(s);
            block_total += s;
        }
        if block_total == 0 {
            continue;
        }
        let pool = rng.below(10_000_000_000_000); // up to 10M ANSEM base units
        let mut sum: u128 = 0;
        let mut paid = 0u128;
        for &s in &stakes {
            if s == 0 {
                continue;
            }
            let share = (pool as u128 * s as u128 / block_total as u128) as u64;
            sum += share as u128;
            paid += 1;
        }
        assert!(
            sum <= pool as u128,
            "iter {iter}: jackpot OVER-PAID: Σ={sum} > pool={pool}"
        );
        assert!(
            pool as u128 - sum <= paid,
            "iter {iter}: jackpot dust exceeds paid-player count"
        );
    }
    println!("[inv2] 50k configs: no jackpot over-pay");
}

// ---------------------------------------------------------------------------
// INVARIANT 3 — payout()'s u128 multiply is overflow-safe across the entire
// realistic operating envelope (a single round's pot up to 1,000,000 SOL, all
// stake on one max-multiplier square = worst case for player_weight).
// Documents the theoretical boundary: proceeds*pw overflows u128 only near a
// ~100M-SOL single-round pot, far above any plausible round.
// ---------------------------------------------------------------------------
#[test]
fn payout_multiply_safe_within_operating_envelope() {
    for pot_sol in [1u64, 100, 10_000, 100_000, 1_000_000] {
        let pot = pot_sol * SOL;
        let mut block_sol = [0u64; GRID_SIZE];
        block_sol[0] = pot; // one player holds the entire pot on one square
        let r = [7u8; 32];
        let tw = total_weight(&block_sol, &r, MIN, MAX);
        let pw = tw; // that lone player's weight == total weight
        let proceeds = mock_proceeds(pot);
        // The exact multiply payout() performs internally:
        let prod = (proceeds as u128).checked_mul(pw);
        assert!(
            prod.is_some(),
            "payout() u128 multiply OVERFLOWS within operating envelope at {pot_sol} SOL"
        );
        // Sole holder of the pot must receive exactly the proceeds (no dust).
        assert_eq!(
            payout(pw, tw, proceeds),
            proceeds,
            "sole holder mispaid at {pot_sol} SOL"
        );
    }
    println!("[inv3] payout multiply safe up to 1,000,000 SOL/round pot");
}

// ---------------------------------------------------------------------------
// INVARIANT 4 — Multiplier always lands inside the configured band, for random
// (min ≤ max) bands, random squares, random randomness. Includes the edge bands.
// ---------------------------------------------------------------------------
#[test]
fn multiplier_always_within_band() {
    let mut rng = Rng::new(0xCAFE_u64);
    for _ in 0..50_000 {
        let a = rng.next_u64() as u16;
        let b = rng.next_u64() as u16;
        let (min, max) = if a <= b { (a, b) } else { (b, a) };
        let r = rng.r32();
        let sq = rng.below(GRID_SIZE as u64) as u8;
        let m = multiplier_bps(&r, sq, min, max);
        assert!(m >= min && m <= max, "multiplier {m} outside [{min},{max}]");
    }
    // Explicit edge bands.
    let r = [3u8; 32];
    for sq in 0..GRID_SIZE as u8 {
        assert_eq!(multiplier_bps(&r, sq, 10_000, 10_000), 10_000); // fixed 1.0x
        let full = multiplier_bps(&r, sq, 0, u16::MAX);
        let _ = full; // any u16 is in-band; just must not panic
        let dev = multiplier_bps(&r, sq, MIN, MAX);
        assert!((MIN..=MAX).contains(&dev));
    }
    println!("[inv4] 50k random bands + edges: multiplier always in-band");
}

// ---------------------------------------------------------------------------
// INVARIANT 5 — Payout monotonicity: adding stake never reduces a player's
// payout (with the rest of the board held fixed). Guards against a griefing
// incentive where staking more pays less.
// ---------------------------------------------------------------------------
#[test]
fn more_stake_weakly_increases_payout() {
    let mut rng = Rng::new(0xD00D_u64);
    for iter in 0..20_000u64 {
        let r = rng.r32();
        let sq = rng.below(GRID_SIZE as u64) as usize;
        let base = MIN_STAKE + rng.below(50 * SOL);
        let extra = rng.below(50 * SOL);
        let osq = rng.below(GRID_SIZE as u64) as usize;
        let ostake = MIN_STAKE + rng.below(50 * SOL);

        let mut small = [0u64; GRID_SIZE];
        small[sq] = base;
        let mut big = [0u64; GRID_SIZE];
        big[sq] = base + extra;

        let mut bs1 = [0u64; GRID_SIZE];
        bs1[sq] += base;
        bs1[osq] += ostake;
        let mut bs2 = [0u64; GRID_SIZE];
        bs2[sq] += base + extra;
        bs2[osq] += ostake;

        let proceeds = 1_000_000_000_000u64;
        let p1 = payout(player_weight(&small, &r, MIN, MAX), total_weight(&bs1, &r, MIN, MAX), proceeds);
        let p2 = payout(player_weight(&big, &r, MIN, MAX), total_weight(&bs2, &r, MIN, MAX), proceeds);
        assert!(p2 >= p1, "iter {iter}: more stake REDUCED payout: {p2} < {p1}");
    }
    println!("[inv5] 20k configs: payout is monotonic in stake");
}

// ---------------------------------------------------------------------------
// INVARIANT 6 — Jackpot roll boundaries: odds=0 never hits, odds=1 always hits,
// and the winning block is always a valid square. Statistical rate near 1/odds.
// ---------------------------------------------------------------------------
#[test]
fn jackpot_roll_boundaries_and_rate() {
    let mut rng = Rng::new(0xFEED_u64);
    for _ in 0..10_000 {
        let r = rng.r32();
        assert!(!jackpot_hit(&r, 0, b"jackpot_sm"), "odds=0 must never hit");
        assert!(jackpot_hit(&r, 1, b"jackpot_big"), "odds=1 must always hit");
        assert!((jackpot_block(&r, b"jkblock_sm") as usize) < GRID_SIZE);
        assert!((jackpot_block(&r, b"jkblock_big") as usize) < GRID_SIZE);
    }
    // Empirical rate for odds=100 over 200k draws should sit near 1%.
    let (mut hits, n) = (0u32, 200_000u32);
    for i in 0..n {
        let mut r = [0u8; 32];
        r[0..4].copy_from_slice(&i.to_le_bytes());
        if jackpot_hit(&r, 100, b"jackpot_sm") {
            hits += 1;
        }
    }
    let rate = hits as f64 / n as f64;
    assert!((0.006..0.014).contains(&rate), "odds=100 rate {rate} off ~0.01 (hits={hits})");
    println!("[inv6] odds boundaries hold; odds=100 empirical rate = {rate:.4}");
}

// ---------------------------------------------------------------------------
// INVARIANT 7 — Degenerate inputs pay zero, never panic (empty board, zero
// total weight, zero player weight).
// ---------------------------------------------------------------------------
#[test]
fn degenerate_inputs_pay_zero() {
    let r = [1u8; 32];
    assert_eq!(payout(0, 0, 1_000_000), 0, "tw=0 must pay 0 (no div-by-zero)");
    assert_eq!(payout(0, 12_345, 1_000_000), 0, "zero-weight player pays 0");
    assert_eq!(payout(999, 0, 1_000_000), 0, "tw=0 pays 0 even with pw>0");
    let empty = [0u64; GRID_SIZE];
    assert_eq!(total_weight(&empty, &r, MIN, MAX), 0);
    assert_eq!(player_weight(&empty, &r, MIN, MAX), 0);
    assert_eq!(
        payout(player_weight(&empty, &r, MIN, MAX), total_weight(&empty, &r, MIN, MAX), 999),
        0
    );
    println!("[inv7] degenerate inputs pay zero, no panic");
}
