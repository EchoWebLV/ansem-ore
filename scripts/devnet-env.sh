#!/bin/bash
# ANSEM Miner — devnet env. `source` this before deploy-devnet.sh or the smoke.
# Single source of truth for the local->devnet delta (see M3 spec/plan). Exports the
# same env var names the ts-mocha suites already read, so the local suites become a
# devnet smoke just by pointing these at devnet infra.
# Robust across bash/zsh + sourced-or-executed: ${BASH_SOURCE[0]} is empty when
# `source`d under zsh, so derive the repo root from git (we always run inside it).
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

RPC=$(grep '^HELIUS_RPC_DEVNET=' "$REPO_ROOT/.env" | cut -d= -f2- | tr -d '"')
[ -z "$RPC" ] && { echo "ERROR: HELIUS_RPC_DEVNET missing from .env"; return 1 2>/dev/null || exit 1; }
WS=$(echo "$RPC" | sed -E 's#^https#wss#')

export DEVNET_WALLET="${DEVNET_WALLET:-$HOME/.config/solana/ansem-devnet.json}"

# L1 (base) provider — used by anchor's AnchorProvider.env().
export ANCHOR_PROVIDER_URL="$RPC"
export ANCHOR_WALLET="$DEVNET_WALLET"
export PROVIDER_ENDPOINT="$RPC"
export WS_ENDPOINT="$WS"

# ER — a SPECIFIC regional ER endpoint, NOT the router. VERIFIED: an ER write
# (stake/commit) through the router `devnet-router.magicblock.app` fails
# "Blockhash not found" (the router proxies an L1 blockhash the ER doesn't have);
# the direct regional endpoint gives a blockhash its own ER recognizes. Must match
# the region of the validator we delegate to (VALIDATOR below) — US here.
export EPHEMERAL_PROVIDER_ENDPOINT="${EPHEMERAL_PROVIDER_ENDPOINT:-https://devnet-us.magicblock.app}"
export EPHEMERAL_WS_ENDPOINT="${EPHEMERAL_WS_ENDPOINT:-wss://devnet-us.magicblock.app}"

# Delegation target (regional ER validator identity) + devnet VRF base queue.
# VALIDATOR must be the identity of the ER region we point at (US endpoint ⇒ US id).
# NOTE: the devnet base queue Cuj97gg… DIFFERS from the local queue GKE6d7… .
export VALIDATOR="${VALIDATOR:-MUS3hc9TCw4cGC12vHNoYcCGzJG1txjgQLZWVoeNHNd}"
export VRF_BASE_QUEUE="Cuj97ggrhhidhbu39TijNVqE74xvKJ69gDervRUXAxGh"

echo "devnet-env: RPC=$(echo "$RPC" | sed -E 's/api-key=.*/api-key=<masked>/') wallet=$DEVNET_WALLET validator=$VALIDATOR"
