#!/usr/bin/env bash
# ============================================================================
# _sandbox.sh — ONE-COMMAND local $BEEF rehearsal sandbox
# ============================================================================
# Boots the COMPLETE BEEF economy on a throwaway solana-test-validator so an
# operator can play the whole loop in a browser BEFORE the mainnet launch.
# Everything targets 127.0.0.1 ONLY — the script refuses to run otherwise, and
# it NEVER loads server/.env (mainnet keys).
#
# USAGE
#   scripts/_sandbox.sh            boot a FRESH sandbox (stops any prior one first)
#   scripts/_sandbox.sh --stop     tear the whole sandbox down (validator+keeper+app)
#   scripts/_sandbox.sh --status   show what is running
#
# WHAT IT DOES (fresh boot)
#   1. generates throwaway keypairs: keeper/admin (also genesis-funded + program
#      upgrade authority), a player/seeder, and the BEEF mint + vault
#   2. boots solana-test-validator -r with the devnet-feature program preloaded
#   3. mock initialize()  ->  beef-mint-create.mjs --skip-metadata  ->  _beef-launch.mjs
#      (BeefConfig + JackpotConfig(25/100) + fee 5% + 60s rounds)
#   4. starts the keeper from source (direct-L1 mode, SWAP_MODE=mock) — owns
#      createRound + finalize(swap+stamp) + the /snapshot read server
#   5. starts a local VRF settler — the localhost stand-in for the MagicBlock VRF
#      oracle: flips OPEN past-deadline rounds to SETTLED via the devnet settle()
#      ix (the bare validator has no ephemeral-VRF program, so the keeper's own
#      request_settle can never land here — see NOTE below)
#   6. starts the app dev server on :3200 pointed at the sandbox keeper + RPC
#   7. prints a banner with every address/URL + how to connect Phantom + how to stop
#
# NOTE (why a settler exists): the keeper only knows the ER/VRF settle path
# (request_settle -> ephemeral-VRF CPI). A bare local validator has no VRF
# program, so that CPI reverts ATOMICALLY (round stays OPEN, no state damage).
# The settler provides the randomness locally via the program's devnet settle()
# fallback — exactly what tests/direct-beef.ts does. On devnet/mainnet the
# MagicBlock oracle plays this role; here it is a ~40-line loop.
#
# Runtime state (keypairs, logs, ledger, pids) lives under $SANDBOX_HOME
# (default /tmp/ansem-beef-sandbox) — OUTSIDE the repo, nothing committed.
# ============================================================================
set -uo pipefail

# ---- fixed sandbox wiring (localhost only) ---------------------------------
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROGRAM_ID="8Q9EnK7ydn6ywo7ZxeqhubqYybf7FFNNwnz8JzJjXZjz"
SO="$REPO/target/deploy/ansem_miner.so"
RPC="http://127.0.0.1:8899"
# solana-test-validator serves RPC on 8899 but the PubSub WebSocket on 8900. The keeper's
# buildChain derives ws from ANCHOR_PROVIDER_URL (same port -> wrong 8899, tx confirms hang),
# so pin WS_ENDPOINT here. web3.js's own default (settler/seeder) already maps 8899 -> 8900.
RPC_WS="ws://127.0.0.1:8900"
KEEPER_URL="http://127.0.0.1:8787"
KEEPER_WS="ws://127.0.0.1:8787"
KEEPER_PORT="8787"
APP_PORT="3200"
APP_URL="http://127.0.0.1:${APP_PORT}"
ROUND_SECS="${SANDBOX_ROUND_SECS:-60}"           # launch value; keeper stamps this per round
SANDBOX_HOME="${SANDBOX_HOME:-/tmp/ansem-beef-sandbox}"
PIDS_FILE="$SANDBOX_HOME/pids"
SOLANA="solana -u $RPC"

