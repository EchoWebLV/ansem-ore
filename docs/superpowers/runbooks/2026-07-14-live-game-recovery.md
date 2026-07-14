# Mainnet Live Game Recovery Runbook

This is the production procedure for upgrading the ANSEM Miner program, deploying the keeper,
and proving one funded round end to end. Run it from the reviewed release worktree in one Bash
session. Stop at the first failed command or failed assertion.

Never paste RPC credentials, API tokens, wallet JSON, seed phrases, or private keys into this
file or deployment evidence. Evidence is limited to public keys, public URLs, hashes, deployment
IDs, slots, balances, and transaction signatures.

## Non-negotiable safety rules

- `tick_bps` and `bonus_cap_bps` stay zero during deployment and rollback.
- Base BEEF stays enabled.
- The existing 47.481502 BEEF historical vault balance, 47,481,502 base units, is the
  protected vault floor. It is never swept, burned, transferred, reassigned, or counted down
  as an operational recovery fund.
- Never run a BEEF vault or treasury sweep command during this procedure.
- Do not upgrade unless the release worktree is clean, all local verification has passed, and
  the available signer is the recorded mainnet upgrade authority.
- Do not advance from a failed check. Preserve its output, stop writes, and choose the rollback
  path only after identifying the failing layer.

## Public production facts

| Item | Value |
|---|---|
| Program | `8Q9EnK7ydn6ywo7ZxeqhubqYybf7FFNNwnz8JzJjXZjz` |
| ProgramData | `2K1sLP43GKajCgrGTgkAfvc23GVLgqY1YQwwkCGBaFvM` |
| Upgrade authority | `FP39ztVCx7FDPpou4mfPV6HyXoNVDRLEqZyvKkFgpCCM` |
| BEEF mint | `4dk28PNZpaViXXk3U1wHjwE1bpksH45gZiSh9CPz4jQN` |
| Bonus-zero transaction | `4Y3oRsyFT8LKDnkvU5KXiw49WPPfXBuZi2Ti2CE5VJfh5KgmqagDxhbsrcGctrip1usnxJ65Ht7Cr75MtCna9ppM` |
| Railway target | `ansem-keeper / production / keeper` |
| Required keeper duration | `KEEPER_ROUND_SECS=60` |
| Protected BEEF vault floor | `47.481502 BEEF` (`47481502` base units) |

## 1. Session bootstrap

Use a private shell history policy appropriate for the operator machine. Set secret-bearing
values only in the shell. `MAINNET_RPC` is an HTTPS mainnet RPC URL, and both wallet variables
are local keypair paths or supported remote-signer URLs. Keep `EVIDENCE_DIR` outside the release
worktree so evidence collection cannot invalidate the clean-source gate.

```bash
set -euo pipefail

export PROGRAM_ID=8Q9EnK7ydn6ywo7ZxeqhubqYybf7FFNNwnz8JzJjXZjz
export PROGRAMDATA_ID=2K1sLP43GKajCgrGTgkAfvc23GVLgqY1YQwwkCGBaFvM
export EXPECTED_UPGRADE_AUTHORITY=FP39ztVCx7FDPpou4mfPV6HyXoNVDRLEqZyvKkFgpCCM
export EXPECTED_KEEPER_ADMIN=5grN1um11z51nvrkkbwo8vLW7K9HiSssLVsPdup4yu1o
export BEEF_MINT=4dk28PNZpaViXXk3U1wHjwE1bpksH45gZiSh9CPz4jQN
export BONUS_ZERO_SIGNATURE=4Y3oRsyFT8LKDnkvU5KXiw49WPPfXBuZi2Ti2CE5VJfh5KgmqagDxhbsrcGctrip1usnxJ65Ht7Cr75MtCna9ppM
export BEEF_PROTECTED_VAULT_FLOOR_BASE_UNITS=47481502
export RAILWAY_PROJECT=ansem-keeper
export RAILWAY_ENVIRONMENT=production
export RAILWAY_SERVICE=keeper
export EVIDENCE_DIR="${EVIDENCE_DIR:-/tmp/ansem-live-game-recovery}"
export NEW_PROGRAM_SO="$PWD/target/deploy/ansem_miner.so"
export PREVIOUS_PROGRAM_SO="$EVIDENCE_DIR/ansem-miner-before.so"

: "${MAINNET_RPC:?MAINNET_RPC must be an HTTPS mainnet RPC URL}"
: "${UPGRADE_KEYPAIR:?UPGRADE_KEYPAIR must identify the available upgrade signer}"
case "$EVIDENCE_DIR/" in
  ("$PWD"/*) echo "EVIDENCE_DIR must be outside the release worktree" >&2; exit 1 ;;
esac
mkdir -p "$EVIDENCE_DIR"

test "$(solana genesis-hash --url "$MAINNET_RPC")" = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"
solana --version
anchor --version
node --version
pnpm --version
railway --version
```

## 2. Release source and clean-worktree gate

Task 11 produces and verifies the program binary and prebuilt SDK before this gate. Its required
order is `anchor build -- --features devnet`, `pnpm run sdk:sync-idl`, then the applicable SDK
compile, tests, and build. After those pass, run the final default-mainnet `anchor build` last and
do not sync or build the SDK again. The committed SDK IDL remains the verified devnet IDL while
`target/deploy/ansem_miner.so` is the final mainnet binary. Known pre-existing `cargo fmt` or
app-test exceptions must be named in the Task 11 report with their exact failing commands and
scope. They do not authorize a new source-formatting or app-test regression. Do not run an Anchor
build or IDL-syncing SDK build after entering the clean release procedure below.

```bash
export RELEASE_COMMIT="$(git rev-parse HEAD)"
export RELEASE_BRANCH="$(git branch --show-current)"
test "$RELEASE_BRANCH" = "codex/live-game-recovery"
test -z "$(git status --porcelain)"
git show --no-patch --format='commit=%H%ncommitted_at=%cI%nsubject=%s' "$RELEASE_COMMIT" \
  | tee "$EVIDENCE_DIR/source.txt"
git log --oneline --decorate -14 | tee "$EVIDENCE_DIR/release-log.txt"
```

Record:

- Source commit:
- Source branch:
- Clean worktree confirmed at UTC:
- Verification report or review reference:
- Solana CLI version:
- Anchor CLI version:
- Node version:
- pnpm version:

## 3. Program identity, authority, and signer gate

Read the live loader state and assert every fixed identity before using a signer.

