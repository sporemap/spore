// DESIGN §11.5 "Activity (heat)" and the map side panel's endpoints: GET /api/map/heat (shape,
// order, tracked coins only, 15 s cache, ETag/304), /api/candles?scope=all in ours mode, the light
// /api/coin payload (?children=0&trades=0) and the activity numbers in /api/health.
// No network, no RPC: the fixture tree behind the express app, a fake clock for the caches.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../lib/api.mjs";
import { EventHub } from "../lib/events.mjs";
import { Db } from "../lib/db.mjs";
import { Model, HEAT_CACHE_MS } from "../lib/model.mjs";
import { ImageCache } from "../lib/meta.mjs";
import { K, PLATFORM, quiet, base, T22 } from "./helpers/tree.mjs";

const OUR_SHARES = [{ address: "CR", bps: 5000 }, { address: PLATFORM, bps: 5000 }];
const FOREIGN_SHARES = [{ address: "CR", bps: 10000 }];
let clock, dir, hub;
const apps = []; // { server, url, model, db }

/** ROOT → A (ours) → G, ROOT → B (foreign), and S: an untracked (on-demand) coin with trades. */
function buildModel(mode) {
  const db = new Db(":memory:");
  const model = new Model(db, { platformWallet: PLATFORM, splitBps: [5000, 0, 0, 5000], mode, now: () => clock, log: quiet });
  model.load();
  model.setGlobal({ maxCurveDepth: 2, initialRealTokenReserves: "793100000000000", createV2Enabled: true, whitelistedQuoteMints: [] });
  model.setSolUsd(100);
  model.upsertCoin({ mint: K.ROOT, curve: "C_ROOT", depth: 0, quoteMint: null, ...base, virtualQuoteReserves: "100000000000", createdAt: 1000 });
  model.upsertCoin({ mint: K.A, curve: "C_A", depth: 1, quoteMint: K.ROOT, ...base, virtualQuoteReserves: "2000000000000000", realQuoteReserves: "50000000000000", createdAt: 2000, shares: OUR_SHARES, sharesAt: 1 });
  model.upsertCoin({ mint: K.B, curve: "C_B", depth: 1, quoteMint: K.ROOT, ...base, virtualQuoteReserves: "1000000000000000", realQuoteReserves: "10000000000000", createdAt: 3000, shares: FOREIGN_SHARES, sharesAt: 1 });
  model.upsertCoin({ mint: K.G, curve: "C_G", depth: 2, quoteMint: K.A, ...base, virtualQuoteReserves: "500000000000000", realQuoteReserves: "7000000000000", createdAt: 4000, shares: OUR_SHARES, sharesAt: 1 });
  model.upsertCoin({ mint: K.S, curve: "C_S", depth: 0, quoteMint: null, ...base, virtualQuoteReserves: "100000000000", tracked: false });
  for (const [mint, symbol] of [[K.ROOT, "ROOT"], [K.A, "OURS"], [K.B, "FOREIGN"], [K.G, "DEEP"]]) model.setMint({ mint, decimals: 6, tokenProgram: T22, name: `${symbol} coin`, symbol, onchainAt: 1 });
  const nowS = Math.floor(clock / 1000);
  let n = 0;
  const trade = (mint, ago, isBuy, valueUsd) => model.recordTrade({ sig: `S${n++}`, mint, idx: 0, slot: n, time: nowS - ago, isBuy, user: "U", baseAmount: "1000000", quoteAmount: "2000000", priceQuote: 2, priceUsd: 2e-5, valueUsd });
  // B: 3 trades in the hour (2 buys); A: 1 in the hour + 2 older (bigger volume); G: 2 hours ago only; S: untracked.
  trade(K.A, 7_000, true, 40); trade(K.A, 5_000, false, 25.555);
  trade(K.G, 7_200, true, 1);
  trade(K.B, 900, true, 1.5); trade(K.B, 600, false, 2); trade(K.B, 300, true, 0.5);
  trade(K.A, 120, true, 3);
  trade(K.S, 60, true, 99);
  return { db, model };
}

async function serve(mode) {
  const { db, model } = buildModel(mode);
  const indexer = { fetchCoin: async () => null, snapshot: () => ({ phase: "test" }), globalRaw: null, quoteControlRaw: null };
  const images = new ImageCache(join(dir, mode), { fetchImpl: async () => new Response("", { status: 404 }) });
  const app = createApp({ model, indexer, rpc: { proxy: async () => ({ status: 200, text: "{}" }) }, hub, images, meta: null, platformWallet: PLATFORM, splitBps: [5000, 0, 0, 5000], distDir: null, log: quiet });
  const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const entry = { server, url: `http://127.0.0.1:${server.address().port}`, model, db };
  apps.push(entry);
  return entry;
}
const get = async (url, headers = {}) => { const r = await fetch(url, { headers }); return { status: r.status, headers: r.headers, body: r.status === 304 ? null : await r.json() }; };

let all, ours;
before(async () => {
  clock = Date.now();
  dir = mkdtempSync(join(tmpdir(), "spore-heat-"));
  hub = new EventHub({ heartbeatMs: 60_000 });
  all = await serve("all");
  ours = await serve("ours");
});
after(() => { hub?.close(); for (const a of apps) { a.server.close(); a.db.close(); } if (dir) rmSync(dir, { recursive: true, force: true }); });

