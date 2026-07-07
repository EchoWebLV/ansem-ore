import { describe, it, expect, vi } from "vitest";
import { createKeeperClient, type KeeperStatus } from "./keeper-client.js";
import type { WireSnapshot } from "@ansem/sdk";

// Minimal fake WebSocket we can drive from the test.
class FakeWS {
  static instances: FakeWS[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  readyState = 0;
  constructor(public url: string) { FakeWS.instances.push(this); }
  close() { this.readyState = 3; this.onclose?.(); }
  open() { this.readyState = 1; this.onopen?.(); }
  emit(obj: unknown) { this.onmessage?.({ data: JSON.stringify(obj) }); }
}

const wireSnap = (roundId: number): WireSnapshot => ({
  roundId, state: 0, deadlineTs: 0, pot: "0", blockSol: Array(25).fill("0"),
  jackpotSquare: null, jackpotPool: "0", rolloverJackpot: "0", updatedAt: 1,
  leaderboard: [], recentEvents: [],
});

function setup(overrides: { fetchImpl?: typeof fetch } = {}) {
  FakeWS.instances = [];
  const snapshots: WireSnapshot[] = [];
  const statuses: KeeperStatus[] = [];
  const fetchImpl = overrides.fetchImpl ??
    (vi.fn().mockResolvedValue({ ok: true, json: async () => wireSnap(1) }) as unknown as typeof fetch);
  const client = createKeeperClient({
    wsUrl: "ws://x", httpUrl: "http://x",
    WebSocketImpl: FakeWS as unknown as typeof WebSocket,
    fetchImpl,
    reconnectMs: 10,
    onSnapshot: (s) => snapshots.push(s),
    onStatus: (s) => statuses.push(s),
  });
  return { client, snapshots, statuses, fetchImpl };
}

describe("createKeeperClient", () => {
  it("cold-loads the REST snapshot on start", async () => {
    const { client, snapshots } = setup();
    client.start();
    await vi.waitFor(() => expect(snapshots).toContainEqual(expect.objectContaining({ roundId: 1 })));
    client.stop();
  });

  it("forwards WS {snapshot, events} frames", async () => {
    const { client, snapshots } = setup();
    client.start();
    await vi.waitFor(() => expect(FakeWS.instances).toHaveLength(1));
    FakeWS.instances[0].open();
    FakeWS.instances[0].emit({ snapshot: wireSnap(2), events: [] });
    await vi.waitFor(() => expect(snapshots).toContainEqual(expect.objectContaining({ roundId: 2 })));
    client.stop();
  });

  it("reports connected/disconnected status and reconnects on close", async () => {
    const { client, statuses } = setup();
    client.start();
    await vi.waitFor(() => expect(FakeWS.instances).toHaveLength(1));
    FakeWS.instances[0].open();
    await vi.waitFor(() => expect(statuses).toContain("connected"));
    FakeWS.instances[0].close();
    await vi.waitFor(() => expect(statuses).toContain("disconnected"));
    // backoff should spin up a fresh socket
    await vi.waitFor(() => expect(FakeWS.instances.length).toBeGreaterThanOrEqual(2));
    client.stop();
  });

  it("stop() closes the socket and suppresses further reconnects", async () => {
    const { client } = setup();
    client.start();
    await vi.waitFor(() => expect(FakeWS.instances).toHaveLength(1));
    client.stop();
    const countAfterStop = FakeWS.instances.length;
    FakeWS.instances[0].close();
    await new Promise((r) => setTimeout(r, 30));
    expect(FakeWS.instances).toHaveLength(countAfterStop); // no reconnect after stop
  });
});
