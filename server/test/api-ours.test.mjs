// HTTP contract in "ours" mode (DESIGN §11): the same fixture tree as test/ours.test.mjs behind the
// express app, plus the launch fee, POST /api/spawned, GET /m/:name and the self-hosted upload.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, RateLimiter, isSig } from "../lib/api.mjs";
import { EventHub } from "../lib/events.mjs";
import { Db } from "../lib/db.mjs";
import { Model } from "../lib/model.mjs";
import { ImageCache } from "../lib/meta.mjs";
import { MetaHost } from "../lib/metahost.mjs";
import { K, PLATFORM, quiet, base, T22 } from "./helpers/tree.mjs";
import { createTxFor } from "./helpers/spawntx.mjs";

const OUR_SHARES = [{ address: "CR", bps: 5000 }, { address: PLATFORM, bps: 5000 }];
const FOREIGN_SHARES = [{ address: "CR", bps: 10000 }];
const PNG_B64 = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082", "hex").toString("base64");
let server, url, model, db, hub, dir, metahost, deploys = 0, adopted = [], fetched = 0;
const txs = new Map(); // signature → transaction the fake RPC answers
const SIG = { X: "5".repeat(88), U: "6".repeat(88), BAD: "7".repeat(88), NOFEE: "8".repeat(88), OTHER: "9".repeat(88) };
const txLookups = [];

