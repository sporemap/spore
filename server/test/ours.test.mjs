// "Ours only" mode at the model level (DESIGN §11.1): a root with one child spawned through Spore
// (its sharing config names the platform) and one foreign child. No network, no RPC.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Db } from "../lib/db.mjs";
import { Model, PENDING_TTL_MS, PENDING_MAX } from "../lib/model.mjs";
import { K, PLATFORM, quiet, base, T22 } from "./helpers/tree.mjs";

const OUR_SHARES = [{ address: "CR", bps: 5000 }, { address: PLATFORM, bps: 5000 }];
const FOREIGN_SHARES = [{ address: "CR", bps: 10000 }];

/** ROOT (SOL) → OURS (depth 1, platform in shares) and FOREIGN (depth 1, no platform) → DEEP (depth 2, ours, under FOREIGN). */
function buildOursTree({ mode = "ours", now = () => 1_000_000_000_000 } = {}) {
  const db = new Db(":memory:");
  const model = new Model(db, { platformWallet: PLATFORM, splitBps: [5000, 0, 0, 5000], mode, now, log: quiet });
  model.load();
  model.setGlobal({ maxCurveDepth: 2, initialRealTokenReserves: "793100000000000", createV2Enabled: true, whitelistedQuoteMints: [] });
  model.setSolUsd(100);
  model.upsertCoin({ mint: K.ROOT, curve: "C_ROOT", depth: 0, quoteMint: null, ...base, virtualQuoteReserves: "100000000000", createdAt: 1000 });
  model.upsertCoin({ mint: K.A, curve: "C_A", depth: 1, quoteMint: K.ROOT, ...base, virtualQuoteReserves: "2000000000000000", realQuoteReserves: "50000000000000", createdAt: 2000, shares: OUR_SHARES, sharesAt: 1 });
  model.upsertCoin({ mint: K.B, curve: "C_B", depth: 1, quoteMint: K.ROOT, ...base, virtualQuoteReserves: "1000000000000000", realQuoteReserves: "10000000000000", createdAt: 3000, shares: FOREIGN_SHARES, sharesAt: 1 });
  model.upsertCoin({ mint: K.G, curve: "C_G", depth: 2, quoteMint: K.B, ...base, virtualQuoteReserves: "500000000000000", realQuoteReserves: "7000000000000", createdAt: 4000, shares: OUR_SHARES, sharesAt: 1 });
  for (const [mint, symbol] of [[K.ROOT, "ROOT"], [K.A, "OURS"], [K.B, "FOREIGN"], [K.G, "DEEP"]]) model.setMint({ mint, decimals: 6, tokenProgram: T22, name: `${symbol} coin`, symbol, onchainAt: 1 });
  return { db, model };
}

test("ours flags come from the sharing config; ancestors are context (ours:false)", () => {
  const { model } = buildOursTree();
  assert.deepEqual(model.oursOf(model.get(K.A)), { ours: true, oursPending: false });
  assert.deepEqual(model.oursOf(model.get(K.B)), { ours: false, oursPending: false });
  assert.deepEqual(model.oursOf(model.get(K.ROOT)), { ours: false, oursPending: false });
  const sc = model.scope();
  assert.deepEqual([...sc.ours].sort(), [K.A, K.G].sort());
  assert.deepEqual([...sc.inScope].sort(), [K.ROOT, K.A, K.B, K.G].sort(), "FOREIGN is in scope only as DEEP's ancestor");
  const v = model.view(model.get(K.A));
  assert.equal(v.ours, true); assert.equal(v.oursPending, false);
  assert.equal(v.parent.ours, false); assert.equal(v.ancestors[0].ours, false);
});

