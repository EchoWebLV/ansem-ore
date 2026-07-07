import type { WireSnapshot, KeeperEvent } from "@ansem/sdk";

export type KeeperStatus = "connecting" | "connected" | "disconnected";

export interface KeeperClientOpts {
  wsUrl: string;
  httpUrl: string;
  onSnapshot: (snap: WireSnapshot) => void;
  onEvents?: (events: KeeperEvent[]) => void;
  onStatus?: (status: KeeperStatus) => void;
  reconnectMs?: number;
  WebSocketImpl?: typeof WebSocket;
  fetchImpl?: typeof fetch;
}

export interface KeeperClient { start: () => void; stop: () => void; }

/**
 * Read-only keeper client: REST cold-load + WS live push with reconnect.
 * All I/O is injectable so it is fully unit-tested without a network.
 */
export function createKeeperClient(opts: KeeperClientOpts): KeeperClient {
  const WS = opts.WebSocketImpl ?? WebSocket;
  const doFetch = opts.fetchImpl ?? fetch;
  const reconnectMs = opts.reconnectMs ?? 2000;
  let ws: WebSocket | null = null;
  let stopped = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const setStatus = (s: KeeperStatus) => opts.onStatus?.(s);

  async function coldLoad() {
    try {
      const res = await doFetch(`${opts.httpUrl}/snapshot`);
      if (res.ok) opts.onSnapshot((await res.json()) as WireSnapshot);
    } catch { /* WS will deliver the next frame; ignore cold-load miss */ }
  }

  function connect() {
    if (stopped) return;
    setStatus("connecting");
    const sock = new WS(opts.wsUrl);
    ws = sock;
    sock.onopen = () => setStatus("connected");
    sock.onmessage = (ev: MessageEvent) => {
      try {
        const frame = JSON.parse(String(ev.data)) as { snapshot?: WireSnapshot; events?: KeeperEvent[] };
        if (frame.snapshot) opts.onSnapshot(frame.snapshot);
        if (frame.events && frame.events.length) opts.onEvents?.(frame.events);
      } catch { /* ignore malformed frame */ }
    };
    sock.onerror = () => { try { sock.close(); } catch { /* noop */ } };
    sock.onclose = () => {
      setStatus("disconnected");
      if (!stopped) reconnectTimer = setTimeout(connect, reconnectMs);
    };
  }

  return {
    start() {
      stopped = false;
      void coldLoad();
      connect();
    },
    stop() {
      stopped = true;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      if (ws) { try { ws.close(); } catch { /* noop */ } ws = null; }
    },
  };
}
