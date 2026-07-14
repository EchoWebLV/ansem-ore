export function Disclaimer() {
  return (
    <footer
      data-testid="disclaimer"
      className="mx-auto max-w-3xl px-4 py-6 text-center text-xs leading-relaxed text-zinc-500"
    >
      ANSEM Miner is an <strong>unofficial fan project</strong> — not affiliated with or
      endorsed by Ansem. BullStake Phase I runs on <strong>Solana mainnet</strong>: stakes
      are real SOL, the round&apos;s winner takes the whole pot paid in ANSEM, and every
      stake and payout is publicly verifiable on-chain.{" "}
      <strong>Only stake what you can afford to lose.</strong>
    </footer>
  );
}
