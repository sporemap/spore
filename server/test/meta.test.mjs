import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082", "hex");
import { isAllowedImageUrl, isAllowedMetaUrl, normalizeImageUrl, pickMeta, ImageCache, MetaFetcher, HostPacer, gatewayCandidates, ipfsPathOf, imageProxyUrl, retryAfterS, META_TTL_S, HOST_SPACING_MS } from "../lib/meta.mjs";

test("image hosts: any public https host at the default port passes; local, numeric, non-https, credentials and ports are refused", () => {
  for (const ok of [
    "https://ipfs.io/ipfs/QmX", "https://gateway.pinata.cloud/ipfs/QmX", "https://pump.fun/x.png", "https://images.pump.fun/x.png",
    "https://arweave.net/abc", "https://x.arweave.net/abc", "https://bafy.ipfs.nftstorage.link/x.png", "https://bafy.ipfs.dweb.link/",
    "https://axiomtrading-v2.axiom-cdn.io/x.png", "https://cdn.example-launchpad.io/images/1", "https://m.rapidlaunch.io/x.png", "https://evil.com/ipfs.io",
  ]) assert.equal(isAllowedImageUrl(ok), true, ok);
  for (const bad of [
    "http://ipfs.io/ipfs/QmX", "https://user:pw@ipfs.io/x", "ftp://ipfs.io/x", "https://localhost/x", "", null, undefined, "https://ipfsXio/x",
    "javascript:alert(1)", "https://ipfs.io:8443/ipfs/QmX", "https://x.ipfs.dweb.link:8080/", "https://127.0.0.1/x", "https://[::1]/x", "https://169.254.169.254/latest", "https://box.local/x",
  ]) assert.equal(isAllowedImageUrl(bad), false, String(bad));
});

