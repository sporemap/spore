// Partner API keys for /v1 (DESIGN §12). A key is `spk_` + 32 base58 characters (~187 bits) and is
// shown once, by the CLI that creates it (scripts/keys.mjs); sqlite keeps only its sha256, so a copy
// of the database (a backup, a laptop) never leaks a usable key. There is no HTTP admin surface.
//
// The server verifies a key on every keyed request: the hash is looked up in `api_keys` (indexed,
// microseconds) and a hit is remembered for `cacheMs`, so a revocation done by the CLI in another
// process takes effect within that window. Misses are not cached: a key created a second ago must
// work at once, and a lookup is cheaper than a cache that a flood of random keys could grow.
// Usage counters (`requests`, `last_used_at`) are kept in memory and written in one transaction
// every `flushMs`, never per request.
import { createHash, randomBytes } from "node:crypto";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export const KEY_PREFIX = "spk_";
export const KEY_RE = /^spk_[1-9A-HJ-NP-Za-km-z]{32}$/;
export const TIERS = ["partner"];

/** A new random key. Rejection sampling keeps every base58 character equally likely (256 = 4·58 + 24). */
export function generateKey(random = randomBytes) {
  let out = "";
  while (out.length < 32) {
    for (const b of random(48)) {
      if (b >= 232) continue;
      out += B58[b % 58];
      if (out.length === 32) break;
    }
  }
  return KEY_PREFIX + out;
}
export const hashKey = (key) => createHash("sha256").update(String(key), "utf8").digest("hex");
export const isKeyShaped = (s) => typeof s === "string" && KEY_RE.test(s);

export class ApiKeys {
  constructor(db, { cacheMs = 15_000, flushMs = 30_000, now = Date.now, log = console } = {}) {
    this.db = db; this.cacheMs = cacheMs; this.flushMs = flushMs; this.now = now; this.log = log;
    this.cache = new Map();    // hash → { at, rec } (valid keys only)
    this.pending = new Map();  // id → { requests, lastUsedAt } not yet written
    this.timer = null;
    this.stats = { verified: 0, rejected: 0, flushes: 0, flushErrors: 0 };
  }

  /** Creates a key; the plaintext is in the result and nowhere else, ever. */
  create({ name, contact = null, tier = "partner" } = {}) {
    const n = String(name ?? "").trim();
    if (!n || n.length > 80) throw new Error("name is required (at most 80 characters)");
    if (!TIERS.includes(tier)) throw new Error(`tier must be one of ${TIERS.join(", ")}`);
    const c = contact == null ? null : String(contact).trim().slice(0, 200) || null;
    const key = generateKey();
    const createdAt = Math.floor(this.now() / 1000);
    const id = this.db.apiKeyInsert({ name: n, contact: c, hash: hashKey(key), tier, createdAt });
    return { id, key, name: n, contact: c, tier, createdAt };
  }
  list() { return this.db.apiKeys(); }
  /** Revokes by id; true when a live key was revoked. The server forgets it within `cacheMs`. */
  revoke(id) {
    const ok = this.db.apiKeyRevoke(Number(id), Math.floor(this.now() / 1000));
    for (const [h, e] of this.cache) if (e.rec.id === Number(id)) this.cache.delete(h);
    return ok;
  }

  /** `{ id, name, tier }` for a live key, else null (malformed, unknown or revoked). */
  verify(key) {
    if (!isKeyShaped(key)) { this.stats.rejected++; return null; }
    const h = hashKey(key);
    const t = this.now();
    const hit = this.cache.get(h);
    if (hit && t - hit.at < this.cacheMs) { this.stats.verified++; return hit.rec; }
    let row = null;
    try { row = this.db.apiKeyByHash(h); } catch (e) { this.log.warn?.(`apikeys: lookup failed: ${e.message}`); }
    if (!row || row.revokedAt != null) { this.cache.delete(h); this.stats.rejected++; return null; }
    const rec = { id: row.id, name: row.name, tier: row.tier };
    this.cache.set(h, { at: t, rec });
    if (this.cache.size > 5_000) this.cache.delete(this.cache.keys().next().value);
    this.stats.verified++;
    return rec;
  }

  /** Counts one served request for a key (written by the next flush). */
  count(id) {
    const p = this.pending.get(id) ?? { requests: 0, lastUsedAt: 0 };
    p.requests++; p.lastUsedAt = Math.floor(this.now() / 1000);
    this.pending.set(id, p);
  }
  /** Writes the pending counters in one transaction; on failure they are kept for the next try. */
  flush() {
    if (!this.pending.size) return 0;
    const rows = [...this.pending].map(([id, p]) => ({ id, requests: p.requests, lastUsedAt: p.lastUsedAt }));
    this.pending.clear();
    try { this.db.apiKeyUsage(rows); this.stats.flushes++; return rows.length; }
    catch (e) {
      this.stats.flushErrors++;
      this.log.warn?.(`apikeys: usage flush failed (${rows.length} keys kept for the next one): ${e.message}`);
      for (const r of rows) { const p = this.pending.get(r.id) ?? { requests: 0, lastUsedAt: 0 }; p.requests += r.requests; p.lastUsedAt = Math.max(p.lastUsedAt, r.lastUsedAt); this.pending.set(r.id, p); }
      return 0;
    }
  }
  start() { if (!this.timer) { this.timer = setInterval(() => this.flush(), this.flushMs); this.timer.unref(); } return this; }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; this.flush(); }
  snapshot() { return { ...this.stats, cached: this.cache.size, pending: this.pending.size }; }
}
