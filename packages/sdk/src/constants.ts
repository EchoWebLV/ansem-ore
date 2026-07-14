import { PublicKey } from "@solana/web3.js";

export const PROGRAM_ID = new PublicKey("8Q9EnK7ydn6ywo7ZxeqhubqYybf7FFNNwnz8JzJjXZjz");

// PDA seeds (bytes must match programs/ansem-miner/src/constants.rs exactly)
export const SEED = {
  config: "config",
  round: "round",
  miner: "miner",
  escrow: "escrow",
  potVault: "pot_vault",
  treasury: "treasury",
  vaultAuth: "vault_auth",
  mintAuth: "mint_auth",
  ansemMint: "ansem_mint",
  beefConfig: "beef_config",
  beefMiner: "beef_miner",
  beefRound: "beef_round",
  jackpotConfig: "jackpot_config",
  sessionTokenV2: "session_token_v2", // gum
} as const;

// Scalars
export const GRID_SIZE = 25;
export const ANSEM_DECIMALS = 6;
export const RETURN_MAX_BPS = 5000; // non-jackpot squares capped at 50%
export const DEFAULT_ROUND_DURATION_SECS = 60;
export const SWAP_MODE_MOCK = 0;
export const SWAP_MODE_JUPITER = 1;

// BEEF emission-layer defaults (mirror programs/ansem-miner/src/constants.rs).
// Mint-on-emission model (spec 2026-07-14 D1/D4): per-round mint =
// max_round_mint * pot/(pot + sat_lamports), decayed by remaining cap headroom.
export const BEEF_MAX_ROUND_MINT = 210_000_000;          // 210 BEEF/round nominal
export const BEEF_SAT_LAMPORTS = 1_000_000_000;          // half-max at a 1 SOL pot
export const BEEF_HARD_CAP = 21_000_000_000_000;         // 21,000,000 BEEF supply cap
export const BEEF_TREASURY_BPS = 2_000;                  // 20% continuous treasury cut
export const DEFAULT_BEEF_TICK_BPS = 3;                  // +0.03% hold-to-grow per tick
export const DEFAULT_BEEF_BONUS_CAP_BPS = 30_000;        // +300% -> 4x payout cap (~7 days)
export const DEFAULT_BEEF_ACTIVITY_WINDOW_SECS = 86_400; // daily-streak activity gate
export const DEFAULT_BEEF_SECS_PER_TICK = 60;            // one tick per round-length
/** @deprecated dormant vault-drip divisor (pre-2026-07-14); superseded by the
 *  mint-on-emission BEEF_* constants above. Kept only for the legacy beef-init script. */
export const DEFAULT_BEEF_DIVISOR = 1_800_000;

// Jackpot: random-trigger + bet-scaled cap (spec D6; mirror constants.rs).
export const DEFAULT_JACKPOT_TRIGGER_ODDS = 25;          // 1-in-25 winner rounds
export const DEFAULT_JACKPOT_CAP_MULT = 100;             // bite <= 100x winning-square value

// Round.state values
export enum RoundState {
  Open = 0,
  VrfPending = 1,
  Settled = 2,
  Swapping = 3, // reserved (mainnet Jupiter), unused in mock
  Claimable = 4,
  Closed = 5,
}

// Upgradeable BPF loader — its [programId] PDA is the ProgramData account that
// gates initialize_real to the program's upgrade authority (see programDataPda).
export const BPF_LOADER_UPGRADEABLE_ID = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

// SPL token programs. The mock PDA mint (devnet) is classic SPL; the real $ANSEM mint
// on mainnet is Token-2022. The program's token layer uses anchor_spl::token_interface,
// so builders thread whichever program owns the mint into ATA derivation + the
// `tokenProgram` account (which is no longer auto-resolvable — the interface has 2 ids).
export const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

// Known devnet infra
export const DLP_PROGRAM_ID = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
export const GUM_PROGRAM_ID = new PublicKey("KeyspM2ssCJbqUhQ4k7sveSiY4WjnYsrXkC8oDbwde5");
export const DEFAULT_ER_VALIDATOR = new PublicKey("MUS3hc9TCw4cGC12vHNoYcCGzJG1txjgQLZWVoeNHNd");
export const VRF_BASE_QUEUE = new PublicKey("Cuj97ggrhhidhbu39TijNVqE74xvKJ69gDervRUXAxGh");
export const DEFAULT_ER_ENDPOINT = "https://devnet-us.magicblock.app";
export const DEFAULT_ER_WS_ENDPOINT = "wss://devnet-us.magicblock.app";
