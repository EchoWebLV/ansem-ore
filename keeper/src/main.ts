import { loadKeeperConfig, fsLoadKeypair } from "./env.js";
import { createService } from "./service.js";
import { makeLogger } from "./logger.js";

const log = makeLogger();
const cfg = loadKeeperConfig(process.env, fsLoadKeypair);
const service = createService(cfg, log);

process.on("SIGINT", () => { log.info("shutting down"); void service.stop().then(() => process.exit(0)); });
process.on("SIGTERM", () => { void service.stop().then(() => process.exit(0)); });

service.start().catch((e) => { log.error("keeper crashed", { err: String(e) }); process.exit(1); });
