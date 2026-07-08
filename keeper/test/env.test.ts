import { describe, it, expect } from "vitest";
import { Keypair } from "@solana/web3.js";
import { loadKeeperConfig } from "../src/env.js";

const kp = Keypair.generate();
const fakeLoad = (_path: string) => kp;

const baseEnv = {
  ANCHOR_PROVIDER_URL: "https://rpc.example",
  WS_ENDPOINT: "wss://rpc.example",
  DEVNET_WALLET: "/tmp/kp.json",
};

describe("loadKeeperConfig", () => {
  it("fills defaults for optional fields", () => {
    const cfg = loadKeeperConfig(baseEnv as any, fakeLoad);
    expect(cfg.rpcUrl).toBe("https://rpc.example");
    expect(cfg.erEndpoint).toBe("https://devnet-us.magicblock.app");
    expect(cfg.validator.toBase58()).toBe("MUS3hc9TCw4cGC12vHNoYcCGzJG1txjgQLZWVoeNHNd");
    expect(cfg.roundDurationSecs).toBe(60);
    expect(cfg.graceSecs).toBe(180);
    expect(cfg.pollMs).toBe(4000);
    expect(cfg.httpPort).toBe(8787);
    expect(cfg.adminKeypair.publicKey.equals(kp.publicKey)).toBe(true);
  });

  it("honors overrides", () => {
    const cfg = loadKeeperConfig(
      { ...baseEnv, KEEPER_ROUND_SECS: "30", KEEPER_HTTP_PORT: "9000", VALIDATOR: "MUS3hc9TCw4cGC12vHNoYcCGzJG1txjgQLZWVoeNHNd" } as any,
      fakeLoad,
    );
    expect(cfg.roundDurationSecs).toBe(30);
    expect(cfg.httpPort).toBe(9000);
  });

  it("direct mode is off by default and on with KEEPER_DIRECT_MODE=1", () => {
    expect(loadKeeperConfig(baseEnv as any, fakeLoad).directMode).toBe(false);
    expect(loadKeeperConfig({ ...baseEnv, KEEPER_DIRECT_MODE: "1" } as any, fakeLoad).directMode).toBe(true);
  });

  it("throws when a required var is missing", () => {
    expect(() => loadKeeperConfig({ WS_ENDPOINT: "x", DEVNET_WALLET: "y" } as any, fakeLoad))
      .toThrow(/ANCHOR_PROVIDER_URL/);
  });
});
