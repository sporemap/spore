// Pure logic of the map's data layer (DESIGN §11.5 "Map v2"): live pair counting, highlight keys and
// counts, the rails, the "since your last visit" digest, share text, the full re-sync rule and the
// bubble sizes (family tops weigh their whole family).
//
//   node --import tsx --test test/map-logic.test.mts
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyPair, type NodeSet } from "../src/lib/map/nodes.ts";
import { HL_KEYS, formatHl, hlCounts, hlPredicate, hlTest, parseHl, type HlCtx, type HlKey } from "../src/lib/map/highlight.ts";
import { railGrowing, railHot, railNew, railSpore, sinceDigest } from "../src/lib/map/rails.ts";
import { mapLink, shareText } from "../src/lib/map/share.ts";
import { applyTrade, indexHeat, type HeatIndex } from "../src/lib/map/heat.ts";
import { FULL_EVERY_MS, needsFull } from "../src/lib/map/use-map-data.ts";
import { TOP_GROW, TOP_LOG, TOP_MIN, TOP_RATIO, familyRadii, familyWeights, families, rangeFor, valueOf } from "../src/lib/map/sizing.ts";
import type { BubbleNode } from "../src/lib/map/types.ts";
import type { MapCoin } from "../src/lib/api.ts";

const NOW = 1_800_000_000; // unix s
const node = (mint: string, parentMint: string | null, depth: number, o: Partial<BubbleNode> = {}): BubbleNode => ({
  mint, parentMint, depth, name: `${mint} coin`, symbol: mint.toUpperCase(), image: null, mcapUsd: 500, lockedUsd: null, children: 0, descendants: 0, migrated: false, ours: false, createdAt: NOW - 30 * 86_400, ...o,
});
const coin = (n: BubbleNode): MapCoin => ({ mint: n.mint, name: n.name, symbol: n.symbol, image: n.image, depth: n.depth, mcapUsd: n.mcapUsd, lockedUsd: n.lockedUsd, children: n.children, descendants: n.descendants ?? 0, migrated: n.migrated, createdAt: n.createdAt ?? null, parentMint: n.parentMint });

// root ─ a ─ a1, a2      root2 ─ b      (createdAt chosen per test)
function fixture(): BubbleNode[] {
  return [
    node("root", null, 0, { children: 2, descendants: 4, lockedUsd: 40_000, mcapUsd: 90_000, ours: false }),
    node("a", "root", 1, { children: 2, descendants: 2, lockedUsd: 3_000, mcapUsd: 12_000, createdAt: NOW - 1_800, migrated: true }),
    node("a1", "a", 2, { mcapUsd: 1_500, createdAt: NOW - 600, ours: true }),
    node("a2", "a", 2, { mcapUsd: 800, createdAt: null }),
    node("c", "root", 1, { mcapUsd: 2_000, createdAt: NOW - 20 * 3_600, ours: true }),
    node("root2", null, 0, { children: 1, descendants: 1, lockedUsd: 5_000, mcapUsd: 7_000 }),
    node("b", "root2", 1, { mcapUsd: 300, createdAt: NOW - 40 * 3_600 }),
  ];
}
const setOf = (ns: BubbleNode[]): NodeSet => new Map(ns.map((n) => [n.mint, n]));
const heatOf = (rows: Record<string, { t1h: number; n24?: number; v24?: number; last?: number; buys1h?: number }>): HeatIndex => ({
  at: NOW, version: 1, rows: new Map(Object.entries(rows).map(([m, r]) => [m, { t1h: r.t1h, n24: r.n24 ?? r.t1h, v24: r.v24 ?? 0, last: r.last ?? (r.t1h ? NOW - 60 : NOW - 7_200), buys1h: r.buys1h ?? 0 }])),
});

