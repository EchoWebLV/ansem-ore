import assert from "node:assert/strict";
import test from "node:test";

import { rollStampedRound } from "./_seed-beef-roll.mjs";

test("waits for BeefRound and retries roll until the send succeeds", async () => {
  const events = [];
  let reads = 0;
  let sends = 0;

  const result = await rollStampedRound({
    roundId: 17,
    attempts: 4,
    delayMs: 250,
    readBeefRound: async () => {
      reads += 1;
      events.push(`read:${reads}`);
      return reads === 1 ? null : { emission: 84_000_000n };
    },
    sendRoll: async () => {
      sends += 1;
      events.push(`send:${sends}`);
      if (sends === 1) throw new Error("transient rpc failure");
      return "roll-signature";
    },
    sleep: async (ms) => events.push(`sleep:${ms}`),
  });

  assert.equal(result, "roll-signature");
  assert.deepEqual(events, [
    "read:1",
    "sleep:250",
    "read:2",
    "send:1",
    "sleep:250",
    "read:3",
    "send:2",
  ]);
});

test("throws the round ID and final failure after retry exhaustion", async () => {
  let sends = 0;

  await assert.rejects(
    rollStampedRound({
      roundId: 42,
      attempts: 3,
      delayMs: 0,
      readBeefRound: async () => ({ emission: 1n }),
      sendRoll: async () => {
        sends += 1;
        throw new Error(`rpc failure ${sends}`);
      },
      sleep: async () => {},
    }),
    (error) => {
      assert.match(error.message, /round 42/i);
      assert.match(error.message, /rpc failure 3/);
      return true;
    },
  );
  assert.equal(sends, 3);
});
