//! Stress / property harness for the ANSEM Miner LOTTERY payout math.
//!
//! HOST tests (`cargo test`), test-only, touching NO production code. They hammer
//! the pure functions in `ansem_miner::math` with tens of thousands of adversarial
//! random rounds to prove "solvency by construction": across a round (and across
//! the jackpot rollover), the ANSEM paid out never exceeds the ANSEM minted
//! (`proceeds Q` + any carried rollover), and the return/jackpot split conserves
//! exactly.
//!
//! Run: `cargo test -p ansem-miner --test invariants -- --nocapture`

use ansem_miner::constants::{GRID_SIZE, RETURN_MAX_BPS};
use ansem_miner::math::{
    jackpot_block, jackpot_share, multiplier_bps, nonjackpot_payout, return_weight,
};

const SOL: u64 = 1_000_000_000;
const MAX_STAKE_PER_ROUND: u64 = 100 * SOL;
const MIN_STAKE: u64 = 10_000_000; // 0.01 SOL
const DOMAIN: &[u8] = b"jackpot"; // must match settle.rs / vrf_settle.rs

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

/// A random return band `(min, max)` inside the on-chain cap `[0, RETURN_MAX_BPS]`
/// (set_return_band enforces `min <= max <= RETURN_MAX_BPS`).
fn rand_band(rng: &mut Rng) -> (u16, u16) {
    let a = rng.below(RETURN_MAX_BPS as u64 + 1) as u16;
    let b = rng.below(RETURN_MAX_BPS as u64 + 1) as u16;
    if a <= b {
        (a, b)
    } else {
        (b, a)
    }
}

/// Build a random round: `max_players` players scattering stakes, plus the exact
/// per-square totals (block_sol). Amounts bounded so per-square u64 never overflows.
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

/// Mock swap proceeds Q (ANSEM base units) = net(pot) * mock_rate / 1 SOL, with
/// fee_bps = 100 (1%) and mock_rate = 2800e6 — mirrors execute_swap_mock.
fn mock_proceeds(pot: u64) -> u64 {
    let fee = pot / 100;
    let net = pot - fee;
    ((net as u128) * 2_800_000_000u128 / SOL as u128) as u64
}

/// Mirror the on-chain split (swap.rs + claim.rs) for one round. Returns
/// (Q, nj_total, jackpot_pool, new_rollover, jackpot_square, per-player payouts).
fn settle_round(
    players: &[[u64; GRID_SIZE]],
    block_sol: &[u64; GRID_SIZE],
    r: &[u8; 32],
    min: u16,
    max: u16,
    rollover_in: u64,
) -> (u64, u64, u64, u64, u8, Vec<u64>) {
    let pot: u64 = block_sol.iter().copied().sum();
    let q = mock_proceeds(pot);
    let jsq = jackpot_block(r, DOMAIN);
    let nj_total = nonjackpot_payout(return_weight(block_sol, r, jsq, min, max), pot, q);
    let leftover = q - nj_total; // nj_total <= q/2 always (each f_j <= 50%)
    let (pool, new_rollover) = if block_sol[jsq as usize] > 0 {
        (leftover + rollover_in, 0)
    } else {
        (0, rollover_in + leftover)
    };
    let mut payouts = Vec::with_capacity(players.len());
    for p in players {
        let nj = nonjackpot_payout(return_weight(p, r, jsq, min, max), pot, q);
        let jp = jackpot_share(pool, p[jsq as usize], block_sol[jsq as usize]);
        payouts.push(nj + jp);
    }
    (q, nj_total, pool, new_rollover, jsq, payouts)
}

