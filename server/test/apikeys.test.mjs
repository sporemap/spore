// Partner API keys (DESIGN §12): format, hashing (the plaintext is never stored), verify cache and
// revocation, batched usage counters, and the admin CLI (scripts/keys.mjs) end to end on a temp file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Db } from "../lib/db.mjs";
import { ApiKeys, generateKey, hashKey, isKeyShaped, KEY_RE } from "../lib/apikeys.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "../scripts/keys.mjs");
const quiet = { info() {}, warn() {}, error() {} };

test("generateKey: spk_ + 32 base58 characters, unbiased alphabet, never repeats", () => {
  const seen = new Set(), chars = new Map();
  for (let i = 0; i < 2_000; i++) {
    const k = generateKey();
    assert.match(k, KEY_RE); assert.equal(k.length, 36); assert.ok(isKeyShaped(k));
    assert.ok(!seen.has(k)); seen.add(k);
    for (const c of k.slice(4)) chars.set(c, (chars.get(c) ?? 0) + 1);
  }
  assert.equal(chars.size, 58, "every base58 character occurs");
  const counts = [...chars.values()], mean = (2_000 * 32) / 58;
  assert.ok(Math.min(...counts) > mean * 0.75 && Math.max(...counts) < mean * 1.25, "roughly uniform");
  // Rejection sampling: bytes ≥ 232 are skipped, so a source of only those never yields a character.
  let calls = 0;
  const k = generateKey((n) => { calls++; return calls === 1 ? Buffer.alloc(n, 255) : Buffer.alloc(n, 57); });
  assert.equal(k, `spk_${"z".repeat(32)}`); assert.equal(calls, 2);
  for (const bad of ["spk_short", `spk_${"0".repeat(32)}`, `sk_${"a".repeat(32)}`, `spk_${"a".repeat(33)}`, null, 42]) assert.equal(isKeyShaped(bad), false, String(bad));
});

test("create stores only the sha256; verify, revoke; malformed keys never reach the database", () => {
  const db = new Db(":memory:");
  const keys = new ApiKeys(db, { log: quiet });
  const k = keys.create({ name: " Axiom ", contact: "@axiom" });
  assert.equal(k.name, "Axiom"); assert.equal(k.tier, "partner"); assert.match(k.key, KEY_RE);
  const rows = db.db.prepare("SELECT * FROM api_keys").all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].hash, hashKey(k.key)); assert.match(rows[0].hash, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(rows).includes(k.key.slice(4)), "the plaintext is nowhere in the table");
  assert.ok(!JSON.stringify(keys.list()).includes(k.key.slice(4)) && !("hash" in keys.list()[0]), "list() shows neither key nor hash");
  assert.deepEqual(keys.verify(k.key), { id: k.id, name: "Axiom", tier: "partner" });
  assert.equal(keys.verify(`spk_${"1".repeat(32)}`), null);
  assert.throws(() => keys.create({ name: "" }), /name is required/);
  assert.throws(() => keys.create({ name: "x", tier: "god" }), /tier/);
  let lookups = 0; const orig = db.apiKeyByHash.bind(db); db.apiKeyByHash = (h) => { lookups++; return orig(h); };
  assert.equal(keys.verify("not a key"), null); assert.equal(keys.verify(""), null); assert.equal(lookups, 0);
  assert.equal(keys.revoke(k.id), true); assert.equal(keys.revoke(k.id), false, "already revoked");
  assert.equal(keys.verify(k.key), null);
  assert.ok(db.apiKeys()[0].revokedAt > 0);
  db.close();
});

test("verify cache: a revocation written by another process is honoured once the cache entry expires; a new key works at once", () => {
  let t = 1_000_000;
  const db = new Db(":memory:");
  const keys = new ApiKeys(db, { cacheMs: 15_000, now: () => t, log: quiet });
  const k = keys.create({ name: "Photon" });
  assert.ok(keys.verify(k.key));
  db.apiKeyRevoke(k.id); // the CLI, not this instance: the cache does not know
  t += 14_000; assert.ok(keys.verify(k.key), "cached hit inside the window");
  t += 2_000; assert.equal(keys.verify(k.key), null, "revoked after the window");
  // A miss is not cached: a key created after a failed attempt is valid immediately.
  const other = new ApiKeys(db, { now: () => t, log: quiet });
  const fresh = other.create({ name: "BullX" });
  assert.ok(keys.verify(fresh.key));
  db.close();
});

