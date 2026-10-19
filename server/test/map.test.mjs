// DESIGN §11.5: the whole-forest map (`limit=all`), delta sync (`since=<ms>` + `updatedAt` stamps),
// the `pair` and `mapdelta` streams, the metadata sweep order and the coverage numbers in health.
// No network, no RPC: the fixture tree behind the express app, a fake clock for the 10 s caches.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { createApp, healthOf } from "../lib/api.mjs";
import { EventHub } from "../lib/events.mjs";
import { Db } from "../lib/db.mjs";
import { Model, MAP_CACHE_MS } from "../lib/model.mjs";
import { Indexer, MAPDELTA_MAX } from "../lib/indexer.mjs";
import { MetaFetcher, ImageCache } from "../lib/meta.mjs";
import { PublicKey } from "../lib/sdk.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTxFor, FIXTURE_EVENT } from "./helpers/spawntx.mjs";
import { K, PLATFORM, quiet, base, T22 } from "./helpers/tree.mjs";

const key = (seed) => new PublicKey(createHash("sha256").update(`map-test-${seed}`).digest()).toBase58(); // distinct for any seed (the tree helper's fill-byte keys wrap at 255)
const EXTRA = 45; // more children than the top-n fan-out cap (40) under ROOT
const PARENT = FIXTURE_EVENT.quoteMint; // the real parent of the fixture CreateEvent
let server, url, model, db, hub, indexer, events, clock, dir;
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const get = async (p, headers = {}) => { const r = await fetch(url + p, { headers }); return { status: r.status, headers: r.headers, body: r.headers.get("content-type")?.includes("json") ? await r.json() : null }; };
const later = () => { clock += MAP_CACHE_MS + 1; }; // step past the response cache

before(async () => {
  clock = Date.now();
  db = new Db(":memory:");
  model = new Model(db, { platformWallet: PLATFORM, splitBps: [5000, 2500, 1000, 1500], mode: "all", now: () => clock, log: quiet });
  model.load();
  model.setGlobal({ maxCurveDepth: 2, initialRealTokenReserves: "793100000000000", createV2Enabled: true, whitelistedQuoteMints: [] });
  model.setSolUsd(100);
  // ROOT → A → G, ROOT → B, ROOT → 45 small children; PARENT (depth 1 under ROOT) waits for the fixture spawn.
  model.upsertCoin({ mint: K.ROOT, curve: "C_ROOT", depth: 0, quoteMint: null, ...base, virtualQuoteReserves: "100000000000", createdAt: 1000 });
  model.upsertCoin({ mint: K.A, curve: "C_A", depth: 1, quoteMint: K.ROOT, ...base, virtualQuoteReserves: "2000000000000000", realQuoteReserves: "50000000000000", createdAt: 2000 });
  model.upsertCoin({ mint: K.B, curve: "C_B", depth: 1, quoteMint: K.ROOT, ...base, virtualQuoteReserves: "1000000000000000", realQuoteReserves: "10000000000000", createdAt: 3000 });
  model.upsertCoin({ mint: K.G, curve: "C_G", depth: 2, quoteMint: K.A, ...base, virtualQuoteReserves: "500000000000000", realQuoteReserves: "7000000000000", createdAt: 4000, complete: true });
  model.upsertCoin({ mint: PARENT, curve: "C_P", depth: 1, quoteMint: K.ROOT, ...base, virtualQuoteReserves: "1000000000000000", realQuoteReserves: "1000000000000", createdAt: 5000 });
  for (let i = 0; i < EXTRA; i++) model.upsertCoin({ mint: key(100 + i), curve: `C_E${i}`, depth: 1, quoteMint: K.ROOT, ...base, virtualQuoteReserves: "1000000000000000", realQuoteReserves: String(1_000_000 * (i + 1)), createdAt: 6000 + i });
  for (const [mint, symbol] of [[K.ROOT, "ROOT"], [K.A, "AAA"], [K.B, "BBB"], [K.G, "GGG"], [PARENT, "PAR"]]) model.setMint({ mint, decimals: 6, tokenProgram: T22, name: `${symbol} coin`, symbol, uri: `https://ipfs.io/ipfs/${symbol}`, onchainAt: 1 });
  model.setMeta("https://ipfs.io/ipfs/AAA", { image: "https://ipfs.io/ipfs/imgA", description: "A", twitter: null, telegram: null, website: null, fetchedAt: 1, ok: true });
  clock += 1_000; // the fake clock stood still during setup: stamps there are strictly monotonic (+1 ms each), so move past them
  hub = new EventHub({ heartbeatMs: 60_000 });
  events = [];
  const fakeHub = { emit: (ev, data) => { events.push([ev, data]); hub.emit(ev, data); }, clients: hub.clients };
  const rpc = { getMultipleAccounts: async (keys) => keys.map(() => null), snapshot: () => ({}), lane: () => rpc };
  indexer = new Indexer({ rpc, model, meta: null, hub: fakeHub, log: quiet, opts: { backfill: false } });
  dir = mkdtempSync(join(tmpdir(), "spore-map-"));
  const images = new ImageCache(dir, { fetchImpl: async () => new Response("", { status: 404 }) });
  const app = createApp({ model, indexer, rpc, hub, images, meta: null, platformWallet: PLATFORM, splitBps: [5000, 2500, 1000, 1500], distDir: null, log: quiet });
  await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
  url = `http://127.0.0.1:${server.address().port}`;
});
after(() => { hub?.close(); server?.close(); db?.close(); if (dir) rmSync(dir, { recursive: true, force: true }); });