// ---------------------------------------------------------------- applyPair
test("applyPair: a new grandchild counts on every ancestor the set holds", () => {
  const set = setOf(fixture());
  const child = node("a3", "a", 2, { createdAt: NOW });
  applyPair(set, { coin: coin(child), parent: coin(set.get("a")!) });
  assert.equal(set.get("a")!.children, 3);
  assert.equal(set.get("a")!.descendants, 3);
  assert.equal(set.get("root")!.children, 2, "the root's direct children do not change");
  assert.equal(set.get("root")!.descendants, 5);
  assert.equal(set.get("a3")!.parentMint, "a");
  // the same event again (a replay) changes nothing
  applyPair(set, { coin: coin(child), parent: coin(set.get("a")!) });
  assert.equal(set.get("root")!.descendants, 5);
  assert.equal(set.get("a")!.children, 3);
});
test("applyPair: an unknown parent under a known root adds both, the root counts two", () => {
  const set = setOf(fixture());
  const parent = node("p", "root2", 1, { children: 1, descendants: 1 });
  const child = node("p1", "p", 2);
  applyPair(set, { coin: coin(child), parent: coin(parent) });
  assert.ok(set.has("p") && set.has("p1"));
  assert.equal(set.get("p")!.children, 1, "the parent keeps the server's counts");
  assert.equal(set.get("root2")!.children, 2);
  assert.equal(set.get("root2")!.descendants, 3);
});
test("applyPair: a brand-new root is inserted from the event", () => {
  const set = setOf(fixture());
  const parent = node("r3", null, 0, { children: 1, descendants: 1 });
  applyPair(set, { coin: coin(node("r3c", "r3", 1)), parent: coin(parent) });
  assert.equal(set.get("r3")!.descendants, 1);
  assert.equal(set.get("r3c")!.parentMint, "r3");
  assert.equal(set.get("root")!.descendants, 4);
});

// ---------------------------------------------------------------- highlight
const ctx = (o: Partial<HlCtx> = {}): HlCtx => ({ nowS: NOW, seenAtS: NOW - 3 * 3_600, heat: heatOf({ a: { t1h: 4 }, b: { t1h: 0, last: NOW - 1_200 }, c: { t1h: 0 } }), ...o });
test("hlCounts equals a manual filter for every key", () => {
  const ns = fixture(), c = ctx();
  const counts = hlCounts(ns, c);
  const manual: Record<HlKey, (n: BubbleNode) => boolean> = {
    ours: (n) => !!n.ours,
    new1h: (n) => n.createdAt != null && n.createdAt >= NOW - 3_600,
    new24h: (n) => n.createdAt != null && n.createdAt >= NOW - 86_400,
    grad: (n) => n.migrated,
    min1k: (n) => (n.mcapUsd ?? 0) >= 1_000,
    active: (n) => n.mint === "a" || n.mint === "b",
    since: (n) => n.createdAt != null && n.createdAt > NOW - 3 * 3_600,
  };
  for (const k of HL_KEYS) assert.equal(counts[k], ns.filter(manual[k]).length, k);
  assert.deepEqual(counts, { ours: 2, new1h: 2, new24h: 3, grad: 1, min1k: 5, active: 2, since: 2 });
});
test("hlTest: createdAt null is never new; without heat nothing is active; first visit has no 'since'", () => {
  const a2 = fixture().find((n) => n.mint === "a2")!;
  for (const k of ["new1h", "new24h", "since"] as HlKey[]) assert.equal(hlTest(k, a2, ctx()), false, k);
  assert.equal(hlTest("active", fixture()[1], ctx({ heat: null })), false);
  assert.equal(hlTest("since", fixture()[2], ctx({ seenAtS: null })), false);
});
test("hlPredicate: AND of the keys, null when empty", () => {
  const c = ctx();
  assert.equal(hlPredicate([], c), null);
  const p = hlPredicate(["ours", "min1k"], c)!;
  assert.deepEqual(fixture().filter(p).map((n) => n.mint), ["a1", "c"]);
  const q = hlPredicate(["ours", "new1h"], c)!;
  assert.deepEqual(fixture().filter(q).map((n) => n.mint), ["a1"]);
  const r = hlPredicate(["grad", "active", "new1h"], c)!;
  assert.deepEqual(fixture().filter(r).map((n) => n.mint), ["a"]);
});
test("parseHl / formatHl round trip, canonical order, unknown keys dropped", () => {
  assert.deepEqual(parseHl(null), []);
  assert.deepEqual(parseHl(""), []);
  assert.deepEqual(parseHl("grad,bogus,ours,grad, MIN1K "), ["ours", "grad", "min1k"]);
  assert.equal(formatHl([]), null);
  assert.equal(formatHl(["since", "ours"]), "ours,since");
  for (const keys of [["ours"], ["new1h", "active"], [...HL_KEYS]] as HlKey[][]) assert.deepEqual(parseHl(formatHl(keys)), keys);
  assert.equal(formatHl(parseHl("active,ours,x")), "ours,active");
});

