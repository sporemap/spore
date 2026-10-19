// Live subscription: reconnect backoff with jitter, the stale-socket watchdog, and no duplicate timers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { LogsSubscriber, jitter } from "../lib/live.mjs";

test("jitter: uniform in [base/2, base]", () => {
  assert.equal(jitter(1000, () => 0), 500);
  assert.equal(jitter(1000, () => 0.999999), 1000);
  for (let i = 0; i < 50; i++) { const j = jitter(30_000); assert.ok(j >= 15_000 && j <= 30_000, String(j)); }
});

test("a socket that fails to open backs off (1 s → 30 s, jittered), one timer at a time; stop clears it", async () => {
  const Real = globalThis.WebSocket;
  let opened = 0;
  globalThis.WebSocket = class { constructor() { opened++; throw new Error("ECONNREFUSED"); } };
  try {
    const warns = [];
    const sub = new LogsSubscriber({ wsUrl: "wss://x.example", programId: "P", onLogs() {}, log: { info() {}, warn: (m) => warns.push(m) }, staleMs: 60_000 }).start();
    assert.equal(opened, 1);
    assert.equal(sub.stats.errors, 1);
    assert.ok(sub.reconnectTimer, "a reconnect is scheduled");
    assert.equal(sub.backoffMs, 1000);
    assert.match(warns[0], /reconnecting in ([5-9]\d\d|1000) ms/);
    const snap = sub.snapshot();
    assert.equal(snap.connected, false); assert.equal(snap.reconnecting, true); assert.equal(snap.backoffMs, 1000);
    sub.stop();
    assert.equal(sub.reconnectTimer, null);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(opened, 1, "stopped: no further attempt");
  } finally { globalThis.WebSocket = Real; }
});
