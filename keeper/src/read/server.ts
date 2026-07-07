import { createServer, Server } from "node:http";
import { AddressInfo } from "node:net";
import { WebSocketServer, WebSocket } from "ws";
import type { FullSnapshot } from "./snapshot.js";
import type { KeeperEvent } from "./events.js";

export interface ReadServer {
  port: number;
  broadcast: (snapshot: FullSnapshot, events: KeeperEvent[]) => void;
  close: () => Promise<void>;
}

const jsonSafe = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);
const encode = (obj: unknown) => JSON.stringify(obj, jsonSafe);

export function startReadServer(
  port: number,
  getSnapshot: () => FullSnapshot | null,
): Promise<ReadServer> {
  const http: Server = createServer((req, res) => {
    if (req.url === "/health") { res.writeHead(200).end("ok"); return; }
    if (req.url === "/snapshot") {
      const snap = getSnapshot();
      res.writeHead(snap ? 200 : 503, { "content-type": "application/json", "access-control-allow-origin": "*" });
      res.end(snap ? encode(snap) : encode({ error: "no snapshot yet" }));
      return;
    }
    res.writeHead(404).end();
  });

  const wss = new WebSocketServer({ server: http });
  wss.on("connection", (ws: WebSocket) => {
    const snap = getSnapshot();
    if (snap) ws.send(encode({ snapshot: snap, events: [] }));
  });

  return new Promise((resolve) => {
    http.listen(port, "127.0.0.1", () => {
      const actualPort = (http.address() as AddressInfo).port;
      resolve({
        port: actualPort,
        broadcast: (snapshot, events) => {
          const payload = encode({ snapshot, events });
          for (const client of wss.clients) if (client.readyState === WebSocket.OPEN) client.send(payload);
        },
        close: () => new Promise<void>((res) => { wss.close(); http.close(() => res()); }),
      });
    });
  });
}
