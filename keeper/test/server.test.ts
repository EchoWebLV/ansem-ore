import { describe, it, expect, afterEach } from "vitest";
import { WebSocket } from "ws";
import { RoundState } from "@ansem/sdk";
import { startReadServer, ReadServer } from "../src/read/server.js";
import type { FullSnapshot } from "../src/read/snapshot.js";

const grid = () => Array.from({ length: 25 }, () => 0n);
const snap = (roundId: number): FullSnapshot => ({
  roundId, state: RoundState.Open, deadlineTs: 5000, pot: 3n, blockSol: grid(),
  jackpotSquare: null, jackpotPool: 0n, rolloverJackpot: 0n, updatedAt: 1,
  leaderboard: [], recentEvents: [],
});

let server: ReadServer;
afterEach(async () => { await server?.close(); });

describe("read server", () => {
  it("serves the current snapshot over REST (bigint as string)", async () => {
    const current: FullSnapshot | null = snap(100);
    server = await startReadServer(0, () => current);
    const res = await fetch(`http://127.0.0.1:${server.port}/snapshot`);
    const body = await res.json();
    expect(body.roundId).toBe(100);
    expect(body.pot).toBe("3"); // bigint serialized as string
  });

  it("pushes the snapshot to a ws client on connect and on broadcast", async () => {
    let current: FullSnapshot | null = snap(100);
    server = await startReadServer(0, () => current);
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
    const messages: any[] = [];
    await new Promise<void>((resolve, reject) => {
      ws.on("message", (d) => { messages.push(JSON.parse(d.toString())); resolve(); });
      ws.on("error", reject);
    });
    expect(messages[0].snapshot.roundId).toBe(100); // initial push on connect

    const got = new Promise<any>((resolve) => ws.on("message", (d) => resolve(JSON.parse(d.toString()))));
    current = snap(101);
    server.broadcast(current, [{ type: "round.open", roundId: 101, deadlineTs: 5000 }]);
    const msg = await got;
    expect(msg.snapshot.roundId).toBe(101);
    expect(msg.events[0].type).toBe("round.open");
    ws.close();
  });
});
