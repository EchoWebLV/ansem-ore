"use client";
import { useCallback, useRef, type ReactNode } from "react";

/**
 * Perspective stage for the board card: mouse-tilt holo effect on fine pointers,
 * inert on touch (scrolling must win) and under prefers-reduced-motion. Writes the
 * transform + glare position straight to the node — zero re-renders per pointer move.
 */
export function Stage({ children, className }: { children: ReactNode; className?: string }) {
  const card = useRef<HTMLDivElement>(null);
  const raf = useRef(0);

  const apply = (rx: number, ry: number, gx: number, gy: number) => {
    const el = card.current;
    if (!el) return;
    el.style.transform = `rotateX(${rx.toFixed(2)}deg) rotateY(${ry.toFixed(2)}deg)`;
    el.style.setProperty("--gx", `${gx.toFixed(1)}%`);
    el.style.setProperty("--gy", `${gy.toFixed(1)}%`);
  };

  const onMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== "mouse") return;
    if (typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const r = e.currentTarget.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width - 0.5;
    const py = (e.clientY - r.top) / r.height - 0.5;
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(() => apply(-py * 8, px * 10, (px + 0.5) * 100, (py + 0.5) * 100));
  }, []);

  const onLeave = useCallback(() => {
    cancelAnimationFrame(raf.current);
    apply(0, 0, 50, 50);
  }, []);

  return (
    <div className="stage" onPointerMove={onMove} onPointerLeave={onLeave}>
      <div ref={card} className={`stage-card relative ${className ?? ""}`}>
        {children}
        {/* Cursor-tracked holo sheen (desktop hover only, see globals.css). */}
        <div className="stage-glare" aria-hidden />
      </div>
    </div>
  );
}