# Keypair / log paths
KEEPER_KP="$SANDBOX_HOME/keeper.json"             # admin + treasury owner + genesis mint + upgrade auth
PLAYER_KP="$SANDBOX_HOME/player.json"             # automated seeder / player
MINT_KP="$SANDBOX_HOME/beef-mint.json"
VAULT_KP="$SANDBOX_HOME/beef-vault.json"
VALIDATOR_LOG="$SANDBOX_HOME/validator.log"
KEEPER_LOG="$SANDBOX_HOME/keeper.log"
SETTLER_LOG="$SANDBOX_HOME/settler.log"
APP_LOG="$SANDBOX_HOME/app.log"
BOOTSTRAP_MJS="$SANDBOX_HOME/bootstrap.mjs"
SETTLER_MJS="$SANDBOX_HOME/settler.mjs"

# ---- SAFETY: every endpoint must be loopback -------------------------------
assert_localhost() {
  for url in "$RPC" "$KEEPER_URL" "$KEEPER_WS" "$APP_URL"; do
    h="$(printf '%s' "$url" | sed -E 's#^[a-z]+://##; s#[:/].*$##')"
    case "$h" in
      127.0.0.1|localhost|0.0.0.0) : ;;
      *) echo "SAFETY ABORT: endpoint '$url' host '$h' is not loopback. Sandbox is 127.0.0.1 ONLY." >&2; exit 2 ;;
    esac
  done
}

# ---- process-tree kill (portable; only touches OUR recorded PIDs) ----------
kill_tree() {
  local pid="$1"
  [ -z "$pid" ] && return 0
  local c
  for c in $(pgrep -P "$pid" 2>/dev/null); do kill_tree "$c"; done
  kill -TERM "$pid" 2>/dev/null || true
}

stop_sandbox() {
  echo "[stop] tearing down sandbox ..."
  if [ -f "$PIDS_FILE" ]; then
    while IFS='=' read -r name pid; do
      [ -z "${pid:-}" ] && continue
      echo "[stop] $name (pid $pid)"
      kill_tree "$pid"
    done < "$PIDS_FILE"
    rm -f "$PIDS_FILE"
  fi
  # Belt-and-suspenders: our validator is uniquely identified by its ledger path.
  pkill -f "solana-test-validator.*$SANDBOX_HOME/test-ledger" 2>/dev/null || true
  # Our app is the only next dev on APP_PORT (the operator's other app is elsewhere).
  pkill -f "next dev -p ${APP_PORT}" 2>/dev/null || true
  sleep 1
  echo "[stop] done."
}

status_sandbox() {
  echo "SANDBOX_HOME=$SANDBOX_HOME"
  [ -f "$PIDS_FILE" ] && { echo "recorded pids:"; cat "$PIDS_FILE"; } || echo "(no pids file — not started)"
  echo "--- listeners ---"
  for pd in 8899 "$KEEPER_PORT" "$APP_PORT"; do
    if lsof -iTCP:"$pd" -sTCP:LISTEN -n >/dev/null 2>&1; then echo "port $pd: LISTENING"; else echo "port $pd: down"; fi
  done
}

wait_for() { # label, timeout_s, command...
  local label="$1"; local timeout="$2"; shift 2
  local i=0
  while [ "$i" -lt "$timeout" ]; do
    if "$@" >/dev/null 2>&1; then return 0; fi
    sleep 1; i=$((i+1))
  done
  return 1
}

# ---- argv --------------------------------------------------------------------
assert_localhost
case "${1:-}" in
  --stop)   stop_sandbox; exit 0 ;;
  --status) status_sandbox; exit 0 ;;
  "")       : ;;  # fresh boot
  *)        echo "unknown arg: $1  (use: --stop | --status | <none>)" >&2; exit 2 ;;
esac

# ============================================================================
# FRESH BOOT
# ============================================================================
echo "[boot] fresh \$BEEF sandbox — repo $REPO"
stop_sandbox                       # idempotent: kill any prior instance first
rm -rf "$SANDBOX_HOME"
mkdir -p "$SANDBOX_HOME"
# Generated .mjs helpers live here; ESM resolves bare imports from the FILE's dir,
# so give them the repo's node_modules (workspace @ansem/sdk + @solana/* + anchor).
ln -sfn "$REPO/node_modules" "$SANDBOX_HOME/node_modules"
: > "$PIDS_FILE"

# 0. program binary (build ONLY if missing — devnet feature, v3) --------------
if [ ! -f "$SO" ]; then
  echo "[boot] $SO missing — building (cargo build-sbf --arch v3 --features devnet) ..."
  ( cd "$REPO" && cargo build-sbf --arch v3 --tools-version v1.54 --features devnet ) || { echo "build failed" >&2; exit 1; }
