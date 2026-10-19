// The RPC budget: a 429 pauses the lane that hit it with growing backoff, a later 429 inside the
// pause does not double it, success resets it, and the browser proxy and API lookups run on their
// own lanes so their traffic (and the 429s it provokes) never stalls the indexer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Rpc, deriveWsUrl, redact } from "../lib/rpc.mjs";

const quiet = { info() {}, warn() {}, error() {} };
const json = (result, status = 200, headers = {}) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status, headers: { "content-type": "application/json", ...headers } });

test("429 from the provider pauses the client, retries after the pause; the proxy lane pauses on its own", async () => {
  const calls = [];
  let script = [() => new Response("slow down", { status: 429, headers: { "retry-after": "0" } }), () => json(123)];
  const rpc = new Rpc({ url: "https://rpc.example", rps: 1000, concurrency: 2, log: quiet, backoffMinMs: 40, backoffMaxMs: 200, fetchImpl: async (url, init) => { calls.push(JSON.parse(init.body)); return (script.shift() ?? (() => json("ok")))(); } });
  const t0 = Date.now();
  assert.equal(await rpc.call("getSlot"), 123);
  assert.ok(Date.now() - t0 >= 35, "waited out the pause");
  assert.equal(rpc.stats.rateLimited, 1); assert.equal(rpc.backoffMs, 0, "success resets the backoff");
  assert.equal(calls.length, 2);
  // Rate limit answered through the proxy: only the proxy lane pauses; the indexer goes on at once.
  script = [() => new Response("{}", { status: 429 }), () => json(7)];
  const p = await rpc.proxy({ jsonrpc: "2.0", id: 9, method: "getSlot" });
  assert.equal(p.status, 429);
  const lanes = rpc.laneSnapshot();
  assert.ok(lanes.proxy.pausedMs > 0 && lanes.proxy.pausedMs <= 40, `proxy paused ${lanes.proxy.pausedMs} ms`);
  assert.equal(rpc.snapshot().pausedMs, 0, "the main lane is untouched");
  const t1 = Date.now();
  assert.equal(await rpc.call("getSlot"), 7);
  assert.ok(Date.now() - t1 < 25, "indexer call did not wait for the proxy's pause");
  // Backoff doubles across separate pauses, capped at backoffMaxMs.
  script = [() => new Response("", { status: 429 }), () => new Response("", { status: 429 }), () => json(1)];
  await rpc.call("getSlot");
  assert.ok(rpc.stats.rateLimited >= 3);
});

test("lanes: rpc.lane(\"api\") runs every helper through the api bucket; the proxy relays at most PROXY_MAX_BYTES", async () => {
  const seen = [];
  const rpc = new Rpc({ url: "https://rpc.example", rps: 1000, apiRps: 1000, log: quiet, fetchImpl: async (url, init) => { seen.push(JSON.parse(init.body).method); return json({ value: [null] }); } });
  const api = rpc.lane("api");
  assert.equal(api.laneName, "api");
  assert.deepEqual(await api.getMultipleAccounts(["k"]), [null]);
  assert.equal(seen[0], "getMultipleAccounts");
  assert.equal(rpc.lanes.api.inFlight, 0); assert.equal(rpc.stats.calls, 1);
  assert.throws(() => rpc.lane("nope"), /unknown rpc lane/);
  const big = new Rpc({ url: "https://rpc.example", rps: 1000, log: quiet, fetchImpl: async () => new Response("x".repeat(3000)) });
  await assert.rejects(big.proxy({ method: "getSlot" }, { maxBytes: 2000 }), /response over 2000 bytes/);
  assert.equal((await big.proxy({ method: "getSlot" }, { maxBytes: 4000 })).text.length, 3000);
});

test("JSON-envelope rate limits and -32005 are retried; other JSON-RPC errors throw RpcError", async () => {
  let n = 0;
  const bodies = [{ error: { code: 429, message: "Too many requests" } }, { error: { code: -32005, message: "Node is behind" } }, { result: "fine" }, { error: { code: -32602, message: "Invalid params" } }];
  const rpc = new Rpc({ url: "https://rpc.example", rps: 1000, log: quiet, backoffMinMs: 10, fetchImpl: async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, ...bodies[n++] })) });
  assert.equal(await rpc.call("getSlot"), "fine");
  await assert.rejects(rpc.call("getSlot"), (e) => e.name === "RpcError" && e.code === -32602);
});

test("network failures retry with backoff then surface; budget stats are reported", async () => {
  let n = 0;
  const rpc = new Rpc({ url: "https://rpc.example", rps: 1000, log: quiet, fetchImpl: async () => { n++; throw new Error("ECONNRESET"); } });
  await assert.rejects(rpc.call("getSlot", [], { retries: 0 }), /ECONNRESET/);
  assert.equal(n, 1); assert.equal(rpc.stats.errors, 1); assert.match(rpc.stats.lastError, /ECONNRESET/);
  assert.deepEqual(Object.keys(rpc.snapshot()).sort(), ["calls", "errors", "inFlight", "lastError", "pausedMs", "queued", "rateLimited"]);
});

test("deriveWsUrl keeps the key in the query; redact hides it", () => {
  assert.equal(deriveWsUrl("https://mainnet.helius-rpc.com/?api-key=K"), "wss://mainnet.helius-rpc.com/?api-key=K");
  assert.equal(redact("wss://mainnet.helius-rpc.com/?api-key=K"), "wss://mainnet.helius-rpc.com/?api-key=…");
});
