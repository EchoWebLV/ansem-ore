// Ops tool: LIST-DAY skeleton — create the Meteora DAMM v2 (cp-amm) BEEF/ANSEM
// pool (spec D10): base = BEEF (classic SPL), quote = ANSEM (Token-2022, custom
// quote), single-sided BEEF deposit from the treasury, fee scheduler armed
// (high start decaying — anti-snipe), position PERMANENTLY LOCKED in the same
// transaction. Net effect: every SOL<->BEEF trade routes through ANSEM and the
// LP can never be withdrawn; swap fees stay claimable by the position owner.
//
// ============================================================================
// FEASIBILITY VERIFICATION (2026-07-14, @meteora-ag/cp-amm-sdk v1.4.5 installed
// types/impl + github.com/MeteoraAg/damm-v2 program source + docs.meteora.ag):
//
// Q1 — Custom quote mint, permissionless, Token-2022 gating: VERIFIED.
//   `initialize_customizable_pool` takes any (tokenAMint, tokenBMint) pair and
//   no config/authority account (SDK IDL accounts list; docs: "does not require
//   any config key"). Token program ids are explicit params (tokenAProgram /
//   tokenBProgram). Token-2022 extension allowlist in the program source
//   (programs/cp-amm/src/utils/token.rs is_supported_mint):
//     TransferFeeConfig | MetadataPointer | TokenMetadata  -> permissionless;
//   anything else needs an admin-whitelisted token badge. ANSEM's only
//   extensions are metadataPointer + tokenMetadata -> inside the allowlist, no
//   badge needed (the SDK always passes both token-badge PDAs as remaining
//   accounts; they may be uninitialized). CAVEAT: ONE customizable pool per
//   pair — the pool PDA is ["cpool", sorted mints] — and the repo README says
//   it "should be only used by token deployer": create ours before announcing
//   the mint, or a griefer can claim the canonical cpool address for the pair.
//
// Q2 — Fee scheduler on a permissionless custom pool: VERIFIED.
//   `InitializeCustomizeablePoolParams.poolFees.baseFee` carries the scheduler,
//   built by getBaseFeeParams({ baseFeeMode: FeeTimeSchedulerLinear(0) |
//   FeeTimeSchedulerExponential(1), feeTimeSchedulerParam: { startingFeeBps,
//   endingFeeBps, numberOfPeriod, totalDuration } }, tokenBDecimal,
//   activationType). totalDuration is in seconds when activationType =
//   Timestamp (slots when Slot). Cap: max fee 9900 bps (99%) at pool version 1
//   (MAX_FEE_BPS_V1, enforced by getFeeTimeSchedulerParams).
//
// Q3 — Single-sided base-only deposit + price expression: VERIFIED.
//   cpAmm.preparePoolCreationSingleSide({ tokenAAmount, minSqrtPrice,
//   maxSqrtPrice, initSqrtPrice, collectFeeMode }) returns the liquidityDelta;
//   it REQUIRES initSqrtPrice == minSqrtPrice ("Only support single side for
//   base token") — the pool starts at the bottom of its range holding only
//   BEEF, so it can never quote below the listing price. tokenBAmount = 0
//   passes on-chain-mirrored validation (validateCustomizablePoolParams only
//   rejects BOTH amounts zero). Price is expressed as sqrt(price) in Q64.64:
//   getSqrtPriceFromPrice(humanPrice quote-per-base, tokenADecimals,
//   tokenBDecimals).
//
// Q4 — Permanent lock vs time lock, irreversibility: VERIFIED.
//   `permanent_lock_position(permanent_lock_liquidity: u128)` (SDK
//   cpAmm.permanentLockPosition, signer = position owner) moves unlocked ->
//   permanent_locked_liquidity. Distinct from lock_position (vesting/cliff
//   time lock). Irreversible on-chain: the program's full instruction list has
//   NO unlock/admin path, and ix_permanent_lock_position.rs only ever
//   increases permanent_locked_liquidity (remove_liquidity draws from
//   unlocked_liquidity only). Docs: creators "claim fees on permanently locked
//   liquidity forever, even though they no longer have access to that
//   liquidity". Bonus: createCustomPool({ isLockLiquidity: true }) appends the
//   permanent-lock instruction to the SAME pool-create transaction (verified
//   in the SDK impl) — creation and lock are atomic, no unlock window at all.
//
// DAY-0 / FUTURE-ACTIVATION VERIFICATION (2026-07-14, damm-v2 program source):
// our launch is mine-first — the BEEF mint is public days before LIST DAY, so
// the pool is created on day 0 (securing the one-per-pair cpool PDA) with
// trading gated until list day. All four follow-ups VERIFIED in favor:
//
// Q5 — Future activation blocks swaps on-chain: VERIFIED.
//   pool_action_access/permissionless.rs can_swap(): non-whitelisted senders
//   need `current_point >= activation_point`; enforced in swap/ix_p_swap.rs
//   via require!(access_validator.can_swap(payer), PoolError::PoolDisabled).
//   With hasAlphaVault=false the whitelisted_vault is Pubkey::default() —
//   nobody gets the 1h-early alpha window. activationPoint=None defaults to
//   the current point (immediate activation, today's behavior preserved).
//
// Q6 — Liquidity ops BEFORE activation: VERIFIED.
//   can_create_position / can_add_liquidity / can_lock_position gate ONLY on
//   pool_status == Enable (set at init), NOT on activation (same file; each
//   ix calls its can_* — ix_create_position.rs, ix_add_liquidity.rs,
//   ix_permanent_lock_position.rs). So: day-0 dust seed -> pre-list add +
//   permanent lock of the treasury's mined BEEF -> no trading until list day.
//   Note: can_remove_liquidity requires current_point >= activation_point —
//   even UNLOCKED liquidity cannot be pulled pre-activation.
//
// Q7 — Fee-scheduler clock anchors at ACTIVATION, not creation: VERIFIED.
//   base_fee/fee_time_scheduler.rs get_base_fee_numerator(): period =
//   (current_point - activation_point) / period_frequency — a day-0 pool
//   opens on list day at the FULL cliff fee and decays from there. (The
//   `current_point < activation_point` branch returns the min fee, but only
//   the alpha vault can swap pre-activation and we have none.)
//
// Q8 — activationPoint range: VERIFIED.
//   params/activation.rs (no alpha vault): current_point <= activation_point
//   <= current_point + MAX_ACTIVATION_TIME_DURATION, where constants.rs sets
//   MAX_ACTIVATION_TIME_DURATION = 3600*24*31 = 31 DAYS (Timestamp type).
//   Mirrored client-side below so a bad ACTIVATION_TS fails fast.
// ============================================================================
//
// Usage (DRY-RUN IS THE DEFAULT — builds + prints, signs and sends NOTHING):
//
// Mode 1 — pool creation (day 0 or list day):
//   RPC_URL=<mainnet rpc> BEEF_MINT=<CA> \
//   SEED_BEEF_BASE_UNITS=<base units> INITIAL_PRICE_ANSEM_PER_BEEF=<human price> \
//   [ACTIVATION_TS=<unix secs — future activation; absent = trade immediately>] \
//   [ANSEM_MINT=9cRC...pump] [PAYER_WALLET=<keypair path>] \
//   [FEE_START_BPS=5000] [FEE_END_BPS=100] [FEE_PERIODS=60] [FEE_DECAY_SECS=3600] \
//   [FEE_MODE=exponential|linear] [COLLECT_FEE_MODE=onlyB|both] \
//   node scripts/meteora-list.mjs [--simulate]
//
// Mode 2 — add + permanently lock a position on an EXISTING pool (pre-list
// treasury add; works pre-activation, see Q6):
//   RPC_URL=<mainnet rpc> BEEF_MINT=<CA> SEED_BEEF_BASE_UNITS=<base units> \
//   INITIAL_PRICE_ANSEM_PER_BEEF=<human price — placeholder fallback only> \
//   [POOL=<pool address — default: derived from the mint pair>] \
//   node scripts/meteora-list.mjs --add-locked-position [--simulate]
//
// REAL MODE (either mode): requires BOTH --no-dry-run AND --i-know-what-i-am-doing
// flags, plus PAYER_WALLET + BEEF_MINT + all params. The payer must hold
// SEED_BEEF_BASE_UNITS of BEEF in its ATA (the treasury's mined share).
import { Connection, Keypair, PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { getMint, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import BN from "bn.js";
import {
  CpAmm, getBaseFeeParams, getSqrtPriceFromPrice, getPriceFromSqrtPrice,
  getBaseFeeHandlerFromBorshData, feeNumeratorToBps,
  getLiquidityDeltaFromAmountA, getAmountBFromLiquidityDelta, Rounding,
  deriveCustomizablePoolAddress, deriveTokenVaultAddress, derivePositionAddress,
  derivePositionNftAccount, BaseFeeMode, ActivationType, CollectFeeMode,
  MAX_SQRT_PRICE, CpAmmIdl,
} from "@meteora-ag/cp-amm-sdk";

const req = (k) => {
  const v = process.env[k];
  if (!v) { console.error(`missing env ${k}`); process.exit(1); }
  return v;
};
const kpOf = (p) => Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(p, "utf8"))));

