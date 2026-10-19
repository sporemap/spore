// Hardening contract: security headers + CSP nonce, body caps (413), rate limits (429 with
// X-RateLimit headers, per forwarded IP behind a trusted proxy), compression, ETag/304, cache
// policies, the health shape, the treasury shape, the SPA fallback and the upload validation path.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, brotliDecompressSync } from "node:zlib";
import { createApp, healthOf } from "../lib/api.mjs";
import { RateLimiter, rateLimit, compression, buildCsp, etagOf } from "../lib/http.mjs";
import { EventHub } from "../lib/events.mjs";
import { ImageCache } from "../lib/meta.mjs";
import { MetaHost } from "../lib/metahost.mjs";
import { buildTree, K, PLATFORM, quiet } from "./helpers/tree.mjs";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082", "hex");
let server, base, model, db, hub, dir, clock = 1_000_000_000_000, deploys = 0, deployFail = false;
const now = () => clock;
const indexer = { fetchCoin: async () => null, snapshot: () => ({ phase: "live", lastRefreshAt: Math.floor(Date.now() / 1000) - 7, lastError: null, created: { probed: 1, found: 1 }, live: { connected: true, lastMessageAgoMs: 120, connects: 1, errors: 0, backoffMs: 0, reconnecting: false } }), globalRaw: null, quoteControlRaw: null };
const treasury = { stats: { computes: 0, errors: 0, lastError: null }, get: async () => ({ platform: PLATFORM, ourCoins: 0, pendingByQuote: [], coins: [], updatedAt: 1 }) };

before(async () => {
  ({ db, model } = buildTree());
  hub = new EventHub({ heartbeatMs: 200 });
  dir = mkdtempSync(join(tmpdir(), "spore-http-"));
  mkdirSync(join(dir, "dist", "assets"), { recursive: true });
  writeFileSync(join(dir, "dist", "index.html"), '<!doctype html><html><head><script nonce="__CSP_NONCE__">document.documentElement.dataset.theme="dark"</script></head><body><div id="root"></div></body></html>');
  writeFileSync(join(dir, "dist", "assets", "index-abc123.js"), "console.log(1)".repeat(200));
  writeFileSync(join(dir, "dist", "favicon.svg"), "<svg/>");
  const images = new ImageCache(join(dir, "img"), { fetchImpl: async () => new Response(PNG, { headers: { "content-type": "image/png" } }) });
  const metahost = new MetaHost({ root: join(dir, "pages"), domain: "spore-2x6.pages.dev", log: quiet, deployImpl: async () => { deploys++; if (deployFail) throw new Error("wrangler pages deploy failed: API 10000"); return "https://x.spore-2x6.pages.dev"; } });
  const rpc = { proxy: async () => ({ status: 200, text: JSON.stringify({ jsonrpc: "2.0", id: 1, result: "ok" }) }), snapshot: () => ({ calls: 1, errors: 0, rateLimited: 0, lastError: null, inFlight: 0, queued: 0, pausedMs: 0 }) };
  const app = createApp({ model, indexer, rpc, hub, images, meta: null, metahost, treasury, metaDir: join(dir, "pages"), platformWallet: PLATFORM, splitBps: [5000, 0, 0, 5000], distDir: join(dir, "dist"), origins: ["http://localhost:5174"], log: quiet,
    rates: { api: { limit: 1000, windowMs: 60_000 }, img: { limit: 1000, windowMs: 60_000 }, rpc: { limit: 3, windowMs: 60_000 }, upload: { limit: 2, windowMs: 600_000 }, spawned: { limit: 1000, windowMs: 600_000 } },
    trustProxy: true, hsts: "auto", logSample: 0, pagesDomain: "spore-2x6.pages.dev", now });
  await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { hub.close(); server.close(); db.close(); rmSync(dir, { recursive: true, force: true }); });

const get = (p, headers = {}) => fetch(base + p, { headers });
const post = (p, body, headers = {}) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });

test("security headers on every response; API gets the closed CSP; HSTS only behind TLS", async () => {
  const r = await get("/api/stats");
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.equal(r.headers.get("x-frame-options"), "DENY");
  assert.equal(r.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
  assert.equal(r.headers.get("cross-origin-opener-policy"), "same-origin");
  assert.match(r.headers.get("permissions-policy"), /camera=\(\)/);
  assert.equal(r.headers.get("content-security-policy"), "default-src 'none'; frame-ancestors 'none'");
  assert.equal(r.headers.get("x-powered-by"), null);
  assert.equal(r.headers.get("strict-transport-security"), null, "plain http: no HSTS");
  const tls = await get("/api/stats", { "x-forwarded-proto": "https" });
  assert.match(tls.headers.get("strict-transport-security"), /max-age=15552000/);
});

test("SPA: index.html carries the full CSP with a fresh nonce substituted into the inline snippet; assets immutable; unknown files 404; /api/nope 404 JSON", async () => {
  const r = await get("/");
  const html = await r.text();
  const csp = r.headers.get("content-security-policy");
  const nonce = csp.match(/'nonce-([^']+)'/)?.[1];
  assert.ok(nonce, csp);
  assert.ok(html.includes(`<script nonce="${nonce}">`), "nonce substituted");
  assert.ok(!html.includes("__CSP_NONCE__"));
  for (const d of ["default-src 'self'", "frame-ancestors 'none'", "object-src 'none'", "connect-src 'self' https://spore-2x6.pages.dev", "img-src 'self' data: blob: https://spore-2x6.pages.dev", "https://fonts.gstatic.com", "frame-src https://connect.solflare.com", "base-uri 'self'"]) assert.ok(csp.includes(d), d);
  assert.equal(r.headers.get("cache-control"), "no-cache");
  const r2 = await get("/explore");
  assert.notEqual(r2.headers.get("content-security-policy").match(/'nonce-([^']+)'/)[1], nonce, "nonce is per request");
  assert.match(await r2.text(), /id="root"/);
  const a = await get("/assets/index-abc123.js");
  assert.equal(a.status, 200); assert.equal(a.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.equal((await get("/favicon.svg")).headers.get("cache-control"), "public, max-age=3600");
  assert.equal((await get("/missing.png")).status, 404);
  const nope = await get("/api/nope");
  assert.equal(nope.status, 404); assert.deepEqual(await nope.json(), { error: "not found" });
  assert.equal((await get("/api")).status, 404);
});

test("body caps: 16 KB on ordinary routes, 3 MB on the upload → 413 JSON; bad JSON → 400", async () => {
  const big = await post("/api/spawned", JSON.stringify({ mint: K.A, pad: "x".repeat(17 * 1024) }));
  assert.equal(big.status, 413); assert.match((await big.json()).error, /body too large/);
  const huge = await post("/api/upload", JSON.stringify({ name: "a", symbol: "A", image: "x".repeat(3 * 1024 * 1024 + 100) }));
  assert.equal(huge.status, 413);
  // Over 16 KB is fine on the upload route: it reaches validation (and fails there on the ticker, not on size).
  const ok = await post("/api/upload", { name: "Spore", symbol: "bad ticker", image: "x".repeat(100 * 1024) });
  assert.equal(ok.status, 400); assert.match((await ok.json()).error, /ticker must be/);
  const rpcBig = await post("/api/rpc", JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getSlot", params: ["x".repeat(20_000)] }));
  assert.equal(rpcBig.status, 413);
  assert.equal((await post("/api/rpc", "{not json")).status, 400);
});

test("rate limits: X-RateLimit headers, 429 with Retry-After after the limit, keyed per forwarded IP, window resets", async () => {
  const call = (ip) => post("/api/rpc", { jsonrpc: "2.0", id: 1, method: "getSlot" }, { "x-forwarded-for": ip });
  const a1 = await call("203.0.113.1");
  assert.equal(a1.status, 200); assert.equal(a1.headers.get("x-ratelimit-limit"), "3"); assert.equal(a1.headers.get("x-ratelimit-remaining"), "2");
  assert.match(a1.headers.get("x-ratelimit-policy"), /^3;w=60;name=rpc$/);
  assert.equal(Number(a1.headers.get("x-ratelimit-reset")), Math.ceil((clock + 60_000) / 1000));
  await call("203.0.113.1"); await call("203.0.113.1");
  const a4 = await call("203.0.113.1");
  assert.equal(a4.status, 429); assert.equal(a4.headers.get("x-ratelimit-remaining"), "0"); assert.equal(a4.headers.get("retry-after"), "60");
  const body = await a4.json(); assert.match(body.error, /rate limited \(rpc: 3 per 60 s\)/); assert.equal(body.retryAfter, 60);
  assert.equal((await call("203.0.113.2")).status, 200, "another client has its own bucket");
  clock += 60_000;
  assert.equal((await call("203.0.113.1")).status, 200, "window reset");
});

test("compression: gzip and brotli for JSON over 1 KB, none for small bodies, never for the event stream", async () => {
  const gz = await get("/api/feed?limit=50", { "accept-encoding": "gzip" });
  assert.equal(gz.headers.get("content-encoding"), "gzip"); assert.match(gz.headers.get("vary"), /accept-encoding/);
  const decoded = await gz.text();
  assert.ok(Number(gz.headers.get("content-length")) < decoded.length / 3, "sync path: the encoded length travels and is far smaller");
  assert.ok(Array.isArray(JSON.parse(decoded).coins));
  // Raw bytes: ask through a client that does not decode (node's fetch always does), so verify with zlib on a manual socket-less check.
  const raw = await fetch(base + "/api/feed?limit=50", { headers: { "accept-encoding": "br" } });
  assert.equal(raw.headers.get("content-encoding"), "br");
  assert.ok(Array.isArray((await raw.json()).coins));
  const small = await get("/api/stats", { "accept-encoding": "gzip, br" });
  assert.equal(small.headers.get("content-encoding"), null, "stats is under the threshold");
  const asset = await get("/assets/index-abc123.js", { "accept-encoding": "gzip" });
  assert.equal(asset.headers.get("content-encoding"), "gzip", "streamed static file compressed too");
  assert.equal((await asset.text()).length, "console.log(1)".length * 200);
  const ctrl = new AbortController();
  const sse = await fetch(base + "/api/events", { headers: { "accept-encoding": "gzip" }, signal: ctrl.signal });
  assert.equal(sse.headers.get("content-encoding"), null); assert.equal(sse.headers.get("content-type"), "text/event-stream; charset=utf-8");
  ctrl.abort();
});

test("compression middleware unit: sync and stream paths produce decodable bytes", async () => {
  const run = (enc, chunks, type = "application/json") => new Promise((resolve) => {
    const out = []; const headers = {};
    const res = { statusCode: 200, headersSent: false, getHeader: (k) => headers[k.toLowerCase()], setHeader: (k, v) => { headers[k.toLowerCase()] = v; }, removeHeader: (k) => { delete headers[k.toLowerCase()]; },
      write: (c) => { out.push(Buffer.from(c)); return true; }, end: (c) => { if (c) out.push(Buffer.from(c)); resolve({ body: Buffer.concat(out), headers }); }, writeHead(s) { this.statusCode = s; }, once() {}, destroy() {} };
    compression()({ method: "GET", headers: { "accept-encoding": enc } }, res, () => {
      res.setHeader("content-type", type);
      if (chunks.length === 1) res.end(chunks[0]); else { for (const c of chunks) res.write(c); res.end(); }
    });
  });
  const text = JSON.stringify({ a: "x".repeat(5000) });
  const s = await run("gzip", [text]);
  assert.equal(s.headers["content-encoding"], "gzip"); assert.equal(gunzipSync(s.body).toString(), text); assert.equal(Number(s.headers["content-length"]), s.body.length);
  const b = await run("br", [text.slice(0, 3000), text.slice(3000)]);
  assert.equal(b.headers["content-encoding"], "br"); assert.equal(brotliDecompressSync(b.body).toString(), text);
  const tiny = await run("gzip", ["{}"]);
  assert.equal(tiny.headers["content-encoding"], undefined); assert.equal(tiny.body.toString(), "{}");
  const img = await run("gzip", [Buffer.alloc(5000)], "image/png");
  assert.equal(img.headers["content-encoding"], undefined);
});

test("ETag + short public caching on feed/roots/map/tree/coin/stats; If-None-Match → 304; search stays no-store", async () => {
  for (const [p, maxAge] of [["/api/feed", 5], ["/api/roots", 5], ["/api/map", 10], [`/api/tree/${K.ROOT}`, 5], [`/api/coin/${K.A}`, 3], ["/api/stats", 3]]) {
    const r = await get(p);
    assert.equal(r.status, 200, p);
    assert.match(r.headers.get("cache-control"), new RegExp(`^public, max-age=${maxAge}, stale-while-revalidate=${maxAge * 4}$`), p);
    const tag = r.headers.get("etag");
    assert.match(tag, /^W\/"/, p);
    const again = await get(p, { "if-none-match": tag });
    assert.equal(again.status, 304, p);
  }
  assert.equal((await get("/api/search?q=aa")).headers.get("cache-control"), "no-store");
  assert.equal((await get("/api/health")).headers.get("cache-control"), "no-store");
  assert.equal(etagOf("abc"), etagOf("abc")); assert.notEqual(etagOf("abc"), etagOf("abd"));
});

test("GET /api/health: indexer lag, ws state, backfill, rpc, sse count; ?strict=1 is 503 when degraded", async () => {
  const r = await get("/api/health");
  assert.equal(r.status, 200);
  const h = await r.json();
  for (const k of ["ok", "status", "now", "uptimeS", "mode", "coins", "ourCoins", "indexer", "ws", "rpc", "meta", "images", "metahost", "treasury", "sse", "solUsd", "memoryMb"]) assert.ok(k in h, k);
  assert.equal(h.ok, true); assert.equal(h.status, "ok"); assert.equal(h.indexer.lagS, 7); assert.equal(h.ws.connected, true);
  assert.deepEqual(Object.keys(h.indexer.backfill).sort(), ["done", "resolved", "total"]);
  assert.equal(typeof h.memoryMb.rss, "number");
  const down = healthOf({ model, indexer: { snapshot: () => ({ phase: "live", lastRefreshAt: Math.floor(Date.now() / 1000) - 900, live: { connected: false, lastMessageAgoMs: 500_000 } }) }, hub, startedAt: 0 });
  assert.equal(down.ok, false); assert.equal(down.status, "degraded");
  assert.equal((await get("/api/health?strict=1")).status, 200, "healthy fixture stays 200 under strict");
});

test("GET /api/treasury: the documented shape, cached", async () => {
  const r = await get("/api/treasury");
  assert.equal(r.status, 200);
  const t = await r.json();
  assert.deepEqual(Object.keys(t).sort(), ["coins", "ourCoins", "pendingByQuote", "platform", "updatedAt"]);
  assert.equal(t.platform, PLATFORM); assert.deepEqual(t.pendingByQuote, []);
  assert.match(r.headers.get("cache-control"), /max-age=30/);
});

test("POST /api/upload: HTML and control characters rejected, magic bytes checked, rejected attempts refunded; wrangler failure → 502 with a retry hint", async () => {
  const img = `data:image/png;base64,${PNG.toString("base64")}`;
  const bad = [
    [{ name: "<b>Spore</b>", symbol: "SP", image: img }, /name must be plain text/],
    [{ name: "Spore", symbol: "SP", description: "x\u0000y", image: img }, /description contains control/],
    [{ name: "Spore", symbol: "SP", image: `data:image/png;base64,${Buffer.from("GIF89a" + "\0".repeat(20), "latin1").toString("base64")}` }, /image is gif, not png/],
    [{ name: "Spore", symbol: "SP", image: "data:image/svg+xml;base64,PHN2Zy8+" }, /png, jpeg, gif or webp/],
    [{ name: "Spore", symbol: "SP", twitter: "https://evil.example/x", image: img }, /twitter must be/],
    [{ name: "Spore", symbol: "SP", website: "javascript:alert(1)", image: img }, /website/],
  ];
  for (const [body, re] of bad) { const r = await post("/api/upload", body, { "x-forwarded-for": "198.51.100.9" }); assert.equal(r.status, 400); assert.match((await r.json()).error, re); }
  // Six rejected attempts above against a limit of 2: all refunded, so a valid upload still goes through.
  const ok = await post("/api/upload", { name: "Spore", symbol: "sp", description: "Hi <3? no: plain", image: img, twitter: "@spore" }, { "x-forwarded-for": "198.51.100.9" });
  assert.equal(ok.status, 400, "'<3' contains < and is refused as markup");
  const ok2 = await post("/api/upload", { name: "Spore", symbol: "sp", description: "plain", image: img, twitter: "@spore" }, { "x-forwarded-for": "198.51.100.9" });
  assert.equal(ok2.status, 200);
  const j = await ok2.json();
  assert.match(j.metadataUri, /^https:\/\/spore-2x6\.pages\.dev\/m\/[a-f0-9]{64}\.json$/);
  assert.equal(j.metadata.twitter, "https://x.com/spore"); assert.equal(j.metadata.symbol, "SP");
  assert.equal(deploys, 1);
  deployFail = true;
  const fail = await post("/api/upload", { name: "Spore2", symbol: "SP2", image: img }, { "x-forwarded-for": "198.51.100.9" });
  assert.equal(fail.status, 502); assert.equal(fail.headers.get("retry-after"), "30");
  const f = await fail.json(); assert.match(f.error, /wrangler pages deploy failed/); assert.equal(f.retryAfter, 30); assert.match(f.hint, /retry/);
  deployFail = false;
  const limited = await post("/api/upload", { name: "Spore3", symbol: "SP3", image: img }, { "x-forwarded-for": "198.51.100.9" });
  assert.equal(limited.status, 429, "two real attempts used the 2-per-window budget");
  assert.equal(limited.headers.get("x-ratelimit-limit"), "2");
});

test("RateLimiter.check/refund and the standalone middleware", () => {
  let t = 0;
  const rl = new RateLimiter({ limit: 2, windowMs: 100, now: () => t });
  assert.deepEqual(rl.check("a"), { ok: true, limit: 2, remaining: 1, resetAt: 100 });
  assert.equal(rl.check("a").remaining, 0);
  assert.equal(rl.check("a").ok, false);
  rl.refund("a");
  assert.equal(rl.check("a").ok, true);
  t = 100;
  assert.equal(rl.check("a").remaining, 1);
  const mw = rateLimit({ limit: 1, windowMs: 1000, name: "t", now: () => 0 });
  const headers = {}; let status = 200, body = null;
  const res = { setHeader: (k, v) => { headers[k] = v; }, status: (s) => { status = s; return res; }, json: (b) => { body = b; } };
  let passed = 0;
  mw({ ip: "1.1.1.1" }, res, () => passed++);
  mw({ ip: "1.1.1.1" }, res, () => passed++);
  assert.equal(passed, 1); assert.equal(status, 429); assert.equal(headers["retry-after"], "1"); assert.match(body.error, /t: 1 per 1 s/);
});

test("buildCsp without a nonce has no nonce source; extra connect hosts are appended", () => {
  const c = buildCsp({ pagesDomain: "x.example", extraConnect: ["wss://rpc.example"] });
  assert.ok(!c.includes("nonce")); assert.ok(c.includes("connect-src 'self' https://x.example wss://rpc.example"));
});

test("CORS preflight answers 204 for an allowed origin and carries no allow-origin for others", async () => {
  const pre = await fetch(base + "/api/upload", { method: "OPTIONS", headers: { origin: "http://localhost:5174", "access-control-request-method": "POST" } });
  assert.equal(pre.status, 204); assert.equal(pre.headers.get("access-control-allow-origin"), "http://localhost:5174"); assert.equal(pre.headers.get("access-control-max-age"), "600");
  const other = await fetch(base + "/api/stats", { headers: { origin: "https://evil.example" } });
  assert.equal(other.headers.get("access-control-allow-origin"), null);
});