```bash
solana program show "$PROGRAM_ID" --url "$MAINNET_RPC" --commitment finalized --output json \
  | tee "$EVIDENCE_DIR/program-before.json"

PROGRAM_ID="$PROGRAM_ID" PROGRAMDATA_ID="$PROGRAMDATA_ID" \
EXPECTED_UPGRADE_AUTHORITY="$EXPECTED_UPGRADE_AUTHORITY" \
node --input-type=module <<'NODE'
import { readFileSync } from "node:fs";
const p = JSON.parse(readFileSync(`${process.env.EVIDENCE_DIR}/program-before.json`, "utf8"));
const expected = {
  programId: process.env.PROGRAM_ID,
  programdataAddress: process.env.PROGRAMDATA_ID,
  authority: process.env.EXPECTED_UPGRADE_AUTHORITY,
};
for (const [field, value] of Object.entries(expected)) {
  if (p[field] !== value) throw new Error(`${field} mismatch: ${p[field]} != ${value}`);
}
if (p.owner !== "BPFLoaderUpgradeab1e11111111111111111111111") {
  throw new Error(`unexpected program owner ${p.owner}`);
}
console.log(JSON.stringify(p, null, 2));
NODE

test "$(solana address --keypair "$UPGRADE_KEYPAIR")" = "$EXPECTED_UPGRADE_AUTHORITY"
solana balance "$EXPECTED_UPGRADE_AUTHORITY" --lamports \
  --url "$MAINNET_RPC" --commitment finalized

test -s packages/sdk/dist/index.js
node --input-type=module -e 'await import("@ansem/sdk")'
RPC="$MAINNET_RPC" EXPECTED_KEEPER_ADMIN="$EXPECTED_KEEPER_ADMIN" \
node --input-type=module <<'NODE' | tee "$EVIDENCE_DIR/config-admin-preflight.json"
import { Connection, Keypair } from "@solana/web3.js";
import { Wallet } from "@coral-xyz/anchor";
import { createProgram, configPda, fetchConfig } from "@ansem/sdk";
const conn = new Connection(process.env.RPC, "finalized");
const program = createProgram(conn, new Wallet(Keypair.generate()));
const config = await fetchConfig(program, configPda());
if (config.admin !== process.env.EXPECTED_KEEPER_ADMIN) {
  throw new Error(`Config admin mismatch: ${config.admin}`);
}
console.log(JSON.stringify({ config: configPda().toBase58(), admin: config.admin }, null, 2));
NODE

export SWAP_RENT_RESERVE_LAMPORTS=890880
export KEEPER_FEE_MARGIN_LAMPORTS=50000000
export MINIMUM_KEEPER_BALANCE_LAMPORTS="$((
  SWAP_RENT_RESERVE_LAMPORTS + KEEPER_FEE_MARGIN_LAMPORTS
))"
export KEEPER_BALANCE_LAMPORTS="$(solana balance "$EXPECTED_KEEPER_ADMIN" \
  --lamports --url "$MAINNET_RPC" --commitment finalized \
  | awk 'NF >= 1 { value=$1 } END { if (value == "") exit 1; print value }')"
case "$KEEPER_BALANCE_LAMPORTS:$MINIMUM_KEEPER_BALANCE_LAMPORTS" in
  (*[!0-9:]*|:*|*:|*::*) echo "Could not parse keeper lamport amounts" >&2; exit 1 ;;
esac
test "$KEEPER_BALANCE_LAMPORTS" -ge "$MINIMUM_KEEPER_BALANCE_LAMPORTS"
{
  printf 'keeper_admin=%s\n' "$EXPECTED_KEEPER_ADMIN"
  printf 'swap_rent_reserve_lamports=%s\n' "$SWAP_RENT_RESERVE_LAMPORTS"
  printf 'keeper_fee_margin_lamports=%s\n' "$KEEPER_FEE_MARGIN_LAMPORTS"
  printf 'minimum_keeper_balance_lamports=%s\n' "$MINIMUM_KEEPER_BALANCE_LAMPORTS"
  printf 'keeper_balance_lamports=%s\n' "$KEEPER_BALANCE_LAMPORTS"
} | tee "$EVIDENCE_DIR/keeper-funding-gate.txt"
```

Record:

- Observed program ID:
- Observed ProgramData address:
- Observed loader owner:
- Observed upgrade authority:
- Available signer public key:
- Program last deploy slot before recovery:
- Upgrade signer balance before recovery, lamports:
- Live Config admin: `5grN1um11z51nvrkkbwo8vLW7K9HiSssLVsPdup4yu1o`
- Config admin equality confirmed:
- Swap rent reserve charged to keeper admin, lamports: `890880`
- Keeper transaction-fee margin, lamports: `50000000`
- Minimum keeper-admin balance, lamports: `50890880`
- Observed keeper-admin balance, lamports:
- Authority match confirmed at UTC:

## 4. Live BEEF readback and protected-vault gate

Define a read-only accounting command. It uses a throwaway in-memory wallet only to construct an
Anchor provider. It does not sign or send a transaction.

```bash
read_beef_state() {
  local output="$1"
  RPC="$MAINNET_RPC" BEEF_MINT="$BEEF_MINT" \
  BEEF_PROTECTED_VAULT_FLOOR_BASE_UNITS="$BEEF_PROTECTED_VAULT_FLOOR_BASE_UNITS" \
  PROOF_WALLET_PUBKEY="${PROOF_WALLET_PUBKEY:-}" \
  node --input-type=module <<'NODE' | tee "$output"
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { Wallet } from "@coral-xyz/anchor";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  createProgram, beefConfigPda, beefMinerPda, fetchBeefConfig,
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID,
} from "@ansem/sdk";

const conn = new Connection(process.env.RPC, "finalized");
const program = createProgram(conn, new Wallet(Keypair.generate()));
const beef = await fetchBeefConfig(program, beefConfigPda());
if (beef.beefMint !== process.env.BEEF_MINT) {
  throw new Error(`BEEF mint mismatch: ${beef.beefMint}`);
}
if (beef.tickBps !== 0 || beef.bonusCapBps !== 0) {
  throw new Error(`bonus is not zero: tick=${beef.tickBps} cap=${beef.bonusCapBps}`);
}
const mint = new PublicKey(beef.beefMint);
const mintInfo = await conn.getAccountInfo(mint, "finalized");
if (!mintInfo) throw new Error("BEEF mint account is absent");
let tokenProgram;
if (mintInfo.owner.equals(TOKEN_PROGRAM_ID)) tokenProgram = TOKEN_PROGRAM_ID;
else if (mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID)) tokenProgram = TOKEN_2022_PROGRAM_ID;
else throw new Error(`BEEF mint has unsupported owner ${mintInfo.owner.toBase58()}`);
const tokenAmount = async (address) =>
  BigInt((await conn.getTokenAccountBalance(new PublicKey(address), "finalized")).value.amount);
const supply = BigInt((await conn.getTokenSupply(mint, "finalized")).value.amount);
const vault = await tokenAmount(beef.beefVault);
const treasury = await tokenAmount(beef.beefTreasury);
const totalOwed = BigInt(beef.totalOwed);
const protectedVaultFloor = BigInt(process.env.BEEF_PROTECTED_VAULT_FLOOR_BASE_UNITS);
if (vault < totalOwed) throw new Error(`BEEF undercollateralized: ${vault} < ${totalOwed}`);
if (vault < protectedVaultFloor) {
  throw new Error(`protected vault floor breached: ${vault} < ${protectedVaultFloor}`);
}
let playerBalance = null;
let playerAta = null;
let beefMiner = null;
let minerUnclaimed = null;
if (process.env.PROOF_WALLET_PUBKEY) {
  const wallet = new PublicKey(process.env.PROOF_WALLET_PUBKEY);
  playerAta = getAssociatedTokenAddressSync(
    mint, wallet, false, tokenProgram,
  );
  playerBalance = BigInt(
    (await conn.getTokenAccountBalance(playerAta, "finalized").catch(() => ({ value: { amount: "0" } })))
      .value.amount,
  );
  const minerPda = beefMinerPda(wallet);
  const miner = await program.account.beefMiner.fetchNullable(minerPda);
  beefMiner = minerPda.toBase58();
  minerUnclaimed = miner ? BigInt(miner.unclaimed.toString()) : 0n;
}
console.log(JSON.stringify({
  beefConfig: beefConfigPda().toBase58(), beefMint: beef.beefMint,
  beefVault: beef.beefVault, beefTreasury: beef.beefTreasury,
  tokenProgram: tokenProgram.toBase58(), tickBps: beef.tickBps,
  bonusCapBps: beef.bonusCapBps, mintedTotal: beef.mintedTotal.toString(),
  totalOwed: totalOwed.toString(), supply: supply.toString(),
  vault: vault.toString(), treasury: treasury.toString(),
  protectedVaultFloor: protectedVaultFloor.toString(),
  playerAta: playerAta?.toBase58() ?? null,
  playerBalance: playerBalance?.toString() ?? null,
  beefMiner,
  minerUnclaimed: minerUnclaimed?.toString() ?? null,
}, null, 2));
NODE
}

test -s packages/sdk/dist/index.js
node --input-type=module -e 'await import("@ansem/sdk")'
solana confirm "$BONUS_ZERO_SIGNATURE" --url "$MAINNET_RPC" --commitment finalized --verbose \
  | tee "$EVIDENCE_DIR/bonus-zero-confirmation.txt"
read_beef_state "$EVIDENCE_DIR/beef-preflight.json"
```

Record:

- Bonus-zero signature: `4Y3oRsyFT8LKDnkvU5KXiw49WPPfXBuZi2Ti2CE5VJfh5KgmqagDxhbsrcGctrip1usnxJ65Ht7Cr75MtCna9ppM`
- Readback `tick_bps`: `0`
- Readback `bonus_cap_bps`: `0`
- BEEF config address:
- BEEF vault address:
- BEEF treasury address:
- `minted_total` before deployment:
- `total_owed` before deployment:
- Mint supply before deployment:
- Vault balance before deployment:
- Treasury balance before deployment:
- Protected vault floor, base units: `47481502`
- Vault balance at or above protected floor confirmed at UTC:

## 5. Hash the verified build and retain the rollback binary

Run the full Task 11 verification before the clean gate in Section 2. Use its final default-mainnet
binary and prebuilt SDK without rebuilding or syncing generated files here. Hash the exact file
that will be deployed, and dump the current deployed bytes before any write.
The upgradeable loader's ProgramData account adds a 45-byte metadata header. The balance gate
therefore funds one temporary program buffer plus only the positive ProgramData rent-extension
shortfall and a 0.05 SOL deployment fee margin. The keeper admin, not the upgrade authority,
carries the separate swap rent reserve checked in Section 3.

```bash
test -s "$NEW_PROGRAM_SO"

solana program dump "$PROGRAM_ID" "$PREVIOUS_PROGRAM_SO" \
  --url "$MAINNET_RPC" --commitment finalized
export PREVIOUS_PROGRAM_HASH="$(shasum -a 256 "$PREVIOUS_PROGRAM_SO" | awk '{print $1}')"
export NEW_PROGRAM_HASH="$(shasum -a 256 "$NEW_PROGRAM_SO" | awk '{print $1}')"
test "$PREVIOUS_PROGRAM_HASH" != "$NEW_PROGRAM_HASH"

export PROGRAM_BYTES="$(wc -c < "$NEW_PROGRAM_SO" | tr -d ' ')"
case "$PROGRAM_BYTES" in
  (*[!0-9]*|'') echo "Could not parse program byte length" >&2; exit 1 ;;
esac
export PROGRAMDATA_METADATA_BYTES=45
export BUFFER_RENT_LAMPORTS="$(
  solana rent "$PROGRAM_BYTES" --lamports --url "$MAINNET_RPC" \
    | awk 'NF >= 2 { value=$(NF-1) } END { if (value == "") exit 1; print value }'
)"
export PROGRAMDATA_REQUIRED_RENT_LAMPORTS="$(
  solana rent "$((PROGRAM_BYTES + PROGRAMDATA_METADATA_BYTES))" \
    --lamports --url "$MAINNET_RPC" \
    | awk 'NF >= 2 { value=$(NF-1) } END { if (value == "") exit 1; print value }'
)"
export CURRENT_PROGRAMDATA_LAMPORTS="$(node -e '
const { readFileSync } = require("node:fs");
const p = JSON.parse(readFileSync(`${process.env.EVIDENCE_DIR}/program-before.json`, "utf8"));
if (!Number.isSafeInteger(p.lamports) || p.lamports < 0) process.exit(1);
process.stdout.write(String(p.lamports));
')"
export SIGNER_BALANCE_LAMPORTS="$(solana balance "$EXPECTED_UPGRADE_AUTHORITY" \
  --lamports --url "$MAINNET_RPC" --commitment finalized \
  | awk 'NF >= 1 { value=$1 } END { if (value == "") exit 1; print value }')"
case "$BUFFER_RENT_LAMPORTS:$PROGRAMDATA_REQUIRED_RENT_LAMPORTS:$CURRENT_PROGRAMDATA_LAMPORTS:$SIGNER_BALANCE_LAMPORTS" in
  (*[!0-9:]*|:*|*:|*::*) echo "Could not parse lamport amounts" >&2; exit 1 ;;
esac
if test "$PROGRAMDATA_REQUIRED_RENT_LAMPORTS" -gt "$CURRENT_PROGRAMDATA_LAMPORTS"; then
  export PROGRAMDATA_EXTENSION_SHORTFALL_LAMPORTS="$((
    PROGRAMDATA_REQUIRED_RENT_LAMPORTS - CURRENT_PROGRAMDATA_LAMPORTS
  ))"
else
  export PROGRAMDATA_EXTENSION_SHORTFALL_LAMPORTS=0
fi
export DEPLOY_FEE_MARGIN_LAMPORTS=50000000
export MINIMUM_OPERATOR_BALANCE_LAMPORTS="$((
  BUFFER_RENT_LAMPORTS + PROGRAMDATA_EXTENSION_SHORTFALL_LAMPORTS +
  DEPLOY_FEE_MARGIN_LAMPORTS
))"
test "$SIGNER_BALANCE_LAMPORTS" -ge "$MINIMUM_OPERATOR_BALANCE_LAMPORTS"

{
  printf 'program_bytes=%s\n' "$PROGRAM_BYTES"
  printf 'buffer_rent_lamports=%s\n' "$BUFFER_RENT_LAMPORTS"
  printf 'programdata_required_rent_lamports=%s\n' "$PROGRAMDATA_REQUIRED_RENT_LAMPORTS"
  printf 'current_programdata_lamports=%s\n' "$CURRENT_PROGRAMDATA_LAMPORTS"
  printf 'programdata_extension_shortfall_lamports=%s\n' "$PROGRAMDATA_EXTENSION_SHORTFALL_LAMPORTS"
  printf 'deploy_fee_margin_lamports=%s\n' "$DEPLOY_FEE_MARGIN_LAMPORTS"
  printf 'minimum_operator_balance_lamports=%s\n' "$MINIMUM_OPERATOR_BALANCE_LAMPORTS"
  printf 'signer_balance_lamports=%s\n' "$SIGNER_BALANCE_LAMPORTS"
} | tee "$EVIDENCE_DIR/funding-gate.txt"

printf '%s  %s\n' "$PREVIOUS_PROGRAM_HASH" "$PREVIOUS_PROGRAM_SO" \
  | tee "$EVIDENCE_DIR/program-before.sha256"
printf '%s  %s\n' "$NEW_PROGRAM_HASH" "$NEW_PROGRAM_SO" \
  | tee "$EVIDENCE_DIR/program-release.sha256"
```

Record:

- Task 11 final build command: default-mainnet `anchor build`
- Release artifact path: `target/deploy/ansem_miner.so`
- Release artifact byte length:
- ProgramData metadata overhead, bytes: `45`
- Deterministic release SHA-256:
- Current deployed SHA-256 before upgrade:
- Previous binary retained at:
- Buffer rent estimate, lamports:
- Required ProgramData rent for release bytes, lamports:
- Current ProgramData balance, lamports:
- ProgramData rent-extension shortfall, lamports:
- Deployment fee margin, lamports: `50000000`
- Minimum operator balance gate, lamports:
- Observed signer balance, lamports:
- Local verification summary:
- Independent review result:

## 6. Stop the old keeper, then upgrade and verify the program

This section mutates production. Link to the exact Railway target, capture the old deployment ID
for evidence only, stop it, and prove it is stopped before any program write. The old image must
remain down throughout the upgrade. Its recorded deployment ID is never an approved rollback
target.