test("GET /api/map?scope=all&limit=all: every root and every descendant, no fan-out cap, version/generatedAt/total; limit=<n> keeps the top-n shape", async () => {
  const { status, headers, body } = await get("/api/map?scope=all&limit=all");
  assert.equal(status, 200);
  assert.equal(body.scope, "all"); assert.equal(typeof body.version, "number"); assert.equal(body.generatedAt, clock);
  assert.equal(body.roots.length, 1); assert.equal(body.roots[0].coin.mint, K.ROOT);
  assert.equal(body.roots[0].children.length, 3 + EXTRA, "no fan-out cap");
  assert.deepEqual(body.roots[0].children.slice(0, 2).map((n) => n.coin.mint), [K.A, K.B], "children ordered by locked value");
  assert.deepEqual(body.roots[0].children[0].children.map((n) => n.coin.mint), [K.G]);
  let n = 0; const walk = (x) => { n++; x.children.forEach(walk); }; body.roots.forEach(walk);
  assert.equal(body.total, n); assert.equal(n, 4 + EXTRA + 1);
  for (const k of ["mint", "name", "symbol", "image", "depth", "ours", "oursPending", "mcapUsd", "lockedUsd", "children", "descendants", "migrated", "createdAt"]) assert.ok(k in body.roots[0].coin, k);
  assert.equal(body.roots[0].coin.name, "ROOT coin", "on-chain names always ride along");
  assert.match(headers.get("cache-control"), /max-age=10/); assert.ok(headers.get("etag"));
  // Cached per version for 10 s: the same bytes come back (same generatedAt), a 304 on If-None-Match.
  const again = await get("/api/map?scope=all&limit=all");
  assert.equal(again.body.generatedAt, body.generatedAt);
  assert.equal((await fetch(`${url}/api/map?scope=all&limit=all`, { headers: { "if-none-match": headers.get("etag") } })).status, 304);
  // Pre-encoded gzip when the client accepts it.
  const gz = await fetch(`${url}/api/map?scope=all&limit=all`, { headers: { "accept-encoding": "gzip" } });
  assert.equal(gz.headers.get("content-encoding"), "gzip");
  assert.equal((await gz.json()).total, body.total, "fetch decodes the pre-compressed body");
  const entry = model.mapAll({ all: true });
  assert.ok(entry.prepared.gz && gunzipSync(entry.prepared.gz).toString() === entry.prepared.text, "the gzip bytes are cached with the build");
  // Top-n behaviour is intact: default fan-out 40 and limit=1.
  const top = await get("/api/map?scope=all&limit=1");
  assert.equal(top.body.roots.length, 1); assert.equal(top.body.roots[0].children.length, 40); assert.equal("version" in top.body, false);
  assert.equal((await get("/api/map?scope=all&limit=all&since=abc")).status, 400);
});

