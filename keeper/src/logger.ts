export type LogLevel = "info" | "warn" | "error";
export interface Logger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

const jsonSafe = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);

export function makeLogger(
  sink: (line: string) => void = (l) => console.log(l),
  now: () => number = () => Date.now(),
): Logger {
  const emit = (level: LogLevel, msg: string, fields?: Record<string, unknown>) =>
    sink(JSON.stringify({ t: now(), level, msg, ...fields }, jsonSafe));
  return {
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
  };
}
