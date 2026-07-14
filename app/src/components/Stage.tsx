import type { ReactNode } from "react";

export function Stage({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={`stage ${className ?? ""}`}>{children}</div>;
}