test("since=<ms>: only nodes whose updatedAt moved, flat with parentMint; stamps bump on reserves (child + parent), names, logos, migrate, shares — never on a no-op refresh", async () => {
  later();
  const full = (await get("/api/map?scope=all&limit=all")).body;
  const g = full.generatedAt;
  const delta = async (since) => { later(); const { body } = await get(`/api/map?scope=all&limit=all&since=${since}`); return body; };
  let d = await delta(g);
  assert.deepEqual(d, { nodes: [], removed: [], generatedAt: clock, total: full.total, version: model.version }, "nothing changed yet");
  // A refresh tick that re-reads an unchanged curve is not a change.
  model.upsertCoin({ mint: K.G, refreshedAt: 12345, realQuoteReserves: "7000000000000" });
  d = await delta(g);
  assert.deepEqual(d.nodes, [], "no-op upsert does not stamp");
  // Trade-driven numbers: the child and its parent (locked value) move.
  model.upsertCoin({ mint: K.B, realQuoteReserves: "20000000000000" });
  d = await delta(g);
  assert.deepEqual(d.nodes.map((x) => [x.mint, x.parentMint]).sort(), [[K.B, K.ROOT], [K.ROOT, null]].sort());
  assert.ok(d.nodes.every((x) => "lockedUsd" in x && "mcapUsd" in x && "name" in x && "image" in x));
  const g2 = d.generatedAt;
  // A name that resolves on chain, and a logo that resolves off chain, reach the map.
  model.setMint({ mint: K.B, name: "Renamed" });
  d = await delta(g2);
  assert.deepEqual(d.nodes.map((x) => x.mint), [K.B]); assert.equal(d.nodes[0].name, "Renamed");
  const g3 = d.generatedAt;
  const nowS = Math.floor(Date.now() / 1000);
  model.setMeta("https://ipfs.io/ipfs/GGG", { image: "https://ipfs.io/ipfs/imgG", description: null, twitter: null, telegram: null, website: null, fetchedAt: nowS, ok: true });
  d = await delta(g3);
  assert.deepEqual(d.nodes.map((x) => x.mint), [K.G]); assert.equal(d.nodes[0].image, "/api/img?u=https%3A%2F%2Fipfs.io%2Fipfs%2FimgG");
  const g4 = d.generatedAt;
  model.setMeta("https://ipfs.io/ipfs/GGG", { image: "https://ipfs.io/ipfs/imgG", description: "later", twitter: null, telegram: null, website: null, fetchedAt: nowS + 1, ok: true });
  assert.deepEqual((await delta(g4)).nodes, [], "a re-read with the same image stamps nothing");
  // Migration moves the coin and its parent; a sharing config flips the ours flag.
  model.upsertCoin({ mint: K.G, migrated: true, poolQuote: "7000000000000" });
  d = await delta(g4);
  assert.deepEqual(d.nodes.map((x) => x.mint).sort(), [K.A, K.G].sort()); assert.equal(d.nodes.find((x) => x.mint === K.G).migrated, true);
  const g5 = d.generatedAt;
  model.upsertCoin({ mint: K.A, shares: [{ address: "CR", bps: 8500 }, { address: PLATFORM, bps: 1500 }], sharesAt: 1 });
  d = await delta(g5);
  assert.deepEqual(d.nodes.map((x) => x.mint), [K.A]); assert.equal(d.nodes[0].ours, true);
  assert.equal(d.total, full.total);
  // The sqlite row carries the ms stamp; the coin page keeps seconds.
  const row = db.allCoins().find((c) => c.mint === K.A);
  assert.ok(row.updatedAt > 1e12 && row.updatedAt === model.get(K.A).updatedAt);
  assert.equal(model.view(model.get(K.A)).updatedAt, Math.floor(row.updatedAt / 1000));
  assert.ok(db.allCoins().find((c) => c.mint === K.ROOT).updatedAt > g, "the parent's stamp is persisted too");
  // A change in the same millisecond as a build still lands after it.
  const g6 = (await delta(g5)).generatedAt;
  model.upsertCoin({ mint: K.B, realQuoteReserves: "21000000000000" });
  assert.ok(model.get(K.B).updatedAt > g6);
});

