import type { ReactNode } from "react";

/**
 * Unified product header: the BullStake mark + wordmark on the left, the phase
 * roadmap as a segmented control on the right, and a slot ({children}) where the
 * PlayBoard drops the wallet button. Phase I (ANSEM Miner) is the product that is
 * live today; II and III are future phases and stay locked until they ship.
 */
const PHASES = [
  { label: "PHASE I", live: true },
  { label: "PHASE II", live: false },
  { label: "PHASE III", live: false },
] as const;

export function PhaseNav({ children }: { children?: ReactNode }) {
  return (
    <nav
      data-testid="phase-nav"
      aria-label="BullStake phases"
      className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3"
    >
      <div className="flex items-center gap-3">
        {/* eslint-disable-next-line @next/next/no-img-element -- static brand SVG; next/image is overkill for a 44px inline mark */}
        <img src="/bullstake-logo.svg" alt="" width={44} height={44} aria-hidden className="shrink-0" />
        <div className="leading-none">
          <div className="font-mono font-extrabold text-[19px] lg:text-[22px] tracking-[1.5px]">
            <span className="text-bull-green" style={{ textShadow: "0 0 18px rgba(53,224,122,0.45)" }}>
              BULL
            </span>
            <span className="text-bull-gold" style={{ textShadow: "0 0 18px rgba(232,196,82,0.45)" }}>
              STAKE
            </span>
          </div>
          <div className="mt-1.5 font-mono text-[9px] lg:text-[10px] tracking-[3px] text-bull-muted">
            ANSEM MINER
          </div>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <div
          role="group"
          aria-label="Phases"
          className="inline-flex items-center gap-1 rounded-2xl border border-bull-edge bg-white/[0.03] p-1"
        >
          {PHASES.map(({ label, live }) => (
            <button
              key={label}
              type="button"
              disabled={!live}
              title={live ? undefined : "Coming soon"}
              aria-current={live ? "page" : undefined}
              className={
                live
                  ? "whitespace-nowrap rounded-xl bg-bull-green px-4 py-2 font-mono text-[11px] lg:text-[12px] font-extrabold tracking-[1.5px] text-black shadow-[0_0_28px_-4px_rgba(53,224,122,0.85)]"
                  : "whitespace-nowrap rounded-xl px-4 py-2 font-mono text-[11px] lg:text-[12px] font-bold tracking-[1.5px] text-bull-muted/70 cursor-not-allowed"
              }
            >
              {live ? (
                <span
                  aria-hidden
                  className="glow-live mr-1.5 inline-block h-[6px] w-[6px] rounded-full bg-black align-middle"
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
        {children}
      </div>
    </nav>
  );
}
