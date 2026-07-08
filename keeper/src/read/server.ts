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
  // A server- or socket-level 'error' with no listener is an UNHANDLED 'error' event,
  // which Node's EventEmitter rethrows — crashing the whole keeper process over a single
  // misbehaving client (abrupt disconnect, protocol error, write-after-close).
  wss.on("error", () => { /* swallow: a bad listener/socket must not take down the keeper */ });

  const safeSend = (ws: WebSocket, payload: string) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    try { ws.send(payload); } catch { /* client vanished mid-send — ignore */ }
  };

  wss.on("connection", (ws: WebSocket) => {
    ws.on("error", () => { /* abrupt disconnect / protocol error — swallow, don't crash */ });
    const snap = getSnapshot();
    if (snap) safeSend(ws, encode({ snapshot: snap, events: [] }));
  });

  return new Promise((resolve, reject) => {
    http.once("error", reject); // bind failure (e.g. port in use) -> reject instead of hanging
    http.listen(port, "127.0.0.1", () => {
      http.removeListener("error", reject);
      const actualPort = (http.address() as AddressInfo).port;
      resolve({
        port: actualPort,
        broadcast: (snapshot, events) => {
          const payload = encode({ snapshot, events });
          for (const client of wss.clients) safeSend(client, payload);
        },
        close: () => new Promise<void>((res) => {
          for (const client of wss.clients) client.terminate(); // don't wait on live sockets to drain
          wss.close();
          http.close(() => res());
        }),
      });
    });
  });
}