```bash
: "${KEEPER_BASE_URL:?KEEPER_BASE_URL must be the public HTTPS keeper origin}"
railway whoami
railway link --project "$RAILWAY_PROJECT" \
  --environment "$RAILWAY_ENVIRONMENT" \
  --service "$RAILWAY_SERVICE"
railway status --json | tee "$EVIDENCE_DIR/railway-before.json"

railway_active_deployment_id() {
  railway status --json | node -e '
let s=""; process.stdin.on("data", d => s += d); process.stdin.on("end", () => {
  const j = JSON.parse(s);
  const environment = j.environments.edges.map(e => e.node)
    .find(n => n.name === process.env.RAILWAY_ENVIRONMENT);
  const service = j.services.edges.map(e => e.node)
    .find(n => n.name === process.env.RAILWAY_SERVICE);
  const deployment = service?.serviceInstances.edges.map(e => e.node)
    .find(n => n.environmentId === environment?.id)?.latestDeployment;
  if (!deployment?.id || deployment.status === "REMOVED") process.exit(1);
  process.stdout.write(deployment.id);
});'
}

export PREVIOUS_KEEPER_DEPLOYMENT_ID="$(railway_active_deployment_id)"
test -n "$PREVIOUS_KEEPER_DEPLOYMENT_ID"

# Immediate clean gate before stopping production.
test -z "$(git status --porcelain)"
railway down --yes --service "$RAILWAY_SERVICE" --environment "$RAILWAY_ENVIRONMENT"
export KEEPER_STOP_CONFIRMED=0
for attempt in $(seq 1 30); do
  if ! railway_active_deployment_id >/dev/null 2>&1; then
    export KEEPER_STOP_CONFIRMED=1
    break
  fi
  sleep 2
done
test "$KEEPER_STOP_CONFIRMED" = 1
if curl --fail --silent --show-error "$KEEPER_BASE_URL/health" >/dev/null 2>&1; then
  echo "Keeper health endpoint still responds after railway down" >&2
  exit 1
fi

# Immediate clean and stopped gates before the program write.
test -z "$(git status --porcelain)"
if railway_active_deployment_id >/dev/null 2>&1; then
  echo "Keeper restarted before program deploy" >&2
  exit 1
fi
solana program deploy "$NEW_PROGRAM_SO" \
  --program-id "$PROGRAM_ID" \
  --upgrade-authority "$UPGRADE_KEYPAIR" \
  --fee-payer "$UPGRADE_KEYPAIR" \
  --url "$MAINNET_RPC" \
  --commitment finalized \
  --use-rpc \
  --max-sign-attempts 60 \
  --output json \
  | tee "$EVIDENCE_DIR/program-upgrade.json"

solana program show "$PROGRAM_ID" --url "$MAINNET_RPC" --commitment finalized --output json \
  | tee "$EVIDENCE_DIR/program-after.json"
PROGRAM_ID="$PROGRAM_ID" PROGRAMDATA_ID="$PROGRAMDATA_ID" \
EXPECTED_UPGRADE_AUTHORITY="$EXPECTED_UPGRADE_AUTHORITY" \
node --input-type=module <<'NODE'
import { readFileSync } from "node:fs";
const p = JSON.parse(readFileSync(`${process.env.EVIDENCE_DIR}/program-after.json`, "utf8"));
if (p.programId !== process.env.PROGRAM_ID) throw new Error(`program ID changed: ${p.programId}`);
if (p.programdataAddress !== process.env.PROGRAMDATA_ID) {
  throw new Error(`ProgramData changed: ${p.programdataAddress}`);
}
if (p.authority !== process.env.EXPECTED_UPGRADE_AUTHORITY) {
  throw new Error(`upgrade authority changed: ${p.authority}`);
}
console.log(JSON.stringify({
  programId: p.programId, programdataAddress: p.programdataAddress,
  authority: p.authority, lastDeploySlot: p.lastDeploySlot,
}, null, 2));
NODE
solana program dump "$PROGRAM_ID" "$EVIDENCE_DIR/ansem-miner-after.so" \
  --url "$MAINNET_RPC" --commitment finalized
export DEPLOYED_PROGRAM_HASH="$(shasum -a 256 "$EVIDENCE_DIR/ansem-miner-after.so" | awk '{print $1}')"
test "$DEPLOYED_PROGRAM_HASH" = "$NEW_PROGRAM_HASH"
read_beef_state "$EVIDENCE_DIR/beef-after-program-upgrade.json"
if railway_active_deployment_id >/dev/null 2>&1; then
  echo "Old keeper restarted during program verification" >&2
  exit 1
fi
```

Record:

- Previous keeper deployment ID, forensic reference only:
- Old keeper stopped and health endpoint unavailable at UTC:
- Program upgrade UTC:
- Program upgrade signature:
- Program last deploy slot after recovery:
- Local release SHA-256:
- Deployed program SHA-256:
- Hash equality confirmed:
- Upgrade authority after deployment:
- Bonus-zero readback after deployment:
- Protected vault floor and balance readback after deployment:
- Old keeper remained stopped through program verification:

## 7. Deploy the reviewed recovery keeper at 300 seconds, then 60 seconds

The linked production service must still hold its existing `KEEPER_ROUND_SECS=300` value. Upload
the reviewed recovery source with that value first. Only after the new deployment is distinct,
healthy, and serving a valid snapshot may the operator set 60 seconds and upload the same clean
reviewed source again. Never start the recorded old image.

```bash
railway variables --json --service "$RAILWAY_SERVICE" --environment "$RAILWAY_ENVIRONMENT" \
  | node -e '
let s=""; process.stdin.on("data", d => s += d); process.stdin.on("end", () => {
  const v = JSON.parse(s);
  if (v.KEEPER_ROUND_SECS !== "300") throw new Error("existing KEEPER_ROUND_SECS is not 300");
  console.log("KEEPER_ROUND_SECS=300");
});'
if railway_active_deployment_id >/dev/null 2>&1; then
  echo "A keeper is active before the reviewed recovery upload" >&2
  exit 1
fi
test -z "$(git status --porcelain)"
railway up --ci --service "$RAILWAY_SERVICE" --environment "$RAILWAY_ENVIRONMENT"

export RECOVERY_300_DEPLOYMENT_ID="$(railway_active_deployment_id)"
test -n "$RECOVERY_300_DEPLOYMENT_ID"
test "$RECOVERY_300_DEPLOYMENT_ID" != "$PREVIOUS_KEEPER_DEPLOYMENT_ID"
railway logs "$RECOVERY_300_DEPLOYMENT_ID" --deployment \
  --service "$RAILWAY_SERVICE" --environment "$RAILWAY_ENVIRONMENT" \
  | tee "$EVIDENCE_DIR/keeper-recovery-300.log"
curl --fail --silent --show-error "$KEEPER_BASE_URL/health" \
  | tee "$EVIDENCE_DIR/keeper-health-300.txt" | grep -Fx ok
curl --fail --silent --show-error "$KEEPER_BASE_URL/snapshot" \
  | tee "$EVIDENCE_DIR/keeper-snapshot-300.json" \
  | node -e '
let s=""; process.stdin.on("data", d => s += d); process.stdin.on("end", () => {
  const x = JSON.parse(s);
  for (const k of ["roundId", "state", "deadlineTs", "updatedAt"]) {
    if (!(k in x)) throw new Error(`snapshot missing ${k}`);
  }
  console.log(JSON.stringify(x));
});'

railway variables --set "KEEPER_ROUND_SECS=60" \
  --service "$RAILWAY_SERVICE" --environment "$RAILWAY_ENVIRONMENT"
railway variables --json --service "$RAILWAY_SERVICE" --environment "$RAILWAY_ENVIRONMENT" \
  | node -e '
let s=""; process.stdin.on("data", d => s += d); process.stdin.on("end", () => {
  const v = JSON.parse(s);
  if (v.KEEPER_ROUND_SECS !== "60") throw new Error("KEEPER_ROUND_SECS is not 60");
  console.log("KEEPER_ROUND_SECS=60");
});'
test -z "$(git status --porcelain)"
railway up --ci --service "$RAILWAY_SERVICE" --environment "$RAILWAY_ENVIRONMENT"

railway status --json | tee "$EVIDENCE_DIR/railway-after.json"
export KEEPER_DEPLOYMENT_ID="$(railway_active_deployment_id)"
test -n "$KEEPER_DEPLOYMENT_ID"
test "$KEEPER_DEPLOYMENT_ID" != "$PREVIOUS_KEEPER_DEPLOYMENT_ID"
test "$KEEPER_DEPLOYMENT_ID" != "$RECOVERY_300_DEPLOYMENT_ID"
railway logs "$KEEPER_DEPLOYMENT_ID" --deployment \
  --service "$RAILWAY_SERVICE" --environment "$RAILWAY_ENVIRONMENT" \
  | tee "$EVIDENCE_DIR/keeper-deployment-60.log"
curl --fail --silent --show-error "$KEEPER_BASE_URL/health" \
  | tee "$EVIDENCE_DIR/keeper-health-60.txt" | grep -Fx ok
curl --fail --silent --show-error "$KEEPER_BASE_URL/snapshot" \
  | tee "$EVIDENCE_DIR/keeper-snapshot-60.json" \
  | node -e '
let s=""; process.stdin.on("data", d => s += d); process.stdin.on("end", () => {
  const x = JSON.parse(s);
  for (const k of ["roundId", "state", "deadlineTs", "updatedAt"]) {
    if (!(k in x)) throw new Error(`snapshot missing ${k}`);
  }
  console.log(JSON.stringify({roundId:x.roundId,state:x.state,deadlineTs:x.deadlineTs,updatedAt:x.updatedAt}));
});'
```