test("SSE pair: a live CreateEvent with a tracked parent announces { coin, parent } once (both modes); again when the parent becomes known", async () => {
  const tx = createTxFor({ mint: K.X });
  events.length = 0;
  indexer.onLogs({ slot: 7, signature: "s".repeat(64), err: null, logs: tx.meta.logMessages });
  const pairs = () => events.filter(([ev]) => ev === "pair");
  assert.equal(pairs().length, 1, "announced synchronously: the parent is tracked");
  const [, p] = pairs()[0];
  assert.equal(p.coin.mint, K.X); assert.equal(p.coin.name, FIXTURE_EVENT.name); assert.equal(p.coin.depth, FIXTURE_EVENT.depth);
  assert.equal(p.parent.mint, PARENT); assert.equal(p.parent.symbol, "PAR");
  assert.equal(p.coin.parentMint, PARENT, "the child carries its parent like a since= node"); assert.ok("parentMint" in p.parent, "the parent carries its own parent (null for a root)");
  for (const k of ["mcapUsd", "lockedUsd", "children", "descendants", "migrated", "ours", "image"]) { assert.ok(k in p.coin, k); assert.ok(k in p.parent, k); }
  await tick();
  assert.equal(pairs().length, 1, "the enrich path is deduped");
  assert.equal(events.filter(([ev]) => ev === "coin").length, 1, "the ours-only coin event is unchanged (all mode announces it)");
  assert.equal(indexer.announcePair(K.X), false, "deduped for a minute");
  // The spawn is in the delta sync too, under its parent.
  later();
  const { body } = await get(`/api/map?scope=all&limit=all&since=${clock - MAP_CACHE_MS - 2}`);
  assert.ok(body.nodes.some((x) => x.mint === K.X && x.parentMint === PARENT));
  // A child whose parent the model does not know yet: no pair until the parent arrives.
  model.upsertCoin({ mint: K.U, curve: "C_U", depth: 1, quoteMint: K.S, ...base, virtualQuoteReserves: "1000000000000000" });
  assert.equal(indexer.announcePair(K.U), false);
  model.upsertCoin({ mint: K.S, curve: "C_S", depth: 0, quoteMint: null, ...base, virtualQuoteReserves: "100000000000", tracked: false });
  assert.equal(indexer.announcePair(K.U), false, "an untracked (on-demand) parent does not count");
  model.upsertCoin({ mint: K.S, tracked: true });
  assert.equal(indexer.announcePair(K.U), true);
  assert.equal(pairs().length, 2);
  // Ours mode: the same event goes out (the map shows everything), verified on a second model.
  const db2 = new Db(":memory:");
  const ours = new Model(db2, { platformWallet: PLATFORM, splitBps: [5000, 0, 0, 5000], mode: "ours", log: quiet });
  ours.load();
  ours.upsertCoin({ mint: K.ROOT, curve: "C_ROOT", depth: 0, quoteMint: null, ...base, virtualQuoteReserves: "100000000000" });
  ours.upsertCoin({ mint: PARENT, curve: "C_P", depth: 1, quoteMint: K.ROOT, ...base, virtualQuoteReserves: "1000000000000000" });
  const got = [];
  const ix2 = new Indexer({ rpc: { getMultipleAccounts: async (k) => k.map(() => null), snapshot: () => ({}) }, model: ours, meta: null, hub: { emit: (ev, d) => got.push([ev, d]) }, log: quiet, opts: { backfill: false } });
  ix2.onLogs({ slot: 7, signature: "t".repeat(64), err: null, logs: tx.meta.logMessages });
  await tick();
  assert.deepEqual(got.map(([ev]) => ev), ["pair"], "pair yes, coin no (not ours)");
  // adopt (a verified spawn) announces the pair after its enrich.
  const got3 = [];
  const db3 = new Db(":memory:");
  const m3 = new Model(db3, { platformWallet: PLATFORM, splitBps: [5000, 0, 0, 5000], mode: "ours", log: quiet }); m3.load();
  m3.upsertCoin({ mint: PARENT, curve: "C_P", depth: 1, quoteMint: K.ROOT, ...base, virtualQuoteReserves: "1000000000000000" });
  const ix3 = new Indexer({ rpc: { getMultipleAccounts: async (k) => k.map(() => null), snapshot: () => ({}) }, model: m3, meta: null, hub: { emit: (ev, d) => got3.push([ev, d]) }, log: quiet, opts: { backfill: false } });
  m3.markPending(K.X, "sig", { feePaid: "20000000" });
  await ix3.adopt(K.X, { create: FIXTURE_EVENT.mint === K.X ? FIXTURE_EVENT : { ...FIXTURE_EVENT, mint: K.X }, slot: 1, feePaid: 20_000_000n });
  assert.deepEqual(got3.map(([ev]) => ev).sort(), ["coin", "pair"]);
  db2.close(); db3.close();
});

