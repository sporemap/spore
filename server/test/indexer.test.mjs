// Indexer paths that need no chain: adopting a verified spawn from its CreateEvent (roots included),
// the fetchCoin verdict cache and the RPC lane a request-driven lookup runs on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Db } from "../lib/db.mjs";
import { Model } from "../lib/model.mjs";
import { Indexer } from "../lib/indexer.mjs";
import { decodeEvent, eventsInLogs } from "../lib/decode.mjs";
import { createTxFor } from "./helpers/spawntx.mjs";
import { K, PLATFORM, quiet } from "./helpers/tree.mjs";

const createEventFor = (mint) => decodeEvent("CreateEvent", eventsInLogs(createTxFor({ mint }).meta.logMessages).find((e) => e.name === "CreateEvent").data);
/** An RPC that knows no accounts, counting calls per lane. */
const fakeRpc = () => {
  const calls = { main: 0, api: 0 };
  const rpc = { getMultipleAccounts: async (keys) => { calls.main++; return keys.map(() => null); }, snapshot: () => ({}) };
  rpc.lane = () => ({ getMultipleAccounts: async (keys) => { calls.api++; return keys.map(() => null); } });
  return { rpc, calls };
};

test("adopt inserts a verified spawn from its CreateEvent, tracked at any depth, with the fee it paid, and announces it once pending", async () => {
  const db = new Db(":memory:");
  const model = new Model(db, { platformWallet: PLATFORM, splitBps: [5000, 0, 0, 5000], mode: "ours", log: quiet });
  model.load();
  const events = [];
  const { rpc, calls } = fakeRpc();
  const indexer = new Indexer({ rpc, model, meta: null, hub: { emit: (ev, data) => events.push([ev, data]) }, log: quiet, opts: { backfill: false } });
  const create = createEventFor(K.X);
  // A root: the event says depth 2 here (real bytes), but the point is that adopt does not gate on depth.
  model.markPending(K.X, "sig", { feePaid: "20000000" });
  const c = await indexer.adopt(K.X, { create, slot: 123, feePaid: 20_000_000n });
  assert.ok(c); assert.equal(c.tracked, true); assert.equal(c.feePaid, "20000000"); assert.equal(c.createdSlot, 123); assert.equal(c.createdAt, create.timestamp);
  assert.equal(c.quoteMint, create.quoteMint); assert.equal(c.curve, create.bondingCurve); assert.equal(c.creator, create.creator);
  assert.equal(model.nameOf(K.X).symbol, "ponzi");
  assert.equal(model.mint(K.X).uri, create.uri);
  assert.equal(db.allCoins().find((x) => x.mint === K.X).feePaid, "20000000", "persisted (tracked)");
  assert.deepEqual(model.oursOf(c), { ours: false, oursPending: true });
  assert.equal(events.length, 1); assert.equal(events[0][0], "coin"); assert.equal(events[0][1].mint, K.X); assert.equal(events[0][1].feePaid, "20000000");
  assert.ok(indexer.hot.has(K.X));
  assert.ok(calls.main >= 1, "ancestors / mint info / shares were looked up on the main lane"); assert.equal(calls.api, 0);
  // Without an event and no curve on chain: nothing to adopt.
  assert.equal(await indexer.adopt(K.U), null);
  db.close();
});

test("fetchCoin remembers a negative verdict for a minute and runs on the lane it is given", async () => {
  const db = new Db(":memory:");
  const model = new Model(db, { platformWallet: PLATFORM, splitBps: [5000, 0, 0, 5000], log: quiet });
  model.load();
  const { rpc, calls } = fakeRpc();
  const indexer = new Indexer({ rpc, model, meta: null, hub: null, log: quiet, opts: { backfill: false } });
  assert.equal(await indexer.fetchCoin(K.U, { rpc: rpc.lane("api") }), null);
  assert.equal(await indexer.fetchCoin(K.U, { rpc: rpc.lane("api") }), null);
  assert.equal(await indexer.fetchCoin(K.U), null);
  assert.deepEqual(calls, { main: 0, api: 1 }, "one lookup, on the api lane, then the cache");
  indexer.fetchCache.clear();
  await indexer.fetchCoin(K.U);
  assert.deepEqual(calls, { main: 1, api: 1 });
  db.close();
});
