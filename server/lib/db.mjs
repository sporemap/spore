// Persistence on node:sqlite (built in, no native module). The in-memory model (model.mjs) is the
// working set; this layer is the write-through store that makes restarts cheap: coins, mints and
// metadata come back from disk and the backfill continues where it stopped.
//
// Every u64 is stored as a decimal TEXT string: JS numbers lose precision above 2^53 and sqlite's
// INTEGER would silently round. Prices (REAL) are derived values and may lose precision freely.
import { DatabaseSync, backup } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const SCHEMA_VERSION = 3;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS backfill_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS mints (
  mint TEXT PRIMARY KEY, decimals INTEGER, token_program TEXT, supply TEXT,
  name TEXT, symbol TEXT, uri TEXT, onchain_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS coins (
  mint TEXT PRIMARY KEY, curve TEXT NOT NULL, depth INTEGER NOT NULL, quote_mint TEXT, creator TEXT NOT NULL,
  tracked INTEGER NOT NULL DEFAULT 1,
  vtr TEXT NOT NULL DEFAULT '0', vqr TEXT NOT NULL DEFAULT '0', rtr TEXT NOT NULL DEFAULT '0', rqr TEXT NOT NULL DEFAULT '0',
  supply TEXT NOT NULL DEFAULT '0', ivqr TEXT NOT NULL DEFAULT '0',
  complete INTEGER NOT NULL DEFAULT 0, migrated INTEGER NOT NULL DEFAULT 0, mayhem INTEGER NOT NULL DEFAULT 0,
  holder_reward INTEGER NOT NULL DEFAULT 0, creator_fee_bps INTEGER NOT NULL DEFAULT 0,
  pool TEXT, pool_base_vault TEXT, pool_quote_vault TEXT, pool_base TEXT, pool_quote TEXT,
  created_at INTEGER, created_slot INTEGER, created_probe INTEGER NOT NULL DEFAULT 0,
  shares TEXT, shares_at INTEGER NOT NULL DEFAULT 0,
  refreshed_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0,
  fee_paid TEXT
);
CREATE INDEX IF NOT EXISTS coins_quote ON coins(quote_mint);
CREATE INDEX IF NOT EXISTS coins_depth ON coins(depth);
CREATE INDEX IF NOT EXISTS coins_created ON coins(created_at);
CREATE TABLE IF NOT EXISTS trades (
  sig TEXT NOT NULL, mint TEXT NOT NULL, idx INTEGER NOT NULL DEFAULT 0,
  slot INTEGER NOT NULL, time INTEGER NOT NULL, is_buy INTEGER NOT NULL, user TEXT NOT NULL,
  base_amount TEXT NOT NULL, quote_amount TEXT NOT NULL,
  price_quote REAL NOT NULL, price_usd REAL, value_usd REAL,
  PRIMARY KEY (sig, mint, idx)
);
CREATE INDEX IF NOT EXISTS trades_mint_time ON trades(mint, time);
CREATE INDEX IF NOT EXISTS trades_time ON trades(time);
CREATE TABLE IF NOT EXISTS meta (
  uri TEXT PRIMARY KEY, image TEXT, description TEXT, twitter TEXT, telegram TEXT, website TEXT,
  fetched_at INTEGER NOT NULL DEFAULT 0, ok INTEGER NOT NULL DEFAULT 0, error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS backfill_curves (
  curve TEXT PRIMARY KEY, depth INTEGER NOT NULL, quote_mint TEXT, data TEXT NOT NULL,
  graduated INTEGER NOT NULL DEFAULT 0, rq REAL NOT NULL DEFAULT 0,
  mint TEXT, resolved_at INTEGER NOT NULL DEFAULT 0, error TEXT
);
CREATE INDEX IF NOT EXISTS backfill_pending ON backfill_curves(resolved_at, graduated, rq, depth);
CREATE TABLE IF NOT EXISTS uploads (
  name TEXT PRIMARY KEY, kind TEXT NOT NULL, pair TEXT, ip TEXT, bytes INTEGER NOT NULL DEFAULT 0, at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS uploads_at ON uploads(at);
CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, contact TEXT, hash TEXT NOT NULL UNIQUE,
  tier TEXT NOT NULL DEFAULT 'partner', created_at INTEGER NOT NULL, revoked_at INTEGER, last_used_at INTEGER,
  requests INTEGER NOT NULL DEFAULT 0
);
`;

const now = () => Math.floor(Date.now() / 1000);

export class Db {
  /**
   * `busyMs`: how long a write waits for another connection's write lock before failing. The API-key
   * CLI (scripts/keys.mjs) writes to the same file as the running server; its transactions take
   * well under a millisecond, so a short wait turns a would-be SQLITE_BUSY into a tiny pause.
   */
  constructor(file, { busyMs = 2_000 } = {}) {
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(busyMs))}; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = OFF; PRAGMA temp_store = MEMORY;`);
    this.migrate();
    this.#prepare();
  }

  /** Idempotent: CREATE IF NOT EXISTS for the base schema, then per-version column additions. */
  migrate() {
    this.db.exec(SCHEMA);
    const current = Number(this.db.prepare("SELECT value FROM kv WHERE key = 'schema_version'").get()?.value ?? 0);
    // v2: the launch fee a verified spawn paid. Guarded by the column's absence rather than the
    // version alone, since a fresh database already has it from the CREATE TABLE above.
    if (current < 2 && !this.db.prepare("PRAGMA table_info(coins)").all().some((c) => c.name === "fee_paid")) this.db.exec("ALTER TABLE coins ADD COLUMN fee_paid TEXT");
    // v3: `coins.updated_at` moves from seconds to milliseconds (the map's delta-sync stamp,
    // DESIGN §11.5: `since=<ms>` returns the rows with `updated_at > since`) and `meta.attempts`
    // counts consecutive failed fetches so the retry backoff survives a restart.
    if (current < 3) {
      if (!this.db.prepare("PRAGMA table_info(meta)").all().some((c) => c.name === "attempts")) this.db.exec("ALTER TABLE meta ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0");
      this.db.exec("UPDATE coins SET updated_at = updated_at * 1000 WHERE updated_at > 0 AND updated_at < 100000000000");
    }
    // `api_keys` (partner API keys, DESIGN §12) is a new table only, so CREATE IF NOT EXISTS above is its migration.
    if (current < SCHEMA_VERSION) this.db.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));
  }

  #prepare() {
    const p = (sql) => this.db.prepare(sql);
    this.q = {
      kvGet: p("SELECT value FROM kv WHERE key = ?"),
      kvSet: p("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)"),
      bfGet: p("SELECT value FROM backfill_state WHERE key = ?"),
      bfSet: p("INSERT OR REPLACE INTO backfill_state (key, value) VALUES (?, ?)"),
      bfAll: p("SELECT key, value FROM backfill_state"),
      mintUpsert: p(`INSERT INTO mints (mint, decimals, token_program, supply, name, symbol, uri, onchain_at) VALUES (@mint, @decimals, @tokenProgram, @supply, @name, @symbol, @uri, @onchainAt)
        ON CONFLICT(mint) DO UPDATE SET decimals = COALESCE(excluded.decimals, decimals), token_program = COALESCE(excluded.token_program, token_program), supply = COALESCE(excluded.supply, supply),
        name = COALESCE(excluded.name, name), symbol = COALESCE(excluded.symbol, symbol), uri = COALESCE(excluded.uri, uri), onchain_at = MAX(excluded.onchain_at, onchain_at)`),
      mintsAll: p("SELECT * FROM mints"),
      coinUpsert: p(`INSERT INTO coins (mint, curve, depth, quote_mint, creator, tracked, vtr, vqr, rtr, rqr, supply, ivqr, complete, migrated, mayhem, holder_reward, creator_fee_bps,
          pool, pool_base_vault, pool_quote_vault, pool_base, pool_quote, created_at, created_slot, created_probe, shares, shares_at, refreshed_at, updated_at, fee_paid)
        VALUES (@mint, @curve, @depth, @quoteMint, @creator, @tracked, @vtr, @vqr, @rtr, @rqr, @supply, @ivqr, @complete, @migrated, @mayhem, @holderReward, @creatorFeeBps,
          @pool, @poolBaseVault, @poolQuoteVault, @poolBase, @poolQuote, @createdAt, @createdSlot, @createdProbe, @shares, @sharesAt, @refreshedAt, @updatedAt, @feePaid)
        ON CONFLICT(mint) DO UPDATE SET curve = excluded.curve, depth = excluded.depth, quote_mint = excluded.quote_mint, creator = excluded.creator, tracked = MAX(excluded.tracked, tracked),
          vtr = excluded.vtr, vqr = excluded.vqr, rtr = excluded.rtr, rqr = excluded.rqr, supply = excluded.supply, ivqr = excluded.ivqr,
          complete = excluded.complete, migrated = excluded.migrated, mayhem = excluded.mayhem, holder_reward = excluded.holder_reward, creator_fee_bps = excluded.creator_fee_bps,
          pool = excluded.pool, pool_base_vault = excluded.pool_base_vault, pool_quote_vault = excluded.pool_quote_vault, pool_base = excluded.pool_base, pool_quote = excluded.pool_quote,
          created_at = COALESCE(excluded.created_at, created_at), created_slot = COALESCE(excluded.created_slot, created_slot), created_probe = MAX(excluded.created_probe, created_probe),
          shares = COALESCE(excluded.shares, shares), shares_at = MAX(excluded.shares_at, shares_at), refreshed_at = excluded.refreshed_at, updated_at = excluded.updated_at,
          fee_paid = COALESCE(excluded.fee_paid, fee_paid)`),
      coinsAll: p("SELECT * FROM coins"),
      coinTouch: p("UPDATE coins SET updated_at = ? WHERE mint = ? AND updated_at < ?"),
      tradeInsert: p(`INSERT OR IGNORE INTO trades (sig, mint, idx, slot, time, is_buy, user, base_amount, quote_amount, price_quote, price_usd, value_usd)
        VALUES (@sig, @mint, @idx, @slot, @time, @isBuy, @user, @baseAmount, @quoteAmount, @priceQuote, @priceUsd, @valueUsd)`),
      tradeTrim: p("DELETE FROM trades WHERE mint = ? AND rowid NOT IN (SELECT rowid FROM trades WHERE mint = ? ORDER BY time DESC, rowid DESC LIMIT ?)"),
      tradeCount: p("SELECT COUNT(*) AS n FROM trades WHERE mint = ?"),
      tradesFor: p("SELECT * FROM trades WHERE mint = ? ORDER BY time DESC, rowid DESC LIMIT ?"),
      tradesSince: p("SELECT * FROM trades WHERE mint = ? AND time >= ? ORDER BY time ASC, rowid ASC"),
      tradesWindow: p("SELECT mint, time, is_buy, value_usd FROM trades WHERE time >= ? ORDER BY time, rowid"),
      vol24: p("SELECT COUNT(*) AS n, COALESCE(SUM(value_usd), 0) AS usd FROM trades WHERE mint = ? AND time >= ?"),
      vol24All: p("SELECT mint, COUNT(*) AS n, COALESCE(SUM(value_usd), 0) AS usd FROM trades WHERE time >= ? GROUP BY mint"),
      metaGet: p("SELECT * FROM meta WHERE uri = ?"),
      metaAll: p("SELECT * FROM meta"),
      metaSet: p(`INSERT OR REPLACE INTO meta (uri, image, description, twitter, telegram, website, fetched_at, ok, error, attempts) VALUES (@uri, @image, @description, @twitter, @telegram, @website, @fetchedAt, @ok, @error, @attempts)`),
      bfCurveUpsert: p(`INSERT INTO backfill_curves (curve, depth, quote_mint, data, graduated, rq) VALUES (@curve, @depth, @quoteMint, @data, @graduated, @rq)
        ON CONFLICT(curve) DO UPDATE SET depth = excluded.depth, quote_mint = excluded.quote_mint, data = excluded.data, graduated = excluded.graduated, rq = excluded.rq`),
      bfCurvePending: p("SELECT curve, depth, quote_mint, data FROM backfill_curves WHERE resolved_at = 0 AND error IS NULL ORDER BY graduated DESC, rq DESC, depth DESC LIMIT ?"),
      bfCurveResolve: p("UPDATE backfill_curves SET mint = ?, resolved_at = ?, error = NULL WHERE curve = ?"),
      bfCurveFail: p("UPDATE backfill_curves SET error = ?, resolved_at = ? WHERE curve = ?"),
      bfCurveStats: p("SELECT COUNT(*) AS total, SUM(resolved_at > 0 AND error IS NULL) AS resolved, SUM(error IS NOT NULL) AS failed FROM backfill_curves"),
      bfCurveByKey: p("SELECT curve, depth, quote_mint, data, mint, resolved_at FROM backfill_curves WHERE curve = ?"),
      bfCurvesUnresolvedKeys: p("SELECT curve FROM backfill_curves WHERE resolved_at = 0"),
      uploadInsert: p("INSERT OR IGNORE INTO uploads (name, kind, pair, ip, bytes, at) VALUES (@name, @kind, @pair, @ip, @bytes, @at)"),
      uploadStale: p("SELECT name, kind, pair, at FROM uploads WHERE at < ? ORDER BY at ASC LIMIT ?"),
      uploadDelete: p("DELETE FROM uploads WHERE name = ?"),
      uploadPairCount: p("SELECT COUNT(*) AS n FROM uploads WHERE kind = 'json' AND pair = ?"),
      uploadCount: p("SELECT COUNT(*) AS n FROM uploads"),
      priceBefore: p("SELECT price_quote, price_usd, time FROM trades WHERE mint = ? AND time <= ? ORDER BY time DESC, rowid DESC LIMIT 1"),
      priceAfter: p("SELECT price_quote, price_usd, time FROM trades WHERE mint = ? AND time > ? ORDER BY time ASC, rowid ASC LIMIT 1"),
      keyInsert: p("INSERT INTO api_keys (name, contact, hash, tier, created_at) VALUES (?, ?, ?, ?, ?)"),
      keyByHash: p("SELECT id, name, tier, revoked_at FROM api_keys WHERE hash = ?"),
      keysAll: p("SELECT id, name, contact, tier, created_at, revoked_at, last_used_at, requests FROM api_keys ORDER BY id"),
      keyRevoke: p("UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL"),
      keyUsage: p("UPDATE api_keys SET requests = requests + ?, last_used_at = MAX(COALESCE(last_used_at, 0), ?) WHERE id = ?"),
    };
  }

  transaction(fn) {
    this.db.exec("BEGIN");
    try { const r = fn(); this.db.exec("COMMIT"); return r; } catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }

  kvGet(key, fallback = null) { const r = this.q.kvGet.get(key); return r ? JSON.parse(r.value) : fallback; }
  kvSet(key, value) { this.q.kvSet.run(key, JSON.stringify(value)); }
  backfillGet(key, fallback = null) { const r = this.q.bfGet.get(key); return r ? JSON.parse(r.value) : fallback; }
  backfillSet(key, value) { this.q.bfSet.run(key, JSON.stringify(value)); }
  backfillAll() { return Object.fromEntries(this.q.bfAll.all().map((r) => [r.key, JSON.parse(r.value)])); }

  upsertMint(m) { this.q.mintUpsert.run({ mint: m.mint, decimals: m.decimals ?? null, tokenProgram: m.tokenProgram ?? null, supply: m.supply ?? null, name: m.name ?? null, symbol: m.symbol ?? null, uri: m.uri ?? null, onchainAt: m.onchainAt ?? 0 }); }
  allMints() { return this.q.mintsAll.all().map((r) => ({ mint: r.mint, decimals: r.decimals, tokenProgram: r.token_program, supply: r.supply, name: r.name, symbol: r.symbol, uri: r.uri, onchainAt: r.onchain_at })); }

  upsertCoin(c) {
    this.q.coinUpsert.run({
      mint: c.mint, curve: c.curve, depth: c.depth, quoteMint: c.quoteMint ?? null, creator: c.creator, tracked: c.tracked ? 1 : 0,
      vtr: c.virtualTokenReserves, vqr: c.virtualQuoteReserves, rtr: c.realTokenReserves, rqr: c.realQuoteReserves, supply: c.tokenTotalSupply, ivqr: c.initialVirtualQuoteReserves ?? "0",
      complete: c.complete ? 1 : 0, migrated: c.migrated ? 1 : 0, mayhem: c.mayhem ? 1 : 0, holderReward: c.holderReward ? 1 : 0, creatorFeeBps: c.creatorFeeBps ?? 0,
      pool: c.pool ?? null, poolBaseVault: c.poolBaseVault ?? null, poolQuoteVault: c.poolQuoteVault ?? null, poolBase: c.poolBase ?? null, poolQuote: c.poolQuote ?? null,
      createdAt: c.createdAt ?? null, createdSlot: c.createdSlot ?? null, createdProbe: c.createdProbe ? 1 : 0, shares: c.shares ? JSON.stringify(c.shares) : null, sharesAt: c.sharesAt ?? 0,
      refreshedAt: c.refreshedAt ?? 0, updatedAt: c.updatedAt ?? Date.now(), feePaid: c.feePaid ?? null,
    });
  }
  /** Moves a coin's `updated_at` (ms) forward without rewriting the row (a child's trade changes the parent's locked value). */
  touchCoin(mint, at) { this.q.coinTouch.run(at, mint, at); }
  allCoins() {
    return this.q.coinsAll.all().map((r) => ({
      mint: r.mint, curve: r.curve, depth: r.depth, quoteMint: r.quote_mint, creator: r.creator, tracked: !!r.tracked,
      virtualTokenReserves: r.vtr, virtualQuoteReserves: r.vqr, realTokenReserves: r.rtr, realQuoteReserves: r.rqr, tokenTotalSupply: r.supply, initialVirtualQuoteReserves: r.ivqr,
      complete: !!r.complete, migrated: !!r.migrated, mayhem: !!r.mayhem, holderReward: !!r.holder_reward, creatorFeeBps: r.creator_fee_bps,
      pool: r.pool, poolBaseVault: r.pool_base_vault, poolQuoteVault: r.pool_quote_vault, poolBase: r.pool_base, poolQuote: r.pool_quote,
      createdAt: r.created_at, createdSlot: r.created_slot, createdProbe: !!r.created_probe, shares: r.shares ? JSON.parse(r.shares) : null, sharesAt: r.shares_at,
      refreshedAt: r.refreshed_at, updatedAt: r.updated_at, feePaid: r.fee_paid ?? null,
    }));
  }

  /**
   * Inserts a trade and keeps at most `keep` rows per mint (DESIGN §6.5: 2 000); the count is an
   * indexed lookup. Returns whether the row is new: a replayed (sig, mint, idx) — the live stream
   * re-delivers after a reconnect — is ignored, so the in-memory activity counters never count it twice.
   */
  insertTrade(t, keep = 2000) {
    const r = this.q.tradeInsert.run({ sig: t.sig, mint: t.mint, idx: t.idx ?? 0, slot: t.slot, time: t.time, isBuy: t.isBuy ? 1 : 0, user: t.user, baseAmount: t.baseAmount, quoteAmount: t.quoteAmount, priceQuote: t.priceQuote, priceUsd: t.priceUsd ?? null, valueUsd: t.valueUsd ?? null });
    if (!(Number(r.changes) > 0)) return false;
    if (this.q.tradeCount.get(t.mint).n > keep) this.q.tradeTrim.run(t.mint, t.mint, keep);
    return true;
  }
  static trade(r) { return { sig: r.sig, mint: r.mint, slot: r.slot, time: r.time, isBuy: !!r.is_buy, user: r.user, baseAmount: r.base_amount, quoteAmount: r.quote_amount, priceQuote: r.price_quote, priceUsd: r.price_usd, valueUsd: r.value_usd }; }
  tradesFor(mint, limit = 50) { return this.q.tradesFor.all(mint, limit).map(Db.trade); }
  tradesSince(mint, since) { return this.q.tradesSince.all(mint, since).map(Db.trade); }
  /** Every stored trade at or after `sinceS`, oldest first (trades_time index): what seeds the activity counters at boot. */
  tradesWindow(sinceS) { return this.q.tradesWindow.all(sinceS).map((r) => ({ mint: r.mint, time: r.time, isBuy: !!r.is_buy, valueUsd: r.value_usd })); }
  volume24h(mint) { const r = this.q.vol24.get(mint, now() - 86_400); return { trades: r.n, usd: r.usd }; }
  /** A fresh GROUP BY over 24 h of trades; the API reads the in-memory counters (activity.mjs) instead, this is their reference. */
  volume24hAll() { return new Map(this.q.vol24All.all(now() - 86_400).map((r) => [r.mint, { trades: r.n, usd: r.usd }])); }

  metaGet(uri) { const r = this.q.metaGet.get(uri); return r ? Db.meta(r) : null; }
  allMeta() { return this.q.metaAll.all().map(Db.meta); }
  static meta(r) { return { uri: r.uri, image: r.image, description: r.description, twitter: r.twitter, telegram: r.telegram, website: r.website, fetchedAt: r.fetched_at, ok: !!r.ok, error: r.error, attempts: r.attempts ?? 0 }; }
  metaSet(m) { this.q.metaSet.run({ uri: m.uri, image: m.image ?? null, description: m.description ?? null, twitter: m.twitter ?? null, telegram: m.telegram ?? null, website: m.website ?? null, fetchedAt: m.fetchedAt ?? now(), ok: m.ok ? 1 : 0, error: m.error ?? null, attempts: m.attempts ?? 0 }); }

  backfillCurveUpsert(c) { this.q.bfCurveUpsert.run({ curve: c.curve, depth: c.depth, quoteMint: c.quoteMint ?? null, data: c.data, graduated: c.graduated ? 1 : 0, rq: c.rq }); }
  backfillPending(limit) { return this.q.bfCurvePending.all(limit).map((r) => ({ curve: r.curve, depth: r.depth, quoteMint: r.quote_mint, data: r.data })); }
  backfillResolve(curve, mint) { this.q.bfCurveResolve.run(mint, now(), curve); }
  backfillFail(curve, error) { this.q.bfCurveFail.run(String(error).slice(0, 200), now(), curve); }
  backfillStats() { const r = this.q.bfCurveStats.get(); return { total: r.total ?? 0, resolved: r.resolved ?? 0, failed: r.failed ?? 0 }; }
  backfillCurve(curve) { const r = this.q.bfCurveByKey.get(curve); return r ? { curve: r.curve, depth: r.depth, quoteMint: r.quote_mint, data: r.data, mint: r.mint, resolvedAt: r.resolved_at } : null; }
  backfillUnresolvedCurves() { return new Set(this.q.bfCurvesUnresolvedKeys.all().map((r) => r.curve)); }

  // Ledger of the files /api/upload wrote (metahost.mjs garbage-collects unclaimed ones; files
  // written by other tools are not listed and therefore never touched).
  uploadRecord(u) { this.q.uploadInsert.run({ name: u.name, kind: u.kind, pair: u.pair ?? null, ip: u.ip ?? null, bytes: u.bytes ?? 0, at: u.at ?? now() }); }
  uploadsStale(before, limit = 500) { return this.q.uploadStale.all(before, limit).map((r) => ({ name: r.name, kind: r.kind, pair: r.pair, at: r.at })); }
  uploadForget(name) { this.q.uploadDelete.run(name); }
  uploadsUsingImage(name) { return this.q.uploadPairCount.get(name).n; }
  uploadCount() { return this.q.uploadCount.get().n; }

  /**
   * The price a coin last traded at, at or before `t` (unix s), else its first trade after `t`:
   * the reference of a 24 h change (the second case is a coin whose history starts inside the window).
   */
  priceRef(mint, t) { const r = this.q.priceBefore.get(mint, t) ?? this.q.priceAfter.get(mint, t); return r ? { priceQuote: r.price_quote, priceUsd: r.price_usd, time: r.time } : null; }

  // Partner API keys (lib/apikeys.mjs owns the logic; only the sha256 of a key is ever stored).
  apiKeyInsert({ name, contact = null, hash, tier = "partner", createdAt = now() }) { return Number(this.q.keyInsert.run(name, contact, hash, tier, createdAt).lastInsertRowid); }
  apiKeyByHash(hash) { const r = this.q.keyByHash.get(hash); return r ? { id: r.id, name: r.name, tier: r.tier, revokedAt: r.revoked_at } : null; }
  apiKeys() { return this.q.keysAll.all().map((r) => ({ id: r.id, name: r.name, contact: r.contact, tier: r.tier, createdAt: r.created_at, revokedAt: r.revoked_at, lastUsedAt: r.last_used_at, requests: r.requests })); }
  apiKeyRevoke(id, at = now()) { return Number(this.q.keyRevoke.run(at, id).changes) > 0; }
  /** Adds batched per-key counters (`[{ id, requests, lastUsedAt }]`) in one transaction. */
  apiKeyUsage(rows) { if (rows.length) this.transaction(() => { for (const r of rows) this.q.keyUsage.run(r.requests, r.lastUsedAt, r.id); }); }

  /** Folds the WAL into the main file so a shutdown (or a file-level copy) leaves one complete file. */
  checkpoint() { try { this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch { /* read-only or already closed */ } }
  /** Consistent online copy to `file` (node:sqlite's backup API; safe while the server writes). */
  async backup(file) { return backup(this.db, file); }
  close() { this.checkpoint(); this.db.close(); }
}
