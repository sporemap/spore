// Partner API v1 (DESIGN §12) against the in-memory tree: shapes, 404s, live lookup, absolute images,
// cache headers + ETag, CORS *, read-only, tiers and limits, the filtered stream, the embed framing
// rules per path, and the OpenAPI document (parses, lists every route, every $ref resolves).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../lib/api.mjs";
import { EventHub } from "../lib/events.mjs";
import { ApiKeys } from "../lib/apikeys.mjs";
import { V1_ROUTES, V1_CACHE, V1Stream, V1_STREAM_TYPES } from "../lib/v1.mjs";
import { openApiDoc } from "../lib/openapi.mjs";
import { buildTree, K, PLATFORM, T22, base as baseCurve, quiet } from "./helpers/tree.mjs";

const PUB = "https://sporepad.com";
const nowS = () => Math.floor(Date.now() / 1000);
let dir, main, tiers;

/** One app on an ephemeral port: the main one (generous limits) or the tier one (tiny limits, fake clock). */
async function start({ limits, now = Date.now, fetchCoin } = {}) {
  const { db, model } = buildTree();
  // B is a Spore launch (its sharing config pays the platform its slice).
  model.upsertCoin({ mint: K.B, shares: [{ address: "CR", bps: 8500 }, { address: PLATFORM, bps: 1500 }] });
  const t = nowS();
  model.recordTrade({ sig: "OLD", mint: K.A, idx: 0, slot: 1, time: t - 90_000, isBuy: true, user: "U", baseAmount: "1", quoteAmount: "1", priceQuote: 1, priceUsd: 1e-5, valueUsd: 1 });
  for (let i = 0; i < 3; i++) model.recordTrade({ sig: `N${i}`, mint: K.A, idx: 0, slot: 10 + i, time: t - 60 * i, isBuy: true, user: "U", baseAmount: "1", quoteAmount: "1", priceQuote: 2, priceUsd: 2e-5, valueUsd: 1 });
  const hub = new EventHub({ heartbeatMs: 60_000 });
  const apiKeys = new ApiKeys(db, { log: quiet, now });
  const indexer = { fetchCoin: fetchCoin ?? (async () => null), snapshot: () => ({ phase: "test" }) };
  const app = createApp({ model, indexer, rpc: { proxy: async () => ({ status: 200, text: "{}" }) }, hub, images: { handler: () => (_q, r) => r.status(404).end() }, meta: null, platformWallet: PLATFORM, splitBps: [5000, 2500, 1000, 1500],
    distDir: join(dir, "dist"), origins: ["http://localhost:5174"], log: quiet, trustProxy: true, apiKeys, publicUrl: PUB, v1Limits: limits, now });
  const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  return { db, model, hub, apiKeys, app, server, base: `http://127.0.0.1:${server.address().port}` };
}
const stop = (x) => { x.app.locals.v1.close(); x.hub.close(); x.server.closeAllConnections?.(); x.server.close(); x.db.close(); };

let clock = 1_800_000_000_000;
before(async () => {
  dir = mkdtempSync(join(tmpdir(), "spore-v1-"));
  mkdirSync(join(dir, "dist"), { recursive: true });
  writeFileSync(join(dir, "dist", "index.html"), '<!doctype html><html><head><script nonce="__CSP_NONCE__">1</script></head><body><div id="root"></div></body></html>');
  main = await start({
    limits: { publicPerMin: 10_000, partnerPerMin: 10_000, publicStreams: 3, partnerStreams: 3 },
    // An unknown mint K.X is a live pump.fun coin quoted in A (untracked, like a page view of a foreign coin); K.U is not a pump coin.
    fetchCoin: async (mint) => {
      if (mint === K.S) throw new Error("rpc down");
      if (mint !== K.X) return null;
      main.model.setMint({ mint: K.X, decimals: 6, tokenProgram: T22, name: "Live coin", symbol: "LIVE", uri: null, onchainAt: 1 });
      return main.model.upsertCoin({ mint: K.X, curve: "C_X", depth: 2, quoteMint: K.A, ...baseCurve, virtualQuoteReserves: "1000000000000000", tracked: false });
    },
  });
  main.model.setMeta("https://ipfs.io/ipfs/ROOT", { image: "https://ipfs.io/ipfs/imgRoot", fetchedAt: 1, ok: true });
  tiers = await start({ limits: { publicPerMin: 3, partnerPerMin: 5, publicStreams: 1, partnerStreams: 2 }, now: () => clock });
});
after(() => { stop(main); stop(tiers); rmSync(dir, { recursive: true, force: true }); });