fi
echo "[boot] program .so: $SO"

# 1. throwaway keypairs -------------------------------------------------------
for kp in "$KEEPER_KP" "$PLAYER_KP" "$MINT_KP" "$VAULT_KP"; do
  solana-keygen new --no-bip39-passphrase -s -o "$kp" --force >/dev/null 2>&1
done
KEEPER_PUB="$(solana address -k "$KEEPER_KP")"
PLAYER_PUB="$(solana address -k "$PLAYER_KP")"
BEEF_MINT="$(solana address -k "$MINT_KP")"
BEEF_VAULT="$(solana address -k "$VAULT_KP")"
echo "[boot] keeper/admin $KEEPER_PUB"
echo "[boot] player       $PLAYER_PUB"
echo "[boot] BEEF mint     $BEEF_MINT"
echo "[boot] BEEF vault    $BEEF_VAULT"

# 2. boot validator: devnet program preloaded UPGRADEABLE, keeper = genesis mint
#    + upgrade authority (matches the proven per-suite harness). -r = fresh chain.
echo "[boot] starting validator (fresh -r) ..."
( cd "$SANDBOX_HOME" && nohup solana-test-validator -r \
    --mint "$KEEPER_PUB" \
    --upgradeable-program "$PROGRAM_ID" "$SO" "$KEEPER_PUB" \
    --ledger "$SANDBOX_HOME/test-ledger" -q > "$VALIDATOR_LOG" 2>&1 & echo "validator=$!" >> "$PIDS_FILE" )
wait_for "validator" 45 $SOLANA cluster-version || { echo "validator never came up:" >&2; tail -20 "$VALIDATOR_LOG" >&2; exit 1; }
echo "[boot] validator RPC up @ $RPC"

# 3. fund the player (keeper is genesis-funded via --mint) ---------------------
$SOLANA airdrop 100 "$PLAYER_PUB" >/dev/null 2>&1 || true
$SOLANA airdrop 100 "$KEEPER_PUB" >/dev/null 2>&1 || true   # top-up (also proves faucet)
echo "[boot] airdropped player + keeper"

# 4a. bootstrap: mock initialize() (config.admin := keeper) --------------------
cat > "$BOOTSTRAP_MJS" <<'EOF'
// Generated by _sandbox.sh — mock initialize() so config.admin == keeper (localhost only).
import { Connection, Keypair } from "@solana/web3.js";
import { Wallet } from "@coral-xyz/anchor";
import { readFileSync } from "node:fs";
import { createProgram, configPda, fetchConfig, TOKEN_PROGRAM_ID } from "@ansem/sdk";
const RPC = process.env.RPC;
if (!/^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0)[:\/]/.test(RPC)) { console.error("SAFETY ABORT non-localhost RPC"); process.exit(1); }
const keeper = Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(process.env.KEEPER_WALLET, "utf8"))));
const conn = new Connection(RPC, "confirmed");
const p = createProgram(conn, new Wallet(keeper));
if (!(await conn.getAccountInfo(configPda()))) {
  const sig = await p.methods.initialize().accountsPartial({ admin: keeper.publicKey, tokenProgram: TOKEN_PROGRAM_ID }).rpc({ commitment: "confirmed" });
  console.log("mock initialize DONE ->", sig);
} else { console.log("config already exists — skip initialize"); }
const c = await fetchConfig(p, configPda());
console.log("config.admin =", c.admin, "| currentRoundId =", c.currentRoundId, "| finalized =", c.currentRoundFinalized);
EOF
echo "[boot] bootstrap: mock initialize ..."
( cd "$REPO" && RPC="$RPC" KEEPER_WALLET="$KEEPER_KP" DOTENV_CONFIG_PATH=/dev/null node "$BOOTSTRAP_MJS" ) || { echo "bootstrap failed" >&2; exit 1; }