const NO_DRY_RUN = process.argv.includes("--no-dry-run");
const I_KNOW = process.argv.includes("--i-know-what-i-am-doing");
const SIMULATE = process.argv.includes("--simulate");
const ADD_LOCKED = process.argv.includes("--add-locked-position");
const REAL = NO_DRY_RUN && I_KNOW;
if (NO_DRY_RUN && !I_KNOW) {
  console.error("REFUSED: --no-dry-run also requires --i-know-what-i-am-doing. This creates and PERMANENTLY LOCKS mainnet liquidity.");
  process.exit(1);
}

// Day-0 play: create the pool now, open trading at ACTIVATION_TS (unix secs).
// Client-side mirror of the on-chain check (params/activation.rs, no alpha
// vault): now <= activation_point <= now + 31 days (Q8).
const MAX_ACTIVATION_AHEAD_SECS = 3600 * 24 * 31;
let activationTs = null;
if (process.env.ACTIVATION_TS !== undefined) {
  activationTs = Number(process.env.ACTIVATION_TS);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isInteger(activationTs) || activationTs < now || activationTs > now + MAX_ACTIVATION_AHEAD_SECS) {
    console.error(`ACTIVATION_TS must be unix seconds in [now, now + 31 days] = [${now}, ${now + MAX_ACTIVATION_AHEAD_SECS}] (on-chain MAX_ACTIVATION_TIME_DURATION); got ${process.env.ACTIVATION_TS}`);
    process.exit(1);
  }
}