const get = async (x, p, headers = {}) => { const r = await fetch(x.base + p, { headers }); const text = await r.text(); let body = null; try { body = JSON.parse(text); } catch { body = text; } return { status: r.status, headers: r.headers, body }; };

// ---------------------------------------------------------------- shapes
test("family of a root: every contract field, root = itself, children by locked value, absolute images, links", async () => {
  const { status, body, headers } = await get(main, `/v1/coin/${K.ROOT}/family`);
  assert.equal(status, 200);
  assert.deepEqual(Object.keys(body).sort(), ["ancestors", "change24h", "children", "depth", "descendants", "image", "launchedOnSpore", "links", "lockedUsd", "mcapUsd", "mint", "name", "parent", "quoteMint", "quoteSymbol", "root", "symbol", "trades1h"].sort());
  assert.equal(body.mint, K.ROOT); assert.equal(body.depth, 0); assert.equal(body.quoteMint, null); assert.equal(body.quoteSymbol, "SOL");
  assert.deepEqual(body.root, { mint: K.ROOT, name: "ROOT coin", symbol: "ROOT", image: `${PUB}/api/img?u=${encodeURIComponent("https://ipfs.io/ipfs/imgRoot")}`, depth: 0 });
  assert.equal(body.parent, null); assert.deepEqual(body.ancestors, []);
  assert.equal(body.children.count, 2);
  assert.deepEqual(body.children.top.map((c) => c.mint), [K.A, K.B], "most locked value first");
  assert.deepEqual(Object.keys(body.children.top[0]).sort(), ["depth", "image", "lockedUsd", "mcapUsd", "mint", "name", "symbol"]);
  assert.equal(body.children.top[0].image, `${PUB}/api/img?u=${encodeURIComponent("https://ipfs.io/ipfs/imgA")}`);
  assert.equal(body.descendants, 3);
  assert.ok(body.mcapUsd > 0 && body.lockedUsd > 0);
  assert.equal(body.change24h, null, "no recorded trades of ROOT");
  assert.equal(body.trades1h, 0); assert.equal(body.launchedOnSpore, false);
  assert.deepEqual(body.links, { spore: `${PUB}/c/${K.ROOT}`, launchUnder: `${PUB}/launch?parent=${K.ROOT}`, embed: `${PUB}/embed/tree/${K.ROOT}` });
  assert.equal(headers.get("cache-control"), V1_CACHE);
});

test("family of a depth-2 coin: parent, ancestors nearest first, root; 24 h change and trades in the last hour", async () => {
  const g = (await get(main, `/v1/coin/${K.G}/family`)).body;
  assert.equal(g.depth, 2); assert.equal(g.quoteMint, K.A); assert.equal(g.quoteSymbol, "AAA");
  assert.equal(g.parent.mint, K.A); assert.deepEqual(g.ancestors.map((a) => a.mint), [K.A, K.ROOT]); assert.equal(g.root.mint, K.ROOT);
  assert.deepEqual(g.children, { count: 0, top: [] });
  const a = (await get(main, `/v1/coin/${K.A}/family`)).body;
  assert.equal(a.trades1h, 3);
  assert.equal(a.change24h, 100, "2e-5 USD now against 1e-5 USD at the last trade before the window");
  assert.equal((await get(main, `/v1/coin/${K.B}/family`)).body.launchedOnSpore, true);
});

