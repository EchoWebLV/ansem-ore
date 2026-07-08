"use client";
import { useCallback, useRef, type ReactNode } from "react";

/**
 * Perspective stage for the board card: mouse-tilt holo effect on fine pointers,
 * inert on touch (scrolling must win) and under prefers-reduced-motion. Writes the
 * transform straight to the node — zero re-renders per pointer move.
 */
export function Stage({ children }: { children: ReactNode }) {
  const card = useRef<HTMLDivElement>(null);
  const raf = useRef(0);

  const apply = (rx: number, ry: number) => {
    const el = card.current;
    if (el) el.style.transform = `rotateX(${rx.toFixed(2)}deg) rotateY(${ry.toFixed(2)}deg)`;
  };

  const onMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== "mouse") return;
    if (typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const r = e.currentTarget.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width - 0.5;
    const py = (e.clientY - r.top) / r.height - 0.5;
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(() => apply(-py * 7, px * 9));
  }, []);

  const onLeave = useCallback(() => {
    cancelAnimationFrame(raf.current);
    apply(0, 0);
  }, []);

  return (
    <div className="stage" onPointerMove={onMove} onPointerLeave={onLeave}>
      <div ref={card} className="stage-card">
        {children}
      </div>
    </div>
  );
}