Record:

- Railway project: `ansem-keeper`
- Railway environment: `production`
- Railway service: `keeper`
- Previous keeper deployment ID, never restarted:
- Recovery keeper 300-second deployment ID:
- Recovery keeper 300-second health and snapshot verified at UTC:
- Final recovery keeper 60-second deployment ID:
- Keeper release commit:
- `KEEPER_ROUND_SECS` final readback: `60`
- Final keeper deployment UTC:
- Keeper health URL and response:
- Keeper snapshot URL:
- Snapshot round ID, state, deadline, and updated timestamp:

## 8. Controlled funded-round proof

Use a dedicated, funded proof wallet with no unrelated pending BEEF entitlement. Its keypair stays
local. The existing seeder submits exactly one minimum stake when `MAX_ROUNDS=1`, waits for the
keeper swap and stamp, and rolls the stamped BEEF before it exits.

```bash
: "${CONTROLLED_WALLET:?CONTROLLED_WALLET must identify the approved proof wallet}"
export PROOF_WALLET_PUBKEY="$(solana address --keypair "$CONTROLLED_WALLET")"
export PROOF_START_SLOT="$(solana slot --url "$MAINNET_RPC" --commitment finalized)"
read_beef_state "$EVIDENCE_DIR/beef-before-proof.json"
node -e '
const { readFileSync } = require("node:fs");
const x = JSON.parse(readFileSync(`${process.env.EVIDENCE_DIR}/beef-before-proof.json`, "utf8"));
if (x.minerUnclaimed !== "0") throw new Error(`proof wallet has prior unclaimed BEEF: ${x.minerUnclaimed}`);
console.log(`proof wallet starts with zero unclaimed BEEF at ${x.beefMiner}`);
'

read -r SEED_LAMPORTS_PER_ROUND CURRENT_ROLLOVER < <(
  RPC="$MAINNET_RPC" node --input-type=module <<'NODE'
import { Connection, Keypair } from "@solana/web3.js";
import { Wallet } from "@coral-xyz/anchor";
import { createProgram, configPda, fetchConfig } from "@ansem/sdk";
const conn = new Connection(process.env.RPC, "finalized");
const program = createProgram(conn, new Wallet(Keypair.generate()));
const c = await fetchConfig(program, configPda());
process.stdout.write(`${c.minStake} ${c.rolloverJackpot}`);
NODE
)
export SEED_LAMPORTS_PER_ROUND
export TARGET_ANSEM_BASE_UNITS="$(node -e 'process.stdout.write((BigInt(process.argv[1]) + 1n).toString())' \
  "$CURRENT_ROLLOVER")"
export MAX_ROUNDS=1

RPC_URL="$MAINNET_RPC" SEEDER_WALLET="$CONTROLLED_WALLET" \
SEED_LAMPORTS_PER_ROUND="$SEED_LAMPORTS_PER_ROUND" \
TARGET_ANSEM_BASE_UNITS="$TARGET_ANSEM_BASE_UNITS" MAX_ROUNDS="$MAX_ROUNDS" \
node scripts/seed-jackpot-roll.mjs --live | tee "$EVIDENCE_DIR/proof-stake-and-roll.log"
```

Claim the rolled BEEF and print the exact claim signature and amount received.

```bash
RPC="$MAINNET_RPC" PLAYER_WALLET="$CONTROLLED_WALLET" node --input-type=module <<'NODE' \
  | tee "$EVIDENCE_DIR/proof-claim.json"
import { readFileSync } from "node:fs";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { Wallet } from "@coral-xyz/anchor";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  createProgram, beefConfigPda, beefMinerPda, fetchBeefConfig, claimBeefIx,
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID,
} from "@ansem/sdk";
const raw = JSON.parse(readFileSync(process.env.PLAYER_WALLET, "utf8"));
const player = Keypair.fromSecretKey(Uint8Array.from(raw));
const conn = new Connection(process.env.RPC, "finalized");
const program = createProgram(conn, new Wallet(player));
const beef = await fetchBeefConfig(program, beefConfigPda());
const mint = new PublicKey(beef.beefMint);
const mintInfo = await conn.getAccountInfo(mint, "finalized");
if (!mintInfo) throw new Error("BEEF mint account is absent");
let tokenProgram;
if (mintInfo.owner.equals(TOKEN_PROGRAM_ID)) tokenProgram = TOKEN_PROGRAM_ID;
else if (mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID)) tokenProgram = TOKEN_2022_PROGRAM_ID;
else throw new Error(`BEEF mint has unsupported owner ${mintInfo.owner.toBase58()}`);
const ata = getAssociatedTokenAddressSync(mint, player.publicKey, false, tokenProgram);
const minerPda = beefMinerPda(player.publicKey);
let minerBefore = null;
for (let attempt = 1; attempt <= 45; attempt += 1) {
  minerBefore = await program.account.beefMiner.fetchNullable(minerPda);
  if (minerBefore && BigInt(minerBefore.unclaimed.toString()) > 0n) break;
  if (attempt === 45) break;
  await new Promise((resolve) => setTimeout(resolve, 2_000));
}
const expectedUnclaimed = minerBefore ? BigInt(minerBefore.unclaimed.toString()) : 0n;
if (expectedUnclaimed <= 0n) {
  throw new Error("fresh proof roll did not become visible at finalized commitment within 90s");
}
const balance = async () => BigInt(
  (await conn.getTokenAccountBalance(ata, "finalized").catch(() => ({ value: { amount: "0" } })))
    .value.amount,
);
const before = await balance();
const signature = await claimBeefIx(
  program, player.publicKey, mint, new PublicKey(beef.beefVault), tokenProgram,
).signers([player]).rpc({ commitment: "finalized" });
const after = await balance();
if (after <= before) throw new Error(`BEEF claim did not increase balance: ${before} -> ${after}`);
const received = after - before;
if (received !== expectedUnclaimed) {
  throw new Error(`claim received ${received}, fresh rolled entitlement was ${expectedUnclaimed}`);
}
const minerAfter = await program.account.beefMiner.fetch(minerPda);
if (BigInt(minerAfter.unclaimed.toString()) !== 0n) {
  throw new Error(`claim left unclaimed BEEF: ${minerAfter.unclaimed}`);
}
console.log(JSON.stringify({
  signature, player: player.publicKey.toBase58(), playerAta: ata.toBase58(),
  beefMiner: minerPda.toBase58(), expectedUnclaimed: expectedUnclaimed.toString(),
  before: before.toString(), after: after.toString(), received: received.toString(),
  unclaimedAfter: "0",
}, null, 2));
NODE

read_beef_state "$EVIDENCE_DIR/beef-after-proof.json"
export PROOF_END_SLOT="$(solana slot --url "$MAINNET_RPC" --commitment finalized)"
```

Discover successful program instructions inside the bounded proof slot window. This command
aborts unless all five required names are present and bound to the controlled wallet and one
round. It also requires a quiet BEEF accounting window: exactly one stamp, exactly one claim,
and no BEEF vault sweep may occur between the before and after snapshots. If unrelated BEEF
activity is found, do not use the broad balance-delta reconciliation. Wait for a quiet window and
run a new controlled proof.