// ---------------------------------------------------------------------------
// INVARIANT 1 — Round accounting conserves exactly + claims never over-pay.
// `nj_total + jackpot_pool + new_rollover == Q + rollover_in` (no leak), and the
// sum of every player's (returns + jackpot share) never exceeds what's available.
// ---------------------------------------------------------------------------
#[test]
fn round_accounting_conserves_and_never_overpays_50k() {
    let mut rng = Rng::new(0x00A1_1CE0_u64);
    let mut worst_dust: u128 = 0;
    for iter in 0..50_000u64 {
        let r = rng.r32();
        let (min, max) = rand_band(&mut rng);
        let (players, block_sol) = random_round(&mut rng, 8);
        let rollover_in = rng.below(5_000_000_000_000); // up to 5M ANSEM carried

        let (q, nj_total, pool, new_rollover, _jsq, payouts) =
            settle_round(&players, &block_sol, &r, min, max, rollover_in);

        // Exact accounting identity — the minted proceeds + carried rollover are
        // partitioned with no leak.
        assert_eq!(
            nj_total as u128 + pool as u128 + new_rollover as u128,
            q as u128 + rollover_in as u128,
            "iter {iter}: accounting leak"
        );

        // Claims never exceed what's payable this round (= nj_total + pool).
        let claimed: u128 = payouts.iter().map(|&x| x as u128).sum();
        let available = nj_total as u128 + pool as u128;
        assert!(
            claimed <= available,
            "iter {iter}: OVER-PAID {claimed} > {available} (INSOLVENT)"
        );
        let dust = available - claimed;
        assert!(
            dust <= 4 * players.len() as u128 + 4,
            "iter {iter}: dust {dust} exceeds bound for {} players",
            players.len()
        );
        worst_dust = worst_dust.max(dust);
    }
    println!("[inv1] 50k rounds: accounting conserves; no over-pay; worst floor-dust = {worst_dust}");
}

// ---------------------------------------------------------------------------
// INVARIANT 2 — Zero band (0,0) sends the ENTIRE pot to the jackpot square (or
// rolls it all over if nobody staked that square).
// ---------------------------------------------------------------------------
#[test]
fn zero_band_sends_all_to_jackpot() {
    let mut rng = Rng::new(0x0B0B_u64);
    for _ in 0..10_000 {
        let r = rng.r32();
        let (players, block_sol) = random_round(&mut rng, 6);
        let (q, nj_total, pool, new_rollover, jsq, _payouts) =
            settle_round(&players, &block_sol, &r, 0, 0, 0);
        assert_eq!(nj_total, 0, "zero band must pay no returns");
        if block_sol[jsq as usize] > 0 {
            assert_eq!(pool, q, "winner takes all proceeds");
            assert_eq!(new_rollover, 0);
        } else {
            assert_eq!(pool, 0);
            assert_eq!(new_rollover, q, "no winner: all Q rolls over");
        }
    }
    println!("[inv2] zero band => entire pot to the jackpot square (or full rollover)");
}

// ---------------------------------------------------------------------------
// INVARIANT 3 — Non-jackpot returns never exceed half the proceeds (each square's
// return fraction is capped at 50%, so the jackpot is always >= half the pot).
// ---------------------------------------------------------------------------
#[test]
fn returns_never_exceed_half_30k() {
    let mut rng = Rng::new(0xCAFE_u64);
    for iter in 0..30_000u64 {
        let r = rng.r32();
        let (min, max) = rand_band(&mut rng);
        let (players, block_sol) = random_round(&mut rng, 8);
        let (q, nj_total, _pool, _nr, _jsq, _p) = settle_round(&players, &block_sol, &r, min, max, 0);
        assert!(
            nj_total as u128 <= q as u128 / 2 + 1,
            "iter {iter}: NJ {nj_total} > Q/2 (Q={q})"
        );
    }
    println!("[inv3] 30k rounds: non-jackpot returns <= 50% of proceeds");
}

