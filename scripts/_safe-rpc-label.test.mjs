import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

let safeRpcLabel;
try {
  ({ safeRpcLabel } = await import("./_safe-rpc-label.mjs"));
} catch {
  safeRpcLabel = undefined;
}

test("reduces an RPC URL with credentials to its non-secret origin", () => {
  assert.equal(typeof safeRpcLabel, "function", "safeRpcLabel helper must exist");

  const rpc = "https://alice:password@rpc.example.com:8899/v2/path-secret?api-key=query-secret#fragment-secret";
  const label = safeRpcLabel(rpc);

  assert.equal(label, "https://rpc.example.com:8899");
  assert.doesNotMatch(label, /alice|password|path-secret|query-secret|fragment-secret/);
});

test("does not echo an invalid RPC value", () => {
  assert.equal(typeof safeRpcLabel, "function", "safeRpcLabel helper must exist");

  const label = safeRpcLabel("not-a-url-with-secret-credential");

  assert.equal(label, "(custom RPC endpoint)");
  assert.doesNotMatch(label, /secret-credential/);
});

test("seed plan prints the safe RPC label instead of the configured URL", () => {
  const source = readFileSync(new URL("./seed-jackpot-roll.mjs", import.meta.url), "utf8");

  assert.match(source, /rpc:\s*safeRpcLabel\(RPC\)/);
  assert.doesNotMatch(source, /rpc:\s*RPC[,\s]/);
});
