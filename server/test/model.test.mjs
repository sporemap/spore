import { test } from "node:test";
import assert from "node:assert/strict";
import { Model } from "../lib/model.mjs";
import { buildTree, K, PLATFORM, quiet, base } from "./helpers/tree.mjs";

test("chain pricing through the tree", () => {
  const { model } = buildTree();
  const d = model.computed();
  assert.ok(Math.abs(d.get(K.ROOT).priceSol - 1e-7) < 1e-20);
  assert.ok(Math.abs(d.get(K.A).priceSol - 2e-7) < 1e-20);
  assert.ok(Math.abs(d.get(K.G).priceSol - 1e-7) < 1e-20);
  assert.ok(Math.abs(d.get(K.G).priceUsd - 1e-5) < 1e-18);
  assert.equal(d.get(K.A).priceQuote, 2);
});

test("locked value, children and descendants", () => {
  const { model } = buildTree();
  const d = model.computed();
  assert.equal(d.get(K.ROOT).lockedQuote, 60_000_000_000_000n); // A + B raised ROOT
  assert.ok(Math.abs(d.get(K.ROOT).lockedUsd - 60e6 * 1e-5) < 1e-9); // 60M ROOT × $1e-5
  assert.equal(d.get(K.ROOT).children, 2);
  assert.equal(d.get(K.ROOT).descendants, 3);
  assert.equal(d.get(K.A).descendants, 1);
  assert.equal(d.get(K.A).lockedQuote, 7_000_000_000_000n);
  assert.equal(d.get(K.G).descendants, 0);
});

test("view() has every contract field with the right types", () => {
  const { model } = buildTree();
  const v = model.view(model.get(K.G));
  const keys = ["mint", "name", "symbol", "image", "description", "twitter", "telegram", "website", "creator", "quoteMint", "quoteSymbol", "depth", "parent", "root", "ancestors", "complete", "migrated", "pool", "createdAt", "createdSlot", "tokenProgram", "decimals", "totalSupply", "priceQuote", "priceSol", "priceUsd", "mcapSol", "mcapUsd", "progress", "children", "descendants", "lockedQuote", "lockedUsd", "volume24hUsd", "trades24h", "holderReward", "creatorFeeBps", "shares", "updatedAt"];
  for (const k of keys) assert.ok(k in v, `missing ${k}`);
  assert.equal(v.quoteSymbol, "AAA");
  assert.equal(v.parent.mint, K.A);
  assert.equal(v.parent.image, "/api/img?u=https%3A%2F%2Fipfs.io%2Fipfs%2FimgA");
  assert.equal(v.root.mint, K.ROOT);
  assert.deepEqual(v.ancestors.map((a) => a.mint), [K.A, K.ROOT]);
  assert.equal(v.progress, 1);
  assert.equal(typeof v.lockedQuote, "string");
  assert.equal(typeof v.totalSupply, "string");
  assert.ok(Math.abs(v.mcapUsd - 1e-5 * 1e9) < 1e-6);
  const r = model.view(model.get(K.ROOT));
  assert.equal(r.parent, null); assert.equal(r.root, null); assert.deepEqual(r.ancestors, []); assert.equal(r.quoteSymbol, "SOL");
  const a = model.view(model.get(K.A));
  assert.equal(a.image, "/api/img?u=https%3A%2F%2Fipfs.io%2Fipfs%2FimgA");
  assert.equal(a.twitter, "https://x.com/a");
});

test("stats", () => {
  const { model } = buildTree();
  const s = model.stats();
  assert.equal(s.coins, 4); assert.equal(s.roots, 1); assert.deepEqual(s.byDepth, [1, 2, 1]); assert.equal(s.maxDepth, 2); assert.equal(s.solUsd, 100);
  assert.ok(s.lockedUsd > 0);
  assert.deepEqual(s.backfill, { done: false, total: 0, resolved: 0 });
});

test("untracked coins stay out of the tree until explicitly tracked; persistence round-trip", () => {
  const { db, model } = buildTree();
  model.upsertCoin({ mint: K.X, curve: "C_X", depth: 0, quoteMint: null, ...base, virtualQuoteReserves: "1", tracked: false });
  model.upsertCoin({ mint: K.X, virtualQuoteReserves: "2" });
  assert.equal(model.get(K.X).tracked, false);
  assert.equal(model.stats().coins, 4);
  model.upsertCoin({ mint: K.X, tracked: true });
  assert.equal(model.get(K.X).tracked, true);
  const again = new Model(db, { platformWallet: PLATFORM, splitBps: [5000, 2500, 1000, 1500], log: quiet });
  again.load();
  assert.equal(again.coins.size, 5);
  assert.equal(again.solUsd, 100);
  assert.deepEqual(again.ancestors(K.G).map((c) => c.mint), [K.A, K.ROOT]);
  assert.equal(again.byCurve("C_G").mint, K.G);
});

test("untracked on-demand coins are never written to sqlite and leave memory when idle; pruneTouched forgets old views", () => {
  const { db, model } = buildTree();
  model.upsertCoin({ mint: K.X, curve: "C_X", depth: 0, quoteMint: null, ...base, virtualQuoteReserves: "1", tracked: false, updatedAt: 1 });
  assert.equal(model.get(K.X).tracked, false);
  assert.equal(db.allCoins().some((c) => c.mint === K.X), false, "not persisted");
  assert.equal(model.byCurve("C_X").mint, K.X);
  model.touch(K.X);
  assert.equal(model.evictUntracked({ idleMs: 60_000 }), 0, "just viewed: stays");
  model.touched.set(K.X, Date.now() - 11 * 60_000);
  model.coins.get(K.X).updatedAt = 1;
  assert.equal(model.evictUntracked(), 1);
  assert.equal(model.get(K.X), null); assert.equal(model.byCurve("C_X"), null); assert.equal(model.touched.has(K.X), false);
  // Tracked coins, coins with children and pending spawns are never evicted.
  model.upsertCoin({ mint: K.U, curve: "C_U", depth: 0, quoteMint: null, ...base, virtualQuoteReserves: "1", tracked: false, updatedAt: 1 });
  model.markPending(K.U, null);
  assert.equal(model.evictUntracked({ idleMs: 0 }), 0);
  model.touched.set(K.A, Date.now() - 300_000); model.touched.set(K.B, Date.now());
  model.pruneTouched(120_000);
  assert.deepEqual([...model.touched.keys()], [K.B]);
  assert.equal(model.evictUntracked({ idleMs: 0 }), 0, "A, B, G, ROOT are tracked");
});

test("quote symbols: SOL, USDC, parent symbol, short mint", () => {
  const { model } = buildTree();
  model.upsertCoin({ mint: K.U, curve: "C_U", depth: 0, quoteMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", ...base, virtualQuoteReserves: "1" });
  model.upsertCoin({ mint: K.S, curve: "C_S", depth: 0, quoteMint: "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB", ...base, virtualQuoteReserves: "1" });
  assert.equal(model.quoteSymbol(model.get(K.U)), "USDC");
  assert.equal(model.quoteSymbol(model.get(K.S)), "XsDo…HzoB");
  assert.equal(model.rootQuoteKind(model.get(K.U)), "usdc");
  assert.equal(model.rootQuoteKind(model.get(K.S)), "other");
  assert.deepEqual(model.computed().get(K.S).priceSol, null);
  assert.equal(model.quoteUsdOf(null), 100); assert.equal(model.quoteUsdOf("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"), 1);
  assert.ok(Math.abs(model.quoteUsdOf(K.A) - 2e-5) < 1e-18, "a tracked pump coin's own USD price");
  assert.equal(model.quoteUsdOf("XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB"), null);
});

test("a root quoted in a listed mint with a known USD price (PUMP) prices its whole tree", () => {
  const { db, model } = buildTree();
  const PUMP = "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn";
  model.upsertCoin({ mint: K.S, curve: "C_S", depth: 0, quoteMint: PUMP, ...base, virtualQuoteReserves: "1000000000000000" }); // 1 PUMP per token
  model.upsertCoin({ mint: K.X, curve: "C_X", depth: 1, quoteMint: K.S, ...base, virtualQuoteReserves: "500000000000000", realQuoteReserves: "1000000000000" }); // 0.5 S per X
  model.setMint({ mint: PUMP, decimals: 6, tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", symbol: "PUMP", onchainAt: 1 });
  assert.equal(model.computed().get(K.X).priceUsd, null, "unknown PUMP price → null");
  model.setQuoteUsd(PUMP, 0.004);
  const d = model.computed();
  assert.ok(Math.abs(d.get(K.S).priceUsd - 0.004) < 1e-15);
  assert.ok(Math.abs(d.get(K.X).priceUsd - 0.002) < 1e-15);
  assert.ok(Math.abs(d.get(K.X).priceSol - 0.002 / 100) < 1e-15);
  assert.ok(Math.abs(d.get(K.S).lockedUsd - 1e6 * 0.004) < 1e-6, "1M S locked in X at $0.004");
  assert.equal(model.quoteSymbol(model.get(K.S)), "PUMP");
  const again = new Model(db, { platformWallet: PLATFORM, splitBps: [5000, 2500, 1000, 1500], log: quiet });
  again.load();
  assert.equal(again.quoteUsd.get(PUMP), 0.004, "quote prices persist");
});