const RPC = process.env.RPC_URL || process.env.RPC || "https://api.mainnet-beta.solana.com";
const ANSEM_MINT = new PublicKey(process.env.ANSEM_MINT || "9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump");
const seedBeef = new BN(req("SEED_BEEF_BASE_UNITS"));
const priceAnsemPerBeef = req("INITIAL_PRICE_ANSEM_PER_BEEF"); // human units: ANSEM per 1 BEEF
const FEE_START_BPS = Number(process.env.FEE_START_BPS ?? "5000"); // 50% anti-snipe start
const FEE_END_BPS = Number(process.env.FEE_END_BPS ?? "100");      // 1% resting fee
const FEE_PERIODS = Number(process.env.FEE_PERIODS ?? "60");
const FEE_DECAY_SECS = Number(process.env.FEE_DECAY_SECS ?? "3600");
const FEE_MODE = (process.env.FEE_MODE ?? "exponential") === "linear"
  ? BaseFeeMode.FeeTimeSchedulerLinear : BaseFeeMode.FeeTimeSchedulerExponential;
// onlyB = all swap fees collected in ANSEM (the quote) — thesis-aligned default.
const COLLECT_FEE_MODE = (process.env.COLLECT_FEE_MODE ?? "onlyB") === "both"
  ? CollectFeeMode.BothToken : CollectFeeMode.OnlyB;

// Real mode: everything must be real. Dry-run: placeholders allowed for the
// not-yet-existing pieces (BEEF mint pre-launch, payer), loudly marked.
let beefMint, beefIsPlaceholder = false;
if (process.env.BEEF_MINT) {
  beefMint = new PublicKey(process.env.BEEF_MINT);
} else if (!REAL) {
  beefMint = Keypair.generate().publicKey;
  beefIsPlaceholder = true;
} else {
  req("BEEF_MINT");
}
const payerKp = REAL ? kpOf(req("PAYER_WALLET"))
  : (process.env.PAYER_WALLET ? kpOf(process.env.PAYER_WALLET) : Keypair.generate());
const payer = payerKp.publicKey;

const conn = new Connection(RPC, "confirmed");
const cpAmm = new CpAmm(conn);

