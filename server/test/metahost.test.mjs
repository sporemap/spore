// Self-hosted metadata (DESIGN §11.3): file naming, JSON shape, local serving and the deploy queue.
// No wrangler here: deploys are stubbed; a real publish happens only from the running server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MetaHost, metaFiles, META_NAME_RE, DEFAULT_PAGES_DOMAIN, DailyQuota, QuotaError } from "../lib/metahost.mjs";
import { Db } from "../lib/db.mjs";
import { configureLocalMetaHost, localMetaFile, isAllowedImageUrl, MetaFetcher, ImageCache } from "../lib/meta.mjs";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082", "hex");
const sha = (b) => createHash("sha256").update(b).digest("hex");

test("metaFiles: content-addressed names, pump.fun-shaped JSON, URIs on the Pages domain", () => {
  const r = metaFiles({ name: " Spore Test ", symbol: "sporet", description: "First spore.", imageBytes: PNG, imageType: "image/png", twitter: "https://x.com/spore", telegram: "", website: "" });
  assert.equal(r.imgName, `${sha(PNG)}.png`);
  assert.equal(r.imageUri, `https://${DEFAULT_PAGES_DOMAIN}/m/${r.imgName}`);
  assert.equal(r.jsonName, `${sha(Buffer.from(r.json))}.json`);
  assert.equal(r.metadataUri, `https://${DEFAULT_PAGES_DOMAIN}/m/${r.jsonName}`);
  assert.ok(META_NAME_RE.test(r.imgName) && META_NAME_RE.test(r.jsonName));
  assert.deepEqual(JSON.parse(r.json), { name: "Spore Test", symbol: "SPORET", description: "First spore.", image: r.imageUri, showName: true, createdOn: `https://${DEFAULT_PAGES_DOMAIN}`, twitter: "https://x.com/spore" });
  assert.equal(metaFiles({ name: "A", symbol: "A", imageBytes: PNG, imageType: "image/jpeg" }).imgName.split(".").pop(), "jpg");
  assert.equal(metaFiles({ name: "A", symbol: "A", imageBytes: PNG, imageType: "image/png", domain: "x.example" }).metadataUri.startsWith("https://x.example/m/"), true);
  assert.throws(() => metaFiles({ name: "A", symbol: "A", imageBytes: PNG, imageType: "image/svg+xml" }), /unsupported image type/);
  assert.throws(() => metaFiles({ name: "A", symbol: "A", imageBytes: Buffer.alloc(0), imageType: "image/png" }), /empty image/);
  // Same content → same names, so a re-upload never creates a second file.
  assert.equal(metaFiles({ name: "A", symbol: "A", imageBytes: PNG, imageType: "image/png" }).jsonName, metaFiles({ name: "A", symbol: "A", imageBytes: PNG, imageType: "image/png" }).jsonName);
});