test("SSE mapdelta: batched from the dirty set, only when something changed, labels included, capped at 500 largest-locked-first with the rest carried over", () => {
  model.takeDirty();
  assert.equal(indexer.flushMapDelta(), null, "nothing changed → nothing sent");
  events.length = 0;
  model.upsertCoin({ mint: K.A, realQuoteReserves: "60000000000000" });
  const payload = indexer.flushMapDelta();
  assert.ok(payload && typeof payload.at === "number");
  assert.deepEqual(payload.updated.map((e) => e.mint), [K.ROOT, K.A], "the parent (bigger locked value) first");
  for (const k of ["mint", "mcapUsd", "lockedUsd", "children", "descendants", "migrated", "name", "symbol", "image"]) assert.ok(k in payload.updated[0], k);
  assert.equal(payload.updated[1].image, "/api/img?u=https%3A%2F%2Fipfs.io%2Fipfs%2FimgA");
  assert.deepEqual(events.map(([ev]) => ev), ["mapdelta"]);
  assert.equal(indexer.flushMapDelta(), null, "drained");
  // 600 changes → 500 now (largest lockedUsd first), the remaining 101 (with ROOT) on the next flush.
  for (let i = 0; i < 600; i++) model.upsertCoin({ mint: key(1000 + i), curve: `C_M${i}`, depth: 1, quoteMint: K.ROOT, ...base, virtualQuoteReserves: "1000000000000000", realQuoteReserves: String(i + 1) });
  const dirtyBefore = model.dirty.size;
  const first = indexer.flushMapDelta();
  assert.equal(first.updated.length, MAPDELTA_MAX);
  assert.equal(first.updated[0].mint, K.ROOT, "the root has the largest locked value");
  const second = indexer.flushMapDelta();
  assert.equal(second.updated.length, dirtyBefore - MAPDELTA_MAX);
  assert.equal(indexer.flushMapDelta(), null);
  assert.equal(indexer.state.map.deltas, 3);
});

test("metadata sweep queues every tracked coin's uri that needs a fetch, biggest locked value first then newest; coverage shows in health", () => {
  const f = new MetaFetcher(model, { concurrency: 0, pacer: { fetchAny: async () => null }, log: quiet });
  const n = f.sweep();
  const order = f.queue.slice(f.head);
  assert.equal(n, order.length);
  assert.deepEqual(order.slice(0, 3), ["https://ipfs.io/ipfs/ROOT", "https://ipfs.io/ipfs/AAA", "https://ipfs.io/ipfs/PAR"], "locked value first (AAA's entry is stale: fetchedAt 1)");
  assert.ok(order.indexOf(FIXTURE_EVENT.uri) < order.indexOf("https://ipfs.io/ipfs/BBB"), "no locked value: newest first");
  assert.ok(!order.includes("https://ipfs.io/ipfs/GGG"), "a fresh resolved image is not re-fetched");
  assert.equal(order.length, 5);
  assert.equal(f.sweep(), 0, "already queued: nothing added twice");
  const cov = f.coverage();
  assert.equal(cov.total, model.tracked().length);
  assert.equal(cov.withMeta, 2); assert.equal(cov.withImage, 2); assert.equal(cov.failed, 0); assert.equal(cov.queued, n);
  const h = healthOf({ model, indexer, hub, meta: f, startedAt: 0 });
  for (const k of ["total", "withMeta", "withImage", "queued", "failed", "run"]) assert.ok(k in h.meta, k);
  for (const k of ["fetched", "failed", "rateLimited", "rotated", "sweeps"]) assert.ok(k in h.meta.run, `run.${k}`);
  f.stop();
});
