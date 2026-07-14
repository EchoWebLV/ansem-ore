import type { WireSnapshot, KeeperEvent, WireMessage } from "@ansem/sdk";

export type KeeperStatus = "connecting" | "connected" | "disconnected";

/**
 * The wire snapshot as the keeper actually serves it: the SDK's `WireSnapshot`
 * plus keeper-appended, additive-optional fields. `claimWindowSecs` = seconds a
 * win stays claimable past a round's deadline. `jackpotTriggerOdds` = the 1-in-N
 * jackpot-round odds (added alongside the BEEF launch; older keepers omit it).
 * All are optional so a snapshot from an older keeper (or a cold-load race) simply
 * renders without that detail rather than crashing.
 */
export interface AppSnapshot extends WireSnapshot {
  claimWindowSecs?: number;
  jackpotTriggerOdds?: number;
}

export interface KeeperClientOpts {
  wsUrl: string;
  httpUrl: string;
  onSnapshot: (snap: AppSnapshot) => void;
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
  const baseReconnectMs = opts.reconnectMs ?? 1000;
  const maxReconnectMs = 15_000;
  let reconnectDelay = baseReconnectMs;
  let ws: WebSocket | null = null;
  let stopped = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const setStatus = (s: KeeperStatus) => opts.onStatus?.(s);

  async function coldLoad() {
    try {
      const res = await doFetch(`${opts.httpUrl}/snapshot`);
      // Guard: a fetch that resolves after stop() must not push a stale snapshot
      // (symmetry with connect()'s `stopped` check).
      if (res.ok && !stopped) opts.onSnapshot((await res.json()) as AppSnapshot);
    } catch { /* WS will deliver the next frame; ignore cold-load miss */ }
  }

  function connect() {
    if (stopped) return;
    setStatus("connecting");
    const sock = new WS(opts.wsUrl);
    ws = sock;
    sock.onopen = () => { reconnectDelay = baseReconnectMs; setStatus("connected"); };
    sock.onmessage = (ev: MessageEvent) => {
      try {
        const frame = JSON.parse(String(ev.data)) as Partial<WireMessage>;
        if (frame.snapshot) opts.onSnapshot(frame.snapshot);
        if (frame.events && frame.events.length) opts.onEvents?.(frame.events);
      } catch { /* ignore malformed frame */ }
    };
    sock.onerror = () => { try { sock.close(); } catch { /* noop */ } };
    sock.onclose = () => {
      setStatus("disconnected");
      if (!stopped) {
        reconnectTimer = setTimeout(connect, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, maxReconnectMs); // exponential backoff, capped
      }
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
