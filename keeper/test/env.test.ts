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
    // Mainnet real-payout layer defaults.
    expect(cfg.swapMode).toBe("mock");
    expect(cfg.jupBaseUrl).toBe("https://lite-api.jup.ag/swap/v1");
    expect(cfg.slippageBps).toBe(100);
    expect(cfg.buybackMinSol).toBe(0.05);
    expect(cfg.treasuryKeepSol).toBe(0.01);
    expect(cfg.inventoryMinAnsem).toBe(0);
  });

  it("swap config: defaults to mock, honors SWAP_MODE=real + jupiter/buyback overrides", () => {
    const cfg = loadKeeperConfig(
      { ...baseEnv, SWAP_MODE: "real", JUP_BASE_URL: "https://api.jup.ag/swap/v1",
        SLIPPAGE_BPS: "250", BUYBACK_MIN_SOL: "0.1", TREASURY_KEEP_SOL: "0.02", INVENTORY_MIN: "1000000" } as any,
      fakeLoad,
    );
    expect(cfg.swapMode).toBe("real");
    expect(cfg.jupBaseUrl).toBe("https://api.jup.ag/swap/v1");
    expect(cfg.slippageBps).toBe(250);
    expect(cfg.buybackMinSol).toBe(0.1);
    expect(cfg.treasuryKeepSol).toBe(0.02);
    expect(cfg.inventoryMinAnsem).toBe(1000000);
    // an unrecognized SWAP_MODE falls back to the safe mock path
    expect(loadKeeperConfig({ ...baseEnv, SWAP_MODE: "garbage" } as any, fakeLoad).swapMode).toBe("mock");
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