test("family: 400 malformed, 404 not a pump coin, live lookup for an unindexed pump coin, 503 when the lookup fails", async () => {
  assert.equal((await get(main, "/v1/coin/not-a-mint/family")).status, 400);
  const nf = await get(main, `/v1/coin/${K.U}/family`);
  assert.equal(nf.status, 404); assert.deepEqual(nf.body, { error: "not a pump.fun coin" });
  assert.equal(nf.headers.get("cache-control"), "no-store");
  const live = await get(main, `/v1/coin/${K.X}/family`);
  assert.equal(live.status, 200);
  assert.equal(live.body.symbol, "LIVE"); assert.equal(live.body.parent.mint, K.A); assert.equal(live.body.root.mint, K.ROOT); assert.equal(live.body.image, null);
  const down = await get(main, `/v1/coin/${K.S}/family`);
  assert.equal(down.status, 503); assert.ok(down.body.retryAfter > 0);
});

test("tree: the whole tree from its root, flat with parentMint, breadth-first by locked value; an untracked coin is appended", async () => {
  const { status, body, headers } = await get(main, `/v1/tree/${K.G}`);
  assert.equal(status, 200);
  assert.deepEqual(Object.keys(body).sort(), ["nodes", "root", "total"]);
  assert.equal(body.root.mint, K.ROOT); assert.deepEqual(Object.keys(body.root).sort(), ["depth", "image", "mint", "name", "symbol"]);
  assert.deepEqual(body.nodes.map((n) => [n.mint, n.parentMint]), [[K.ROOT, null], [K.A, K.ROOT], [K.B, K.ROOT], [K.G, K.A]]);
  assert.equal(body.total, 4);
  for (const k of ["mint", "name", "symbol", "image", "depth", "ours", "oursPending", "mcapUsd", "lockedUsd", "children", "descendants", "migrated", "createdAt", "parentMint"]) assert.ok(k in body.nodes[0], k);
  assert.ok(body.nodes[0].image.startsWith(`${PUB}/api/img?u=`));
  assert.equal(headers.get("cache-control"), V1_CACHE);
  assert.deepEqual((await get(main, `/v1/tree/${K.ROOT}`)).body, body, "same tree from any of its coins");
  const x = (await get(main, `/v1/tree/${K.X}`)).body;
  assert.deepEqual(x.nodes.at(-1).mint, K.X); assert.equal(x.nodes.at(-1).parentMint, K.A); assert.equal(x.total, 5);
  assert.equal((await get(main, `/v1/tree/${K.U}`)).status, 404);
  assert.equal((await get(main, "/v1/tree/xyz")).status, 400);
});

test("map: full forest and since= delta, the /api shapes with absolute images; bad since is 400", async () => {
  const full = await get(main, "/v1/map");
  assert.equal(full.status, 200);
  assert.deepEqual(Object.keys(full.body).sort(), ["generatedAt", "roots", "scope", "total", "version"]);
  assert.equal(full.body.scope, "all"); assert.equal(full.body.total, 4, "ROOT, A, B, G (the live-looked-up coin is untracked)");
  assert.equal(full.body.roots[0].coin.mint, K.ROOT);
  const text = JSON.stringify(full.body);
  assert.ok(!text.includes('"image":"/api/img'), "no relative image left");
  assert.ok(text.includes(`"image":"${PUB}/api/img?u=`));
  const apiMap = (await get(main, "/api/map?scope=all&limit=all")).body;
  assert.deepEqual(JSON.parse(JSON.stringify(apiMap).replaceAll('"image":"/api/img?', `"image":"${PUB}/api/img?`)), full.body, "same body as /api/map apart from the image base");
  assert.equal(full.headers.get("cache-control"), V1_CACHE);
  const delta = await get(main, "/v1/map?since=0");
  assert.deepEqual(Object.keys(delta.body).sort(), ["generatedAt", "nodes", "removed", "total", "version"]);
  assert.ok(delta.body.nodes.length >= 4); assert.ok(delta.body.nodes.every((n) => "parentMint" in n));
  assert.equal((await get(main, `/v1/map?since=${Date.now() + 3_600_000}`)).body.nodes.length, 0);
  assert.equal((await get(main, "/v1/map?since=abc")).status, 400);
});