test("MetaHost.write lays the files out under <root>/m with _headers and index.html; publish shares one deploy", async () => {
  const root = mkdtempSync(join(tmpdir(), "spore-meta-"));
  try {
    const deploys = [];
    let release;
    const host = new MetaHost({ root, domain: "spore-2x6.pages.dev", log: { info() {}, error() {} }, deployImpl: () => new Promise((r) => { deploys.push(Date.now()); release = () => r("https://abc.spore-2x6.pages.dev"); }) });
    const r = host.write({ name: "Spore", symbol: "SPORE", imageBytes: PNG, imageType: "image/png" });
    assert.ok(existsSync(join(root, "m", r.imgName)) && existsSync(join(root, "m", r.jsonName)));
    assert.equal(readFileSync(join(root, "m", r.jsonName), "utf8"), r.json);
    assert.match(readFileSync(join(root, "_headers"), "utf8"), /\/m\/\*[\s\S]*immutable[\s\S]*Access-Control-Allow-Origin: \*/);
    assert.ok(existsSync(join(root, "index.html")));
    assert.equal(host.stats.written, 2);
    host.write({ name: "Spore", symbol: "SPORE", imageBytes: PNG, imageType: "image/png" });
    assert.equal(host.stats.written, 2, "idempotent");

    // Three concurrent publishes: the first starts a deploy, the other two share ONE follow-up deploy.
    const p1 = host.publish({ name: "One", symbol: "ONE", imageBytes: PNG, imageType: "image/png" });
    await new Promise((r) => setTimeout(r, 10));
    const p2 = host.publish({ name: "Two", symbol: "TWO", imageBytes: PNG, imageType: "image/png" });
    const p3 = host.publish({ name: "Three", symbol: "THREE", imageBytes: PNG, imageType: "image/png" });
    assert.equal(deploys.length, 1);
    release();
    const r1 = await p1;
    assert.equal(r1.metadataUri, `https://spore-2x6.pages.dev/m/${r1.jsonName}`);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(deploys.length, 2, "one queued deploy for both late callers");
    release();
    const [r2, r3] = await Promise.all([p2, p3]);
    assert.ok(existsSync(join(root, "m", r2.jsonName)) && existsSync(join(root, "m", r3.jsonName)));
    assert.equal(deploys.length, 2);
    assert.equal(host.stats.deploys, 2); assert.equal(host.stats.failed, 0); assert.equal(host.stats.lastUrl, "https://abc.spore-2x6.pages.dev");

    // A failing deploy surfaces a clear error and does not wedge the queue.
    host.deployImpl = async () => { throw new Error("wrangler pages deploy failed: boom"); };
    await assert.rejects(host.publish({ name: "Four", symbol: "FOUR", imageBytes: PNG, imageType: "image/png" }), /wrangler pages deploy failed: boom/);
    assert.equal(host.stats.failed, 1); assert.match(host.stats.lastError, /boom/);
    host.deployImpl = async () => null;
    await host.publish({ name: "Five", symbol: "FIVE", imageBytes: PNG, imageType: "image/png" });
    assert.equal(host.current, null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("daily quotas: uploads per IP, bytes and deploys per day, all reset after 24 h", async () => {
  const root = mkdtempSync(join(tmpdir(), "spore-meta-"));
  try {
    let t = 1_700_000_000_000;
    const host = new MetaHost({ root, log: { info() {}, error() {} }, deployImpl: async () => null, now: () => t, quota: new DailyQuota({ ipPerDay: 2, bytesPerDay: 10_000, deploysPerDay: 3, now: () => t }) });
    const up = (i, ip = "1.1.1.1") => host.publish({ name: `N${i}`, symbol: `S${i}`, imageBytes: PNG, imageType: "image/png" }, { ip });
    await up(1); await up(2);
    await assert.rejects(up(3), (e) => e instanceof QuotaError && /upload limit reached \(2 per day per client\)/.test(e.message) && e.retryAfter > 0);
    await up(3, "2.2.2.2");
    await assert.rejects(up(4, "3.3.3.3"), /published as much as it can today/);
    assert.equal(host.quota.snapshot().deploys, 3); assert.equal(host.quota.snapshot().clients, 2);
    t += 24 * 3600_000;
    await up(5);
    assert.equal(host.quota.snapshot().deploys, 1, "a new day");
    const bytes = new DailyQuota({ bytesPerDay: 100, now: () => t });
    assert.throws(() => bytes.check("x", 101), /full for today/);
    bytes.check("x", 100);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("gc removes ledger files nobody claimed after the grace period; referenced files and shared images stay; other files are never touched", async () => {
  const root = mkdtempSync(join(tmpdir(), "spore-meta-"));
  const db = new Db(":memory:");
  try {
    let t = 1_700_000_000_000; const deploys = [];
    const host = new MetaHost({ root, log: { info() {}, error() {} }, deployImpl: async () => { deploys.push(t); return null; }, now: () => t, ledger: db });
    const a = await host.publish({ name: "A", symbol: "A", description: "a", imageBytes: PNG, imageType: "image/png" }, { ip: "1.1.1.1" });
    const b = await host.publish({ name: "B", symbol: "B", description: "b", imageBytes: PNG, imageType: "image/png" }, { ip: "1.1.1.1" }); // same image as A
    assert.equal(a.imgName, b.imgName); assert.notEqual(a.jsonName, b.jsonName);
    assert.equal(db.uploadCount(), 3);
    const foreign = join(root, "m", "f".repeat(64) + ".json"); writeFileSync(foreign, "{}"); // written by tools/publish-meta.mjs: not in the ledger
    const referenced = new Set([a.jsonName]);
    assert.deepEqual(await host.gc({ referenced: (n) => referenced.has(n) }), { removed: 0, kept: 0 }, "too young");
    t += 25 * 3600_000;
    assert.deepEqual(await host.gc({ referenced: (n) => referenced.has(n) }), { removed: 1, kept: 2 }, "B's JSON goes; A's JSON is referenced and keeps the shared image");
    assert.ok(!existsSync(join(root, "m", b.jsonName))); assert.ok(existsSync(join(root, "m", a.jsonName))); assert.ok(existsSync(join(root, "m", a.imgName))); assert.ok(existsSync(foreign));
    assert.equal(deploys.length, 3, "a removal is followed by a deploy");
    referenced.clear();
    assert.deepEqual(await host.gc({ referenced: (n) => referenced.has(n) }), { removed: 2, kept: 0 });
    assert.ok(!existsSync(join(root, "m", a.imgName))); assert.ok(existsSync(foreign));
    assert.equal(db.uploadCount(), 0); assert.equal(host.stats.collected, 3);
    assert.deepEqual(await host.gc({ referenced: () => false }), { removed: 0, kept: 0 });
    assert.equal(deploys.length, 4);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a missing token file is a clear error before wrangler is spawned", async () => {
  const root = mkdtempSync(join(tmpdir(), "spore-meta-"));
  try {
    const host = new MetaHost({ root, tokenFile: join(root, "nope"), log: { info() {}, error() {} } });
    await assert.rejects(host.deploy(), /token file .*nope is missing/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("local-first resolution: URLs on PAGES_DOMAIN read from disk (metadata and images), remote hosts untouched", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spore-m-"));
  try {
    const r = metaFiles({ name: "Local", symbol: "LOC", description: "d", imageBytes: PNG, imageType: "image/png", domain: "spore-2x6.pages.dev" });
    mkdirSync(join(dir, "m")); writeFileSync(join(dir, "m", r.imgName), PNG); writeFileSync(join(dir, "m", r.jsonName), r.json);
    assert.equal(isAllowedImageUrl(r.imageUri), true, "any public https host is allowed; configuration only adds the local-first read");
    configureLocalMetaHost({ domain: "spore-2x6.pages.dev", dir: join(dir, "m") });
    try {
      assert.equal(isAllowedImageUrl(r.imageUri), true);
      assert.deepEqual(localMetaFile(r.metadataUri), { file: join(dir, "m", r.jsonName), type: "application/json" });
      assert.deepEqual(localMetaFile(r.imageUri), { file: join(dir, "m", r.imgName), type: "image/png" });
      assert.equal(localMetaFile(`https://spore-2x6.pages.dev/m/${"a".repeat(64)}.json`), null, "unknown file → remote fallback");
      assert.equal(localMetaFile("https://spore-2x6.pages.dev/m/../index.html"), null);
      assert.equal(localMetaFile("https://evil.example/m/" + r.jsonName), null);
      // MetaFetcher never calls fetch for a local file; ImageCache serves the file directly.
      let fetched = 0;
      const stored = new Map();
      const model = { meta: new Map(), setMeta: (uri, m) => stored.set(uri, m) };
      const fetcher = new MetaFetcher(model, { fetchImpl: async () => { fetched++; return new Response("{}"); } });
      fetcher.request(r.metadataUri);
      await new Promise((res) => setTimeout(res, 30));
      assert.equal(fetched, 0);
      assert.equal(stored.get(r.metadataUri).ok, true);
      assert.equal(stored.get(r.metadataUri).image, r.imageUri);
      assert.equal(stored.get(r.metadataUri).description, "d");
      const cache = new ImageCache(join(dir, "img"), { fetchImpl: async () => { fetched++; return new Response(PNG, { headers: { "content-type": "image/png" } }); } });
      assert.deepEqual(await cache.get(r.imageUri), { file: join(dir, "m", r.imgName), type: "image/png" });
      assert.equal(fetched, 0);
    } finally { configureLocalMetaHost({}); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("deploy lock: under a burst of concurrent publishes no two deploys ever overlap", async () => {
  const root = mkdtempSync(join(tmpdir(), "spore-meta-"));
  try {
    let running = 0, maxRunning = 0, deploys = 0;
    const host = new MetaHost({ root, log: { info() {}, error() {} }, deployImpl: async () => { running++; deploys++; maxRunning = Math.max(maxRunning, running); await new Promise((r) => setTimeout(r, 15)); running--; return null; } });
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => host.publish({ name: `N${i}`, symbol: `S${i}`, imageBytes: PNG, imageType: "image/png" })));
    assert.equal(maxRunning, 1, "wrangler never runs twice at once");
    assert.ok(deploys >= 1 && deploys <= 2, `${deploys} deploys for 12 uploads`);
    for (const r of results) assert.ok(existsSync(join(root, "m", r.jsonName)), "every upload's files are on disk when its publish resolves");
    assert.equal(host.current, null); assert.equal(host.queued, null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