test("GET /api/map/heat: parallel arrays over tracked coins with a 24 h trade, t1h desc then v24 desc; ETag, 304, max-age=15", async () => {
  for (const { url } of [all, ours]) {
    const { status, headers, body } = await get(`${url}/api/map/heat`);
    assert.equal(status, 200);
    const nowS = Math.floor(clock / 1000);
    assert.deepEqual(Object.keys(body), ["at", "since", "mint", "t1h", "n24", "v24", "last", "buys1h"]);
    assert.equal(body.at, nowS); assert.equal(body.since, nowS - 86_400);
    assert.deepEqual(body.mint, [K.B, K.A, K.G], "every tracked coin whatever SHOW (B is foreign in ours mode); the untracked S is left out");
    assert.deepEqual(body.t1h, [3, 1, 0]);
    assert.deepEqual(body.n24, [3, 3, 1]);
    assert.deepEqual(body.v24, [4, 68.56, 1], "USD in cents");
    assert.deepEqual(body.last, [nowS - 300, nowS - 120, nowS - 7_200]);
    assert.deepEqual(body.buys1h, [2, 1, 0]);
    assert.match(headers.get("cache-control"), /max-age=15/);
    const etag = headers.get("etag");
    assert.ok(etag);
    assert.equal((await get(`${url}/api/map/heat`, { "if-none-match": etag })).status, 304);
  }
});

test("heat is cached for 15 s, then rebuilt from the live counters (and decays with the clock)", async () => {
  const { url, model } = all;
  const first = await get(`${url}/api/map/heat`);
  const nowS = Math.floor(clock / 1000);
  model.recordTrade({ sig: "LATE", mint: K.G, idx: 0, slot: 99, time: nowS, isBuy: true, user: "U", baseAmount: "1", quoteAmount: "1", priceQuote: 1, priceUsd: 1, valueUsd: 10 });
  const cached = await get(`${url}/api/map/heat`);
  assert.equal(cached.headers.get("etag"), first.headers.get("etag"), "within the window: the same bytes");
  clock += HEAT_CACHE_MS + 1;
  const fresh = await get(`${url}/api/map/heat`);
  assert.notEqual(fresh.headers.get("etag"), first.headers.get("etag"));
  const g = fresh.body.mint.indexOf(K.G);
  assert.deepEqual([fresh.body.t1h[g], fresh.body.n24[g], fresh.body.v24[g]], [1, 2, 11]);
  // An hour later the hour counts have decayed without any trade or row change.
  clock += 3_600_000;
  const later = await get(`${url}/api/map/heat`);
  assert.deepEqual(later.body.t1h, [0, 0, 0]);
  assert.deepEqual(later.body.mint, [K.A, K.G, K.B], "now ordered by 24 h volume");
  const h = await get(`${url}/api/health`);
  assert.deepEqual(Object.keys(h.body.activity), ["mints", "events", "seededMs"]);
  assert.equal(h.body.activity.mints, 4, "the counters cover every traded mint; heat narrows to tracked coins");
  assert.equal(h.body.activity.events, 9);
  assert.equal(typeof h.body.activity.seededMs, "number");
});

test("GET /api/candles/:mint?scope=all: any tracked coin in ours mode; without scope the ours-only rule stands", async () => {
  const { url } = ours;
  const scoped = await get(`${url}/api/candles/${K.B}?scope=all&res=300`);
  assert.equal(scoped.status, 200);
  assert.deepEqual(Object.keys(scoped.body), ["candles", "priceKey"]);
  assert.equal(scoped.body.candles.length, 3, "three 5-minute buckets of B's trades");
  for (const k of ["t", "o", "h", "l", "c", "v"]) assert.ok(k in scoped.body.candles[0], k);
  assert.equal(scoped.body.priceKey, "usd");
  const plain = await get(`${url}/api/candles/${K.B}?res=300`);
  assert.equal(plain.status, 404); assert.deepEqual(plain.body, { error: "not a Spore coin" });
  assert.deepEqual((await get(`${url}/api/candles/${K.S}?scope=all`)).body, { error: "not tracked" });
  assert.equal((await get(`${url}/api/candles/${K.S}?scope=all`)).status, 404);
  assert.deepEqual((await get(`${url}/api/candles/${K.U}?scope=all`)).body, { error: "unknown mint" });
  assert.equal((await get(`${url}/api/candles/not-a-mint?scope=all`)).status, 400);
  assert.equal((await get(`${url}/api/candles/${K.A}?res=300`)).status, 200, "ours coins keep their chart without scope");
});

test("GET /api/coin/:mint?children=0&trades=0 keeps the shape with empty lists and the same coin", async () => {
  for (const { url } of [all, ours]) {
    const full = await get(`${url}/api/coin/${K.ROOT}`);
    assert.ok(full.body.children.length > 0);
    const light = await get(`${url}/api/coin/${K.ROOT}?children=0&trades=0`);
    assert.equal(light.status, 200);
    assert.deepEqual(Object.keys(light.body), Object.keys(full.body));
    assert.deepEqual(light.body.children, []); assert.deepEqual(light.body.trades, []);
    assert.deepEqual(light.body.coin, full.body.coin);
    assert.equal(light.body.otherChildren, full.body.otherChildren);
    const a = await get(`${url}/api/coin/${K.A}`);
    assert.ok(a.body.trades.length > 0);
    const noTrades = await get(`${url}/api/coin/${K.A}?trades=0`);
    assert.deepEqual(noTrades.body.trades, []); assert.deepEqual(noTrades.body.children, a.body.children, "children unaffected by trades=0");
    const noKids = await get(`${url}/api/coin/${K.A}?children=false`);
    assert.deepEqual(noKids.body.children, []); assert.deepEqual(noKids.body.trades, a.body.trades);
    assert.deepEqual((await get(`${url}/api/coin/${K.A}?children=1&trades=yes`)).body, a.body, "anything but 0/false is the default");
  }
});