# 4b. BEEF mint + vault + treasury ATA + authority handoff (--skip-metadata) ---
echo "[boot] beef-mint-create (--skip-metadata) ..."
( cd "$REPO" && RPC_URL="$RPC" PAYER_WALLET="$KEEPER_KP" TREASURY_WALLET="$KEEPER_PUB" \
    BEEF_NAME="Bull Stake" BEEF_SYMBOL="BEEF" BEEF_META_URI="https://ansem-miner.vercel.app/beef.json" \
    DOTENV_CONFIG_PATH=/dev/null node scripts/beef-mint-create.mjs \
    --skip-metadata --mint-keypair "$MINT_KP" --vault-keypair "$VAULT_KP" ) \
  || { echo "beef-mint-create failed" >&2; exit 1; }

# 4c. launch params: init_beef + init_jackpot_config(25/100) + fee 5% + 60s ----
echo "[boot] _beef-launch (BeefConfig + JackpotConfig + params) ..."
( cd "$REPO" && RPC="$RPC" KEEPER_WALLET="$KEEPER_KP" BEEF_MINT="$BEEF_MINT" BEEF_VAULT="$BEEF_VAULT" \
    TREASURY_WALLET="$KEEPER_PUB" DOTENV_CONFIG_PATH=/dev/null node scripts/_beef-launch.mjs ) \
  || { echo "_beef-launch failed" >&2; exit 1; }

TREASURY_ATA="$(cd "$REPO" && M="$BEEF_MINT" O="$KEEPER_PUB" node --input-type=module -e \
  'import {getAssociatedTokenAddressSync} from "@solana/spl-token"; import {PublicKey} from "@solana/web3.js"; console.log(getAssociatedTokenAddressSync(new PublicKey(process.env.M), new PublicKey(process.env.O)).toBase58());')"

# 5. keeper from source (direct-L1, mock swap). DOTENV_CONFIG_PATH=/dev/null so
#    server/.env (LIVE MAINNET KEYS) can NEVER load. Binds 127.0.0.1 (no PORT set).
echo "[boot] starting keeper (from source) ..."
( cd "$REPO" && nohup env \
    ANCHOR_PROVIDER_URL="$RPC" \
    WS_ENDPOINT="$RPC_WS" \
    DEVNET_WALLET="$KEEPER_KP" \
    SWAP_MODE=mock \
    KEEPER_DIRECT_MODE=1 \
    KEEPER_HTTP_PORT="$KEEPER_PORT" \
    KEEPER_ROUND_SECS="$ROUND_SECS" \
    KEEPER_POLL_MS=2000 \
    FLOOR_REFRESH_SECS=0 \
    DOTENV_CONFIG_PATH=/dev/null \
    pnpm -F keeper dev > "$KEEPER_LOG" 2>&1 & echo "keeper=$!" >> "$PIDS_FILE" )
wait_for "keeper" 60 curl -fsS "$KEEPER_URL/health" \
  && echo "[boot] keeper /health OK @ $KEEPER_URL" \
  || { echo "keeper never became healthy:" >&2; tail -30 "$KEEPER_LOG" >&2; exit 1; }

# 6. local VRF settler (see NOTE at top) --------------------------------------
cat > "$SETTLER_MJS" <<'EOF'
// Generated by _sandbox.sh — LOCAL VRF settler (localhost only). Flips OPEN
// past-deadline rounds with pot>0 to SETTLED via the program's devnet settle()
// fallback, providing randomness the bare validator has no ephemeral-VRF oracle
// to supply. Empty rounds are left for the keeper to cancel.
import crypto from "node:crypto";
import { Connection, Keypair } from "@solana/web3.js";
import { Wallet } from "@coral-xyz/anchor";
import { readFileSync } from "node:fs";
import { createProgram, configPda, roundPda, fetchConfig, fetchRound, settleIx, RoundState } from "@ansem/sdk";
const RPC = process.env.RPC;
if (!/^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0)[:\/]/.test(RPC)) { console.error("SAFETY ABORT non-localhost RPC"); process.exit(1); }
const keeper = Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(process.env.KEEPER_WALLET, "utf8"))));
const conn = new Connection(RPC, "confirmed");
const p = createProgram(conn, new Wallet(keeper));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const POLL = Number(process.env.SETTLER_POLL_MS || "1000");
let last = -1;
console.log("local VRF settler up | RPC", RPC, "| admin", keeper.publicKey.toBase58());
for (;;) {
  try {
    const c = await fetchConfig(p, configPda());
    const rid = c.currentRoundId;
    if (rid > 0) {
      const r = await fetchRound(p, roundPda(rid)).catch(() => null);
      const now = Math.floor(Date.now() / 1000);
      if (r && r.state === RoundState.Open && now >= r.deadlineTs && r.pot > 0n) {
        try {
          await settleIx(p, keeper.publicKey, rid, [...crypto.randomBytes(32)]).rpc({ commitment: "confirmed" });
          if (rid !== last) { console.log(`settled round ${rid} | pot ${r.pot} lamports`); last = rid; }
        } catch (e) {
          const s = String(e);
          if (!/RoundNotEnded|BadRoundState/.test(s)) console.error(`settle ${rid}:`, s.split("\n")[0]);
        }
      }
    }
  } catch { /* transient RPC — retry */ }
  await sleep(POLL);
}
EOF
echo "[boot] starting local VRF settler ..."
( cd "$REPO" && nohup env RPC="$RPC" KEEPER_WALLET="$KEEPER_KP" DOTENV_CONFIG_PATH=/dev/null \
    node "$SETTLER_MJS" > "$SETTLER_LOG" 2>&1 & echo "settler=$!" >> "$PIDS_FILE" )