test("heat: the /api/map/heat body; ETag + 304 on every cacheable route", async () => {
  const h = await get(main, "/v1/heat");
  assert.equal(h.status, 200);
  assert.deepEqual(h.body, (await get(main, "/api/map/heat")).body);
  assert.deepEqual(h.body.mint, [K.A]); assert.equal(h.body.t1h[0], 3);
  for (const p of ["/v1/heat", "/v1/map", `/v1/tree/${K.A}`, `/v1/coin/${K.A}/family`, "/v1/openapi.json"]) {
    const r = await fetch(main.base + p);
    const tag = r.headers.get("etag"); assert.ok(tag, p);
    assert.equal((await fetch(main.base + p, { headers: { "if-none-match": tag } })).status, 304, p);
  }
});

// ---------------------------------------------------------------- CORS, read-only, headers
test("CORS * on /v1 (no credentials, no allowlist), preflight 204; /api keeps its allowlist", async () => {
  const r = await fetch(`${main.base}/v1/heat`, { headers: { origin: "https://terminal.example" } });
  assert.equal(r.headers.get("access-control-allow-origin"), "*");
  assert.equal(r.headers.get("access-control-allow-credentials"), null);
  assert.ok(!/origin/i.test(r.headers.get("vary") ?? ""), "no per-origin variance");
  assert.match(r.headers.get("access-control-expose-headers"), /X-Spore-Tier/);
  const pre = await fetch(`${main.base}/v1/coin/${K.A}/family`, { method: "OPTIONS", headers: { origin: "https://terminal.example", "access-control-request-method": "GET", "access-control-request-headers": "x-api-key" } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get("access-control-allow-origin"), "*");
  assert.equal(pre.headers.get("access-control-allow-methods"), "GET, OPTIONS");
  assert.equal(pre.headers.get("access-control-allow-headers"), "X-API-Key, Content-Type");
  assert.equal(pre.headers.get("x-ratelimit-limit"), null, "a preflight is not rate limited");
  assert.equal((await fetch(`${main.base}/api/stats`, { headers: { origin: "https://terminal.example" } })).headers.get("access-control-allow-origin"), null);
  assert.equal((await fetch(`${main.base}/api/stats`, { headers: { origin: "http://localhost:5174" } })).headers.get("access-control-allow-origin"), "http://localhost:5174");
});

test("read-only: only GET routes exist, anything else is 405; unknown /v1 paths are 404 JSON", async () => {
  const methods = new Set();
  for (const layer of main.app.locals.v1.router.stack) if (layer.route) for (const m of Object.keys(layer.route.methods)) methods.add(m);
  assert.deepEqual([...methods], ["get"]);
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    const r = await fetch(`${main.base}/v1/map`, { method, headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(r.status, 405, method); assert.equal(r.headers.get("allow"), "GET, HEAD, OPTIONS");
  }
  const nf = await get(main, "/v1/nope");
  assert.equal(nf.status, 404); assert.equal(nf.body.error, "not found"); assert.equal(nf.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal((await get(main, "/v1")).status, 404);
});

// ---------------------------------------------------------------- tiers
test("public tier: per-IP budget with X-RateLimit-* and X-Spore-Tier, 429 + Retry-After when spent, a new window refills", async () => {
  const ip = { "x-forwarded-for": "198.51.100.1" };
  for (let i = 0; i < 3; i++) {
    const r = await get(tiers, "/v1/heat", ip);
    assert.equal(r.status, 200); assert.equal(r.headers.get("x-spore-tier"), "public");
    assert.equal(r.headers.get("x-ratelimit-limit"), "3"); assert.equal(r.headers.get("x-ratelimit-remaining"), String(2 - i));
    assert.ok(Number(r.headers.get("x-ratelimit-reset")) > 0);
  }
  const no = await get(tiers, "/v1/heat", ip);
  assert.equal(no.status, 429); assert.equal(no.body.tier, "public"); assert.ok(Number(no.headers.get("retry-after")) >= 1);
  assert.equal((await get(tiers, "/v1/heat", { "x-forwarded-for": "198.51.100.2" })).status, 200, "another IP has its own budget");
  clock += 61_000;
  assert.equal((await get(tiers, "/v1/heat", ip)).status, 200);
});

test("partner tier: a valid key gets its own (larger) budget per key; invalid and revoked keys are 401; ?key= only on the stream; usage is counted in batches", async () => {
  clock += 61_000;
  const ip = { "x-forwarded-for": "198.51.100.9" };
  const k = tiers.apiKeys.create({ name: "Terminal A", contact: "@a" });
  const hdr = { ...ip, "x-api-key": k.key };
  for (let i = 0; i < 5; i++) {
    const r = await get(tiers, "/v1/heat", hdr);
    assert.equal(r.status, 200); assert.equal(r.headers.get("x-spore-tier"), "partner"); assert.equal(r.headers.get("x-ratelimit-limit"), "5");
  }
  const no = await get(tiers, "/v1/heat", hdr);
  assert.equal(no.status, 429); assert.equal(no.body.tier, "partner");
  assert.equal((await get(tiers, "/v1/heat", ip)).status, 200, "the same IP without the key still has its public budget");
  const bad = await get(tiers, "/v1/heat", { ...ip, "x-api-key": "spk_11111111111111111111111111111111" });
  assert.equal(bad.status, 401); assert.deepEqual(bad.body, { error: "invalid or revoked API key" });
  assert.equal(bad.headers.get("x-spore-tier"), "public");
  assert.ok(bad.headers.get("x-ratelimit-remaining") != null, "a 401 reports the public budget it was charged to");
  assert.equal((await get(tiers, "/v1/heat", { ...ip, "x-api-key": "nonsense" })).status, 401);
  assert.equal((await get(tiers, `/v1/heat?key=${k.key}`, ip)).status, 400);
  assert.ok(!JSON.stringify(bad.body).includes("spk_"), "a key is never echoed");
  // Usage: nothing is written per request, one flush writes the batch.
  assert.equal(tiers.db.apiKeys().find((r) => r.id === k.id).requests, 0);
  assert.equal(tiers.apiKeys.flush(), 1);
  const row = tiers.db.apiKeys().find((r) => r.id === k.id);
  assert.equal(row.requests, 5); assert.ok(row.lastUsedAt > 0);
  assert.ok(tiers.apiKeys.revoke(k.id));
  clock += 61_000;
  assert.equal((await get(tiers, "/v1/heat", hdr)).status, 401, "revoked");
});

// ---------------------------------------------------------------- stream
/** Opens /v1/stream and collects text until `until(text)` or the deadline. */
async function openStream(x, query = "", headers = {}) {
  const ctrl = new AbortController();
  const res = await fetch(`${x.base}/v1/stream${query}`, { headers, signal: ctrl.signal });
  if (res.status !== 200) { const body = await res.json(); return { res, body, close() {} }; }
  const reader = res.body.getReader();
  let text = "";
  return {
    res, get text() { return text; },
    async until(pred, ms = 1500) { const deadline = Date.now() + ms; while (Date.now() < deadline && !pred(text)) { const r = await Promise.race([reader.read(), new Promise((ok) => setTimeout(() => ok({ timeout: true }), deadline - Date.now()))]); if (r.done) break; if (r.value) text += Buffer.from(r.value).toString(); } return text; },
    close() { ctrl.abort(); },
  };
}
const events = (text) => [...text.matchAll(/event: (\w+)\ndata: (.*)\n\n/g)].map((m) => ({ type: m[1], data: JSON.parse(m[2]) }));

test("stream: SSE headers, type filter, tree filter (any coin of the tree), derived heat rows, absolute images, stats never narrowed", async () => {
  const all = await openStream(main);
  const tree = await openStream(main, `?types=trade,heat,pair,stats,mapdelta&mint=${K.G}`);
  const onlyTrades = await openStream(main, "?types=trade");
  try {
    assert.equal(all.res.headers.get("content-type"), "text/event-stream; charset=utf-8");
    assert.equal(all.res.headers.get("cache-control"), "no-store");
    assert.equal(all.res.headers.get("access-control-allow-origin"), "*");
    assert.equal(all.res.headers.get("x-spore-tier"), "public");
    const t = { sig: "SIG1", mint: K.B, slot: 5, time: nowS(), isBuy: true, user: "U", baseAmount: "1", quoteAmount: "2", priceQuote: 1, priceUsd: 1e-5, valueUsd: 0.5 };
    main.hub.emit("trade", { ...t, mint: K.A });                        // in ROOT's tree
    main.hub.emit("trade", { ...t, sig: "SIG2", mint: "Other1111111111111111111111111111111111111" }); // another tree
    main.hub.emit("pair", { coin: { ...main.model.mapRef(main.model.get(K.G), true), parentMint: K.A }, parent: { ...main.model.mapRef(main.model.get(K.A), true), parentMint: K.ROOT } });
    main.hub.emit("stats", { coins: 4 });
    main.hub.emit("mapdelta", { at: 1, updated: [{ mint: K.A, image: "/api/img?u=x", lockedUsd: 1 }, { mint: "Other1111111111111111111111111111111111111", image: null, lockedUsd: 2 }] });
    main.hub.emit("coin", { mint: K.B, image: null, parent: null, root: null, ancestors: [] });
    const done = (s) => s.includes("event: stats");
    const a = events(await all.until(done)), tr = events(await tree.until((s) => s.includes("event: mapdelta"))), ot = events(await onlyTrades.until((s) => s.includes("SIG2")));
    assert.deepEqual(a.map((e) => e.type), ["trade", "heat", "trade", "pair", "stats"], "default types: pair, trade, heat, stats");
    assert.deepEqual(a[1].data, { mint: K.A, at: a[1].data.at, t1h: 3, n24: 3, v24: 3, last: a[1].data.last, buys1h: 3 });
    assert.ok(a[3].data.coin.image === null || a[3].data.coin.image.startsWith(PUB));
    assert.ok(a[3].data.parent.image.startsWith(`${PUB}/api/img?u=`), "pair images are absolute");
    assert.deepEqual(tr.map((e) => e.type), ["trade", "heat", "pair", "stats", "mapdelta"], "only ROOT's tree (asked through G), stats unfiltered");
    assert.deepEqual(tr.find((e) => e.type === "mapdelta").data.updated, [{ mint: K.A, image: `${PUB}/api/img?u=x`, lockedUsd: 1 }], "mapdelta narrowed to the tree");
    assert.deepEqual(ot.map((e) => e.data.sig), ["SIG1", "SIG2"]);
    assert.ok(ot.every((e) => e.type === "trade"));
  } finally { all.close(); tree.close(); onlyTrades.close(); }
});

test("stream: 400 on unknown types or a bad mint; ?key= is accepted; concurrent caps per IP and per key", async () => {
  assert.equal((await openStream(main, "?types=trade,nope")).res.status, 400);
  assert.equal((await openStream(main, "?mint=xyz")).res.status, 400);
  clock += 61_000;
  const ip = { "x-forwarded-for": "198.51.100.77" };
  const s1 = await openStream(tiers, "?types=stats", ip);
  assert.equal(s1.res.status, 200);
  const s2 = await openStream(tiers, "?types=stats", ip);
  assert.equal(s2.res.status, 429); assert.match(s2.body.error, /at most 1 concurrent stream/);
  const k = tiers.apiKeys.create({ name: "Streamer" });
  const p1 = await openStream(tiers, `?types=stats&key=${k.key}`, ip);
  const p2 = await openStream(tiers, "?types=stats", { ...ip, "x-api-key": k.key });
  const p3 = await openStream(tiers, "?types=stats", { ...ip, "x-api-key": k.key });
  assert.equal(p1.res.status, 200); assert.equal(p1.res.headers.get("x-spore-tier"), "partner");
  assert.equal(p2.res.status, 200); assert.equal(p3.res.status, 429);
  assert.equal((await openStream(tiers, "?key=spk_11111111111111111111111111111111", ip)).res.status, 401);
  s1.close(); p1.close(); p2.close();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(tiers.app.locals.v1.stream.clients.size, 0, "closed streams are released");
  clock += 61_000;
  const again = await openStream(tiers, "?types=stats", ip);
  assert.equal(again.res.status, 200, "a released slot can be reused"); again.close();
});

test("V1Stream.parse: defaults and validation", () => {
  const ok = (s) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
  assert.deepEqual([...V1Stream.parse({}, ok).types], ["pair", "trade", "heat", "stats"]);
  assert.deepEqual([...V1Stream.parse({ types: V1_STREAM_TYPES.join(",") }, ok).types], V1_STREAM_TYPES);
  assert.match(V1Stream.parse({ types: "," }, ok).error, /unknown stream type/);
  assert.equal(V1Stream.parse({ mint: K.A }, ok).mint, K.A);
});

// ---------------------------------------------------------------- framing
test("embeds may be framed by anyone (frame-ancestors *, no X-Frame-Options); every other path stays unframeable", async () => {
  for (const p of [`/embed/tree/${K.A}`, "/embed/map", `/embed/map?focus=${K.A}`]) {
    const r = await fetch(main.base + p);
    assert.equal(r.status, 200, p);
    assert.match(r.headers.get("content-security-policy"), /frame-ancestors \*(;|$)/, p);
    assert.equal(r.headers.get("x-frame-options"), null, p);
    assert.match(await r.text(), /id="root"/);
  }
  for (const p of ["/", `/c/${K.A}`, "/docs/api", "/embedded", "/v1/heat", "/api/stats"]) {
    const r = await fetch(main.base + p);
    assert.equal(r.headers.get("x-frame-options"), "DENY", p);
    assert.match(r.headers.get("content-security-policy"), /frame-ancestors 'none'/, p);
  }
});

// ---------------------------------------------------------------- OpenAPI
test("openapi.json: 3.1, every route documented with responses, unique operationIds, every $ref resolves", async () => {
  const r = await get(main, "/v1/openapi.json");
  assert.equal(r.status, 200);
  const doc = r.body;
  assert.equal(doc.openapi, "3.1.0");
  assert.equal(doc.servers[0].url, PUB);
  assert.deepEqual(Object.keys(doc.paths).sort(), [...V1_ROUTES].sort());
  const ids = [];
  for (const [p, item] of Object.entries(doc.paths)) {
    assert.ok(item.get, `${p} has GET`);
    assert.deepEqual(Object.keys(item), ["get"], `${p} is read-only`);
    ids.push(item.get.operationId);
    assert.ok(item.get.responses["200"], `${p} 200`);
  }
  assert.equal(new Set(ids).size, ids.length);
  const refs = [];
  const walk = (v) => { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { if (k === "$ref") refs.push(x); else walk(x); } };
  walk(doc);
  assert.ok(refs.length > 20);
  for (const ref of refs) {
    assert.ok(ref.startsWith("#/"), ref);
    let node = doc; for (const part of ref.slice(2).split("/")) node = node?.[part];
    assert.ok(node, `unresolved ${ref}`);
  }
  for (const name of ["CoinRef", "Family", "Tree", "MapFull", "MapDelta", "Heat", "Trade", "PairEvent", "HeatRow"]) assert.ok(doc.components.schemas[name], name);
  assert.deepEqual(Object.keys(doc.components.securitySchemes).sort(), ["ApiKeyHeader", "ApiKeyQuery"]);
  assert.equal(r.headers.get("cache-control"), "public, max-age=300, s-maxage=3600");
  // The document is a pure function of its inputs.
  assert.deepEqual(openApiDoc({ publicUrl: PUB, limits: { publicPerMin: 10_000, partnerPerMin: 10_000, publicStreams: 3, partnerStreams: 3 } }).paths, doc.paths);
});

test("the examples in the document match the live shapes", async () => {
  const doc = openApiDoc();
  const ex = doc.paths["/v1/coin/{mint}/family"].get.responses["200"].content["application/json"].example;
  const live = (await get(main, `/v1/coin/${K.ROOT}/family`)).body;
  assert.deepEqual(Object.keys(ex).sort(), Object.keys(live).sort());
  const tree = doc.paths["/v1/tree/{mint}"].get.responses["200"].content["application/json"].example;
  assert.deepEqual(Object.keys(tree.nodes[0]).sort(), Object.keys((await get(main, `/v1/tree/${K.ROOT}`)).body.nodes[0]).sort());
});
