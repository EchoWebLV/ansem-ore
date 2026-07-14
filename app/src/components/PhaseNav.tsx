import type { ReactNode } from "react";

export function PhaseNav({ children }: { children?: ReactNode }) {
  return (
    <nav data-testid="phase-nav" aria-label="BullStake product navigation" className="terminal-topbar gap-2 px-0 min-[360px]:gap-4">
      <div className="flex min-w-0 items-center gap-3">
        {/* eslint-disable-next-line @next/next/no-img-element -- static brand SVG; next/image is overkill for a 44px inline mark */}
        <img src="/bullstake-logo.svg" alt="" width={36} height={36} aria-hidden className="shrink-0 max-[359px]:hidden" />
        <div className="min-w-0 whitespace-nowrap">
          <div className="text-[16px] font-bold tracking-[-0.02em] text-bull-ink">
            Bull<span className="text-bull-green">Stake</span>
          </div>
          <div className="terminal-label mt-1 max-[359px]:hidden">ANSEM MINER</div>
        </div>
      </div>
      <span aria-current="page" className="hidden text-[12px] font-semibold text-bull-ink sm:block">
        Play
      </span>
      <div className="flex shrink-0 items-center justify-end gap-2 whitespace-nowrap">{children}</div>
    </nav>
  );
}