echo "[boot] settler up"

# 7. app dev server on :3200, pointed at the sandbox keeper + RPC. Explicit env
#    OVERRIDES app/.env.local (verified: @next/env keeps pre-set process.env).
echo "[boot] starting app dev server on :$APP_PORT ..."
( cd "$REPO" && nohup env \
    NEXT_PUBLIC_RPC_ENDPOINT="$RPC" \
    NEXT_PUBLIC_KEEPER_HTTP="$KEEPER_URL" \
    NEXT_PUBLIC_KEEPER_WS="$KEEPER_WS" \
    pnpm -F app exec next dev -p "$APP_PORT" > "$APP_LOG" 2>&1 & echo "app=$!" >> "$PIDS_FILE" )
wait_for "app" 90 curl -fsS -o /dev/null "$APP_URL" \
  && echo "[boot] app serving @ $APP_URL" \
  || echo "[boot] app still warming up (Next compiles on first hit) — see $APP_LOG"

# ---- banner -----------------------------------------------------------------
cat <<BANNER

============================================================================
  \$BEEF LOCAL SANDBOX IS LIVE  (127.0.0.1 only — throwaway chain)
============================================================================
  App (play here) : $APP_URL
  RPC endpoint    : $RPC
  Keeper REST/WS  : $KEEPER_URL   ($KEEPER_WS)   /snapshot  /health
  Round duration  : ${ROUND_SECS}s   |   swap: mock   |   fee: 5%   |   jackpot: 1-in-25, 100x cap

  Addresses
    program        $PROGRAM_ID
    keeper/admin   $KEEPER_PUB   (also treasury owner)
    BEEF mint      $BEEF_MINT
    BEEF vault     $BEEF_VAULT
    treasury ATA   $TREASURY_ATA
    player/seeder  $PLAYER_PUB

  Connect Phantom (to play in the browser)
    1. Phantom > Settings > Developer Settings > Change Network > add a custom
       localnet RPC:  $RPC   (or pick "Localnet" if listed)
    2. Fund your Phantom wallet on this chain:
         solana airdrop 10 <YOUR_PHANTOM_PUBKEY> -u $RPC
    3. Open $APP_URL and connect the wallet. Stake a square; a live board round
       is always open (${ROUND_SECS}s). BEEF drips as rounds settle.

  Drive rounds WITHOUT a browser (automated player)
    RPC_URL=$RPC SEEDER_WALLET=$PLAYER_KP \\
      SEED_LAMPORTS_PER_ROUND=50000000 TARGET_ANSEM_BASE_UNITS=999999999999999 \\
      MAX_ROUNDS=5 node scripts/seed-jackpot-roll.mjs --live

  Logs
    validator  $VALIDATOR_LOG
    keeper     $KEEPER_LOG
    settler    $SETTLER_LOG
    app        $APP_LOG

  Stop everything :  scripts/_sandbox.sh --stop
  Status          :  scripts/_sandbox.sh --status
============================================================================
BANNER