// Label instructions by DAMM v2 IDL discriminator (or well-known program).
const discs = Object.fromEntries(CpAmmIdl.instructions.map((i) => [i.discriminator.join(","), i.name]));
const label = (ix) => {
  const d = [...ix.data.slice(0, 8)].join(",");
  return discs[d]
    || (ix.programId.equals(TOKEN_PROGRAM_ID) || ix.programId.equals(TOKEN_2022_PROGRAM_ID) ? "spl-token"
      : ix.programId.toBase58() === "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL" ? "create-ata(idempotent)"
      : "system/other");
};
const describeTx = (tx, signers) => ({
  instructionCount: tx.instructions.length,
  instructions: tx.instructions.map((ix, i) => ({
    i, programId: ix.programId.toBase58(), name: label(ix), accounts: ix.keys.length, dataBytes: ix.data.length,
  })),
  signers,
});
const simulateAndPrint = async (tx, placeholderNote) => {
  // Read-only preflight: sigVerify false — no signatures, no state change, no fee.
  const msg = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: (await conn.getLatestBlockhash()).blockhash,
    instructions: tx.instructions,
  }).compileToV0Message();
  const sim = await conn.simulateTransaction(new VersionedTransaction(msg), { sigVerify: false, replaceRecentBlockhash: false });
  console.log("SIMULATION:", JSON.stringify({
    err: sim.value.err,
    logs: (sim.value.logs || []).slice(-15),
    note: placeholderNote,
  }, null, 2));
};

// --- Decimals: fetch live (read-only). ANSEM is Token-2022; BEEF classic SPL.
const ansemMintState = await getMint(conn, ANSEM_MINT, "confirmed", TOKEN_2022_PROGRAM_ID);
let beefDecimals = 6;
if (beefIsPlaceholder) {
  console.log(`NOTE: BEEF_MINT not set — using PLACEHOLDER mint ${beefMint.toBase58()} (assumed 6dp classic SPL). Addresses derived from it are NOT the real ones.`);
} else {
  const beefMintState = await getMint(conn, beefMint, "confirmed", TOKEN_PROGRAM_ID).catch((e) => {
    console.error(`BEEF_MINT ${beefMint.toBase58()} is not a classic SPL mint on this cluster (${e.name ?? e}).`);
    process.exit(1);
  });
  beefDecimals = beefMintState.decimals;
}