```bash
RPC="$MAINNET_RPC" PROGRAM_ID="$PROGRAM_ID" PROOF_START_SLOT="$PROOF_START_SLOT" \
PROOF_END_SLOT="$PROOF_END_SLOT" PROOF_WALLET_PUBKEY="$PROOF_WALLET_PUBKEY" \
SEED_LAMPORTS_PER_ROUND="$SEED_LAMPORTS_PER_ROUND" EVIDENCE_DIR="$EVIDENCE_DIR" \
node --input-type=module <<'NODE' | tee "$EVIDENCE_DIR/proof-program-signatures.json"
import { readFileSync } from "node:fs";
import { Connection, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { beefRoundPda, roundPda } from "@ansem/sdk";
import idl from "./packages/sdk/src/idl/ansem_miner.json" with { type: "json" };
const conn = new Connection(process.env.RPC, "finalized");
const program = new PublicKey(process.env.PROGRAM_ID);
const proofWallet = new PublicKey(process.env.PROOF_WALLET_PUBKEY).toBase58();
const firstSlot = Number(process.env.PROOF_START_SLOT);
const lastSlot = Number(process.env.PROOF_END_SLOT);
if (!Number.isSafeInteger(firstSlot) || !Number.isSafeInteger(lastSlot) || lastSlot < firstSlot) {
  throw new Error(`invalid proof slot window ${firstSlot}..${lastSlot}`);
}
const wanted = new Set([
  "stake_direct", "execute_swap_real", "stamp_beef", "roll_beef", "claim_beef",
  "sweep_beef_excess",
]);
const byDiscriminator = new Map(
  idl.instructions
    .filter((ix) => wanted.has(ix.name))
    .map((ix) => [Buffer.from(ix.discriminator).toString("hex"), ix]),
);
if (byDiscriminator.size !== wanted.size) throw new Error("proof instruction missing from IDL");
const rows = await conn.getSignaturesForAddress(program, { limit: 1000 }, "finalized");
if (rows.length === 1000 && rows.at(-1).slot >= firstSlot) {
  throw new Error("proof signature scan exceeded 1000 rows; use a narrower quiet window");
}
const evidence = [];
for (const row of rows
  .filter((x) => x.err === null && x.slot >= firstSlot && x.slot <= lastSlot)
  .reverse()) {
  const tx = await conn.getParsedTransaction(row.signature, {
    commitment: "finalized", maxSupportedTransactionVersion: 0,
  });
  if (!tx) throw new Error(`finalized transaction unavailable: ${row.signature}`);
  for (const ix of tx.transaction.message.instructions) {
    if (!("data" in ix) || !ix.programId.equals(program)) continue;
    const data = Buffer.from(bs58.decode(ix.data));
    const spec = byDiscriminator.get(data.subarray(0, 8).toString("hex"));
    if (!spec) continue;
    if (!("accounts" in ix) || ix.accounts.length < spec.accounts.length) {
      throw new Error(`${spec.name} account list is incomplete in ${row.signature}`);
    }
    const accounts = Object.fromEntries(
      spec.accounts.map((account, index) => [account.name, ix.accounts[index].toBase58()]),
    );
    if (tx.blockTime === null) throw new Error(`blockTime unavailable: ${row.signature}`);
    const item = {
      instruction: spec.name, signature: row.signature, slot: row.slot,
      blockTime: tx.blockTime, accounts,
    };
    if (["stake_direct", "stamp_beef", "roll_beef"].includes(spec.name)) {
      if (data.length < 16) throw new Error(`${spec.name} arguments are truncated`);
      item.roundId = Number(data.readBigUInt64LE(8));
      if (!Number.isSafeInteger(item.roundId)) throw new Error(`${spec.name} round ID is unsafe`);
    }
    if (spec.name === "stake_direct") {
      if (data.length < 25) throw new Error("stake_direct arguments are truncated");
      item.amount = data.readBigUInt64LE(17).toString();
    }
    evidence.push(item);
  }
}
const exactlyOne = (label, matches) => {
  if (matches.length !== 1) throw new Error(`${label}: expected 1, observed ${matches.length}`);
  return matches[0];
};
const atLeastOne = (label, matches) => {
  if (matches.length === 0) throw new Error(`${label}: missing`);
  return matches.at(-1);
};
const stake = exactlyOne("controlled stake_direct", evidence.filter(
  (x) => x.instruction === "stake_direct" && x.accounts.authority === proofWallet,
));
if (stake.amount !== process.env.SEED_LAMPORTS_PER_ROUND) {
  throw new Error(`stake amount mismatch: ${stake.amount}`);
}
const proofRoundId = stake.roundId;
const proofRound = roundPda(proofRoundId).toBase58();
const proofBeefRound = beefRoundPda(proofRoundId).toBase58();
if (stake.accounts.round !== proofRound) throw new Error("stake round PDA mismatch");
const swap = exactlyOne("proof execute_swap_real", evidence.filter(
  (x) => x.instruction === "execute_swap_real" && x.accounts.round === proofRound,
));
const stamp = exactlyOne("proof stamp_beef", evidence.filter(
  (x) => x.instruction === "stamp_beef" && x.roundId === proofRoundId &&
    x.accounts.round === proofRound && x.accounts.beef_round === proofBeefRound,
));
const roll = atLeastOne("proof roll_beef", evidence.filter(
  (x) => x.instruction === "roll_beef" && x.roundId === proofRoundId &&
    x.accounts.authority === proofWallet && x.accounts.round === proofRound,
));
const claimOutput = JSON.parse(
  readFileSync(`${process.env.EVIDENCE_DIR}/proof-claim.json`, "utf8"),
);
if (claimOutput.player !== proofWallet) throw new Error("claim output wallet mismatch");
if (claimOutput.received !== claimOutput.expectedUnclaimed) {
  throw new Error("claim did not equal the freshly rolled entitlement");
}
const claim = exactlyOne("controlled claim_beef", evidence.filter(
  (x) => x.instruction === "claim_beef" && x.accounts.authority === proofWallet &&
    x.signature === claimOutput.signature,
));
const stampsInWindow = evidence.filter((x) => x.instruction === "stamp_beef");
const claimsInWindow = evidence.filter((x) => x.instruction === "claim_beef");
const sweepsInWindow = evidence.filter((x) => x.instruction === "sweep_beef_excess");
if (stampsInWindow.length !== 1 || claimsInWindow.length !== 1 || sweepsInWindow.length !== 0) {
  throw new Error(
    `BEEF window was not quiet: stamps=${stampsInWindow.length} ` +
    `claims=${claimsInWindow.length} sweeps=${sweepsInWindow.length}`,
  );
}
console.log(JSON.stringify({
  proofStartSlot: firstSlot, proofEndSlot: lastSlot, quietBeefWindow: true,
  proofWallet, proofRoundId, proofRoundPda: proofRound, proofBeefRoundPda: proofBeefRound,
  stake, swap, stamp, roll, claim,
}, null, 2));
NODE

read -r PROOF_ROUND_ID STAKE_SIGNATURE SWAP_SIGNATURE STAMP_SIGNATURE \
  ROLL_SIGNATURE CLAIM_SIGNATURE < <(node -e '
const { readFileSync } = require("node:fs");
const x = JSON.parse(readFileSync(`${process.env.EVIDENCE_DIR}/proof-program-signatures.json`, "utf8"));
const values = [x.proofRoundId, x.stake?.signature, x.swap?.signature,
  x.stamp?.signature, x.roll?.signature, x.claim?.signature];
if (values.some((value) => value === undefined || value === null || value === "")) process.exit(1);
process.stdout.write(values.join(" "));
')
export PROOF_ROUND_ID STAKE_SIGNATURE SWAP_SIGNATURE STAMP_SIGNATURE ROLL_SIGNATURE CLAIM_SIGNATURE
for signature in \
  "$STAKE_SIGNATURE" "$SWAP_SIGNATURE" "$STAMP_SIGNATURE" "$ROLL_SIGNATURE" "$CLAIM_SIGNATURE"
do
  solana confirm "$signature" --url "$MAINNET_RPC" --commitment finalized --verbose
done

curl --fail --silent --show-error "$KEEPER_BASE_URL/snapshot" \
  | tee "$EVIDENCE_DIR/keeper-snapshot-after-proof.json"

RPC="$MAINNET_RPC" PROGRAM_ID="$PROGRAM_ID" PROOF_ROUND_ID="$PROOF_ROUND_ID" \
node --input-type=module <<'NODE' | tee "$EVIDENCE_DIR/round-duration-proof.json"
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { Wallet } from "@coral-xyz/anchor";
import bs58 from "bs58";
import {
  createProgram, configPda, fetchConfig, fetchRound, roundPda, RoundState,
} from "@ansem/sdk";
import idl from "./packages/sdk/src/idl/ansem_miner.json" with { type: "json" };
const conn = new Connection(process.env.RPC, "finalized");
const programId = new PublicKey(process.env.PROGRAM_ID);
const program = createProgram(conn, new Wallet(Keypair.generate()));
const proof = JSON.parse(
  readFileSync(`${process.env.EVIDENCE_DIR}/proof-program-signatures.json`, "utf8"),
);
const config = await fetchConfig(program, configPda());
if (config.roundDurationSecs !== 60) {
  throw new Error(`on-chain roundDurationSecs is ${config.roundDurationSecs}, expected 60`);
}
const expectedNextRoundId = Number(process.env.PROOF_ROUND_ID) + 1;
if (config.currentRoundId !== expectedNextRoundId) {
  throw new Error(`expected current round ${expectedNextRoundId}, observed ${config.currentRoundId}`);
}
const nextRoundPda = roundPda(expectedNextRoundId);
const round = await fetchRound(program, nextRoundPda);
if (round.roundId !== expectedNextRoundId) throw new Error("next round ID mismatch");
if (round.state !== RoundState.Open) throw new Error(`next round is not Open: ${round.state}`);
const createSpec = idl.instructions.find((ix) => ix.name === "create_round");
if (!createSpec) throw new Error("create_round is absent from the IDL");
const discriminator = Buffer.from(createSpec.discriminator).toString("hex");
const rows = await conn.getSignaturesForAddress(nextRoundPda, { limit: 50 }, "finalized");
const creates = [];
for (const row of rows.filter((x) => x.err === null)) {
  const tx = await conn.getParsedTransaction(row.signature, {
    commitment: "finalized", maxSupportedTransactionVersion: 0,
  });
  if (!tx) continue;
  for (const ix of tx.transaction.message.instructions) {
    if (!("data" in ix) || !ix.programId.equals(programId) || !("accounts" in ix)) continue;
    const data = Buffer.from(bs58.decode(ix.data));
    if (data.subarray(0, 8).toString("hex") !== discriminator) continue;
    if (!ix.accounts[0]?.equals(new PublicKey(config.admin))) continue;
    if (!ix.accounts[1]?.equals(configPda())) continue;
    if (!ix.accounts[2]?.equals(nextRoundPda)) continue;
    if (tx.blockTime === null) throw new Error(`create_round blockTime unavailable: ${row.signature}`);
    creates.push({ signature: row.signature, slot: row.slot, blockTime: tx.blockTime });
  }
}
if (creates.length !== 1) throw new Error(`expected one create_round, observed ${creates.length}`);
if (creates[0].slot <= proof.stamp.slot || creates[0].blockTime < proof.stamp.blockTime) {
  throw new Error(
    `round ${expectedNextRoundId} was not created after proof stamp ` +
    `${proof.stamp.signature}`,
  );
}
const deltaSeconds = round.deadlineTs - creates[0].blockTime;
if (deltaSeconds < 58 || deltaSeconds > 62) {
  throw new Error(`round duration from chain evidence is ${deltaSeconds}s, expected 60s +/- 2s`);
}
console.log(JSON.stringify({
  configRoundDurationSecs: config.roundDurationSecs,
  roundId: round.roundId, roundState: "Open", roundPda: nextRoundPda.toBase58(),
  createRoundSignature: creates[0].signature, createRoundSlot: creates[0].slot,
  createRoundBlockTime: creates[0].blockTime, deadlineTs: round.deadlineTs,
  deltaSeconds, toleranceSeconds: 2,
}, null, 2));
NODE
```

