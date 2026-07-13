#!/bin/bash
# ANSEM Miner — devnet deploy (loader-v3, resumable). Deploys the prebuilt v3 .so.
# Idempotent: re-run to resume a partial upload (persistent --buffer) or to upgrade.
set -euo pipefail
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$REPO_ROOT"
source scripts/devnet-env.sh

SO="$REPO_ROOT/target/deploy/ansem_miner.so"
PROGRAM_KP="$REPO_ROOT/target/deploy/ansem_miner-keypair.json"
BUFFER_KP="$REPO_ROOT/target/deploy/ansem_miner-buffer.json"   # persistent → resumable
PROGRAM_ID="8Q9EnK7ydn6ywo7ZxeqhubqYybf7FFNNwnz8JzJjXZjz"

# Build the DEVNET binary: sBPF v3 (loader-v3) WITH the `devnet` feature, so the mock
# `initialize`, `execute_swap_mock`, `close_config` and `set_round_cursor` migration
# tools are present for the devnet reset/soak workflow. The MAINNET binary is built
# WITHOUT this feature (its only init path is `initialize_real`) — see docs/mainnet-launch.md.
# anchor build can't pass --tools-version, so build the .so directly (v3 needs v1.54).
# Set SKIP_BUILD=1 to deploy a pre-built .so instead.
if [ -z "${SKIP_BUILD:-}" ]; then
  echo "Building sBPF-v3 devnet binary (--features devnet) ..."
  cargo build-sbf --arch v3 --tools-version v1.54 --features devnet
fi

# Pre-flight guards.
[ -f "$SO" ] || { echo "ERROR: $SO missing — run without SKIP_BUILD to build it first"; exit 1; }
LLVM_READELF=$(ls ~/.cache/solana/*/platform-tools/llvm/bin/llvm-readelf | head -1)
FLAGS=$("$LLVM_READELF" -h "$SO" | awk '/Flags/{print $2}')
[ "$FLAGS" = "0x3" ] || { echo "ERROR: .so is not sBPF v3 (Flags=$FLAGS) — rebuild with ARCH=v3"; exit 1; }
[ "$(solana-keygen pubkey "$PROGRAM_KP")" = "$PROGRAM_ID" ] || { echo "ERROR: program keypair != $PROGRAM_ID"; exit 1; }

# A persistent --buffer makes a mid-upload failure resumable: just re-run. Same
# command works for an initial deploy and an upgrade.
[ -f "$BUFFER_KP" ] || solana-keygen new --no-bip39-passphrase -s -o "$BUFFER_KP" >/dev/null

# Deploy RPC: public devnet, NOT Helius (dev key is hard rate-limited) and NOT
# --use-rpc (chunk writes via rate-limited RPC 429-spiral; TPU/QUIC lands in <45s).
DEPLOY_RPC="${DEPLOY_RPC:-https://api.devnet.solana.com}"

echo "Deploying $SO ($(stat -f%z "$SO") bytes, sBPF v3) -> $PROGRAM_ID on devnet ..."
solana program deploy "$SO" \
  --program-id "$PROGRAM_KP" \
  --buffer "$BUFFER_KP" \
  --keypair "$DEVNET_WALLET" \
  --url "$DEPLOY_RPC" \
  --with-compute-unit-price 50000 \
  --max-sign-attempts 300

echo ""
echo "Deployed. Verifying ..."
solana program show "$PROGRAM_ID" --url "$DEPLOY_RPC"
