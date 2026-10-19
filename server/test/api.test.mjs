// Contract tests for the HTTP API against an in-memory tree (no network, no RPC).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, buildCandles, isMint, RPC_ALLOW, RPC_MAX_BATCH, txTouchesPump, rpcParamsError } from "../lib/api.mjs";
import { PUMP_PROGRAM_ID, PublicKey } from "../lib/sdk.mjs";
import { bs58 } from "../lib/indexer.mjs";
import { TransactionMessage, VersionedTransaction, SystemProgram, Keypair } from "@solana/web3.js";
import { EventHub } from "../lib/events.mjs";
import { ImageCache } from "../lib/meta.mjs";
import { buildTree, K, PLATFORM } from "./helpers/tree.mjs";
let server, base, model, db, hub, dir;

before(async () => {
  ({ db, model } = buildTree());
  const now = Math.floor(Date.now() / 1000);
  for (let i = 0; i < 5; i++) model.recordTrade({ sig: `S${i}`, mint: K.A, idx: 0, slot: i, time: now - 60 * i, isBuy: i % 2 === 0, user: "U", baseAmount: "1000000", quoteAmount: "2000000", priceQuote: 2 + i, priceUsd: 2e-5 + i * 1e-6, valueUsd: 0.02 });
  hub = new EventHub({ heartbeatMs: 200 });
  dir = mkdtempSync(join(tmpdir(), "spore-api-"));
  const images = new ImageCache(dir, { fetchImpl: async () => new Response(Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082", "hex"), { headers: { "content-type": "image/png" } }) });
  const rpcCalls = [];
  const rpc = { proxy: async (body) => { rpcCalls.push(body); return { status: 200, text: JSON.stringify({ jsonrpc: "2.0", id: 1, result: "ok" }) }; } };
  const indexer = { fetchCoin: async () => null, snapshot: () => ({ phase: "test" }), globalRaw: null, quoteControlRaw: null };
  const app = createApp({ model, indexer, rpc, hub, images, meta: null, platformWallet: PLATFORM, splitBps: [5000, 2500, 1000, 1500], distDir: null, origins: ["http://localhost:5174"], log: { info() {}, warn() {}, error() {} } });
  await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { hub.close(); server.close(); db.close(); rmSync(dir, { recursive: true, force: true }); });

const get = async (p) => { const r = await fetch(base + p); return { status: r.status, body: await r.json() }; };

test("GET /api/stats", async () => {
  const { status, body } = await get("/api/stats");
  assert.equal(status, 200);
  for (const k of ["coins", "roots", "byDepth", "lockedUsd", "volume24hUsd", "solUsd", "maxDepth", "backfill", "updatedAt"]) assert.ok(k in body, k);
  assert.equal(body.coins, 4); assert.equal(body.roots, 1); assert.equal(body.volume24hUsd, 0.1);
});

test("GET /api/feed: newest spawns first, before= pages", async () => {
  const { body } = await get("/api/feed?limit=2");
  assert.deepEqual(body.coins.map((c) => c.mint), [K.G, K.B]);
  assert.ok(body.coins.every((c) => c.depth >= 1));
  const page2 = await get("/api/feed?limit=2&before=3000");
  assert.deepEqual(page2.body.coins.map((c) => c.mint), [K.A]);
});

test("GET /api/roots: only parents at depth 0, sorts", async () => {
  const { body } = await get("/api/roots?sort=locked");
  assert.deepEqual(body.roots.map((r) => r.mint), [K.ROOT]);
  assert.equal(body.roots[0].children, 2); assert.equal(body.roots[0].descendants, 3);
  for (const s of ["children", "new", "volume"]) assert.equal((await get(`/api/roots?sort=${s}`)).body.roots.length, 1);
});

test("GET /api/coin/:mint: coin + children sorted by locked + last trades; 404 and 400", async () => {
  const { body } = await get(`/api/coin/${K.ROOT}`);
  assert.equal(body.coin.mint, K.ROOT);
  assert.deepEqual(body.children.map((c) => c.mint), [K.A, K.B]);
  assert.equal(body.trades.length, 0);
  const a = await get(`/api/coin/${K.A}`);
  assert.equal(a.body.trades.length, 5);
  for (const k of ["sig", "mint", "slot", "time", "isBuy", "user", "baseAmount", "quoteAmount", "priceQuote", "priceUsd"]) assert.ok(k in a.body.trades[0], k);
  assert.equal(a.body.coin.volume24hUsd, 0.1); assert.equal(a.body.coin.trades24h, 5);
  assert.equal((await get("/api/coin/9CuFcRfiqEsBEQUCPTTVHaruQU7n9N7HKNSEk5VEivu")).status, 404);
  assert.equal((await get("/api/coin/not-a-mint")).status, 400);
});

test("GET /api/tree/:mint", async () => {
  const { body } = await get(`/api/tree/${K.ROOT}?depth=3`);
  assert.equal(body.coin.mint, K.ROOT);
  assert.deepEqual(body.children.map((n) => n.coin.mint), [K.A, K.B]);
  assert.deepEqual(body.children[0].children.map((n) => n.coin.mint), [K.G]);
  const shallow = await get(`/api/tree/${K.ROOT}?depth=1`);
  assert.deepEqual(shallow.body.children[0].children, []);
  const sub = await get(`/api/tree/${K.G}`);
  assert.deepEqual(sub.body.coin.ancestors.map((a) => a.mint), [K.A, K.ROOT]);
});

test("GET /api/candles/:mint", async () => {
  const { body } = await get(`/api/candles/${K.A}?res=60`);
  assert.equal(body.priceKey, "usd");
  assert.ok(body.candles.length >= 4);
  assert.ok(body.candles.every((c) => c.t % 60 === 0 && c.h >= c.l && typeof c.v === "number"));
  assert.ok(body.candles.every((c, i) => i === 0 || c.t > body.candles[i - 1].t));
  assert.equal((await get(`/api/candles/${K.B}`)).body.candles.length, 0);
});

test("buildCandles falls back to quote prices when USD is missing", () => {
  const r = buildCandles([{ time: 100, priceQuote: 2, priceUsd: null, quoteAmount: "5", valueUsd: null }, { time: 110, priceQuote: 3, priceUsd: null, quoteAmount: "7", valueUsd: null }, { time: 130, priceQuote: 1, priceUsd: 1, quoteAmount: "1", valueUsd: 1 }], 60);
  assert.deepEqual(r, { priceKey: "quote", candles: [{ t: 60, o: 2, h: 3, l: 2, c: 3, v: 12 }, { t: 120, o: 1, h: 1, l: 1, c: 1, v: 1 }] });
});

test("GET /api/search: prefix on symbol/name, exact mint, empty", async () => {
  assert.deepEqual((await get("/api/search?q=aa")).body.coins.map((c) => c.mint), [K.A]);
  assert.deepEqual((await get("/api/search?q=$BBB")).body.coins.map((c) => c.mint), [K.B]);
  assert.deepEqual((await get(`/api/search?q=${K.G}`)).body.coins.map((c) => c.mint), [K.G]);
  assert.equal((await get("/api/search?q=coin")).body.coins.length, 0, "prefix, not substring");
  assert.equal((await get("/api/search?q=")).body.coins.length, 0);
  assert.equal((await get("/api/search?q=9CuFcRfiqEsBEQUCPTTVHaruQU7n9N7HKNSEk5VEivu")).body.coins.length, 0);
});

test("GET /api/eligibility/:mint for an unknown coin has every field and ok=false", async () => {
  const { status, body } = await get("/api/eligibility/9CuFcRfiqEsBEQUCPTTVHaruQU7n9N7HKNSEk5VEivu");
  assert.equal(status, 200);
  for (const k of ["ok", "reason", "depth", "chain", "parentCreator", "grandparentCreator", "shares", "platform"]) assert.ok(k in body, k);
  assert.equal(body.ok, false); assert.match(body.reason, /not a pump.fun coin/); assert.equal(body.platform, PLATFORM);
});

test("GET /api/img: 404 off the allowlist and for allowed URLs the API never handed out; proxied + cached for a coin's image", async () => {
  assert.equal((await fetch(`${base}/api/img?u=${encodeURIComponent("https://evil.com/x.png")}`)).status, 404);
  assert.equal((await fetch(`${base}/api/img?u=${encodeURIComponent("https://ipfs.io/ipfs/QmX")}`)).status, 404, "allowed host, but not the image of any indexed coin");
  const r = await fetch(`${base}/api/img?u=${encodeURIComponent("https://ipfs.io/ipfs/imgA")}`);
  assert.equal(r.status, 200); assert.equal(r.headers.get("content-type"), "image/png"); assert.match(r.headers.get("cache-control"), /max-age=86400/);
});

const serialized = (ix, encoding = "base64") => {
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: Keypair.generate().publicKey, recentBlockhash: "1".repeat(32), instructions: [ix] }).compileToV0Message());
  const bytes = Buffer.from(tx.serialize());
  return encoding === "base58" ? bs58(bytes) : bytes.toString("base64");
};
const pumpIx = { programId: PUMP_PROGRAM_ID, keys: [], data: Buffer.from([1, 2, 3]) };
const transferIx = SystemProgram.transfer({ fromPubkey: Keypair.generate().publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 });

test("POST /api/rpc: batch cap, key caps, no parsed token scans, only pump transactions relayed", async () => {
  const post = (body) => fetch(`${base}/api/rpc`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const call = (method, params = []) => ({ jsonrpc: "2.0", id: 1, method, params });
  assert.equal((await post(Array.from({ length: RPC_MAX_BATCH + 1 }, () => call("getSlot")))).status, 400);
  assert.equal((await post(Array.from({ length: RPC_MAX_BATCH }, () => call("getSlot")))).status, 200);
  assert.equal((await post(call("getMultipleAccounts", [Array.from({ length: 33 }, () => PLATFORM), { encoding: "base64" }]))).status, 403);
  assert.equal((await post(call("getMultipleAccounts", [Array.from({ length: 32 }, () => PLATFORM), { encoding: "base64" }]))).status, 200);
  assert.equal((await post(call("getTokenAccountsByOwner", [PLATFORM, { programId: PLATFORM }, { encoding: "jsonParsed" }]))).status, 403);
  assert.equal((await post(call("getTokenAccountsByOwner", [PLATFORM, { programId: PLATFORM }, { encoding: "base64" }]))).status, 200);
  assert.equal((await post(call("sendTransaction", [serialized(transferIx), { encoding: "base64" }]))).status, 403, "a plain transfer is not relayed");
  assert.equal((await post(call("sendTransaction", [serialized(pumpIx), { encoding: "base64" }]))).status, 200);
  assert.equal((await post(call("simulateTransaction", [serialized(pumpIx, "base58"), { encoding: "base58" }]))).status, 200);
  assert.equal((await post(call("simulateTransaction", ["not a transaction", { encoding: "base64" }]))).status, 403);
  assert.equal(txTouchesPump(serialized(pumpIx)), true); assert.equal(txTouchesPump(serialized(transferIx)), false); assert.equal(txTouchesPump("zz"), false);
  assert.equal(rpcParamsError("getSlot", []), null);
  assert.ok(new PublicKey(PLATFORM));
});

test("POST /api/rpc: allowlist", async () => {
  const post = (body) => fetch(`${base}/api/rpc`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await post({ jsonrpc: "2.0", id: 1, method: "getProgramAccounts", params: [] })).status, 403);
  assert.equal((await post({ jsonrpc: "2.0", id: 1, method: "getLatestBlockhash", params: [] })).status, 200);
  assert.equal((await post([{ jsonrpc: "2.0", id: 1, method: "getSlot" }, { jsonrpc: "2.0", id: 2, method: "requestAirdrop" }])).status, 403);
  assert.equal((await post([])).status, 400);
  assert.ok(!RPC_ALLOW.has("getProgramAccounts"));
});

test("POST /api/upload validates before contacting pump.fun", async () => {
  const post = (body) => fetch(`${base}/api/upload`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await post({ name: "", symbol: "X", image: "data:image/png;base64,AA==" })).status, 400);
  assert.equal((await post({ name: "Spore", symbol: "bad ticker", image: "data:image/png;base64,AA==" })).status, 400);
  assert.equal((await post({ name: "Spore", symbol: "SPORE", image: "data:text/plain;base64,AA==" })).status, 400);
});