// ---------------------------------------------------------------- rails
test("railNew: depth ≥ 1 by createdAt desc, live arrivals first, cap, createdAt null excluded", () => {
  const ns = fixture(), by = setOf(ns);
  const rows = railNew(ns, by, [], 15);
  assert.deepEqual(rows.map((r) => r.node.mint), ["a1", "a", "c", "b"]);
  assert.equal(rows[0].parent?.mint, "a");
  assert.equal(rows[0].root?.mint, "root");
  assert.equal(rows[0].metric, NOW - 600);
  assert.deepEqual(railNew(ns, by, [], 2).map((r) => r.node.mint), ["a1", "a"]);
  // a live pair goes first even when it is older than the top of the list
  assert.deepEqual(railNew(ns, by, [by.get("b")!], 3).map((r) => r.node.mint), ["b", "a1", "a"]);
  // a live entry without createdAt, or not on the map, is skipped
  assert.deepEqual(railNew(ns, by, [by.get("a2")!, node("gone", "root", 1)], 2).map((r) => r.node.mint), ["a1", "a"]);
});
test("railHot: by trades in the last hour, ties by 24 h volume; [] without heat", () => {
  const ns = fixture(), by = setOf(ns);
  const heat = heatOf({ a: { t1h: 4, v24: 10 }, c: { t1h: 9, v24: 1 }, b: { t1h: 4, v24: 50 }, zz: { t1h: 99 }, a2: { t1h: 0, v24: 900 } });
  const rows = railHot(ns, by, heat, 12);
  assert.deepEqual(rows.map((r) => [r.node.mint, r.metric]), [["c", 9], ["b", 4], ["a", 4]]);
  assert.deepEqual(railHot(ns, by, heat, 1).map((r) => r.node.mint), ["c"]);
  assert.deepEqual(railHot(ns, by, null), []);
});
test("railGrowing: roots by descendants created in the window", () => {
  const ns = fixture(), by = setOf(ns);
  const rows = railGrowing(ns, by, NOW, 86_400, 10);
  assert.deepEqual(rows.map((r) => [r.node.mint, r.metric]), [["root", 3]]);
  assert.equal(rows[0].root, null, "a root row has no separate root");
  const wide = railGrowing(ns, by, NOW, 3 * 86_400, 10);
  assert.deepEqual(wide.map((r) => [r.node.mint, r.metric]), [["root", 3], ["root2", 1]]);
  assert.deepEqual(railGrowing(ns, by, NOW, 3 * 86_400, 1).map((r) => r.node.mint), ["root"]);
});
test("railSpore: Spore launches by mcap", () => {
  const ns = fixture(), by = setOf(ns);
  assert.deepEqual(railSpore(ns, by).map((r) => [r.node.mint, r.metric]), [["c", 2_000], ["a1", 1_500]]);
  assert.deepEqual(railSpore(ns, by, 1).map((r) => r.node.mint), ["c"]);
});
test("sinceDigest: pairs after the last visit, trees they landed in, top trees", () => {
  const ns = fixture(), by = setOf(ns);
  const d = sinceDigest(ns, by, NOW - 3 * 3_600);
  assert.equal(d.pairs, 2);
  assert.equal(d.roots, 1);
  assert.deepEqual(d.top.map((r) => [r.node.mint, r.metric]), [["root", 2]]);
  const all = sinceDigest(ns, by, NOW - 10 * 86_400);
  assert.equal(all.pairs, 4);
  assert.equal(all.roots, 2);
  assert.deepEqual(sinceDigest(ns, by, null), { pairs: 0, roots: 0, top: [] });
  assert.equal(sinceDigest(ns, by, NOW).pairs, 0, "strictly after the visit");
});

// ---------------------------------------------------------------- share
test("shareText for a root and a child, mapLink", () => {
  const [root, a] = fixture();
  const t = shareText(root, null);
  assert.match(t, /^\$ROOT on the Spore map: 4 coins trade under it, \$40K locked\.$/);
  const c = shareText(a, root);
  assert.match(c, /^\$A \(\$12K mcap\) is paired with \$ROOT on pump\.fun\./);
  assert.ok(!/undefined|null|NaN/.test(t + c));
  const bare = shareText({ ...root, symbol: null, name: null, descendants: 0, children: 0, lockedUsd: null }, null);
  assert.match(bare, /^root…root on the Spore map: a root of the pump\.fun pair tree\.$/);
  assert.equal(mapLink("Mint111", "https://sporepad.com/"), "https://sporepad.com/map?focus=Mint111");
  assert.equal(mapLink("Mint111", "http://127.0.0.1:5252"), "http://127.0.0.1:5252/map?focus=Mint111");
});