// ============================================================================
// MODE 2: --add-locked-position — create + fund + PERMANENTLY LOCK a new
// position on an EXISTING pool, single-sided BEEF, in ONE atomic transaction.
// Works pre-activation (Q6): create_position/add_liquidity/permanent_lock are
// only pool_status-gated. Pre-activation the price CANNOT move (Q5), so the
// pool still sits at sqrt_price == sqrt_min_price and needs zero ANSEM.
// ============================================================================
if (ADD_LOCKED) {
  const pool = process.env.POOL
    ? new PublicKey(process.env.POOL)
    : deriveCustomizablePoolAddress(beefMint, ANSEM_MINT);

  // Fetch the live pool (read-only). Placeholder fallback for dry-run only.
  let ps = await cpAmm.fetchPoolState(pool).catch(() => null);
  let poolIsPlaceholder = false;
  if (!ps) {
    if (REAL) { console.error(`REFUSED: pool ${pool.toBase58()} does not exist on chain.`); process.exit(1); }
    poolIsPlaceholder = true;
    const p0 = getSqrtPriceFromPrice(priceAnsemPerBeef, beefDecimals, ansemMintState.decimals);
    ps = { sqrtPrice: p0, sqrtMinPrice: p0, sqrtMaxPrice: MAX_SQRT_PRICE, collectFeeMode: COLLECT_FEE_MODE, activationPoint: new BN(0), poolStatus: 0 };
    console.log(`NOTE: pool ${pool.toBase58()} not found — dry-run continues with a PLACEHOLDER pool state at INITIAL_PRICE_ANSEM_PER_BEEF (listing shape).`);
  } else {
    // Guard against fat-fingering a foreign pool via POOL env.
    if (!ps.tokenAMint.equals(beefMint) || !ps.tokenBMint.equals(ANSEM_MINT)) {
      console.error(`REFUSED: pool ${pool.toBase58()} mints (${ps.tokenAMint.toBase58()}, ${ps.tokenBMint.toBase58()}) != (BEEF, ANSEM).`);
      process.exit(1);
    }
  }

  // Liquidity for SEED_BEEF_BASE_UNITS of BEEF over [current price, max].
  const liquidityDelta = getLiquidityDeltaFromAmountA(seedBeef, ps.sqrtPrice, ps.sqrtMaxPrice, ps.collectFeeMode);
  // ANSEM the position would ALSO need, over [min, current]. Zero while the
  // pool sits at its floor price (guaranteed pre-activation — swaps blocked).
  const requiredAnsem = getAmountBFromLiquidityDelta(ps.sqrtMinPrice, ps.sqrtPrice, liquidityDelta, Rounding.Up, ps.collectFeeMode);
  if (!requiredAnsem.isZero()) {
    console.error(`REFUSED: pool price has left the floor — a full-range add now needs ${requiredAnsem.toString()} ANSEM base units too. Single-sided --add-locked-position only works while sqrt_price == sqrt_min_price (pre-activation).`);
    process.exit(1);
  }

  const positionNftKp = Keypair.generate(); // must co-sign at send time (NFT mint)
  const position = derivePositionAddress(positionNftKp.publicKey);
  const positionNftAccount = derivePositionNftAccount(positionNftKp.publicKey);

  const tx = await cpAmm.createPositionAndAddLiquidity({
    owner: payer,
    pool,
    positionNft: positionNftKp.publicKey,
    liquidityDelta,
    maxAmountTokenA: seedBeef,
    maxAmountTokenB: new BN(0),
    tokenAAmountThreshold: seedBeef,   // slippage cap: never pull more BEEF than the seed
    tokenBAmountThreshold: new BN(0),  // hard on-chain guarantee: ZERO ANSEM pulled
    tokenAMint: beefMint,
    tokenBMint: ANSEM_MINT,
    tokenAProgram: TOKEN_PROGRAM_ID,
    tokenBProgram: TOKEN_2022_PROGRAM_ID,
  });
  // Append the permanent lock -> create + add + lock are ONE atomic tx (Q4/Q6).
  const lockTx = await cpAmm.permanentLockPosition({
    owner: payer, position, positionNftAccount, pool, unlockedLiquidity: liquidityDelta,
  });
  tx.add(...lockTx.instructions);

  const now = Math.floor(Date.now() / 1000);
  const activationPoint = Number(ps.activationPoint?.toString() ?? 0);
  console.log("ADD-LOCKED-POSITION PLAN:", JSON.stringify({
    mode: REAL ? "REAL (mainnet, PERMANENT)" : "DRY-RUN (default — nothing signed or sent)",
    rpc: RPC,
    payer: payer.toBase58(),
    pool: pool.toBase58(),
    poolIsPlaceholder,
    poolActivation: poolIsPlaceholder ? "(placeholder)" : {
      activationPoint,
      activationIso: new Date(activationPoint * 1000).toISOString(),
      tradingLive: now >= activationPoint,
    },
    base: { mint: beefMint.toBase58(), decimals: beefDecimals, placeholder: beefIsPlaceholder },
    quote: { mint: ANSEM_MINT.toBase58(), decimals: ansemMintState.decimals },
    position: position.toBase58(),
    positionNftMint: positionNftKp.publicKey.toBase58(),
    positionNftAccount: positionNftAccount.toBase58(),
    deposit: {
      beefBaseUnits: seedBeef.toString(),
      beefUi: Number(seedBeef.toString()) / 10 ** beefDecimals,
      ansemRequired: requiredAnsem.toString() + " (must be 0; on-chain threshold 0 enforces it)",
      poolSqrtPriceQ64: ps.sqrtPrice.toString(),
      liquidityDeltaQ64: liquidityDelta.toString(),
    },
    permanentLock: "permanent_lock_position appended to the SAME transaction (irreversible)",
    transaction: describeTx(tx, [payer.toBase58() + " (owner/payer)", positionNftKp.publicKey.toBase58() + " (position NFT mint)"]),
  }, null, 2));

  if (SIMULATE) {
    await simulateAndPrint(tx, poolIsPlaceholder || beefIsPlaceholder
      ? "placeholder pool/mint does not exist on chain — simulation failure is EXPECTED in that case" : undefined);
  }
  if (!REAL) {
    console.log("DRY-RUN (default): nothing signed, nothing sent. Real mode needs BOTH --no-dry-run AND --i-know-what-i-am-doing, plus PAYER_WALLET + BEEF_MINT.");
    process.exit(0);
  }
  console.log("SENDING in 5s — position add + PERMANENT lock are one atomic, irreversible transaction. Ctrl-C now to abort.");
  await new Promise((r) => setTimeout(r, 5000));
  tx.feePayer = payer;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  tx.partialSign(payerKp, positionNftKp);
  const sig = await conn.sendRawTransaction(tx.serialize());
  await conn.confirmTransaction(sig, "confirmed");
  console.log("POSITION ADDED + PERMANENTLY LOCKED:", JSON.stringify({ sig, pool: pool.toBase58(), position: position.toBase58() }, null, 2));
  process.exit(0);
}