test("GET /api/events: SSE with heartbeat and a pushed event", async () => {
  const ctrl = new AbortController();
  const res = await fetch(`${base}/api/events`, { signal: ctrl.signal });
  assert.equal(res.headers.get("content-type"), "text/event-stream; charset=utf-8");
  const reader = res.body.getReader();
  let text = "";
  const deadline = Date.now() + 2000;
  setTimeout(() => hub.emit("coin", { mint: "A" }), 50);
  while (Date.now() < deadline && !(text.includes(": hb") && text.includes("event: coin"))) {
    const { value, done } = await reader.read(); if (done) break; text += Buffer.from(value).toString();
  }
  ctrl.abort();
  assert.match(text, /: connected/); assert.match(text, /: hb/); assert.match(text, /event: coin\ndata: {"mint":"A"}/);
});

test("CORS only for configured origins; unknown /api routes are 404 JSON", async () => {
  const ok = await fetch(`${base}/api/stats`, { headers: { origin: "http://localhost:5174" } });
  assert.equal(ok.headers.get("access-control-allow-origin"), "http://localhost:5174");
  const no = await fetch(`${base}/api/stats`, { headers: { origin: "https://evil.com" } });
  assert.equal(no.headers.get("access-control-allow-origin"), null);
  assert.equal((await get("/api/nope")).status, 404);
});

test("isMint", () => {
  assert.equal(isMint("9CuFcRfiqEsBEQUCPTTVHaruQU7n9N7HKNSEk5VEivu"), true);
  assert.equal(isMint("0OIl"), false);
  assert.equal(isMint(""), false);
});