test("usage counters are batched: no write per request, one transaction per flush, kept on failure", () => {
  let t = 1_700_000_000_000;
  const db = new Db(":memory:");
  const keys = new ApiKeys(db, { now: () => t, log: quiet });
  const a = keys.create({ name: "A" }), b = keys.create({ name: "B" });
  let writes = 0; const orig = db.apiKeyUsage.bind(db); db.apiKeyUsage = (rows) => { writes++; return orig(rows); };
  for (let i = 0; i < 50; i++) keys.count(a.id);
  t += 5_000; keys.count(b.id);
  assert.equal(writes, 0);
  assert.equal(keys.flush(), 2); assert.equal(writes, 1);
  const byId = Object.fromEntries(db.apiKeys().map((r) => [r.id, r]));
  assert.equal(byId[a.id].requests, 50); assert.equal(byId[b.id].requests, 1);
  assert.equal(byId[b.id].lastUsedAt, Math.floor(t / 1000));
  assert.equal(keys.flush(), 0, "nothing pending");
  db.apiKeyUsage = () => { throw new Error("database is locked"); };
  keys.count(a.id); keys.count(a.id);
  assert.equal(keys.flush(), 0); assert.equal(keys.snapshot().flushErrors, 1); assert.equal(keys.snapshot().pending, 1);
  db.apiKeyUsage = orig; keys.count(a.id);
  assert.equal(keys.flush(), 1);
  assert.equal(db.apiKeys().find((r) => r.id === a.id).requests, 53, "the failed batch was carried over");
  db.close();
});

test("CLI: create prints the key once; list and usage never show it; revoke; a missing database is refused", () => {
  const dir = mkdtempSync(join(tmpdir(), "spore-keys-"));
  try {
    new Db(join(dir, "spore.sqlite")).close();
    const run = (...args) => execFileSync(process.execPath, ["--disable-warning=ExperimentalWarning", CLI, ...args, "--data", dir], { encoding: "utf8" });
    const out = run("create", "--name", "GMGN", "--contact", "team@gmgn.example");
    const key = out.match(/spk_[1-9A-HJ-NP-Za-km-z]{32}/)?.[0];
    assert.ok(key, out); assert.equal(out.split(key).length - 1, 1, "printed exactly once");
    assert.match(out, /created key #1 for GMGN/);
    const list = run("list");
    assert.match(list, /GMGN\s+team@gmgn\.example\s+partner/); assert.match(list, /active/); assert.ok(!list.includes(key.slice(4)));
    // The server side sees it at once (same file, another connection).
    const db = new Db(join(dir, "spore.sqlite"));
    const keys = new ApiKeys(db, { log: quiet });
    assert.equal(keys.verify(key).name, "GMGN");
    keys.count(1); keys.count(1); keys.flush();
    const usage = run("usage");
    assert.match(usage, /GMGN\s+2\s+\d{4}-\d\d-\d\dT/); assert.ok(!usage.includes(key.slice(4)));
    assert.match(run("revoke", "1"), /revoked key #1 \(GMGN\)/);
    assert.match(run("revoke", "1"), /already revoked/);
    assert.match(run("list"), /revoked 20/);
    keys.cache.clear();
    assert.equal(keys.verify(key), null);
    db.close();
    const missing = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", CLI, "list", "--data", join(dir, "nope")], { encoding: "utf8" });
    assert.equal(missing.status, 2); assert.match(missing.stderr, /no database/);
    const bad = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", CLI, "frobnicate", "--data", dir], { encoding: "utf8" });
    assert.equal(bad.status, 2); assert.match(bad.stderr, /usage:/);
    const unknown = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", CLI, "revoke", "9", "--data", dir], { encoding: "utf8" });
    assert.equal(unknown.status, 1); assert.match(unknown.stderr, /no key #9/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("api_keys migration: the table exists on a fresh database and survives reopening", () => {
  const dir = mkdtempSync(join(tmpdir(), "spore-keys-m-"));
  try {
    const f = join(dir, "spore.sqlite");
    let db = new Db(f);
    const cols = db.db.prepare("PRAGMA table_info(api_keys)").all().map((c) => c.name);
    assert.deepEqual(cols, ["id", "name", "contact", "hash", "tier", "created_at", "revoked_at", "last_used_at", "requests"]);
    const id = new ApiKeys(db).create({ name: "X" }).id;
    db.close(); db = new Db(f); db.migrate();
    assert.equal(db.apiKeys()[0].id, id);
    assert.equal(db.db.prepare("PRAGMA busy_timeout").get().timeout, 2000);
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
