import { test } from "node:test";
import assert from "node:assert/strict";
import { Db } from "../lib/db.mjs";

const coin = (over = {}) => ({ mint: "M1", curve: "C1", depth: 1, quoteMint: "ROOT", creator: "CR", tracked: true, virtualTokenReserves: "1", virtualQuoteReserves: "2", realTokenReserves: "3", realQuoteReserves: "18446744073709551615", tokenTotalSupply: "1000000000000000", initialVirtualQuoteReserves: "5", complete: false, migrated: false, mayhem: false, holderReward: false, creatorFeeBps: 0, ...over });

test("schema migration is idempotent and survives reopening", () => {
  const db = new Db(":memory:");
  db.migrate(); db.migrate();
  assert.equal(db.kvGet("schema_version"), 3);
  assert.ok(db.db.prepare("PRAGMA table_info(coins)").all().some((c) => c.name === "fee_paid"), "v2 column present on a fresh database");
  assert.ok(db.db.prepare("PRAGMA table_info(meta)").all().some((c) => c.name === "attempts"), "v3 column present on a fresh database");
  // A v1 database (no fee_paid column, version 1) is upgraded in place.
  db.db.exec("ALTER TABLE coins DROP COLUMN fee_paid");
  db.kvSet("schema_version", 1);
  db.migrate();
  assert.equal(db.kvGet("schema_version"), 3);
  assert.ok(db.db.prepare("PRAGMA table_info(coins)").all().some((c) => c.name === "fee_paid"), "ALTER TABLE added the column");
  db.close();
});

test("v3: updated_at moves from seconds to milliseconds once; meta.attempts is added and round-trips", () => {
  const db = new Db(":memory:");
  db.db.exec("ALTER TABLE meta DROP COLUMN attempts");
  db.upsertCoin({ ...coin(), updatedAt: 1_792_000_000 }); // a v2 row: seconds
  db.kvSet("schema_version", 2);
  db.migrate();
  assert.equal(db.allCoins()[0].updatedAt, 1_792_000_000_000, "seconds × 1000");
  db.migrate();
  assert.equal(db.allCoins()[0].updatedAt, 1_792_000_000_000, "a second migrate leaves ms alone");
  db.touchCoin("M1", 1_792_000_000_500);
  assert.equal(db.allCoins()[0].updatedAt, 1_792_000_000_500);
  db.touchCoin("M1", 1_792_000_000_100);
  assert.equal(db.allCoins()[0].updatedAt, 1_792_000_000_500, "touch never moves the stamp backwards");
  db.metaSet({ uri: "https://ipfs.io/ipfs/x", ok: false, error: "HTTP 403", fetchedAt: 5, attempts: 3 });
  assert.equal(db.metaGet("https://ipfs.io/ipfs/x").attempts, 3);
  assert.equal(db.allMeta()[0].attempts, 3);
  db.close();
});

test("fee_paid round-trips and is never erased by a later upsert without it; the upload ledger records, lists stale rows, counts image users", () => {
  const db = new Db(":memory:");
  db.upsertCoin({ ...coin(), feePaid: "20000000" });
  db.upsertCoin({ ...coin(), feePaid: null });
  assert.equal(db.allCoins()[0].feePaid, "20000000");
  db.uploadRecord({ name: "a".repeat(64) + ".png", kind: "image", ip: "1.2.3.4", bytes: 10, at: 100 });
  db.uploadRecord({ name: "b".repeat(64) + ".json", kind: "json", pair: "a".repeat(64) + ".png", ip: "1.2.3.4", bytes: 20, at: 100 });
  db.uploadRecord({ name: "c".repeat(64) + ".json", kind: "json", pair: "a".repeat(64) + ".png", ip: "1.2.3.4", bytes: 20, at: 500 });
  assert.equal(db.uploadCount(), 3);
  assert.deepEqual(db.uploadsStale(200).map((r) => r.name[0]), ["a", "b"]);
  assert.equal(db.uploadsUsingImage("a".repeat(64) + ".png"), 2);
  db.uploadForget("b".repeat(64) + ".json");
  assert.equal(db.uploadsUsingImage("a".repeat(64) + ".png"), 1);
  db.close();
});

test("coins round-trip with u64 precision and merge on conflict", () => {
  const db = new Db(":memory:");
  db.upsertCoin(coin());
  db.upsertCoin({ ...coin(), createdAt: 1700000000, shares: [{ address: "A", bps: 10000 }], sharesAt: 5 });
  db.upsertCoin({ ...coin(), createdAt: null, shares: null, sharesAt: 0, tracked: false }); // nulls do not erase, tracked does not turn off
  const [c] = db.allCoins();
  assert.equal(c.realQuoteReserves, "18446744073709551615");
  assert.equal(c.createdAt, 1700000000);
  assert.deepEqual(c.shares, [{ address: "A", bps: 10000 }]);
  assert.equal(c.sharesAt, 5);
  assert.equal(c.tracked, true);
  db.close();
});

test("mints merge field by field", () => {
  const db = new Db(":memory:");
  db.upsertMint({ mint: "M1", decimals: 6, tokenProgram: "T" });
  db.upsertMint({ mint: "M1", name: "Spore", symbol: "SPORE", uri: "https://ipfs.io/x", onchainAt: 10 });
  const [m] = db.allMints();
  assert.deepEqual(m, { mint: "M1", decimals: 6, tokenProgram: "T", supply: null, name: "Spore", symbol: "SPORE", uri: "https://ipfs.io/x", onchainAt: 10 });
  db.close();
});

test("trades: dedupe on (sig, mint, idx), 24 h volume, trimming to the cap", () => {
  const db = new Db(":memory:");
  const now = Math.floor(Date.now() / 1000);
  const t = (i, over = {}) => ({ sig: `S${i}`, mint: "M1", idx: 0, slot: i, time: now - i, isBuy: i % 2 === 0, user: "U", baseAmount: "10", quoteAmount: "20", priceQuote: 2, priceUsd: 3, valueUsd: 1.5, ...over });
  db.insertTrade(t(1)); db.insertTrade(t(1));
  db.insertTrade(t(2, { time: now - 90_000 })); // older than 24 h
  assert.equal(db.tradesFor("M1", 50).length, 2);
  assert.deepEqual(db.volume24h("M1"), { trades: 1, usd: 1.5 });
  assert.equal(db.volume24hAll().get("M1").trades, 1);
  for (let i = 3; i < 2300; i++) db.insertTrade(t(i), 2000);
  assert.ok(db.tradesFor("M1", 5000).length <= 2000);
  assert.equal(db.tradesSince("M1", now - 10).length, 9); // S1, S3..S10 (S2 is the day-old one)
  db.close();
});

test("backfill staging: priority order and resolution state", () => {
  const db = new Db(":memory:");
  db.backfillCurveUpsert({ curve: "small", depth: 1, quoteMint: "R", data: "AA==", graduated: false, rq: 10 });
  db.backfillCurveUpsert({ curve: "big", depth: 1, quoteMint: "R", data: "AA==", graduated: false, rq: 1e9 });
  db.backfillCurveUpsert({ curve: "deep", depth: 2, quoteMint: "P", data: "AA==", graduated: false, rq: 1e9 });
  db.backfillCurveUpsert({ curve: "grad", depth: 1, quoteMint: "R", data: "AA==", graduated: true, rq: 0 });
  assert.deepEqual(db.backfillPending(10).map((r) => r.curve), ["grad", "deep", "big", "small"]);
  db.backfillResolve("grad", "MINT");
  db.backfillFail("small", "no token account");
  assert.deepEqual(db.backfillStats(), { total: 4, resolved: 1, failed: 1 });
  assert.deepEqual(db.backfillPending(10).map((r) => r.curve), ["deep", "big"]);
  assert.equal(db.backfillCurve("grad").mint, "MINT");
  db.backfillSet("scanned:1", 123); assert.equal(db.backfillGet("scanned:1"), 123);
  db.close();
});

test("metadata cache round-trips", () => {
  const db = new Db(":memory:");
  db.metaSet({ uri: "https://ipfs.io/x", image: "https://ipfs.io/i", description: "d", fetchedAt: 1, ok: true });
  assert.equal(db.metaGet("https://ipfs.io/x").image, "https://ipfs.io/i");
  assert.equal(db.allMeta().length, 1);
  db.close();
});
