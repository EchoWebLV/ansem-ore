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
  sessionTokenV2: "session_token_v2", // gum
} as const;

// Scalars
export const GRID_SIZE = 25;
export const ANSEM_DECIMALS = 6;
export const RETURN_MAX_BPS = 5000; // non-jackpot squares capped at 50%
export const DEFAULT_ROUND_DURATION_SECS = 60;
export const SWAP_MODE_MOCK = 0;
export const SWAP_MODE_JUPITER = 1;

// Round.state values
export enum RoundState {
  Open = 0,
  VrfPending = 1,
  Settled = 2,
  Swapping = 3, // reserved (mainnet Jupiter), unused in mock
  Claimable = 4,
  Closed = 5,
}

// Known devnet infra
export const DLP_PROGRAM_ID = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
export const GUM_PROGRAM_ID = new PublicKey("KeyspM2ssCJbqUhQ4k7sveSiY4WjnYsrXkC8oDbwde5");
export const DEFAULT_ER_VALIDATOR = new PublicKey("MUS3hc9TCw4cGC12vHNoYcCGzJG1txjgQLZWVoeNHNd");
export const VRF_BASE_QUEUE = new PublicKey("Cuj97ggrhhidhbu39TijNVqE74xvKJ69gDervRUXAxGh");
export const DEFAULT_ER_ENDPOINT = "https://devnet-us.magicblock.app";
export const DEFAULT_ER_WS_ENDPOINT = "wss://devnet-us.magicblock.app";
