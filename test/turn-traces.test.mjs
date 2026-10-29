import test from "node:test";
import assert from "node:assert/strict";
import { TurnTraces, sendResult } from "../bridge/turn-traces.mjs";
const setup = () => {
  let now = 1000;
  const rows = [];
  return {
    rows,
    t: new TurnTraces((r) => rows.push(r), { now: () => now, timeoutMs: 100 }),
    advance: (n) => (now += n),
  };
};
test("business errors and partial bursts are reflected in delivery status", () => {
  const result = sendResult({
    content: [
      {
        text: JSON.stringify({
          ok: false,
          sent: 2,
          failed: 1,
          error: "network",
        }),
      },
    ],
  });
  assert.equal(result.ok, false);
  assert.equal(result.sent, 2);
  const { t, rows } = setup();
  t.enqueue("s", "a", "p");
  t.start("s", "1");
  t.sent("s", result, "1");
  t.finish("s", "1");
  assert.equal(rows.at(-1).status, "partial");
  assert.equal(rows.at(-1).sent, 2);
  assert.equal(sendResult({ content: [{ text: '{"ok":false}' }] }).sent, 0);
});
test("silent first turn, auxiliary turn, then multiple replies bind to correct trace", () => {
  const { t, rows } = setup();
  t.enqueue("s", "a", "p");
  t.enqueue("s", null, "p");
  t.enqueue("s", "b", "p");
  t.start("s", "1");
  t.finish("s", "1");
  t.start("s", "2");
  t.finish("s", "2");
  t.start("s", "3");
  t.sent("s", { ok: true, sent: 1 }, "3");
  t.sent("s", { ok: true, sent: 2 }, "3");
  t.finish("s", "3");
  assert.equal(rows.filter((r) => r.traceId === "a").at(-1).status, "no-reply");
  assert.equal(rows.at(-1).traceId, "b");
  assert.equal(rows.at(-1).sent, 3);
  assert.equal(t.turns.size, 0);
});
test("concurrent starts require explicit identity; reverse completion is safe; replays do not consume queue", () => {
  const { t, rows } = setup();
  t.enqueue("s", "a", "p");
  t.enqueue("s", "b", "p");
  t.start("s", "1");
  t.start("s", "1");
  t.start("s", "2");
  assert.equal(t.sent("s", { ok: true, sent: 1 }), false);
  t.sent("s", { ok: true, sent: 1 }, "2");
  t.finish("s", "2");
  t.finish("s", "1");
  t.enqueue("s", "c", "p");
  t.start("s", "2");
  assert.equal(t.pending.get("s").length, 1);
  assert.equal(rows.find((r) => r.status === "sent").traceId, "b");
});
test("rejected prompt and command do not occupy a model-turn slot", () => {
  const { t, rows } = setup();
  t.cancel(t.enqueue("s", "bad", "p"), "rejected");
  t.cancel(t.enqueue("s", "cmd", "p"), "command", "command");
  t.enqueue("s", "good", "p");
  t.start("s", "t");
  t.sent("s", { ok: false, sent: 0 }, "t");
  t.finish("s", "t");
  assert.equal(rows.at(-1).traceId, "good");
  assert.equal(rows.at(-1).status, "failed");
});
test("lost dispatch acceptance or timeout disables guessing until session rotation", () => {
  const { t, rows, advance } = setup();
  t.enqueue("s", "old", "p");
  advance(101);
  t.enqueue("s", "new", "p");
  assert.equal(t.start("s", "late"), null);
  assert.equal(rows.at(-1).status, "unknown");
  t.enqueue("s2", "fresh", "p");
  assert.equal(t.start("s2", "1").traceId, "fresh");
  t.invalidate("s2", "disconnect");
  assert.equal(t.sent("s2", { ok: true, sent: 1 }, "1"), false);
});