// ---------------------------------------------------------------- heat
test("indexHeat + applyTrade: rows by mint, live trades counted in place", () => {
  const idx = indexHeat({ at: NOW, since: NOW - 86_400, mint: ["a", "b"], t1h: [2, 0], n24: [5, 1], v24: [10.5, 2], last: [NOW - 30, NOW - 7_000], buys1h: [1, 0] });
  assert.deepEqual(idx.get("a"), { t1h: 2, n24: 5, v24: 10.5, last: NOW - 30, buys1h: 1 });
  applyTrade(idx, { mint: "a", time: NOW, isBuy: true, valueUsd: 4.25 }, NOW);
  assert.deepEqual(idx.get("a"), { t1h: 3, n24: 6, v24: 14.75, last: NOW, buys1h: 2 });
  applyTrade(idx, { mint: "n", time: NOW - 2 * 3_600, isBuy: false, valueUsd: null }, NOW);
  assert.deepEqual(idx.get("n"), { t1h: 0, n24: 1, v24: 0, last: NOW - 7_200, buys1h: 0 });
  applyTrade(idx, { mint: "old", time: NOW - 2 * 86_400, isBuy: true, valueUsd: 1 }, NOW);
  assert.equal(idx.has("old"), false);
});

// ---------------------------------------------------------------- full re-sync rule
test("needsFull: never loaded, or the last complete load is older than 15 min", () => {
  const now = 1_760_000_000_000;
  assert.equal(FULL_EVERY_MS, 15 * 60_000);
  assert.equal(needsFull(null, now), true);
  assert.equal(needsFull(Number.NaN, now), true);
  assert.equal(needsFull(now - 60_000, now), false);
  assert.equal(needsFull(now - FULL_EVERY_MS, now), false);
  assert.equal(needsFull(now - FULL_EVERY_MS - 1, now), true);
  assert.equal(needsFull(now - 20 * 60_000, now), true);
});