before(async () => {
  db = new Db(":memory:");
  model = new Model(db, { platformWallet: PLATFORM, splitBps: [5000, 0, 0, 5000], mode: "ours", log: quiet });
  model.load();
  model.setGlobal({ maxCurveDepth: 2, initialRealTokenReserves: "793100000000000", createV2Enabled: true, whitelistedQuoteMints: [] });
  model.setSolUsd(100);
  // ROOT → OURS (ours), FOREIGN (foreign) → DEEP (ours); ROOT → X (foreign, nothing of ours below)
  model.upsertCoin({ mint: K.ROOT, curve: "C_ROOT", depth: 0, quoteMint: null, ...base, virtualQuoteReserves: "100000000000", createdAt: 1000 });
  model.upsertCoin({ mint: K.A, curve: "C_A", depth: 1, quoteMint: K.ROOT, ...base, virtualQuoteReserves: "2000000000000000", realQuoteReserves: "50000000000000", createdAt: 2000, shares: OUR_SHARES, sharesAt: 1 });
  model.upsertCoin({ mint: K.B, curve: "C_B", depth: 1, quoteMint: K.ROOT, ...base, virtualQuoteReserves: "1000000000000000", realQuoteReserves: "10000000000000", createdAt: 3000, shares: FOREIGN_SHARES, sharesAt: 1 });
  model.upsertCoin({ mint: K.G, curve: "C_G", depth: 2, quoteMint: K.B, ...base, virtualQuoteReserves: "500000000000000", realQuoteReserves: "7000000000000", createdAt: 4000, shares: OUR_SHARES, sharesAt: 1 });
  model.upsertCoin({ mint: K.X, curve: "C_X", depth: 1, quoteMint: K.ROOT, ...base, virtualQuoteReserves: "1000000000000000", realQuoteReserves: "1", createdAt: 5000, shares: FOREIGN_SHARES, sharesAt: 1 });
  for (const [mint, symbol] of [[K.ROOT, "ROOT"], [K.A, "OURS"], [K.B, "FOREIGN"], [K.G, "DEEP"], [K.X, "GTA"]]) model.setMint({ mint, decimals: 6, tokenProgram: T22, name: `${symbol} coin`, symbol, onchainAt: 1 });
  const now = Math.floor(Date.now() / 1000);
  for (const m of [K.A, K.X]) model.recordTrade({ sig: `S${m.slice(0, 4)}`, mint: m, idx: 0, slot: 1, time: now - 30, isBuy: true, user: "U", baseAmount: "1", quoteAmount: "2", priceQuote: 2, priceUsd: 2e-5, valueUsd: 0.5 });
  hub = new EventHub({ heartbeatMs: 200 });
  dir = mkdtempSync(join(tmpdir(), "spore-ours-"));
  const images = new ImageCache(join(dir, "img"), { fetchImpl: async () => new Response(Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082", "hex"), { headers: { "content-type": "image/png" } }) });
  metahost = new MetaHost({ root: join(dir, "pages"), domain: "spore-2x6.pages.dev", log: quiet, deployImpl: async () => { deploys++; return "https://x.spore-2x6.pages.dev"; } });
  const indexer = { fetchCoin: async () => { fetched++; return null; }, adopt: async (mint, opts = {}) => { adopted.push({ mint, ...opts }); return model.get(mint); }, snapshot: () => ({ phase: "test" }), globalRaw: null, quoteControlRaw: null };
  txs.set(SIG.X, createTxFor({ mint: K.X, platform: PLATFORM, fee: 20_000_000n }));
  txs.set(SIG.U, createTxFor({ mint: "9CuFcRfiqEsBEQUCPTTVHaruQU7n9N7HKNSEk5VEivu", platform: PLATFORM, fee: 20_000_000n }));
  txs.set(SIG.NOFEE, createTxFor({ mint: K.X }));
  txs.set(SIG.OTHER, createTxFor({ mint: K.U, platform: PLATFORM, fee: 20_000_000n }));
  const rpc = { proxy: async () => ({ status: 200, text: "{}" }), getTransaction: async (sig) => { txLookups.push(sig); return txs.get(sig) ?? null; } };
  const app = createApp({ model, indexer, rpc, hub, images, meta: null, metahost, metaDir: join(dir, "pages"), platformWallet: PLATFORM, splitBps: [5000, 0, 0, 5000], launchFeeSol: 0.02, distDir: null, log: quiet });
  await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
  url = `http://127.0.0.1:${server.address().port}`;
});
after(() => { hub.close(); server.close(); db.close(); rmSync(dir, { recursive: true, force: true }); });

const get = async (p) => { const r = await fetch(url + p); return { status: r.status, body: await r.json(), headers: r.headers }; };
const post = async (p, body) => { const r = await fetch(url + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };

test("GET /api/stats carries mode, ourCoins and otherChildren; counts cover our coins", async () => {
  const { body } = await get("/api/stats");
  assert.equal(body.mode, "ours"); assert.equal(body.ourCoins, 2); assert.equal(body.coins, 2); assert.equal(body.roots, 1); assert.equal(body.otherChildren, 1);
  assert.deepEqual(body.byDepth, [0, 1, 1]);
  assert.equal(body.volume24hUsd, 0.5, "volume of X (foreign, out of scope) is not counted");
});

test("GET /api/feed lists our spawns only, every row flagged", async () => {
  const { body } = await get("/api/feed");
  assert.deepEqual(body.coins.map((c) => c.mint), [K.G, K.A]);
  assert.ok(body.coins.every((c) => c.ours === true && c.oursPending === false));
});

test("GET /api/roots: depth-0 ancestors of our coins, counts over our descendants", async () => {
  const { body } = await get("/api/roots");
  assert.deepEqual(body.roots.map((r) => r.mint), [K.ROOT]);
  assert.equal(body.roots[0].descendants, 2); assert.equal(body.roots[0].children, 2); assert.equal(body.roots[0].otherChildren, 1); assert.equal(body.roots[0].ours, false);
  assert.equal(body.roots[0].lockedQuote, "50000000000000");
});

test("GET /api/coin: children filtered, otherChildren reported; a foreign coin still opens", async () => {
  const root = await get(`/api/coin/${K.ROOT}`);
  assert.deepEqual(root.body.children.map((c) => c.mint).sort(), [K.A, K.B].sort());
  assert.equal(root.body.otherChildren, 1);
  assert.equal(root.body.children.find((c) => c.mint === K.B).ours, false, "FOREIGN is context on the way to DEEP");
  const x = await get(`/api/coin/${K.X}`);
  assert.equal(x.status, 200); assert.equal(x.body.coin.ours, false); assert.deepEqual(x.body.children, []); assert.equal(x.body.otherChildren, 0);
});

test("GET /api/tree and /api/map follow the scope; /api/candles is 404 off-scope", async () => {
  const tree = await get(`/api/tree/${K.ROOT}?depth=3`);
  assert.deepEqual(tree.body.children.map((n) => n.coin.mint).sort(), [K.A, K.B].sort());
  assert.deepEqual(tree.body.children.find((n) => n.coin.mint === K.B).children.map((n) => n.coin.mint), [K.G]);
  const map = await get("/api/map");
  assert.deepEqual(map.body.roots.map((r) => r.coin.mint), [K.ROOT]);
  assert.equal(map.body.roots[0].coin.otherChildren, 1);
  assert.deepEqual(map.body.roots[0].children.map((n) => n.coin.mint).sort(), [K.A, K.B].sort());
  assert.equal(map.body.roots[0].children.find((n) => n.coin.mint === K.A).coin.ours, true);
  assert.equal((await get(`/api/candles/${K.A}`)).status, 200);
  assert.equal((await get(`/api/candles/${K.ROOT}`)).status, 200, "ancestors are in scope");
  assert.equal((await get(`/api/candles/${K.X}`)).status, 404);
});

test("GET /api/search stays global", async () => {
  const { body } = await get("/api/search?q=GTA");
  assert.deepEqual(body.coins.map((c) => c.mint), [K.X]);
  assert.equal(body.coins[0].ours, false);
});

test("GET /api/eligibility: two shareholders by default (creator slot empty), launchFee shape", async () => {
  const { body } = await get("/api/eligibility/9CuFcRfiqEsBEQUCPTTVHaruQU7n9N7HKNSEk5VEivu");
  assert.deepEqual(body.launchFee, { to: PLATFORM, lamports: "20000000", sol: 0.02 });
  assert.equal(body.platform, PLATFORM);
  assert.deepEqual(body.shares, [], "unknown coin: no split (not a pump coin)");
});

test("POST /api/spawned: the transaction is verified on-chain before the coin is listed; verified signatures are cached; 429 after the window", async () => {
  assert.equal((await post("/api/spawned", { mint: "nope", sig: SIG.X })).status, 400);
  assert.equal((await post("/api/spawned", { mint: K.X, sig: "not a sig!" })).status, 400);
  assert.match((await post("/api/spawned", { mint: K.X })).body.error, /signature is required/, "a bare mint no longer lists anything");
  // Unknown signature: 404 with a retry hint, nothing marked.
  const nf = await post("/api/spawned", { mint: K.X, sig: SIG.BAD });
  assert.equal(nf.status, 404); assert.equal(nf.body.retryAfter, 3); assert.equal(model.pending.size, 0);
  // A real create of this mint without the launch fee: refused.
  const nofee = await post("/api/spawned", { mint: K.X, sig: SIG.NOFEE });
  assert.equal(nofee.status, 400); assert.match(nofee.body.error, /launch fee not paid/); assert.equal(model.pending.size, 0);
  // A paid create of another mint: refused.
  assert.match((await post("/api/spawned", { mint: K.X, sig: SIG.OTHER })).body.error, /no pump.fun create of this mint/);
  assert.deepEqual(adopted, [], "nothing was adopted so far");
  // The genuine one: pending, adopted with the decoded event and the fee.
  const r = await post("/api/spawned", { mint: K.X, sig: SIG.X });
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.ok, r.body.ours, r.body.oursPending, r.body.verified, r.body.feePaid], [true, false, true, true, "20000000"]);
  assert.equal(adopted.length, 1); assert.equal(adopted[0].mint, K.X); assert.equal(adopted[0].create.mint, K.X); assert.equal(adopted[0].create.symbol, "ponzi"); assert.equal(adopted[0].feePaid, 20_000_000n);
  assert.equal(r.body.coin.oursPending, true); assert.equal(r.body.coin.feePaid, "20000000", "the fee shows on the coin while pending");
  assert.ok((await get("/api/feed")).body.coins.some((c) => c.mint === K.X && c.oursPending), "pending spawn joins the feed at once");
  assert.equal((await get("/api/stats")).body.ourCoins, 3);
  assert.equal((await get(`/api/candles/${K.X}`)).status, 200);
  // The UI retries once: same signature, no second transaction read, no second adopt.
  const lookupsBefore = txLookups.length;
  const again = await post("/api/spawned", { mint: K.X, sig: SIG.X });
  assert.equal(again.status, 200); assert.equal(again.body.oursPending, true); assert.equal(txLookups.length, lookupsBefore); assert.equal(adopted.length, 1);
  // Already ours: answered from the model, nothing fetched.
  const a = await post("/api/spawned", { mint: K.A, sig: SIG.X });
  assert.deepEqual([a.body.ours, a.body.oursPending, a.body.verified], [true, false, true]); assert.equal(txLookups.length, lookupsBefore);
  // Unknown mint (not indexed yet) with a verified create: pending only.
  const u = await post("/api/spawned", { mint: "9CuFcRfiqEsBEQUCPTTVHaruQU7n9N7HKNSEk5VEivu", sig: SIG.U });
  assert.deepEqual([u.body.ours, u.body.oursPending, u.body.coin], [false, true, null]);
  for (let i = 0; i < 20; i++) await post("/api/spawned", { mint: K.A, sig: SIG.X });
  assert.equal((await post("/api/spawned", { mint: K.A, sig: SIG.X })).status, 429);
  // clean up for the other tests
  model.pending.delete(K.X); model.pending.delete("9CuFcRfiqEsBEQUCPTTVHaruQU7n9N7HKNSEk5VEivu"); model.sweepPending(); model.upsertCoin({ mint: K.X, updatedAt: 1, feePaid: null });
});

test("GET /api/eligibility caches the chain part per mint: different creators cost no extra lookup", async () => {
  const before = fetched;
  const mint = K.U; // a mint no earlier test asked about (the verdict cache is per mint)
  await get(`/api/eligibility/${mint}?creator=${K.A}`);
  await get(`/api/eligibility/${mint}?creator=${K.B}`);
  await get(`/api/eligibility/${mint}`);
  assert.equal(fetched - before, 1);
});

test("POST /api/upload writes the files, deploys once, returns the Pages URI; GET /m/:name serves them immutably", async () => {
  const bad = await post("/api/upload", { name: "Spore", symbol: "SPORE", image: "data:text/plain;base64,AA==" });
  assert.equal(bad.status, 400);
  const r = await post("/api/upload", { name: "Spore", symbol: "spore", description: "x", image: `data:image/png;base64,${PNG_B64}`, twitter: "https://x.com/s" });
  assert.equal(r.status, 200);
  assert.match(r.body.metadataUri, /^https:\/\/spore-2x6\.pages\.dev\/m\/[a-f0-9]{64}\.json$/);
  assert.match(r.body.imageUri, /^https:\/\/spore-2x6\.pages\.dev\/m\/[a-f0-9]{64}\.png$/);
  assert.equal(r.body.metadata.symbol, "SPORE"); assert.equal(r.body.metadata.showName, true);
  assert.equal(deploys, 1);
  const name = r.body.metadataUri.split("/m/")[1];
  assert.ok(existsSync(join(dir, "pages", "m", name)));
  const served = await fetch(`${url}/m/${name}`);
  assert.equal(served.status, 200);
  assert.equal(served.headers.get("content-type"), "application/json");
  assert.match(served.headers.get("cache-control"), /immutable/);
  assert.equal(served.headers.get("access-control-allow-origin"), "*");
  assert.deepEqual(await served.json(), r.body.metadata);
  const img = await fetch(`${url}/m/${r.body.imageUri.split("/m/")[1]}`);
  assert.equal(img.headers.get("content-type"), "image/png");
  assert.equal((await fetch(`${url}/m/..%2Findex.html`)).status, 404);
  assert.equal((await fetch(`${url}/m/${"a".repeat(64)}.json`)).status, 404);
  metahost.deployImpl = async () => { throw new Error("wrangler pages deploy failed: no token"); };
  const fail = await post("/api/upload", { name: "Spore2", symbol: "SPORE2", image: `data:image/png;base64,${PNG_B64}` });
  assert.equal(fail.status, 502); assert.match(fail.body.error, /metadata publish failed: wrangler pages deploy failed: no token/);
});

test("RateLimiter and isSig", () => {
  let t = 0;
  const rl = new RateLimiter({ limit: 2, windowMs: 100, now: () => t });
  assert.deepEqual([rl.allow("a"), rl.allow("a"), rl.allow("a"), rl.allow("b")], [true, true, false, true]);
  t = 100; assert.equal(rl.allow("a"), true);
  assert.equal(isSig("5".repeat(88)), true); assert.equal(isSig("0".repeat(88)), false); assert.equal(isSig("abc"), false);
});
