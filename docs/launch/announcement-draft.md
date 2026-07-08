# ANSEM Miner — launch announcement drafts (Friday 2026-07-10)

> STATUS: DRAFT — user approval required before anything is posted. Replace `<URL>` with the production URL, `<GIF>` with the demo capture.

## X thread (post from user's account)

**1/**
ANSEM MINER is live. 🐂

A fully on-chain mining game on @solana — stake SOL on the bull board, VRF decides the squares, the pot converts to $ANSEM, winners claim.

Gasless. Popup-free. Rounds every 60 seconds, around the clock.

Play the devnet beta now → <URL>

<GIF>

**2/**
How it works:

1. Grab free devnet SOL (faucet linked in-app)
2. Deposit + enter the round — ONE wallet popup, total
3. Click bulls, stake gasless — zero popups, ~50ms confirms
4. VRF settles the round on-chain → claim your ANSEM

No signups. No emails. Just a wallet.

**3/**
Under the hood (for the builders):

• Anchor program on Solana devnet — every payout backed 1:1 by the round's swap, solvency by construction
• @magicblock ephemeral rollup runs the staking hot path — that's the gasless ~50ms feel
• Ephemeral VRF settles every round — verifiable randomness, no admin dice
• Session keys: one approval, then zero popups

**4/**
The fine print (read it):

ANSEM Miner is an unofficial fan project — not affiliated with or endorsed by Ansem. This is a devnet beta: devnet SOL + a mock ANSEM test token only. No real funds are used, held, or paid out.

Real thing is being built in the open. Bulls first. 🐂

## MagicBlock Discord drop (ecosystem/showcase channel)

> Shipped: ANSEM Miner — a grid mining game running its whole staking hot path in an ephemeral rollup (gasless session-key staking, zero popups), settled by ephemeral VRF each round, value custody on L1. Continuous hands-off rounds via a keeper. Devnet beta: <URL> — feedback very welcome. Happy to write up the ER/VRF/session-key integration notes if useful.

## Landing hook (if we add a hero line to the app later — post-launch backlog)

"Mine $ANSEM on the bull board. Gasless. Every 60 seconds."

## Do-NOT list (legal/brand discipline)

- No $ANSEM price talk, no "earnings", no APY/returns language — it's a devnet game with test tokens.
- No implication of Ansem's involvement; disclaimer language travels with every post.
- No "coming to mainnet on <date>" promises — mainnet is gated on audit + legal + liquidity, announced when it clears.