// ---------------------------------------------------------------------------
// INVARIANT 4 — An empty jackpot square (nobody staked it) pays no jackpot and
// rolls its full leftover forward.
// ---------------------------------------------------------------------------
#[test]
fn empty_jackpot_square_rolls_over() {
    let mut rng = Rng::new(0xFEED_u64);
    let mut tested = 0u32;
    for _ in 0..40_000 {
        let r = rng.r32();
        let jsq = jackpot_block(&r, DOMAIN) as usize;
        let mut block_sol = [0u64; GRID_SIZE];
        let mut player = [0u64; GRID_SIZE];
        for _ in 0..5 {
            let mut sq = rng.below(GRID_SIZE as u64) as usize;
            if sq == jsq {
                sq = (sq + 1) % GRID_SIZE; // never stake the jackpot square
            }
            let amt = MIN_STAKE + rng.below(10 * SOL);
            block_sol[sq] += amt;
            player[sq] += amt;
        }
        if block_sol[jsq] != 0 {
            continue;
        }
        let rollover_in = rng.below(1_000_000_000_000);
        let (q, nj_total, pool, new_rollover, _jsq2, _payouts) =
            settle_round(&[player], &block_sol, &r, 0, 5000, rollover_in);
        assert_eq!(pool, 0, "no staker => no jackpot pool paid");
        assert_eq!(
            new_rollover,
            rollover_in + (q - nj_total),
            "leftover must roll over intact"
        );
        tested += 1;
    }
    assert!(tested > 100, "expected many empty-jackpot rounds, got {tested}");
    println!("[inv4] {tested} empty-jackpot rounds: leftover rolls over, nobody wins the pool");
}

// ---------------------------------------------------------------------------
// INVARIANT 5 — Rollover carried A->B and consumed by B's winner; total ANSEM
// paid across both rounds never exceeds total ANSEM minted (Q_a + Q_b).
// ---------------------------------------------------------------------------
#[test]
fn rollover_conserved_across_rounds() {
    let mut rng = Rng::new(0xD00D_u64);
    let mut ran = 0u32;
    for _ in 0..8_000 {
        // Round A: force an empty jackpot square.
        let ra = rng.r32();
        let jsqa = jackpot_block(&ra, DOMAIN) as usize;
        let mut bsa = [0u64; GRID_SIZE];
        let mut pa = [0u64; GRID_SIZE];
        for _ in 0..4 {
            let mut sq = rng.below(GRID_SIZE as u64) as usize;
            if sq == jsqa {
                sq = (sq + 1) % GRID_SIZE;
            }
            let a = MIN_STAKE + rng.below(10 * SOL);
            bsa[sq] += a;
            pa[sq] += a;
        }
        if bsa[jsqa] != 0 {
            continue;
        }
        let (qa, _nja, poola, roll_after_a, _j, paya) = settle_round(&[pa], &bsa, &ra, 0, 5000, 0);
        assert_eq!(poola, 0, "round A has no jackpot winner");

        // Round B: force a staker onto the jackpot square.
        let rb = rng.r32();
        let jsqb = jackpot_block(&rb, DOMAIN) as usize;
        let mut bsb = [0u64; GRID_SIZE];
        let mut pb = [0u64; GRID_SIZE];
        let winb = MIN_STAKE + rng.below(10 * SOL);
        bsb[jsqb] += winb;
        pb[jsqb] += winb;
        for _ in 0..3 {
            let sq = rng.below(GRID_SIZE as u64) as usize;
            let a = MIN_STAKE + rng.below(10 * SOL);
            bsb[sq] += a;
            pb[sq] += a;
        }
        let (qb, _njb, _poolb, roll_after_b, _j2, payb) =
            settle_round(&[pb], &bsb, &rb, 0, 5000, roll_after_a);
        assert_eq!(roll_after_b, 0, "B's winner consumes the rollover");

        let paid: u128 = paya.iter().chain(payb.iter()).map(|&x| x as u128).sum();
        assert!(
            paid <= qa as u128 + qb as u128,
            "paid {paid} > total minted {}",
            qa as u128 + qb as u128
        );
        ran += 1;
    }
    assert!(ran > 100, "expected many A->B pairs, got {ran}");
    println!("[inv5] {ran} A->B pairs: rollover carried then consumed; paid <= minted");
}

// ---------------------------------------------------------------------------
// INVARIANT 6 — Jackpot pool is never over-paid: Σ pro-rata shares <= pool.
// ---------------------------------------------------------------------------
#[test]
fn jackpot_shares_never_exceed_pool_50k() {
    let mut rng = Rng::new(0xB0B_u64);
    for iter in 0..50_000u64 {
        let n = 1 + rng.below(8) as usize;
        let mut stakes = Vec::with_capacity(n);
        let mut total = 0u64;
        for _ in 0..n {
            let s = rng.below(MAX_STAKE_PER_ROUND);
            stakes.push(s);
            total += s;
        }
        if total == 0 {
            continue;
        }
        let pool = rng.below(10_000_000_000_000);
        let sum: u128 = stakes
            .iter()
            .map(|&s| jackpot_share(pool, s, total) as u128)
            .sum();
        assert!(sum <= pool as u128, "iter {iter}: jackpot over-pay {sum} > {pool}");
    }
    println!("[inv6] 50k configs: jackpot pool never over-paid");
}