// ---------------------------------------------------------------- sizes: family tops weigh their family
test("families: tops, members and the walk to the top (an unknown parent makes a top)", () => {
  const ns = [...fixture(), node("orphan", "nowhere", 1), node("o1", "orphan", 2)];
  const f = families(ns);
  const at = (m: string) => ns.findIndex((n) => n.mint === m);
  assert.deepEqual([...f.top].map((q) => ns[q].mint), ["root", "root", "root", "root", "root", "root2", "root2", "orphan", "orphan"]);
  assert.equal(f.members[at("root")], 5);
  assert.equal(f.members[at("root2")], 2);
  assert.equal(f.isTop[at("root")], 1);
  assert.equal(f.isTop[at("orphan")], 1, "a coin whose parent is not on the map tops its family");
  assert.equal(f.isTop[at("a")], 0);
  assert.equal(f.parent[at("a1")], at("a"));
  // a lone bubble is not a top
  const lone = families([node("solo", null, 0)]);
  assert.equal(lone.isTop[0], 0);
});
test("familyWeights: a top weighs its own value plus every descendant's, the rest their own", () => {
  const ns = fixture();
  const f = families(ns);
  const w = familyWeights(ns, f, "locked");
  const v = (m: string) => valueOf(ns.find((n) => n.mint === m)!, "locked")!;
  const at = (m: string) => ns.findIndex((n) => n.mint === m);
  assert.equal(w[at("root")], v("root") + v("a") + v("a1") + v("a2") + v("c"));
  assert.equal(w[at("a")], 3_000);
  assert.equal(w[at("a1")], Math.min(1_500 * 0.02, 500), "a leaf in locked mode: a small, capped slice of its mcap");
  assert.equal(w[at("root2")], 5_000 + Math.min(300 * 0.02, 500));
  const m = familyWeights(ns, f, "mcap");
  assert.equal(m[at("root")], 90_000 + 12_000 + 1_500 + 800 + 2_000);
  // no value at all: NaN for a member, 0 for a top
  const bare = [node("t", null, 0, { mcapUsd: null }), node("k", "t", 1, { mcapUsd: null })];
  const bw = familyWeights(bare, families(bare), "mcap");
  assert.equal(bw[0], 0);
  assert.ok(Number.isNaN(bw[1]));
});
test("familyRadii: area ∝ weight, the top is the largest of its tree, floors apply", () => {
  // a top with two unclamped children and a crowd of tiny ones; a second family of 700 near-zero coins
  const ns = [node("t", null, 0, { lockedUsd: 30_000 }), node("big", "t", 1, { lockedUsd: 10_000 }), node("mid", "t", 1, { lockedUsd: 2_500 }),
    ...Array.from({ length: 30 }, (_, i) => node(`s${i}`, "t", 1, { lockedUsd: 1 })), node("crowd", null, 0, { lockedUsd: 1 }),
    ...Array.from({ length: 700 }, (_, i) => node(`c${i}`, "crowd", 1, { lockedUsd: 0.5, mcapUsd: 1 })), node("x", "big", 2, { mcapUsd: null, lockedUsd: null })];
  const f = families(ns), w = familyWeights(ns, f, "locked");
  let maxW = 0; for (const v of w) if (v > maxW) maxW = v;
  const sc = { maxW, rangeR: 200, floor: 5, maxR: 52 };
  const r = familyRadii(f, w, sc);
  const at = (m: string) => ns.findIndex((n) => n.mint === m);
  // proportional: the heaviest weight sits at rangeR, others by sqrt of their share
  assert.ok(Math.abs(r[at("t")] - 200) < 1e-3, "the top of the heaviest family is drawn at rangeR");
  assert.ok(Math.abs(r[at("big")] ** 2 / r[at("mid")] ** 2 - 4) < 1e-3, "area ratio = weight ratio");
  assert.equal(r[at("s0")], 5, "tiny values sit at the floor");
  assert.equal(r[at("x")], Math.fround(52 * 0.4), "no known value: 0.4 × maxR");
  // every top is ≥ TOP_RATIO × its largest member and at least its count floor
  for (const top of ["t", "crowd"]) {
    const q = at(top);
    let biggest = 0; for (let i = 0; i < ns.length; i++) if (i !== q && f.top[i] === q && r[i] > biggest) biggest = r[i];
    assert.ok(r[q] >= TOP_RATIO * biggest - 1e-4 && TOP_RATIO >= 1.5, `${top}: ${r[q]} vs largest member ${biggest}`);
    assert.ok(r[q] >= 5 * (TOP_MIN + TOP_LOG * Math.log10(f.members[q])) - 1e-4, `${top}: count floor`);
  }
  // the crowded family's coins hold almost nothing: its top still stands out (≥ 3× the floor at 700)
  assert.ok(r[at("crowd")] >= 15, `crowd top ${r[at("crowd")]}`);
  // a heavy member forces its top up to TOP_RATIO × it even when the family sum alone is just over it
  const pair = [node("p", null, 0, { lockedUsd: 1 }), node("q", "p", 1, { lockedUsd: 90_000 })];
  const pf = families(pair), pw = familyWeights(pair, pf, "locked");
  const pr = familyRadii(pf, pw, { maxW: pw[0], rangeR: 100, floor: 5, maxR: 52 });
  assert.ok(pr[0] >= TOP_RATIO * pr[1] - 1e-4);
});
test("rangeFor: TOP_GROW × maxR on a big forest, never below maxR, capped on a small one", () => {
  const big = [node("t", null, 0, { lockedUsd: 1e6 }), ...Array.from({ length: 16_000 }, (_, i) => node(`k${i}`, "t", 1, { lockedUsd: 1 }))];
  const bf = families(big), bw = familyWeights(big, bf, "locked");
  assert.equal(rangeFor(bf, bw, { maxW: bw[0], floor: 5, maxR: 52 }), 52 * TOP_GROW);
  const small = [node("t", null, 0, { lockedUsd: 1e6 }), node("k", "t", 1, { lockedUsd: 1 }), node("j", "t", 1, { lockedUsd: 1 })];
  const sf = families(small), sw = familyWeights(small, sf, "locked");
  const rr = rangeFor(sf, sw, { maxW: sw[0], floor: 7, maxR: 52 });
  assert.equal(rr, 52, "a three-coin map keeps today's largest radius (the fit cap would shrink it below)");
  const mid = [node("t", null, 0, { lockedUsd: 1e6 }), ...Array.from({ length: 400 }, (_, i) => node(`m${i}`, "t", 1, { lockedUsd: 1 }))];
  const mf = families(mid), mw = familyWeights(mid, mf, "locked");
  const mr = rangeFor(mf, mw, { maxW: mw[0], floor: 5, maxR: 52 });
  assert.ok(mr > 52 && mr < 52 * TOP_GROW, `a 400-coin map is capped between: ${mr}`);
});
