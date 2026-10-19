// SSE hub limits: connections per IP and in total, and a stalled client dropped on backpressure.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventHub } from "../lib/events.mjs";

/** A fake express req/res pair: records what the hub wrote and lets a test stall the socket. */
function pair(ip, { writableLength = 0 } = {}) {
  const res = { ip, frames: [], headers: {}, statusCode: 200, body: null, destroyed: false, writableLength,
    writeHead(status) { this.statusCode = status; }, write(s) { this.frames.push(s); return this.writableLength === 0; },
    setHeader(k, v) { this.headers[k] = v; }, status(s) { this.statusCode = s; return this; }, json(b) { this.body = b; return this; },
    end() {}, destroy() { this.destroyed = true; } };
  const req = { ip, handlers: {}, on(ev, fn) { this.handlers[ev] = fn; }, close() { this.handlers.close?.(); } };
  return { req, res };
}

test("per-IP and global caps answer 429/503 with Retry-After; closing a stream frees its slot", () => {
  const hub = new EventHub({ heartbeatMs: 60_000, maxClients: 4, maxPerIp: 2 });
  try {
    const a1 = pair("10.0.0.1"), a2 = pair("10.0.0.1"), a3 = pair("10.0.0.1");
    hub.attach(a1.req, a1.res); hub.attach(a2.req, a2.res); hub.attach(a3.req, a3.res);
    assert.equal(hub.clients.size, 2);
    assert.equal(a3.res.statusCode, 429); assert.equal(a3.res.headers["retry-after"], "10"); assert.match(a3.res.body.error, /at most 2 event streams per client/);
    assert.equal(a1.res.frames[0], ": connected\n\n");
    const b1 = pair("10.0.0.2"), b2 = pair("10.0.0.3"), b3 = pair("10.0.0.4");
    hub.attach(b1.req, b1.res); hub.attach(b2.req, b2.res); hub.attach(b3.req, b3.res);
    assert.equal(hub.clients.size, 4);
    assert.equal(b3.res.statusCode, 503); assert.equal(b3.res.body.retryAfter, 30);
    assert.equal(hub.stats.refused, 2);
    a1.req.close();
    assert.equal(hub.clients.size, 3); assert.equal(hub.perIp.get("10.0.0.1"), 1);
    const a4 = pair("10.0.0.1"); hub.attach(a4.req, a4.res);
    assert.equal(a4.res.statusCode, 200, "the freed slot is reusable");
    hub.emit("coin", { mint: "A" });
    assert.ok(a2.res.frames.includes('event: coin\ndata: {"mint":"A"}\n\n'));
    assert.ok(!a1.res.frames.some((f) => f.includes("event: coin")), "a closed stream gets nothing");
  } finally { hub.close(); }
});

test("a client whose socket buffer never drains is destroyed instead of buffering forever", () => {
  const hub = new EventHub({ heartbeatMs: 60_000, maxBuffered: 100 });
  try {
    const slow = pair("10.0.0.9", { writableLength: 101 }), fine = pair("10.0.0.8");
    hub.attach(slow.req, slow.res); hub.attach(fine.req, fine.res);
    hub.emit("stats", { n: 1 });
    assert.equal(slow.res.destroyed, true); assert.equal(hub.clients.has(slow.res), false); assert.equal(hub.perIp.has("10.0.0.9"), false);
    assert.equal(fine.res.destroyed, false); assert.equal(hub.clients.size, 1); assert.equal(hub.stats.dropped, 1);
  } finally { hub.close(); }
});
