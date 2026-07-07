"use client";
import { useEffect, useRef, useState } from "react";
import type { WireSnapshot, KeeperEvent } from "@ansem/sdk";
import { createKeeperClient, type KeeperClient, type KeeperClientOpts, type KeeperStatus } from "../lib/keeper-client.js";

export interface UseKeeperOpts {
  wsUrl: string;
  httpUrl: string;
  maxEvents?: number;
  /** Injectable for tests; defaults to the real client. */
  clientFactory?: (opts: KeeperClientOpts) => KeeperClient;
}

export interface KeeperView {
  snapshot: WireSnapshot | null;
  events: KeeperEvent[];
  status: KeeperStatus;
}

export function useKeeperSnapshot(opts: UseKeeperOpts): KeeperView {
  const { wsUrl, httpUrl, maxEvents = 30, clientFactory = createKeeperClient } = opts;
  const [snapshot, setSnapshot] = useState<WireSnapshot | null>(null);
  const [events, setEvents] = useState<KeeperEvent[]>([]);
  const [status, setStatus] = useState<KeeperStatus>("connecting");
  const factoryRef = useRef(clientFactory);

  useEffect(() => {
    const client = factoryRef.current({
      wsUrl, httpUrl,
      onSnapshot: setSnapshot,
      onEvents: (incoming) => setEvents((prev) => [...incoming.slice().reverse(), ...prev].slice(0, maxEvents)),
      onStatus: setStatus,
    });
    client.start();
    return () => client.stop();
  }, [wsUrl, httpUrl, maxEvents]);

  return { snapshot, events, status };
}