Record:

- Proof start slot:
- Proof end slot:
- Controlled wallet public key:
- Proof round ID:
- Stake amount, lamports:
- Stake signature:
- Real swap signature:
- BEEF stamp signature:
- `BeefRound` address:
- Player base emission:
- Treasury emission:
- Roll signature:
- BEEF claim signature:
- Claimed BEEF base units:
- Next open round ID:
- Next-round `create_round` signature:
- Next-round create block time:
- Next-round deadline:
- On-chain Config `roundDurationSecs`:
- Deadline minus create block time, seconds:
- Proof completed at UTC:

## 9. Post-proof accounting reconciliation

Compare `beef-before-proof.json` with `beef-after-proof.json`. The final read already enforces
bonus zero, `vault >= total_owed`, and an absolute vault balance of at least 47,481,502 base
units. The controlled wallet has no unrelated pending entitlement, so its legitimate claim must
leave the post-proof vault balance at or above the pre-proof balance. The transaction scan must
also prove the slot window had only the controlled stamp and claim and no vault sweep. Without
that quiet-window evidence, the broad supply and balance equality below is not attributable to
this proof and must not be used.

```bash
node --input-type=module <<'NODE'
import { readFileSync } from "node:fs";
const before = JSON.parse(readFileSync(`${process.env.EVIDENCE_DIR}/beef-before-proof.json`, "utf8"));
const after = JSON.parse(readFileSync(`${process.env.EVIDENCE_DIR}/beef-after-proof.json`, "utf8"));
const proof = JSON.parse(
  readFileSync(`${process.env.EVIDENCE_DIR}/proof-program-signatures.json`, "utf8"),
);
const b = (x) => BigInt(x);
if (proof.quietBeefWindow !== true) throw new Error("quiet BEEF window was not proven");
if (after.tickBps !== 0 || after.bonusCapBps !== 0) throw new Error("BEEF bonus is not zero");
if (b(after.vault) < b(after.totalOwed)) throw new Error("BEEF vault is undercollateralized");
if (b(after.vault) < 47481502n) throw new Error("protected vault floor was breached");
if (b(after.vault) < b(before.vault)) {
  throw new Error("vault balance decreased during the controlled one-wallet proof");
}
if (b(after.supply) - b(before.supply) !==
    (b(after.vault) - b(before.vault)) +
    (b(after.treasury) - b(before.treasury)) +
    (b(after.playerBalance) - b(before.playerBalance))) {
  throw new Error("mint supply delta does not reconcile to vault, treasury, and proof wallet");
}
if (b(after.mintedTotal) - b(before.mintedTotal) !== b(after.supply) - b(before.supply)) {
  throw new Error("minted_total delta does not equal mint supply delta");
}
console.log(JSON.stringify({
  supplyBefore: before.supply, supplyAfter: after.supply,
  vaultBefore: before.vault, vaultAfter: after.vault,
  treasuryBefore: before.treasury, treasuryAfter: after.treasury,
  totalOwedBefore: before.totalOwed, totalOwedAfter: after.totalOwed,
  protectedVaultFloor: "47481502",
  playerBefore: before.playerBalance, playerAfter: after.playerBalance,
}, null, 2));
NODE
```

Record:

- Mint supply after proof:
- Mint supply delta:
- Vault balance after proof:
- Vault balance delta:
- Treasury balance after proof:
- Treasury balance delta:
- `minted_total` after proof:
- `total_owed` after proof:
- Proof wallet BEEF balance delta:
- `beef_vault.amount >= total_owed` confirmed:
- Post-proof vault balance at or above 47.481502 BEEF protected floor:
- Post-proof vault balance at or above pre-proof vault balance:
- Quiet BEEF accounting window confirmed:
- `minted_total` delta equals mint supply delta:
- Supply reconciliation confirmed:

## 10. Rollback

Rollback is a fault-containment action, not a return to unsafe economics. Keep
`KEEPER_ROUND_SECS=60`, `tick_bps=0`, and `bonus_cap_bps=0`. Never sweep the BEEF vault.

### Keeper image rollback

The recorded previous keeper image has no atomic funded-round stamp gate. A polling supervisor
cannot close the race between observing a missing `BeefRound` and that image submitting
`CreateRound`. Therefore the previous image is not an approved running rollback target. The only
safe keeper rollback state is stopped. Leave the program and BEEF accounting readable, preserve
the evidence, and prepare a new reviewed recovery deployment before resuming automation.

```bash
railway down --yes --service "$RAILWAY_SERVICE" --environment "$RAILWAY_ENVIRONMENT"
if railway_active_deployment_id >/dev/null 2>&1; then
  echo "Keeper is still active after stop request" >&2
  exit 1
fi
if curl --fail --silent --show-error "$KEEPER_BASE_URL/health" >/dev/null 2>&1; then
  echo "Keeper health endpoint still responds after stop request" >&2
  exit 1
fi
read_beef_state "$EVIDENCE_DIR/beef-after-keeper-stop.json"
```

Record:

