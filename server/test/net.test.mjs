// Network smoke (DESIGN §9): fetch one depth-2 curve from mainnet and walk its chain to depth 0.
// Skipped with SPORE_NET=0. Uses the public RPC unless RPC_URL is set; a handful of calls.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Db } from "../lib/db.mjs";
import { Model } from "../lib/model.mjs";
import { Rpc } from "../lib/rpc.mjs";
import { Indexer } from "../lib/indexer.mjs";

const skip = process.env.SPORE_NET === "0";
const MINT = "GtsYUp4Gxbyag3c1So1jvfPu54AdU47HGeySBQEvpump"; // curve 9CuFcRfiqEsBEQUCPTTVHaruQU7n9N7HKNSEk5VEivu
const quiet = { info() {}, warn() {}, error() {} };

test("walks a live depth-2 chain down to its SOL root and prices it", { skip, timeout: 120_000 }, async () => {
  const rpc = new Rpc({ url: process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com", rps: 4, concurrency: 2, log: quiet });
  const db = new Db(":memory:");
  const model = new Model(db, { platformWallet: "dBs75Gf7RXQMAsMLuTLYdH2fHV1ac9zgCEh6zC7TxXs", splitBps: [5000, 2500, 1000, 1500], log: quiet });
  model.load();
  const indexer = new Indexer({ rpc, model, meta: null, hub: null, log: quiet, opts: { backfill: false } });
  await indexer.loadGlobal();
  assert.ok(model.global.maxCurveDepth >= 1);
  const coin = await indexer.fetchCoin(MINT);
  assert.equal(coin.depth, 2);
  const chain = model.ancestors(MINT);
  assert.equal(chain.length, 2);
  assert.equal(chain[0].depth, 1); assert.equal(chain[1].depth, 0); assert.equal(chain[1].quoteMint, null);
  assert.equal(chain[0].mint, coin.quoteMint);
  const v = model.view(coin);
  assert.equal(v.symbol, "ponzi"); assert.equal(v.root.mint, chain[1].mint); assert.equal(v.ancestors.length, 2);
  assert.equal(v.migrated, true); assert.ok(v.pool, "a migrated coin has its canonical pool");
  assert.ok(v.priceQuote > 0, "pool price");
  assert.ok(v.priceSol > 0, "chain price in SOL");
  const el = await (await import("../lib/eligibility.mjs")).checkEligibility({ mint: chain[0].mint, creator: null, model, indexer, rpc, platformWallet: "dBs75Gf7RXQMAsMLuTLYdH2fHV1ac9zgCEh6zC7TxXs", splitBps: [5000, 2500, 1000, 1500] });
  assert.equal(el.depth, 2); assert.equal(el.chain.length, 2); assert.equal(el.parentCreator, chain[0].creator); assert.equal(el.shares.reduce((a, s) => a + s.bps, 0), 10_000);
  db.close();
});