// ============================================================================
// MODE 1: pool creation (default). ACTIVATION_TS absent = trade immediately;
// set = day-0 creation with trading gated until ACTIVATION_TS (Q5–Q8).
// ============================================================================
// --- Price + single-sided liquidity (Q3): initSqrtPrice MUST equal sqrtMinPrice.
const initSqrtPrice = getSqrtPriceFromPrice(priceAnsemPerBeef, beefDecimals, ansemMintState.decimals);
const sqrtMinPrice = initSqrtPrice;
const sqrtMaxPrice = MAX_SQRT_PRICE;
const liquidityDelta = cpAmm.preparePoolCreationSingleSide({
  tokenAAmount: seedBeef,
  minSqrtPrice: sqrtMinPrice,
  maxSqrtPrice: sqrtMaxPrice,
  initSqrtPrice,
  collectFeeMode: COLLECT_FEE_MODE,
  // tokenAInfo only needed for Token-2022 transfer-fee base mints; BEEF is classic.
});

// --- Fee scheduler (Q2): high start decaying to resting fee over FEE_DECAY_SECS.
const baseFee = getBaseFeeParams(
  {
    baseFeeMode: FEE_MODE,
    feeTimeSchedulerParam: {
      startingFeeBps: FEE_START_BPS,
      endingFeeBps: FEE_END_BPS,
      numberOfPeriod: FEE_PERIODS,
      totalDuration: FEE_DECAY_SECS, // seconds, because activationType = Timestamp
    },
  },
  ansemMintState.decimals,
  ActivationType.Timestamp,
);
const poolFees = { baseFee, compoundingFeeBps: 0, padding: 0, dynamicFee: null };
// Decode back what will land on-chain (proves the encoding round-trips).
const feeHandler = getBaseFeeHandlerFromBorshData(baseFee.data);
const feeDecoded = {
  mode: FEE_MODE === BaseFeeMode.FeeTimeSchedulerLinear ? "linear" : "exponential",
  maxFeeBps: feeNumeratorToBps(feeHandler.getMaxFeeNumerator()),
  minFeeBps: feeNumeratorToBps(feeHandler.getMinFeeNumerator()),
  numberOfPeriod: feeHandler.numberOfPeriod,
  periodFrequencySecs: feeHandler.periodFrequency.toString(),
};

// --- Build the pool-create + permanent-lock transaction (Q1 + Q4).
const positionNftKp = Keypair.generate(); // must co-sign at send time (NFT mint)
const { tx, pool, position } = await cpAmm.createCustomPool({
  payer,
  creator: payer,
  positionNft: positionNftKp.publicKey,
  tokenAMint: beefMint,       // base = BEEF (classic SPL)
  tokenBMint: ANSEM_MINT,     // quote = ANSEM (Token-2022) — custom quote (Q1)
  tokenAAmount: seedBeef,
  tokenBAmount: new BN(0),    // single-sided (Q3)
  sqrtMinPrice,
  sqrtMaxPrice,
  liquidityDelta,
  initSqrtPrice,
  poolFees,
  hasAlphaVault: false,
  activationType: ActivationType.Timestamp,
  collectFeeMode: COLLECT_FEE_MODE,
  // null = active immediately (list-day creation). ACTIVATION_TS = day-0
  // creation: swaps on-chain-rejected until then (Q5), fee decay starts
  // AT activation (Q7), liquidity adds/locks allowed meanwhile (Q6).
  activationPoint: activationTs !== null ? new BN(activationTs) : null,
  tokenAProgram: TOKEN_PROGRAM_ID,
  tokenBProgram: TOKEN_2022_PROGRAM_ID,
  isLockLiquidity: true,      // PERMANENT LOCK in the same tx (Q4) — atomic, irreversible
});

