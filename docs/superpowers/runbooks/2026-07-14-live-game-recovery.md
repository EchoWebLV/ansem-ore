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

## 3. Program identity, authority, and balance gate

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
solana balance "$EXPECTED_UPGRADE_AUTHORITY" --url "$MAINNET_RPC" --commitment finalized
```

Record:

- Observed program ID:
- Observed ProgramData address:
- Observed loader owner:
- Observed upgrade authority:
- Available signer public key:
- Program last deploy slot before recovery:
- Upgrade signer balance before recovery, lamports:
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
  createProgram, beefConfigPda, fetchBeefConfig,
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
if (process.env.PROOF_WALLET_PUBKEY) {
  playerAta = getAssociatedTokenAddressSync(
    mint, new PublicKey(process.env.PROOF_WALLET_PUBKEY), false, tokenProgram,
  );
  playerBalance = BigInt(
    (await conn.getTokenAccountBalance(playerAta, "finalized").catch(() => ({ value: { amount: "0" } })))
      .value.amount,
  );
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
}, null, 2));
NODE
}

pnpm --filter @ansem/sdk build
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

## 5. Build, hash, and retain the rollback binary

Run the full Task 11 verification before this section. Build with the reviewed pinned toolchain,
hash the exact file that will be deployed, and dump the current deployed bytes before any write.
The upgradeable loader's ProgramData account adds a 45-byte metadata header. The balance gate
therefore funds one temporary program buffer plus only the positive ProgramData rent-extension
shortfall, the maximum swap rent top-up, and a 0.05 SOL deployment fee margin.

```bash
anchor build
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
export SWAP_RENT_RESERVE_LAMPORTS=890880
export DEPLOY_FEE_MARGIN_LAMPORTS=50000000
export MINIMUM_OPERATOR_BALANCE_LAMPORTS="$((
  BUFFER_RENT_LAMPORTS + PROGRAMDATA_EXTENSION_SHORTFALL_LAMPORTS +
  SWAP_RENT_RESERVE_LAMPORTS + DEPLOY_FEE_MARGIN_LAMPORTS
))"
test "$SIGNER_BALANCE_LAMPORTS" -ge "$MINIMUM_OPERATOR_BALANCE_LAMPORTS"

{
  printf 'program_bytes=%s\n' "$PROGRAM_BYTES"
  printf 'buffer_rent_lamports=%s\n' "$BUFFER_RENT_LAMPORTS"
  printf 'programdata_required_rent_lamports=%s\n' "$PROGRAMDATA_REQUIRED_RENT_LAMPORTS"
  printf 'current_programdata_lamports=%s\n' "$CURRENT_PROGRAMDATA_LAMPORTS"
  printf 'programdata_extension_shortfall_lamports=%s\n' "$PROGRAMDATA_EXTENSION_SHORTFALL_LAMPORTS"
  printf 'swap_rent_reserve_lamports=%s\n' "$SWAP_RENT_RESERVE_LAMPORTS"
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

- Build command: `anchor build`
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
- Swap rent-reserve allowance, lamports: `890880`
- Deployment fee margin, lamports: `50000000`
- Minimum operator balance gate, lamports:
- Observed signer balance, lamports:
- Local verification summary:
- Independent review result:

## 6. Program upgrade and byte-for-byte verification

This section mutates mainnet. Re-run Sections 2 through 5 in the same session immediately before
the deploy command.

```bash
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
```

Record:

- Program upgrade UTC:
- Program upgrade signature:
- Program last deploy slot after recovery:
- Local release SHA-256:
- Deployed program SHA-256:
- Hash equality confirmed:
- Upgrade authority after deployment:
- Bonus-zero readback after deployment:
- Protected vault floor and balance readback after deployment:

## 7. Railway keeper deployment

Link explicitly to `ansem-keeper / production / keeper`. Capture the active deployment ID before
the write because that exact ID is the image rollback target.

```bash
railway whoami
railway link --project "$RAILWAY_PROJECT" \
  --environment "$RAILWAY_ENVIRONMENT" \
  --service "$RAILWAY_SERVICE"
railway status --json | tee "$EVIDENCE_DIR/railway-before.json"

railway_deployment_id() {
  railway status --json | node -e '
let s=""; process.stdin.on("data", d => s += d); process.stdin.on("end", () => {
  const j = JSON.parse(s);
  const environment = j.environments.edges.map(e => e.node)
    .find(n => n.name === process.env.RAILWAY_ENVIRONMENT);
  const service = j.services.edges.map(e => e.node)
    .find(n => n.name === process.env.RAILWAY_SERVICE);
  const deployment = service?.serviceInstances.edges.map(e => e.node)
    .find(n => n.environmentId === environment?.id)?.latestDeployment;
  if (!deployment?.id) process.exit(1);
  process.stdout.write(deployment.id);
});'
}

export PREVIOUS_KEEPER_DEPLOYMENT_ID="$(railway_deployment_id)"
test -n "$PREVIOUS_KEEPER_DEPLOYMENT_ID"

railway variables --set "KEEPER_ROUND_SECS=60" \
  --service "$RAILWAY_SERVICE" --environment "$RAILWAY_ENVIRONMENT"
railway up --ci --service "$RAILWAY_SERVICE" --environment "$RAILWAY_ENVIRONMENT"

railway variables --json --service "$RAILWAY_SERVICE" --environment "$RAILWAY_ENVIRONMENT" \
  | node -e '
let s=""; process.stdin.on("data", d => s += d); process.stdin.on("end", () => {
  const v = JSON.parse(s);
  if (v.KEEPER_ROUND_SECS !== "60") throw new Error("KEEPER_ROUND_SECS is not 60");
  console.log("KEEPER_ROUND_SECS=60");
});'

railway status --json | tee "$EVIDENCE_DIR/railway-after.json"
export KEEPER_DEPLOYMENT_ID="$(railway_deployment_id)"
test "$KEEPER_DEPLOYMENT_ID" != "$PREVIOUS_KEEPER_DEPLOYMENT_ID"
railway logs "$KEEPER_DEPLOYMENT_ID" --deployment \
  --service "$RAILWAY_SERVICE" --environment "$RAILWAY_ENVIRONMENT" \
  | tee "$EVIDENCE_DIR/keeper-deployment.log"
```

Set the public Railway service origin, without a trailing slash, then verify both read endpoints.

```bash
: "${KEEPER_BASE_URL:?KEEPER_BASE_URL must be the public HTTPS keeper origin}"
curl --fail --silent --show-error "$KEEPER_BASE_URL/health" \
  | tee "$EVIDENCE_DIR/keeper-health.txt" | grep -Fx ok
curl --fail --silent --show-error "$KEEPER_BASE_URL/snapshot" \
  | tee "$EVIDENCE_DIR/keeper-snapshot.json" \
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
- Previous keeper deployment ID:
- Recovery keeper deployment ID:
- Keeper release commit:
- `KEEPER_ROUND_SECS` readback: `60`
- Keeper deployment UTC:
- Keeper health URL:
- Keeper health response:
- Keeper snapshot URL:
- Snapshot round ID:
- Snapshot state:
- Snapshot deadline:
- Snapshot updated timestamp:

## 8. Controlled funded-round proof

Use a dedicated, funded proof wallet with no unrelated pending BEEF entitlement. Its keypair stays
local. The existing seeder submits exactly one minimum stake when `MAX_ROUNDS=1`, waits for the
keeper swap and stamp, and rolls the stamped BEEF before it exits.

```bash
: "${CONTROLLED_WALLET:?CONTROLLED_WALLET must identify the approved proof wallet}"
export PROOF_WALLET_PUBKEY="$(solana address --keypair "$CONTROLLED_WALLET")"
export PROOF_START_SLOT="$(solana slot --url "$MAINNET_RPC" --commitment finalized)"
read_beef_state "$EVIDENCE_DIR/beef-before-proof.json"

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
  createProgram, beefConfigPda, fetchBeefConfig, claimBeefIx,
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
console.log(JSON.stringify({
  signature, player: player.publicKey.toBase58(), playerAta: ata.toBase58(),
  before: before.toString(), after: after.toString(), received: (after - before).toString(),
}, null, 2));
NODE

read_beef_state "$EVIDENCE_DIR/beef-after-proof.json"
```

Discover the program signatures at or after the recorded proof slot. The output maps Anchor
instruction names to finalized public signatures, including keeper-owned swap and stamp writes.

```bash
RPC="$MAINNET_RPC" PROGRAM_ID="$PROGRAM_ID" PROOF_START_SLOT="$PROOF_START_SLOT" \
node --input-type=module <<'NODE' | tee "$EVIDENCE_DIR/proof-program-signatures.json"
import { Connection, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import idl from "./packages/sdk/src/idl/ansem_miner.json" with { type: "json" };
const conn = new Connection(process.env.RPC, "finalized");
const program = new PublicKey(process.env.PROGRAM_ID);
const firstSlot = Number(process.env.PROOF_START_SLOT);
const wanted = new Set(["stake_direct", "execute_swap_real", "stamp_beef", "roll_beef", "claim_beef"]);
const byDiscriminator = new Map(
  idl.instructions
    .filter((ix) => wanted.has(ix.name))
    .map((ix) => [Buffer.from(ix.discriminator).toString("hex"), ix.name]),
);
const rows = await conn.getSignaturesForAddress(program, { limit: 1000 }, "finalized");
const evidence = [];
for (const row of rows.filter((x) => x.slot >= firstSlot).reverse()) {
  const tx = await conn.getParsedTransaction(row.signature, {
    commitment: "finalized", maxSupportedTransactionVersion: 0,
  });
  if (!tx) continue;
  for (const ix of tx.transaction.message.instructions) {
    if (!("data" in ix) || !ix.programId.equals(program)) continue;
    const name = byDiscriminator.get(Buffer.from(bs58.decode(ix.data)).subarray(0, 8).toString("hex"));
    if (name) evidence.push({ instruction: name, signature: row.signature, slot: row.slot });
  }
}
console.log(JSON.stringify(evidence, null, 2));
NODE
```

Set the five public signatures from the evidence output, then require finalized confirmation.

```bash
: "${STAKE_SIGNATURE:?STAKE_SIGNATURE must come from proof evidence}"
: "${SWAP_SIGNATURE:?SWAP_SIGNATURE must come from proof evidence}"
: "${STAMP_SIGNATURE:?STAMP_SIGNATURE must come from proof evidence}"
: "${ROLL_SIGNATURE:?ROLL_SIGNATURE must come from proof evidence}"
: "${CLAIM_SIGNATURE:?CLAIM_SIGNATURE must come from proof evidence}"
for signature in \
  "$STAKE_SIGNATURE" "$SWAP_SIGNATURE" "$STAMP_SIGNATURE" "$ROLL_SIGNATURE" "$CLAIM_SIGNATURE"
do
  solana confirm "$signature" --url "$MAINNET_RPC" --commitment finalized --verbose
done

curl --fail --silent --show-error "$KEEPER_BASE_URL/snapshot" \
  | tee "$EVIDENCE_DIR/keeper-snapshot-after-proof.json"
```

Record:

- Proof start slot:
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
- New round duration, seconds:
- Proof completed at UTC:

## 9. Post-proof accounting reconciliation

Compare `beef-before-proof.json` with `beef-after-proof.json`. The final read already enforces
bonus zero, `vault >= total_owed`, and an absolute vault balance of at least 47,481,502 base
units. The controlled wallet has no unrelated pending entitlement, so its legitimate claim must
leave the post-proof vault balance at or above the pre-proof balance.

```bash
node --input-type=module <<'NODE'
import { readFileSync } from "node:fs";
const before = JSON.parse(readFileSync(`${process.env.EVIDENCE_DIR}/beef-before-proof.json`, "utf8"));
const after = JSON.parse(readFileSync(`${process.env.EVIDENCE_DIR}/beef-after-proof.json`, "utf8"));
const b = (x) => BigInt(x);
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
- Supply reconciliation confirmed:

## 10. Rollback

Rollback is a fault-containment action, not a return to unsafe economics. Keep
`KEEPER_ROUND_SECS=60`, `tick_bps=0`, and `bonus_cap_bps=0`. Never sweep the BEEF vault.

### Keeper image rollback

Use the recorded previous successful deployment ID. Railway rollback restores that deployment's
image and variables as a new deployment, so immediately reassert `KEEPER_ROUND_SECS=60` and verify
the read endpoints. `RAILWAY_API_TOKEN` is supplied only through the shell.

```bash
: "${RAILWAY_API_TOKEN:?RAILWAY_API_TOKEN must be an account or workspace token}"
: "${PREVIOUS_KEEPER_DEPLOYMENT_ID:?previous keeper deployment ID was not recorded}"
export ROLLBACK_DEPLOYMENT_ID="$PREVIOUS_KEEPER_DEPLOYMENT_ID"

curl --fail-with-body --silent --show-error \
  --request POST \
  --url https://backboard.railway.com/graphql/v2 \
  --header "Authorization: Bearer $RAILWAY_API_TOKEN" \
  --header 'Content-Type: application/json' \
  --data "$(node -e '
const id = process.argv[1];
process.stdout.write(JSON.stringify({
  query: "mutation deploymentRollback($id: String!) { deploymentRollback(id: $id) { id } }",
  variables: { id },
}));' "$ROLLBACK_DEPLOYMENT_ID")" \
  | tee "$EVIDENCE_DIR/railway-rollback.json"

node -e '
const { readFileSync } = require("node:fs");
const x = JSON.parse(readFileSync(`${process.env.EVIDENCE_DIR}/railway-rollback.json`, "utf8"));
if (x.errors?.length || !x.data?.deploymentRollback?.id) throw new Error(JSON.stringify(x));
console.log(`rollback deployment ${x.data.deploymentRollback.id}`);
'

railway variables --set "KEEPER_ROUND_SECS=60" \
  --service "$RAILWAY_SERVICE" --environment "$RAILWAY_ENVIRONMENT"
curl --fail --silent --show-error "$KEEPER_BASE_URL/health" | grep -Fx ok
curl --fail --silent --show-error "$KEEPER_BASE_URL/snapshot" \
  | tee "$EVIDENCE_DIR/keeper-snapshot-after-rollback.json"
read_beef_state "$EVIDENCE_DIR/beef-after-keeper-rollback.json"
```

Record:

- Keeper rollback reason:
- Keeper rollback target deployment ID:
- Keeper rollback deployment ID:
- Keeper rollback UTC:
- `KEEPER_ROUND_SECS=60` reasserted:
- Health after keeper rollback:
- Snapshot after keeper rollback:
- Bonus-zero readback after keeper rollback:
- Protected vault floor and balance readback after keeper rollback:

### Program binary rollback

Redeploy only the exact binary dumped and hashed before the upgrade. This rollback does not alter
BEEF configuration or token accounts.

```bash
test -s "$PREVIOUS_PROGRAM_SO"
test "$(shasum -a 256 "$PREVIOUS_PROGRAM_SO" | awk '{print $1}')" = "$PREVIOUS_PROGRAM_HASH"
test "$(solana address --keypair "$UPGRADE_KEYPAIR")" = "$EXPECTED_UPGRADE_AUTHORITY"

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

Record:

- Program rollback reason:
- Previous program SHA-256:
- Program rollback signature:
- Deployed SHA-256 after rollback:
- Program rollback UTC:
- Upgrade authority after rollback:
- Bonus-zero readback after program rollback:
- Protected vault floor and balance readback after program rollback:

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
- Proof round ID:
- Stake signature:
- Swap signature:
- Stamp signature:
- Roll signature:
- Claim signature:
- Post-proof BEEF supply:
- Post-proof BEEF vault balance:
- Post-proof BEEF treasury balance:
- Post-proof `total_owed`:
- 47.481502 BEEF protected vault floor maintained:
- Post-proof vault balance at or above pre-proof vault balance:
- Final audit UTC:
