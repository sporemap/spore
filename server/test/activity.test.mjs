// The in-memory activity counters (lib/activity.mjs, DESIGN §11.5 "Activity (heat)"): exact sliding
// windows on a fake clock, the model's duplicate guard, agreement with the SQL GROUP BY they replace,
// the heat sidecar's shape and order, and value objects that are mutated in place.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Activity } from "../lib/activity.mjs";
import { Db } from "../lib/db.mjs";
import { Model } from "../lib/model.mjs";
import { buildTree, K, PLATFORM, quiet } from "./helpers/tree.mjs";

const T0 = 1_792_000_000; // unix s
const trade = (mint, time, isBuy = true, valueUsd = 1, extra = {}) => ({ mint, time, isBuy, valueUsd, ...extra });

test("exact windows: a trade leaves the 1 h window after 3 600 s and the 24 h window after 86 400 s; buys1h counts buys only", () => {
  let now = T0;
  const a = new Activity({ now: () => now });
  assert.equal(a.record(trade("M", T0, true, 10)), true);
  assert.equal(a.record(trade("M", T0 + 10, false, 5)), true);
  assert.equal(a.record(trade("M", T0 + 20, true, null)), true, "a trade without a USD value still counts as a trade");
  now = T0 + 20;
  assert.deepEqual(a.get("M"), { trades: 3, usd: 15, t1h: 3, buys1h: 2, last: T0 + 20 });
  assert.deepEqual(a.size(), { mints: 1, events: 3 });

  now = T0 + 3_600; // the first trade is exactly an hour old: still inside (time >= now − 3600, like the SQL window)
  assert.equal(a.get("M").t1h, 3);
  now = T0 + 3_601;
  assert.deepEqual(a.get("M"), { trades: 3, usd: 15, t1h: 2, buys1h: 1, last: T0 + 20 }, "the first buy left the hour, not the day");
  now = T0 + 3_611;
  assert.deepEqual({ t1h: a.get("M").t1h, buys1h: a.get("M").buys1h }, { t1h: 1, buys1h: 1 }, "the sell left: buys unchanged");
  now = T0 + 3_621;
  assert.deepEqual({ t1h: a.get("M").t1h, buys1h: a.get("M").buys1h }, { t1h: 0, buys1h: 0 });

  now = T0 + 86_400;
  assert.equal(a.get("M").trades, 3, "exactly a day old: still inside");
  now = T0 + 86_401;
  assert.deepEqual(a.get("M"), { trades: 2, usd: 5, t1h: 0, buys1h: 0, last: T0 + 20 });
  now = T0 + 86_411;
  assert.deepEqual(a.get("M"), { trades: 1, usd: 0, t1h: 0, buys1h: 0, last: T0 + 20 }, "only the trade without a USD value is left: exactly 0");
  const v = a.volumes().get("M");
  assert.deepEqual(v, { trades: 1, usd: 0 });
  now = T0 + 86_421;
  assert.equal(a.get("M"), null, "nothing left in 24 h");
  assert.equal(a.volumes().has("M"), false, "the volumes() entry is gone, like a mint absent from the GROUP BY");
  assert.deepEqual(a.size(), { mints: 0, events: 0 });
  assert.equal(a.record(trade("M", now - 86_401)), false, "a trade older than the window is ignored");
  assert.equal(a.get("M"), null);
  // A late trade (older than the newest one) is appended and counted; it is only hour-counted when it was inside the hour.
  a.record(trade("N", now, true, 2));
  a.record(trade("N", now - 7_200, true, 3));
  assert.deepEqual(a.get("N"), { trades: 2, usd: 5, t1h: 1, buys1h: 1, last: now });
});

test("ring growth, compaction and id reuse agree with a brute-force recount on a random stream", () => {
  let now = T0;
  const a = new Activity({ now: () => now, capacity: 16 });
  const events = [];
  let seed = 7;
  const rnd = () => { seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648; return seed / 2_147_483_648; };
  const mints = Array.from({ length: 40 }, (_, i) => `M${i}`);
  const check = () => {
    for (const m of mints) {
      const mine = events.filter((e) => e.mint === m && e.time >= now - 86_400);
      const hour = mine.filter((e) => e.time >= now - 3_600);
      const usd = mine.reduce((s, e) => s + (e.valueUsd ?? 0), 0);
      const got = a.get(m);
      if (!mine.length) { assert.equal(got, null, m); continue; }
      assert.equal(got.trades, mine.length, m); assert.equal(got.t1h, hour.length, m); assert.equal(got.buys1h, hour.filter((e) => e.isBuy).length, m);
      assert.ok(Math.abs(got.usd - usd) <= 1e-9 * Math.max(1, usd), `${m}: ${got.usd} vs ${usd}`);
      assert.equal(got.last, Math.max(...events.filter((e) => e.mint === m).map((e) => e.time)), m);
    }
  };
  for (let step = 0; step < 6_000; step++) {
    now += Math.floor(rnd() * 120); // ~1 h of trades every ~60 steps; the stream spans several days
    const e = trade(mints[Math.floor(rnd() * rnd() * mints.length)], now, rnd() < 0.55, rnd() < 0.1 ? null : Math.round(rnd() * 500_000) / 100);
    assert.equal(a.record(e), true);
    events.push(e);
    if (step % 500 === 0) check();
  }
  check();
  assert.ok(a.cap > 16, "the ring grew");
  assert.ok(a.cap < events.length, "and was compacted instead of holding every event ever seen");
  const ids = a.mintOf.length;
  now += 86_401;
  check();
  assert.deepEqual(a.size(), { mints: 0, events: 0 });
  assert.equal(a.free.length, ids, "every id was released");
  for (const m of mints) a.record(trade(m, now));
  assert.equal(a.mintOf.length, ids, "and reused: no new ids");
  assert.equal(a.size().mints, mints.length);
});

test("a duplicate trade through model.recordTrade is counted once", () => {
  const { db, model } = buildTree();
  const now = Math.floor(Date.now() / 1000);
  const t = { sig: "DUP", mint: K.A, idx: 0, slot: 1, time: now - 5, isBuy: true, user: "U", baseAmount: "1", quoteAmount: "2", priceQuote: 2, priceUsd: 1, valueUsd: 3.5 };
  model.recordTrade(t); model.recordTrade(t); model.recordTrade({ ...t });
  assert.deepEqual(model.activity.get(K.A), { trades: 1, usd: 3.5, t1h: 1, buys1h: 1, last: now - 5 });
  assert.deepEqual(model.volumes().get(K.A), { trades: 1, usd: 3.5 });
  assert.deepEqual(db.volume24hAll().get(K.A), { trades: 1, usd: 3.5 });
  model.recordTrade({ ...t, idx: 1 }); // same signature, another event index: a different trade
  assert.equal(model.volumes().get(K.A).trades, 2);
  assert.equal(db.insertTrade({ ...t, idx: 1 }), false, "insertTrade says whether the row is new");
  assert.equal(db.insertTrade({ ...t, idx: 2 }), true);
});

test("seed from sqlite + live records equal Db.volume24hAll() over the same rows", () => {
  const db = new Db(":memory:");
  const now = Math.floor(Date.now() / 1000);
  let seed = 11;
  const rnd = () => { seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648; return seed / 2_147_483_648; };
  const mints = Array.from({ length: 25 }, (_, i) => `MINT${i}`);
  const row = (i, time) => ({ sig: `S${i}`, mint: mints[Math.floor(rnd() * mints.length)], idx: 0, slot: i, time, isBuy: rnd() < 0.5, user: "U", baseAmount: "1", quoteAmount: "1", priceQuote: 1, priceUsd: 1, valueUsd: rnd() < 0.15 ? null : Math.round(rnd() * 1e6) / 1e4 });
  // Stored before boot: 30 h of trades, kept clear of the window edge so a second ticking over cannot split the two reads.
  const stored = [];
  for (let i = 0; i < 3_000; i++) { let time = now - Math.floor(rnd() * 30 * 3_600); if (Math.abs(time - (now - 86_400)) < 30) time -= 60; stored.push(row(i, time)); db.insertTrade(stored[i]); }
  const model = new Model(db, { platformWallet: PLATFORM, splitBps: [5000, 2500, 1000, 1500], log: quiet });
  model.load();
  assert.ok(model.activity.seededMs != null);
  // Live after boot: new trades in time order, plus replays of stored ones (ignored by sqlite and the counters).
  for (let i = 3_000; i < 3_400; i++) model.recordTrade(row(i, now - 400 + (i - 3_000)));
  for (const t of stored.slice(0, 200)) model.recordTrade({ ...t });
  const sql = db.volume24hAll(), mem = model.volumes();
  assert.ok(sql.size > 10);
  assert.deepEqual([...mem.keys()].sort(), [...sql.keys()].sort());
  for (const [mint, v] of sql) {
    assert.equal(mem.get(mint).trades, v.trades, mint);
    assert.ok(Math.abs(mem.get(mint).usd - v.usd) <= 1e-9 * Math.max(1, v.usd), `${mint}: ${mem.get(mint).usd} vs ${v.usd}`);
  }
  const total = [...sql.values()].reduce((s, v) => s + v.trades, 0);
  assert.equal(model.activity.size().events, total);
  db.close();
});

test("heat(): parallel arrays over mints with a 24 h trade, t1h desc then v24 desc, USD in cents; keep() narrows", () => {
  let now = T0;
  const a = new Activity({ now: () => now });
  a.record(trade("GONE", T0 - 86_000, true, 1)); // in time order, as the live stream and the seed deliver them
  a.record(trade("OLD", T0 - 5_000, true, 1_000.006)); // 24 h only
  a.record(trade("BIG", T0 - 100, true, 2.004)); a.record(trade("BIG", T0 - 50, false, 3));
  a.record(trade("SMALL", T0 - 90, false, 0.5)); a.record(trade("SMALL", T0 - 10, true, 0.25));
  a.record(trade("ONE", T0 - 30, true, 9));
  now = T0 + 500; // GONE leaves the day
  const h = a.heat();
  assert.deepEqual(Object.keys(h), ["at", "since", "mint", "t1h", "n24", "v24", "last", "buys1h"]);
  assert.equal(h.at, T0 + 500); assert.equal(h.since, T0 + 500 - 86_400);
  for (const k of ["t1h", "n24", "v24", "last", "buys1h"]) assert.equal(h[k].length, h.mint.length, k);
  assert.deepEqual(h.mint, ["BIG", "SMALL", "ONE", "OLD"], "2 trades in the hour first (bigger volume first), then 1, then 0");
  assert.deepEqual(h.t1h, [2, 2, 1, 0]);
  assert.deepEqual(h.n24, [2, 2, 1, 1]);
  assert.deepEqual(h.v24, [5, 0.75, 9, 1_000.01]);
  assert.deepEqual(h.last, [T0 - 50, T0 - 10, T0 - 30, T0 - 5_000]);
  assert.deepEqual(h.buys1h, [1, 1, 1, 0]);
  assert.deepEqual(a.heat({ keep: (m) => m !== "BIG" }).mint, ["SMALL", "ONE", "OLD"]);
  assert.deepEqual(new Activity({ now: () => now }).heat(), { at: now, since: now - 86_400, mint: [], t1h: [], n24: [], v24: [], last: [], buys1h: [] });
});

test("volumes(): one Map, and one value object per mint mutated in place", () => {
  let now = T0;
  const a = new Activity({ now: () => now });
  a.record(trade("M", T0, true, 1));
  const map = a.volumes(), v = map.get("M");
  for (let i = 1; i <= 50; i++) a.record(trade("M", T0 + i, i % 2 === 0, 1));
  assert.equal(a.volumes(), map, "the same Map");
  assert.equal(a.volumes().get("M"), v, "the same value object");
  assert.deepEqual(v, { trades: 51, usd: 51 });
  now = T0 + 86_401;
  assert.deepEqual(v, { trades: 51, usd: 51 }, "nothing moves until a read expires it");
  assert.equal(a.volumes().get("M"), v);
  assert.deepEqual(v, { trades: 50, usd: 50 }, "expired in place");
});