- Keeper rollback reason:
- Keeper stop UTC:
- No active deployment confirmed:
- Health endpoint unavailable confirmed:
- Previous keeper deployment remained stopped and was not rolled back:
- Bonus-zero readback after keeper stop:
- Protected vault floor and balance readback after keeper stop:

### Program binary rollback

Redeploy only the exact binary dumped and hashed before the upgrade. This rollback does not alter
BEEF configuration or token accounts. The previous binary restores the pot-vault rent wedge, so
stop the keeper before deployment. Before the old binary may process a swap, the pot vault must
retain at least the zero-data rent minimum after the current unswapped pot is removed. In other
words, `potVaultLamports - currentRound.pot >= rentMinimum` for an Open, VrfPending, Settled, or
Swapping round. Top up exactly the positive residual shortfall and keep a continuous residual
floor monitor active. If monitoring cannot be maintained, keep the keeper stopped.

```bash
railway down --yes --service "$RAILWAY_SERVICE" --environment "$RAILWAY_ENVIRONMENT"
test -s "$PREVIOUS_PROGRAM_SO"
test "$(shasum -a 256 "$PREVIOUS_PROGRAM_SO" | awk '{print $1}')" = "$PREVIOUS_PROGRAM_HASH"
test "$(solana address --keypair "$UPGRADE_KEYPAIR")" = "$EXPECTED_UPGRADE_AUTHORITY"
: "${POT_TOPUP_KEYPAIR:?POT_TOPUP_KEYPAIR must be a funded local keypair path}"

RPC="$MAINNET_RPC" POT_TOPUP_KEYPAIR="$POT_TOPUP_KEYPAIR" node --input-type=module <<'NODE' \
  | tee "$EVIDENCE_DIR/pot-vault-rollback-topup.json"
import { readFileSync } from "node:fs";
import {
  Connection, Keypair, SystemProgram, Transaction, sendAndConfirmTransaction,
} from "@solana/web3.js";
import { Wallet } from "@coral-xyz/anchor";
import {
  createProgram, configPda, fetchConfig, fetchRound, potVaultPda, roundPda, RoundState,
} from "@ansem/sdk";
const conn = new Connection(process.env.RPC, "finalized");
const raw = JSON.parse(readFileSync(process.env.POT_TOPUP_KEYPAIR, "utf8"));
const payer = Keypair.fromSecretKey(Uint8Array.from(raw));
const program = createProgram(conn, new Wallet(payer));
const potVault = potVaultPda();
const rentMinimum = BigInt(await conn.getMinimumBalanceForRentExemption(0, "finalized"));
const config = await fetchConfig(program, configPda());
const round = config.currentRoundId === 0
  ? null
  : await fetchRound(program, roundPda(config.currentRoundId));
const imminentPot = round && round.state < RoundState.Claimable ? round.pot : 0n;
const before = BigInt(await conn.getBalance(potVault, "finalized"));
const requiredBefore = rentMinimum + imminentPot;
const shortfall = requiredBefore > before ? requiredBefore - before : 0n;
let signature = null;
if (shortfall > 0n) {
  if (shortfall > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("top-up exceeds safe integer");
  signature = await sendAndConfirmTransaction(
    conn,
    new Transaction().add(SystemProgram.transfer({
      fromPubkey: payer.publicKey, toPubkey: potVault, lamports: Number(shortfall),
    })),
    [payer],
    { commitment: "finalized", preflightCommitment: "finalized" },
  );
}
const after = BigInt(await conn.getBalance(potVault, "finalized"));
const residualAfterSwap = after - imminentPot;
if (residualAfterSwap < rentMinimum) {
  throw new Error(`post-swap residual remains below rent: ${residualAfterSwap} < ${rentMinimum}`);
}
console.log(JSON.stringify({
  potVault: potVault.toBase58(), payer: payer.publicKey.toBase58(),
  currentRoundId: round?.roundId ?? 0, currentRoundState: round?.state ?? null,
  currentRoundPot: imminentPot.toString(), rentMinimum: rentMinimum.toString(),
  requiredBefore: requiredBefore.toString(), before: before.toString(),
  shortfall: shortfall.toString(), topupSignature: signature, after: after.toString(),
  residualAfterSwap: residualAfterSwap.toString(),
}, null, 2));
NODE

solana program deploy "$PREVIOUS_PROGRAM_SO" \
  --program-id "$PROGRAM_ID" \
  --upgrade-authority "$UPGRADE_KEYPAIR" \
  --fee-payer "$UPGRADE_KEYPAIR" \
  --url "$MAINNET_RPC" \
  --commitment finalized \
  --use-rpc \
  --max-sign-attempts 60 \
  --output json \
  | tee "$EVIDENCE_DIR/program-rollback.json"

solana program dump "$PROGRAM_ID" "$EVIDENCE_DIR/ansem-miner-rollback-check.so" \
  --url "$MAINNET_RPC" --commitment finalized
test "$(shasum -a 256 "$EVIDENCE_DIR/ansem-miner-rollback-check.so" | awk '{print $1}')" \
  = "$PREVIOUS_PROGRAM_HASH"
read_beef_state "$EVIDENCE_DIR/beef-after-program-rollback.json"
```

Do not resume any keeper after a program rollback. The latest Railway deployment may still point
to the removed unsafe image, so `railway redeploy` is forbidden here. Confirm the service remains
stopped. Resume only through a new reviewed release sequence that names and verifies the exact
recovery source and program binary.

```bash
if railway_active_deployment_id >/dev/null 2>&1; then
  echo "Keeper unexpectedly active after program rollback" >&2
  exit 1
fi
if curl --fail --silent --show-error "$KEEPER_BASE_URL/health" >/dev/null 2>&1; then
  echo "Keeper health endpoint unexpectedly responds after program rollback" >&2
  exit 1
fi
```

Record:

- Program rollback reason:
- Previous program SHA-256:
- Program rollback signature:
- Deployed SHA-256 after rollback:
- Program rollback UTC:
- Upgrade authority after rollback:
- Bonus-zero readback after program rollback:
- Protected vault floor and balance readback after program rollback:
- Pot vault address:
- Zero-data rent minimum, lamports:
- Current unswapped round pot, lamports:
- Required pre-swap vault balance, lamports:
- Pot vault balance before top-up, lamports:
- Exact top-up shortfall, lamports:
- Top-up signature, or `none` when the shortfall was zero:
- Pot vault balance after top-up, lamports:
- Residual after imminent pot removal, lamports:
- Keeper remained stopped after program rollback:
- Health endpoint unavailable after program rollback:

## 11. Final evidence summary

Complete these public fields after deployment and proof. Keep the raw command outputs in the
operator evidence directory; commit only this public summary.

- Release source commit:
- Release worktree clean:
- Verification counts and documented skips:
- Independent review result:
- Program ID: `8Q9EnK7ydn6ywo7ZxeqhubqYybf7FFNNwnz8JzJjXZjz`
- ProgramData: `2K1sLP43GKajCgrGTgkAfvc23GVLgqY1YQwwkCGBaFvM`
- Upgrade authority: `FP39ztVCx7FDPpou4mfPV6HyXoNVDRLEqZyvKkFgpCCM`
- Release artifact SHA-256:
- Program upgrade signature:
- Deployed program SHA-256:
- Railway deployment ID:
- Keeper health URL:
- Keeper snapshot URL:
- `KEEPER_ROUND_SECS`: `60`
- On-chain Config `roundDurationSecs`: `60`
- Next-round `create_round` signature:
- Next-round create block time:
- Next-round deadline:
- Deadline minus create block time, seconds:
- Proof round ID:
- Proof start and end slots:
- Stake signature:
- Swap signature:
- Stamp signature:
- Roll signature:
- Claim signature:
- Post-proof BEEF supply:
- Post-proof BEEF vault balance:
- Post-proof BEEF treasury balance:
- Post-proof `total_owed`:
- Quiet BEEF accounting window confirmed:
- 47.481502 BEEF protected vault floor maintained:
- Post-proof vault balance at or above pre-proof vault balance:
- Rollback keeper state: `not used`, `stopped`, or `manually supervised`:
- Rollback program state: `not used`, `stopped`, or `rent-floor supervised`:
- Final audit UTC:
