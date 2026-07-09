# ANSEM Miner — launch announcement drafts (Friday 2026-07-10)

> STATUS: DRAFT — user approval required before anything is posted. Replace `<URL>` with the production URL, `<GIF>` with the demo capture.
> Rewritten 2026-07-09 late for the DIRECT-STAKE + WINNER-TAKE-ALL engine (band (0,0) live on devnet; escrow/session copy removed).

## X thread (post from user's account)

**1/**
ANSEM MINER is live. 🐂

25 bulls. 60 seconds. ONE square takes the ENTIRE pot.

Stake SOL on the bull board, verifiable VRF picks the winning square, the whole pot pays out in $ANSEM. Nobody hits? It ALL rolls into the next round — and the jackpot keeps growing until someone takes it.

Play the devnet beta → <URL>

<GIF>

**2/**
How it works:

1. Grab free devnet SOL (faucet linked in-app)
2. Pick your bull(s) and stake — ONE wallet approval, straight from your wallet
3. VRF settles on-chain every 60 seconds
4. Hit the square → claim the whole pot in $ANSEM. Nobody hit → watch the jackpot roll and fatten

No signups. No emails. No deposits held anywhere — your SOL moves only when you stake.

**3/**
Under the hood (for the builders):

• Anchor program on Solana devnet — stakes go wallet→pot inside the stake tx, payouts are pull-claims, solvency by construction
• @magicblock ephemeral VRF settles every round — verifiable randomness, no admin dice
• A keeper cranks rounds hands-off, around the clock
• Every round, stake and payout is a public transaction — the app links you straight to the explorer to check the math

**4/**
The fine print (read it):

ANSEM Miner is an unofficial fan project — not affiliated with or endorsed by Ansem. This is a devnet beta: devnet SOL + a mock ANSEM test token only. No real funds are used, held, or paid out.

Real thing is being built in the open. Bulls first. 🐂

## MagicBlock Discord drop (ecosystem/showcase channel)

> Shipped: ANSEM Miner — a winner-take-all grid game settled by MagicBlock ephemeral VRF every 60 seconds, cranked hands-off by a keeper (1,000+ consecutive devnet rounds and counting). One square takes the whole pot; unhit pots roll over on-chain. Devnet beta: <URL> — feedback very welcome. (The ER + session-key rails are built and tested too — they're our upcoming gasless "automation mode"; happy to write up integration notes.)

## Landing hook (if we add a hero line to the app later — post-launch backlog)

"25 bulls. One takes the whole pot. Every 60 seconds."

## Do-NOT list (legal/brand discipline)

- No $ANSEM price talk, no "earnings", no APY/returns language — it's a devnet game with test tokens.
- No implication of Ansem's involvement; disclaimer language travels with every post.
- No "coming to mainnet on <date>" promises — mainnet is gated on audit + legal + liquidity, announced when it clears.