test("ours needs the platform's full share: a config naming the platform at a dust share is not ours", () => {
  const { model } = buildOursTree();
  const dust = [{ address: "CR", bps: 9999 }, { address: PLATFORM, bps: 1 }];
  model.upsertCoin({ mint: K.X, curve: "C_X", depth: 1, quoteMint: K.ROOT, ...base, virtualQuoteReserves: "1000000000000000", createdAt: 5000, shares: dust, sharesAt: 1 });
  assert.equal(model.isOurs(model.get(K.X)), false);
  assert.ok(!model.visibleSpawns().some((c) => c.mint === K.X));
  model.upsertCoin({ mint: K.X, shares: [{ address: "CR", bps: 5001 }, { address: PLATFORM, bps: 4999 }], sharesAt: 2 });
  assert.equal(model.isOurs(model.get(K.X)), false, "one bps short of the configured slice");
  model.upsertCoin({ mint: K.X, shares: [{ address: "CR", bps: 4000 }, { address: PLATFORM, bps: 6000 }], sharesAt: 3 });
  assert.equal(model.isOurs(model.get(K.X)), true, "more than the slice is fine");
  assert.equal(model.platformMinBps, 5000, "defaults to the SPLIT_BPS platform slice");
  const lax = new Model(new Db(":memory:"), { platformWallet: PLATFORM, splitBps: [5000, 0, 0, 5000], platformMinBps: 1500, mode: "ours", log: quiet });
  assert.equal(lax.platformMinBps, 1500);
  assert.equal(lax.isOurs({ shares: [{ address: PLATFORM, bps: 1500 }] }), true);
  assert.equal(lax.isOurs({ shares: [{ address: PLATFORM, bps: 1499 }] }), false);
  assert.equal(lax.isOurs({ shares: null }), false);
});

test("a root coin launched here (depth 0, our split) is in the ours feed but never in the all-mode spawn feed", () => {
  const { model } = buildOursTree();
  model.upsertCoin({ mint: K.S, curve: "C_S", depth: 0, quoteMint: null, ...base, virtualQuoteReserves: "30000000000", createdAt: 9000, shares: OUR_SHARES, sharesAt: 1, feePaid: "20000000" });
  assert.ok(model.visibleSpawns().some((c) => c.mint === K.S));
  assert.equal(model.view(model.get(K.S)).feePaid, "20000000");
  assert.equal(model.stats().ourCoins, 3);
  assert.equal(model.visibleRoots().some((c) => c.mint === K.S), false, "no children yet, so not a root row");
  const all = buildOursTree({ mode: "all" }).model;
  all.upsertCoin({ mint: K.S, curve: "C_S", depth: 0, quoteMint: null, ...base, virtualQuoteReserves: "30000000000", createdAt: 9000, shares: OUR_SHARES, sharesAt: 1 });
  assert.equal(all.visibleSpawns().some((c) => c.mint === K.S), false);
});

test("the pending map is bounded: the oldest entry makes room", () => {
  let t = 1_000_000_000_000;
  const { model } = buildOursTree({ now: () => t });
  for (let i = 0; i < PENDING_MAX + 5; i++) { t += 1; model.markPending(`M${i}`, null, { feePaid: "1" }); }
  assert.equal(model.pending.size, PENDING_MAX);
  assert.equal(model.pending.has("M0"), false); assert.equal(model.pending.has(`M${PENDING_MAX + 4}`), true);
  assert.equal(model.feePaidOf({ mint: `M${PENDING_MAX + 4}` }), "1");
});

test("ours mode: feed, roots, children and counts cover our coins only; otherChildren says what is left out", () => {
  const { model } = buildOursTree();
  assert.deepEqual(model.visibleSpawns().map((c) => c.mint).sort(), [K.A, K.G].sort());
  assert.deepEqual(model.visibleRoots().map((c) => c.mint), [K.ROOT]);
  // ROOT shows both children: OURS and FOREIGN (context, because DEEP is under it); descendants = our coins only.
  assert.deepEqual(model.visibleChildren(K.ROOT).map((c) => c.mint).sort(), [K.A, K.B].sort());
  const root = model.view(model.get(K.ROOT));
  assert.equal(root.children, 2); assert.equal(root.descendants, 2); assert.equal(root.otherChildren, 0);
  assert.equal(root.lockedQuote, "50000000000000", "locked counts our direct children only (OURS), not FOREIGN");
  const foreign = model.view(model.get(K.B));
  assert.equal(foreign.ours, false); assert.equal(foreign.children, 1); assert.equal(foreign.descendants, 1); assert.equal(foreign.otherChildren, 0);
  // A second foreign child under ROOT with nothing of ours below it is filtered and counted in otherChildren.
  model.upsertCoin({ mint: K.X, curve: "C_X", depth: 1, quoteMint: K.ROOT, ...base, virtualQuoteReserves: "1000000000000000", realQuoteReserves: "1", createdAt: 5000, shares: FOREIGN_SHARES, sharesAt: 1 });
  assert.deepEqual(model.visibleChildren(K.ROOT).map((c) => c.mint).sort(), [K.A, K.B].sort());
  assert.equal(model.view(model.get(K.ROOT)).otherChildren, 1);
  assert.equal(model.inScope(K.X), false);
  const x = model.view(model.get(K.X));
  assert.equal(x.children, 0); assert.equal(x.descendants, 0); assert.equal(x.otherChildren, 0);
  const s = model.stats();
  assert.equal(s.mode, "ours"); assert.equal(s.ourCoins, 2); assert.equal(s.coins, 2); assert.equal(s.roots, 1); assert.equal(s.otherChildren, 1);
  assert.deepEqual(s.byDepth, [0, 1, 1]);
});

test("all mode: the same tree is served whole, with mode/ourCoins reported", () => {
  const { model } = buildOursTree({ mode: "all" });
  assert.deepEqual(model.visibleSpawns().map((c) => c.mint).sort(), [K.A, K.B, K.G].sort());
  const root = model.view(model.get(K.ROOT));
  assert.equal(root.children, 2); assert.equal(root.descendants, 3); assert.equal(root.otherChildren, 0);
  assert.equal(root.lockedQuote, "60000000000000");
  const s = model.stats();
  assert.equal(s.mode, "all"); assert.equal(s.coins, 4); assert.equal(s.ourCoins, 2); assert.equal(s.otherChildren, 0);
  assert.equal(model.view(model.get(K.B)).ours, false);
});

test("a reported spawn is pending until its config confirms it, and expires after 30 min", () => {
  let t = 1_000_000_000_000;
  const { db, model } = buildOursTree({ now: () => t });
  model.upsertCoin({ mint: K.X, curve: "C_X", depth: 1, quoteMint: K.ROOT, ...base, virtualQuoteReserves: "1000000000000000", realQuoteReserves: "5", createdAt: 5000 });
  assert.equal(model.inScope(K.X), false);
  model.markPending(K.X, "sig1");
  assert.deepEqual(model.oursOf(model.get(K.X)), { ours: false, oursPending: true });
  assert.ok(model.visibleSpawns().some((c) => c.mint === K.X), "pending coins are in the feed");
  assert.equal(model.stats().ourCoins, 3);
  // Survives a restart within the window.
  const again = new Model(db, { platformWallet: PLATFORM, splitBps: [5000, 0, 0, 5000], mode: "ours", now: () => t, log: quiet });
  again.load();
  assert.equal(again.oursOf(again.get(K.X)).oursPending, true);
  // Just before the deadline it is still pending; at the deadline it drops.
  t += PENDING_TTL_MS - 1;
  assert.equal(model.oursOf(model.get(K.X)).oursPending, true);
  t += 1;
  assert.deepEqual(model.oursOf(model.get(K.X)), { ours: false, oursPending: false });
  assert.deepEqual(model.pendingMints(), []);
  assert.equal(model.inScope(K.X), false);
  assert.equal(db.kvGet("oursPending").X, undefined);
});

test("a pending spawn becomes ours when the sharing config names the platform; the pending entry is dropped", () => {
  const { model } = buildOursTree();
  model.upsertCoin({ mint: K.X, curve: "C_X", depth: 1, quoteMint: K.ROOT, ...base, virtualQuoteReserves: "1000000000000000", realQuoteReserves: "5", createdAt: 5000 });
  model.markPending(K.X, null);
  model.upsertCoin({ mint: K.X, shares: OUR_SHARES, sharesAt: 2 });
  assert.deepEqual(model.oursOf(model.get(K.X)), { ours: true, oursPending: false });
  assert.deepEqual(model.pendingMints(), []);
  // A config without the platform does not confirm: the flag stays pending (until it expires).
  model.upsertCoin({ mint: K.U, curve: "C_U", depth: 1, quoteMint: K.ROOT, ...base, virtualQuoteReserves: "1000000000000000", createdAt: 5000 });
  model.markPending(K.U, null);
  model.upsertCoin({ mint: K.U, shares: FOREIGN_SHARES, sharesAt: 2 });
  assert.deepEqual(model.oursOf(model.get(K.U)), { ours: false, oursPending: true });
  assert.deepEqual(model.pendingMints(), [K.U]);
});
