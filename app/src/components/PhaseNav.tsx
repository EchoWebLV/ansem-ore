import { BullLogo } from "./BullLogo.js";

/**
 * Product nav above the wallet row: the BullStake mark plus the phase roadmap.
 * Phase I (ANSEM Miner) is the product that is live today; II and III are
 * future phases and stay disabled until they ship.
 */
const PHASES = [
  { label: "PHASE I", live: true },
  { label: "PHASE II", live: false },
  { label: "PHASE III", live: false },
] as const;

export function PhaseNav() {
  return (
    <nav
      data-testid="phase-nav"
      aria-label="BullStake phases"
      className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2"
    >
      <div className="flex items-center gap-2.5">
        <BullLogo size={38} />
        <span className="font-mono text-[15px] lg:text-[17px] font-semibold tracking-[4px]">
          <span className="text-bull-green" style={{ textShadow: "0 0 18px rgba(53,224,122,0.45)" }}>
            BULL
          </span>
          <span className="text-bull-gold" style={{ textShadow: "0 0 18px rgba(232,196,82,0.45)" }}>
            STAKE
          </span>
        </span>
      </div>
      <div role="group" aria-label="Phases" className="flex items-center gap-2">
        {PHASES.map(({ label, live }) => (
          <button
            key={label}
            type="button"
            disabled={!live}
            title={live ? undefined : "Coming soon"}
            aria-current={live ? "page" : undefined}
            className={
              live
                ? "rounded-full border border-bull-green bg-[rgba(53,224,122,0.12)] px-3 py-[6px] font-mono text-[10px] lg:text-[11px] tracking-[2px] text-bull-green shadow-[0_0_18px_-6px_rgba(53,224,122,0.9)]"
                : "rounded-full border border-bull-edge bg-transparent px-3 py-[6px] font-mono text-[10px] lg:text-[11px] tracking-[2px] text-bull-muted opacity-50 cursor-not-allowed"
            }
          >
            {live ? (
              <span
                aria-hidden
                className="glow-live mr-1.5 inline-block h-[6px] w-[6px] rounded-full bg-bull-green align-middle"
              />
            ) : (
              <svg
                width="9"
                height="10"
                viewBox="0 0 9 10"
                aria-hidden
                className="mr-1.5 inline-block align-[-1px] opacity-70"
              >
                <rect x="1" y="4.5" width="7" height="5" rx="1" fill="currentColor" />
                <path d="M2.5 4.5V3a2 2 0 0 1 4 0v1.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
              </svg>
            )}
            {label}
          </button>
        ))}
      </div>
    </nav>
  );
}