test("ImageCache keeps at most maxBytes on disk, evicting the oldest files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spore-img-"));
  try {
    const fetchImpl = async () => new Response(PNG, { headers: { "content-type": "image/png" } });
    const cache = new ImageCache(dir, { pacer: new HostPacer({ fetchImpl, sleep: async () => {} }), maxBytes: 400 });
    for (let i = 0; i < 6; i++) { assert.ok(await cache.get(`https://ipfs.io/ipfs/Qm${i}`)); await new Promise((r) => setTimeout(r, 5)); }
    assert.ok(cache.stats.evicted >= 2, `evicted ${cache.stats.evicted}`);
    assert.ok(cache.stats.bytes <= 400, `bytes ${cache.stats.bytes}`);
    assert.ok(cache.stats.bytes > 0);
    assert.ok(await cache.get("https://ipfs.io/ipfs/Qm5"), "the newest file survived");
    const again = new ImageCache(dir, { pacer: new HostPacer({ fetchImpl, sleep: async () => {} }), maxBytes: 400 });
    assert.equal(again.stats.bytes, cache.stats.bytes, "the budget is measured from disk at boot");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("normalizeImageUrl rewrites ipfs:// to the ipfs.io gateway and nulls disallowed hosts", () => {
  assert.equal(normalizeImageUrl("ipfs://QmX/logo.png"), "https://ipfs.io/ipfs/QmX/logo.png");
  assert.equal(normalizeImageUrl("ipfs://ipfs/QmX"), "https://ipfs.io/ipfs/QmX");
  assert.equal(normalizeImageUrl("https://ipfs.io/ipfs/QmX"), "https://ipfs.io/ipfs/QmX");
  assert.equal(normalizeImageUrl("https://m.rapidlaunch.io/x.png"), "https://m.rapidlaunch.io/x.png");
  assert.equal(normalizeImageUrl("http://m.rapidlaunch.io/x.png"), null);
  assert.equal(normalizeImageUrl(42), null);
});

test("metadata JSON hosts: any public https host, never local or numeric", () => {
  assert.equal(isAllowedMetaUrl("https://m.rapidlaunch.io/m/uQhFx7h80"), true);
  assert.equal(isAllowedMetaUrl("https://ipfs.io/ipfs/QmX"), true);
  for (const bad of ["http://ipfs.io/x", "https://localhost/x", "https://127.0.0.1/x", "https://[::1]/x", "https://169.254.169.254/latest", "https://box.local/x", "https://ipfs.io:8080/x", "https://nodots/x"]) assert.equal(isAllowedMetaUrl(bad), false, bad);
});

test("pickMeta normalizes socials and trims text", () => {
  const m = pickMeta({ image: "ipfs://QmX", description: "  hello ".repeat(3), twitter: "@spore", telegram: "https://t.me/spore", website: "spore.fun" });
  assert.equal(m.image, "https://ipfs.io/ipfs/QmX");
  assert.equal(m.description, "hello   hello   hello");
  assert.equal(m.twitter, "https://x.com/spore");
  assert.equal(m.telegram, "https://t.me/spore");
  assert.equal(m.website, "https://spore.fun/");
  assert.deepEqual(pickMeta(null), { image: null, description: null, twitter: null, telegram: null, website: null });
  assert.equal(pickMeta({ twitter: "javascript:alert(1)" }).twitter, null);
  assert.equal(pickMeta({ website: "ftp://x.y" }).website, null);
});

test("imageProxyUrl routes through /api/img", () => {
  assert.equal(imageProxyUrl("https://ipfs.io/ipfs/Qm?x=1"), "/api/img?u=https%3A%2F%2Fipfs.io%2Fipfs%2FQm%3Fx%3D1");
  assert.equal(imageProxyUrl(null), null);
});

test("ImageCache refuses disallowed hosts without fetching, caches an allowed image, rejects non-images", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spore-img-"));
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.endsWith("big.png")) return new Response(Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)]), { headers: { "content-type": "image/png" } });
    if (url.endsWith("fake.png")) return new Response(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]), { headers: { "content-type": "image/png" } }); // claims png, is not
    if (url.endsWith("logo.svg")) return new Response("<svg/>", { headers: { "content-type": "image/svg+xml" } });
    if (url.endsWith("page.html")) return new Response("<html>", { headers: { "content-type": "text/html" } });
    return new Response(PNG, { headers: { "content-type": "application/octet-stream" } }); // a gateway with a wrong type: the bytes decide
  };
  const cache = new ImageCache(dir, { pacer: new HostPacer({ fetchImpl, sleep: async () => {} }), log: { warn() {} } });
  try {
    assert.equal(await cache.get("https://localhost/x.png"), null);
    assert.equal(calls.length, 0);
    const a = await cache.get("https://ipfs.io/ipfs/QmX/logo.png");
    assert.equal(a.type, "image/png");
    const b = await cache.get("https://ipfs.io/ipfs/QmX/logo.png");
    assert.equal(b.file, a.file);
    assert.equal(calls.length, 1, "second read is a cache hit");
    assert.equal(await cache.get("https://ipfs.io/ipfs/big.png"), null);
    assert.equal(await cache.get("https://ipfs.io/ipfs/page.html"), null);
    assert.equal(await cache.get("https://ipfs.io/ipfs/fake.png"), null, "declared png with non-png bytes");
    assert.equal(await cache.get("https://ipfs.io/ipfs/logo.svg"), null, "svg is never proxied");
    assert.deepEqual({ hits: cache.stats.hits, failed: cache.stats.failed }, { hits: 1, failed: 4 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("MetaFetcher dedupes, bounds the queue and stores failures with a retry window", async () => {
  const stored = new Map();
  const model = { meta: stored, setMeta: (uri, m) => stored.set(uri, { uri, ...m }) };
  let calls = 0;
  const fetchImpl = async (url) => { calls++; if (url.includes("bad")) return new Response("nope", { status: 500 }); return new Response(JSON.stringify({ image: "https://ipfs.io/ipfs/QmI", description: "d" }), { headers: { "content-type": "application/json" } }); };
  const f = new MetaFetcher(model, { pacer: new HostPacer({ fetchImpl, sleep: async () => {} }), concurrency: 2 });
  f.request("https://ipfs.io/ipfs/QmA"); f.request("https://ipfs.io/ipfs/QmA"); f.request("https://ipfs.io/ipfs/bad"); f.request("http://ipfs.io/ipfs/QmPlain");
  await new Promise((r) => setTimeout(r, 50));
  // QmA once; "bad" answers 500 on every gateway of the rotation (5 hosts) before it is recorded.
  assert.equal(calls, 1 + 5);
  assert.equal(stored.get("https://ipfs.io/ipfs/QmA").image, "https://ipfs.io/ipfs/QmI");
  assert.equal(stored.get("https://ipfs.io/ipfs/QmA").attempts, 0);
  assert.equal(stored.get("https://ipfs.io/ipfs/bad").ok, false);
  assert.equal(stored.get("https://ipfs.io/ipfs/bad").attempts, 1);
  assert.equal(f.needsFetch("https://ipfs.io/ipfs/QmA"), false, "fresh success is not refetched");
  assert.equal(f.needsFetch("https://ipfs.io/ipfs/bad"), false, "a fresh failure waits for its retry window");
  assert.equal(f.needsFetch("https://ipfs.io/ipfs/bad", Math.floor(Date.now() / 1000) + 16 * 60), true);
  assert.equal(f.pendingCount, 0);
});

test("gatewayCandidates: IPFS content rotates through pump's pinata, then ipfs.io → dweb.link → gateway.pinata.cloud → w3s.link; cf-ipfs.com is dropped; other URLs stand alone", () => {
  const rotation = ["https://pump.mypinata.cloud/ipfs/QmX/meta.json", "https://ipfs.io/ipfs/QmX/meta.json", "https://dweb.link/ipfs/QmX/meta.json", "https://gateway.pinata.cloud/ipfs/QmX/meta.json", "https://w3s.link/ipfs/QmX/meta.json"];
  assert.deepEqual(gatewayCandidates("https://ipfs.io/ipfs/QmX/meta.json"), rotation);
  assert.deepEqual(gatewayCandidates("https://cf-ipfs.com/ipfs/QmX/meta.json"), rotation, "the dead gateway is never asked");
  assert.deepEqual(gatewayCandidates("https://gateway.pinata.cloud/ipfs/QmX/meta.json"), rotation, "a gateway of the rotation keeps its place");
  assert.deepEqual(gatewayCandidates("https://bafyabc.ipfs.dweb.link/logo.png"), rotation.map((u) => u.replace("QmX/meta.json", "bafyabc/logo.png")), "subdomain form is understood");
  assert.deepEqual(gatewayCandidates("https://ipfs2.extraction.live/ipfs/B6Qao?x=1").slice(0, 2), ["https://ipfs2.extraction.live/ipfs/B6Qao?x=1", "https://pump.mypinata.cloud/ipfs/B6Qao?x=1"], "a gateway outside the rotation goes first: the content may only be there");
  assert.equal(gatewayCandidates("https://ipfs2.extraction.live/ipfs/B6Qao?x=1").length, 6);
  assert.deepEqual(gatewayCandidates("https://m.rapidlaunch.io/m/x"), ["https://m.rapidlaunch.io/m/x"]);
  assert.equal(ipfsPathOf("ipfs://QmX/logo.png"), "QmX/logo.png");
  assert.equal(ipfsPathOf("https://x.y/z"), null);
  assert.ok(isAllowedImageUrl("https://pump.mypinata.cloud/ipfs/QmX"));
  assert.ok(isAllowedImageUrl("https://dweb.link/ipfs/QmX") && isAllowedImageUrl("https://w3s.link/ipfs/QmX"), "path-form entry points of the rotation are allowed");
});

test("HostPacer: a 429 pauses that host and the next gateway serves the content; spacing is enforced per host", async () => {
  const calls = []; const sleeps = [];
  const limitedHost = (url) => url.startsWith("https://pump.mypinata.cloud/") || url.startsWith("https://ipfs.io/");
  const fetchImpl = async (url) => { calls.push(url); return new Response("{}", { status: limitedHost(url) ? 429 : 200, headers: { "content-type": "application/json" } }); };
  const pacer = new HostPacer({ fetchImpl, sleep: async (ms) => { sleeps.push(ms); } });
  const hit = await pacer.fetchAny("https://ipfs.io/ipfs/QmA");
  assert.equal(hit.url, "https://dweb.link/ipfs/QmA");
  assert.deepEqual(calls, ["https://pump.mypinata.cloud/ipfs/QmA", "https://ipfs.io/ipfs/QmA", "https://dweb.link/ipfs/QmA"]);
  // Both limited hosts are now paused and dweb.link was just used: the least-busy gateway of the rotation serves next, with no wait.
  calls.length = 0;
  const again = await pacer.fetchAny("https://ipfs.io/ipfs/QmB");
  assert.equal(again.url, "https://gateway.pinata.cloud/ipfs/QmB");
  assert.deepEqual(calls, ["https://gateway.pinata.cloud/ipfs/QmB"]);
  assert.equal(sleeps.length, 0);
  // Every gateway busy within the spacing window: the soonest free one is waited for.
  calls.length = 0;
  await pacer.fetchAny("https://ipfs.io/ipfs/QmC");
  assert.deepEqual(calls, ["https://w3s.link/ipfs/QmC"]);
  calls.length = 0;
  await pacer.fetchAny("https://ipfs.io/ipfs/QmD");
  assert.equal(calls.length, 1);
  assert.ok(sleeps.length === 1 && sleeps[0] > 0 && sleeps[0] <= HOST_SPACING_MS, `spacing wait applied (${sleeps})`);
  // A host with no alternative that is rate-limited yields null (caller retries later).
  const limited = new HostPacer({ fetchImpl: async () => new Response("", { status: 429 }), sleep: async () => {} });
  assert.equal(await limited.fetchAny("https://m.rapidlaunch.io/m/x"), null);
  assert.equal(await limited.fetchAny("https://m.rapidlaunch.io/m/y"), null, "paused host is skipped without a request");
});

test("HostPacer: a 403/404 from one gateway is not final; the rotation finds the content, or the last answer is returned", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.startsWith("https://pump.mypinata.cloud/") || url.startsWith("https://ipfs.io/")) return new Response("forbidden", { status: 403 });
    if (url.startsWith("https://dweb.link/")) return new Response("nope", { status: 404 });
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  const pacer = new HostPacer({ fetchImpl, sleep: async () => {} });
  const hit = await pacer.fetchAny("https://ipfs.io/ipfs/QmA");
  assert.equal(hit.res.status, 200); assert.equal(hit.url, "https://gateway.pinata.cloud/ipfs/QmA");
  assert.deepEqual(calls, ["https://pump.mypinata.cloud/ipfs/QmA", "https://ipfs.io/ipfs/QmA", "https://dweb.link/ipfs/QmA", "https://gateway.pinata.cloud/ipfs/QmA"]);
  assert.equal(pacer.stats.rotated, 3);
  // Every gateway says no: the last answer comes back so the caller records a status, not a guess.
  const gone = new HostPacer({ fetchImpl: async () => new Response("", { status: 404 }), sleep: async () => {} });
  const miss = await gone.fetchAny("https://ipfs.io/ipfs/QmZ");
  assert.equal(miss.res.status, 404); assert.equal(miss.url, "https://w3s.link/ipfs/QmZ");
  // A timeout on one gateway moves on too; only when all of them error is the error thrown.
  let n = 0;
  const flaky = new HostPacer({ fetchImpl: async (url) => { n++; if (url.startsWith("https://pump.mypinata.cloud/")) throw new Error("The operation was aborted due to timeout"); return new Response("{}", { status: 200 }); }, sleep: async () => {} });
  assert.equal((await flaky.fetchAny("https://ipfs.io/ipfs/QmT")).url, "https://ipfs.io/ipfs/QmT"); assert.equal(n, 2);
  const dead = new HostPacer({ fetchImpl: async () => { throw new Error("ENOTFOUND"); }, sleep: async () => {} });
  await assert.rejects(() => dead.fetchAny("https://ipfs.io/ipfs/QmT"), /ENOTFOUND/);
  await assert.rejects(() => dead.fetchAny("https://m.rapidlaunch.io/m/x"), /ENOTFOUND/, "a single-candidate URL throws as before");
  // Each attempt has its own timeout under one budget per uri: a slow gateway does not eat the next one's time, and the budget ends the rotation.
  const seen = [];
  const slow = new HostPacer({ fetchImpl: async (url, init) => { seen.push(url); await new Promise((r, j) => { init.signal.addEventListener("abort", () => j(init.signal.reason)); }); }, sleep: async () => {} });
  await assert.rejects(() => slow.fetchAny("https://ipfs.io/ipfs/QmS", {}, { timeoutMs: 15, budgetMs: 40 }), /abort|budget/i);
  assert.ok(seen.length >= 2 && seen.length < 5, `the budget stopped the rotation after ${seen.length} attempts`);
});

test("ImageCache: the image proxy uses the same rotation for /ipfs/ URLs (403 on ipfs.io → dweb.link serves)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spore-img-"));
  const calls = [];
  const fetchImpl = async (url) => { calls.push(url); return url.startsWith("https://ipfs.io/") || url.startsWith("https://pump.mypinata.cloud/") ? new Response("forbidden", { status: 403 }) : new Response(PNG, { headers: { "content-type": "image/png" } }); };
  const cache = new ImageCache(dir, { pacer: new HostPacer({ fetchImpl, sleep: async () => {} }) });
  try {
    const hit = await cache.get("https://ipfs.io/ipfs/QmX/logo.png");
    assert.equal(hit.type, "image/png");
    assert.deepEqual(calls, ["https://pump.mypinata.cloud/ipfs/QmX/logo.png", "https://ipfs.io/ipfs/QmX/logo.png", "https://dweb.link/ipfs/QmX/logo.png"]);
    assert.equal(cache.stats.failed, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("MetaFetcher: failures back off per attempt (15 min → 24 h), a uri that once resolved keeps its image when a re-read fails", async () => {
  const stored = new Map();
  const model = { meta: stored, setMeta: (uri, m) => stored.set(uri, { uri, ...m }) };
  let status = 403;
  const fetchImpl = async () => (status === 200 ? new Response(JSON.stringify({ image: "https://ipfs.io/ipfs/QmI" }), { headers: { "content-type": "application/json" } }) : new Response("", { status }));
  const f = new MetaFetcher(model, { pacer: new HostPacer({ fetchImpl, sleep: async () => {} }), concurrency: 1 });
  const uri = "https://m.rapidlaunch.io/m/x";
  const tick = () => new Promise((r) => setTimeout(r, 20));
  f.request(uri); await tick();
  assert.equal(stored.get(uri).ok, false); assert.equal(stored.get(uri).attempts, 1); assert.equal(stored.get(uri).error, "HTTP 403");
  const t0 = stored.get(uri).fetchedAt;
  assert.equal(f.needsFetch(uri, t0 + 14 * 60), false); assert.equal(f.needsFetch(uri, t0 + 16 * 60), true, "first retry after 15 min");
  stored.set(uri, { ...stored.get(uri), attempts: 3 });
  assert.equal(f.needsFetch(uri, t0 + 59 * 60), false); assert.equal(f.needsFetch(uri, t0 + 61 * 60), true, "third failure waits an hour");
  stored.set(uri, { ...stored.get(uri), attempts: 12 });
  assert.equal(f.needsFetch(uri, t0 + 23 * 3600), false); assert.equal(f.needsFetch(uri, t0 + 25 * 3600), true, "capped at a day");
  assert.equal(retryAfterS(1), 15 * 60); assert.equal(retryAfterS(2), 30 * 60); assert.equal(retryAfterS(20), 24 * 3600);
  // Resolves on a later attempt, then a re-read fails: the image survives.
  stored.set(uri, { ...stored.get(uri), fetchedAt: 0 });
  status = 200; f.request(uri); await tick();
  assert.equal(stored.get(uri).ok, true); assert.equal(stored.get(uri).image, "https://ipfs.io/ipfs/QmI"); assert.equal(stored.get(uri).attempts, 0);
  assert.equal(f.needsFetch(uri, stored.get(uri).fetchedAt + META_TTL_S - 1), false, "a resolved image is kept for a week");
  stored.set(uri, { ...stored.get(uri), fetchedAt: 0 });
  status = 500; f.request(uri); await tick();
  assert.equal(stored.get(uri).ok, true); assert.equal(stored.get(uri).image, "https://ipfs.io/ipfs/QmI"); assert.equal(stored.get(uri).attempts, 1); assert.equal(stored.get(uri).error, "HTTP 500");
  f.stop();
});

test("MetaFetcher: a rate-limited URI is requeued, not recorded as a failure", async () => {
  const stored = new Map();
  const model = { meta: stored, setMeta: (uri, m) => stored.set(uri, { uri, ...m }) };
  const f = new MetaFetcher(model, { pacer: { fetchAny: async () => null }, concurrency: 1 });
  f.request("https://m.rapidlaunch.io/m/x");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(stored.size, 0);
  assert.equal(f.stats.rateLimited, 1);
  assert.equal(f.attempts.get("https://m.rapidlaunch.io/m/x"), 1);
  f.stop();
});
