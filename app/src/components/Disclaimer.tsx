export function Disclaimer() {
  return (
    <footer
      data-testid="disclaimer"
      className="mx-auto max-w-3xl px-4 py-6 text-center text-xs leading-relaxed text-zinc-500"
    >
      ANSEM Miner is an <strong>unofficial fan project</strong> — not affiliated with or
      endorsed by Ansem. This is a <strong>devnet beta</strong>: it uses Solana devnet SOL
      and a mock ANSEM test token only. <strong>No real funds</strong> are used, held, or
      paid out. Play is for entertainment and testing.
    </footer>
  );
}