// ---------------------------------------------------------------------------
// INVARIANT 7 — The u128 payout multiply is overflow-safe across the operating
// envelope (a single round pot up to 1,000,000 SOL, all squares at max return).
// ---------------------------------------------------------------------------
#[test]
fn payout_math_overflow_safe_to_1m_sol() {
    for pot_sol in [1u64, 100, 10_000, 100_000, 1_000_000] {
        let pot = pot_sol * SOL;
        let mut block_sol = [0u64; GRID_SIZE];
        for s in block_sol.iter_mut() {
            *s = pot / GRID_SIZE as u64; // spread = worst-case return_weight
        }
        let r = [7u8; 32];
        let jsq = jackpot_block(&r, DOMAIN);
        let q = mock_proceeds(pot);
        let w = return_weight(&block_sol, &r, jsq, RETURN_MAX_BPS, RETURN_MAX_BPS);
        assert!(
            (q as u128).checked_mul(w).is_some(),
            "nonjackpot_payout u128 multiply OVERFLOWS at {pot_sol} SOL"
        );
        let nj = nonjackpot_payout(w, pot, q);
        assert!(nj <= q, "nj {nj} > q {q} at {pot_sol} SOL");
    }
    println!("[inv7] payout math overflow-safe up to 1,000,000 SOL/round");
}

// ---------------------------------------------------------------------------
// INVARIANT 8 — Multiplier (return fraction) always lands inside the band, for
// random (min <= max) bands within the cap, and the jackpot square is valid.
// ---------------------------------------------------------------------------
#[test]
fn return_fraction_in_band_and_jackpot_in_range() {
    let mut rng = Rng::new(0xF00D_u64);
    for _ in 0..50_000 {
        let (min, max) = rand_band(&mut rng);
        let r = rng.r32();
        let sq = rng.below(GRID_SIZE as u64) as u8;
        let f = multiplier_bps(&r, sq, min, max);
        assert!(f >= min && f <= max, "return {f} outside [{min},{max}]");
        assert!((jackpot_block(&r, DOMAIN) as usize) < GRID_SIZE);
    }
    // Edge: (0,0) => always 0; (5000,5000) => always 5000.
    let r = [3u8; 32];
    for sq in 0..GRID_SIZE as u8 {
        assert_eq!(multiplier_bps(&r, sq, 0, 0), 0);
        assert_eq!(multiplier_bps(&r, sq, 5000, 5000), 5000);
    }
    println!("[inv8] 50k random bands + edges: return fraction in-band; jackpot square valid");
}

// ---------------------------------------------------------------------------
// INVARIANT 9 — Degenerate inputs pay zero, never panic.
// ---------------------------------------------------------------------------
#[test]
fn degenerate_inputs_pay_zero() {
    let r = [1u8; 32];
    assert_eq!(nonjackpot_payout(0, 0, 1_000_000), 0, "pot=0 pays 0 (no div-by-zero)");
    assert_eq!(nonjackpot_payout(12_345, 0, 1_000_000), 0, "pot=0 pays 0 with weight");
    assert_eq!(jackpot_share(1_000_000, 0, 0), 0, "no stakers => 0");
    assert_eq!(jackpot_share(1_000_000, 5, 0), 0, "total 0 => 0");
    let empty = [0u64; GRID_SIZE];
    assert_eq!(return_weight(&empty, &r, 0, 0, 5000), 0);
    let (q, nj, pool, roll, _j, pay) = settle_round(&[empty], &empty, &r, 0, 5000, 0);
    assert_eq!((q, nj, pool, roll), (0, 0, 0, 0));
    assert_eq!(pay[0], 0);
    println!("[inv9] degenerate inputs pay zero, no panic");
}