// --- Print the full plan: addresses, params, instruction list.
console.log("LIST-DAY PLAN:", JSON.stringify({
  mode: REAL ? "REAL (mainnet, PERMANENT)" : "DRY-RUN (default — nothing signed or sent)",
  rpc: RPC,
  payer: payer.toBase58(),
  base: { mint: beefMint.toBase58(), program: "spl-token (classic)", decimals: beefDecimals, placeholder: beefIsPlaceholder },
  quote: { mint: ANSEM_MINT.toBase58(), program: "token-2022", decimals: ansemMintState.decimals },
  pool: pool.toBase58(),
  poolDerivationCheck: deriveCustomizablePoolAddress(beefMint, ANSEM_MINT).toBase58(),
  position: position.toBase58(),
  positionNftMint: positionNftKp.publicKey.toBase58(),
  positionNftAccount: derivePositionNftAccount(positionNftKp.publicKey).toBase58(),
  positionCheck: derivePositionAddress(positionNftKp.publicKey).toBase58(),
  tokenAVault: deriveTokenVaultAddress(beefMint, pool).toBase58(),
  tokenBVault: deriveTokenVaultAddress(ANSEM_MINT, pool).toBase58(),
  activation: activationTs !== null ? {
    activationTs,
    activationIso: new Date(activationTs * 1000).toISOString(),
    hoursAhead: Math.round((activationTs - Date.now() / 1000) / 36) / 100,
    note: "DAY-0 MODE: swaps on-chain-rejected (PoolDisabled) until then; fee decay starts AT activation; liquidity adds/locks allowed meanwhile",
  } : "immediate (trading live on creation)",
  deposit: {
    beefBaseUnits: seedBeef.toString(),
    beefUi: Number(seedBeef.toString()) / 10 ** beefDecimals,
    ansemBaseUnits: "0 (single-sided)",
    initialPriceAnsemPerBeef: priceAnsemPerBeef,
    priceRoundTrip: getPriceFromSqrtPrice(initSqrtPrice, beefDecimals, ansemMintState.decimals).toString(),
    initSqrtPriceQ64: initSqrtPrice.toString(),
    sqrtMinPriceQ64: sqrtMinPrice.toString(),
    sqrtMaxPriceQ64: sqrtMaxPrice.toString(),
    liquidityDeltaQ64: liquidityDelta.toString(),
  },
  feeScheduler: {
    requested: { startBps: FEE_START_BPS, endBps: FEE_END_BPS, periods: FEE_PERIODS, decaySecs: FEE_DECAY_SECS },
    decodedFromEncoded: feeDecoded,
    collectFeeMode: COLLECT_FEE_MODE === CollectFeeMode.OnlyB ? "OnlyB (all fees in ANSEM)" : "BothToken",
  },
  permanentLock: "isLockLiquidity=true — permanent_lock_position appended to the SAME transaction (irreversible)",
  transaction: describeTx(tx, [payer.toBase58() + " (payer/creator)", positionNftKp.publicKey.toBase58() + " (position NFT mint)"]),
}, null, 2));

if (SIMULATE) {
  await simulateAndPrint(tx, beefIsPlaceholder
    ? "placeholder BEEF mint does not exist on chain — simulation failure is EXPECTED in that case" : undefined);
}

if (!REAL) {
  console.log("DRY-RUN (default): nothing signed, nothing sent. Real mode needs BOTH --no-dry-run AND --i-know-what-i-am-doing, plus PAYER_WALLET + BEEF_MINT.");
  process.exit(0);
}

// ---- REAL MODE (LIST DAY) ----
if (beefIsPlaceholder) { console.error("REFUSED: real mode with a placeholder BEEF mint."); process.exit(1); }
console.log("SENDING in 5s — pool creation + PERMANENT lock are one atomic, irreversible transaction. Ctrl-C now to abort.");
await new Promise((r) => setTimeout(r, 5000));
tx.feePayer = payer;
tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
tx.partialSign(payerKp, positionNftKp);
const sig = await conn.sendRawTransaction(tx.serialize());
await conn.confirmTransaction(sig, "confirmed");
console.log("POOL CREATED + PERMANENTLY LOCKED:", JSON.stringify({
  sig, pool: pool.toBase58(), position: position.toBase58(),
  next: "verify on app.meteora.ag, then check Jupiter routing after indexing (day-one trades go direct on Meteora)",
}, null, 2));
