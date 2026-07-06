#!/bin/bash
# ANSEM Miner — local two-provider Ephemeral-Rollup test stack (M2a).
#
# Brings up:
#   1. base layer   : mb-test-validator (wraps solana-test-validator 4.1, and
#                     PRE-CLONES the MagicBlock programs incl. the delegation
#                     program DLP) with OUR program PRELOADED AT GENESIS.
#                     Preload (not `anchor deploy`) because anchor-cli 1.0.x
#                     emits sBPF v3, which this validator gates off at *deploy*
#                     time — but happily *executes* a v3 program loaded at genesis.
#   2. ephemeral    : ephemeral-validator (the ER), remotes -> base, listen :7799.
#   (VRF oracle is added in M2b; skipped here.)
#
# Then runs tests/ansem-miner-er.ts against both providers and tears everything
# down on exit. Mirrors magicblock-engine-examples/test-locally.sh.
#
# Env flags:
#   SKIP_BUILD=1   reuse the existing target/deploy/ansem_miner.so (skip anchor build)
#   TEST_FILE=...  override the mocha test file (default tests/ansem-miner-er.ts)
#   SETUP_ONLY=1   bring the stack up and hold until a key is pressed (manual poking)
set +m
stty sane 2>/dev/null || true

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

PROGRAM_ID="8Q9EnK7ydn6ywo7ZxeqhubqYybf7FFNNwnz8JzJjXZjz"
SO_PATH="$REPO_ROOT/target/deploy/ansem_miner.so"
WALLET="${HOME}/.config/solana/id.json"
TEST_FILE="${TEST_FILE:-tests/ansem-miner-er.ts}"
LOG_DIR="$REPO_ROOT/.er-logs"
mkdir -p "$LOG_DIR"

BASE_PID=""
ER_PID=""

cleanup() {
  trap - EXIT INT TERM
  echo ""
  printf 'Stopping validators... '
  for pid in $BASE_PID $ER_PID; do [ -n "$pid" ] && kill -TERM "$pid" 2>/dev/null || true; done
  sleep 1
  for pid in $BASE_PID $ER_PID; do [ -n "$pid" ] && kill -9 "$pid" 2>/dev/null || true; done
  # Fallback by name (mb-test-validator wraps solana-test-validator).
  pkill -f "mb-test-validator"     2>/dev/null || true
  pkill -f "solana-test-validator" 2>/dev/null || true
  pkill -f "ephemeral-validator"   2>/dev/null || true
  pkill -f "vrf-oracle"            2>/dev/null || true
  { wait 2>/dev/null || true; } 2>/dev/null
  if ! pgrep -f "solana-test-validator" >/dev/null 2>&1 \
     && ! pgrep -f "ephemeral-validator" >/dev/null 2>&1; then
    echo "✓ stopped"
  else
    echo "✗ some processes still running"
  fi
}
trap cleanup EXIT INT TERM

command -v mb-test-validator   >/dev/null 2>&1 || { echo "ERROR: mb-test-validator not on PATH (npm i -g @magicblock-labs/ephemeral-validator)"; exit 1; }
command -v ephemeral-validator >/dev/null 2>&1 || { echo "ERROR: ephemeral-validator not on PATH (npm i -g @magicblock-labs/ephemeral-validator)"; exit 1; }
[ -f "$WALLET" ] || { echo "ERROR: wallet $WALLET missing"; exit 1; }
UPGRADE_AUTH="$(solana address -k "$WALLET")"

# 1. Build (unless reusing) — produces the sBPF-v3 .so we preload at genesis.
if [ "${SKIP_BUILD:-0}" != "1" ]; then
  echo "Building program (anchor build)..."
  anchor build || { echo "ERROR: anchor build failed"; exit 1; }
fi
[ -f "$SO_PATH" ] || { echo "ERROR: $SO_PATH missing — build first or unset SKIP_BUILD"; exit 1; }

# Kill any stragglers and start the base validator with our program preloaded.
pkill -f "mb-test-validator" 2>/dev/null || true
pkill -f "solana-test-validator" 2>/dev/null || true
pkill -f "ephemeral-validator" 2>/dev/null || true
sleep 1

solana config set --url http://127.0.0.1:8899 >/dev/null 2>&1

echo "Starting base validator (mb-test-validator, program preloaded at genesis)..."
mb-test-validator --reset \
  --upgradeable-program "$PROGRAM_ID" "$SO_PATH" "$UPGRADE_AUTH" \
  > "$LOG_DIR/base.log" 2>&1 < /dev/null &
BASE_PID=$!

echo "Waiting for base RPC..."
for i in $(seq 1 40); do
  solana cluster-version --url http://127.0.0.1:8899 >/dev/null 2>&1 && break
  kill -0 $BASE_PID 2>/dev/null || { echo "base validator died:"; tail -40 "$LOG_DIR/base.log"; exit 1; }
  sleep 1
done
echo "Base ready. Funding provider wallet..."
solana airdrop 1000 "$UPGRADE_AUTH" >/dev/null 2>&1 || true

# Sanity: our program + the DLP must both be present on base.
solana program show "$PROGRAM_ID" >/dev/null 2>&1 || { echo "ERROR: our program not preloaded"; tail -40 "$LOG_DIR/base.log"; exit 1; }
solana program show DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh >/dev/null 2>&1 || { echo "ERROR: DLP not cloned by mb-test-validator"; exit 1; }

echo "Starting ephemeral-validator (ER)..."
RUST_LOG=info ephemeral-validator \
  --no-tui --lifecycle ephemeral \
  --remotes http://127.0.0.1:8899 --remotes ws://127.0.0.1:8900 \
  --listen 127.0.0.1:7799 --reset \
  > "$LOG_DIR/ephemeral.log" 2>&1 < /dev/null &
ER_PID=$!

echo "Waiting for ER RPC on :7799..."
for i in $(seq 1 60); do
  (echo > /dev/tcp/127.0.0.1/7799) 2>/dev/null && { sleep 1; break; }
  kill -0 $ER_PID 2>/dev/null || { echo "ephemeral-validator died:"; tail -60 "$LOG_DIR/ephemeral.log"; exit 1; }
  sleep 1
done
echo "ER ready."

# Env the two-provider test harness reads (matches magicblock examples).
export PROVIDER_ENDPOINT=http://127.0.0.1:8899
export WS_ENDPOINT=ws://127.0.0.1:8900
export EPHEMERAL_PROVIDER_ENDPOINT=http://127.0.0.1:7799
export EPHEMERAL_WS_ENDPOINT=ws://127.0.0.1:7800
export ANCHOR_PROVIDER_URL=$PROVIDER_ENDPOINT
export ANCHOR_WALLET=$WALLET
export VALIDATOR=mAGicPQYBMvcYveUZA5F5UNNwyHvfYh5xkLS2Fr1mev

if [ "${SETUP_ONLY:-0}" = "1" ]; then
  echo ""
  echo "SETUP_ONLY: base http://127.0.0.1:8899 | ER http://127.0.0.1:7799"
  echo "Press any key to stop..."
  if [ -r /dev/tty ]; then read -rsn1 </dev/tty; else read -rsn1; fi
  exit 0
fi

echo "Running ER test suite: $TEST_FILE"
echo ""
yarn run ts-mocha -p ./tsconfig.json -t 1000000 "$TEST_FILE"
