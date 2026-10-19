// The map's live rails (DESIGN §11.5 "Map v2"): short ranked lists the page shows beside the canvas —
// the newest pairs, the most traded coins in the last hour, the trees that grew most in a day, the Spore
// launches — plus the "since your last visit" digest. Pure functions over the node list; top-n
// selection is a bounded insertion (no full sort of 16 k nodes), and root lookups share one Map per
// nodes array, built on first use.
import type { HeatIndex } from "./heat";
import type { BubbleNode } from "./types";

/// `root` is the tree's root when it is not the node itself; `metric` is what the rail ranks by
/// (createdAt for New, trades in the last hour for Hot, new descendants for Growing, mcap for Spore).
export type RailRow = { node: BubbleNode; parent: BubbleNode | null; root: BubbleNode | null; metric: number };
type ByMint = Map<string, BubbleNode>;

const rootCache = new WeakMap<BubbleNode[], { byMint: ByMint; roots: Map<string, BubbleNode> }>();

/// mint → root node for every node, computed once per nodes array (and its byMint).
function rootsOf(nodes: BubbleNode[], byMint: ByMint): Map<string, BubbleNode> {
  const hit = rootCache.get(nodes);
  if (hit && hit.byMint === byMint) return hit.roots;
  const roots = new Map<string, BubbleNode>();
  const path: BubbleNode[] = [];
  for (const n of nodes) {
    if (roots.has(n.mint)) continue;
    let cur: BubbleNode = n; let top: BubbleNode | undefined;
    path.length = 0;
    for (let hops = 0; hops < 32; hops++) {
      const known = roots.get(cur.mint);
      if (known) { top = known; break; }
      path.push(cur);
      const p = cur.parentMint ? byMint.get(cur.parentMint) : undefined;
      if (!p || p === cur) { top = cur; break; }
      cur = p;
    }
    const r = top ?? cur;
    for (const q of path) roots.set(q.mint, r);
  }
  rootCache.set(nodes, { byMint, roots });
  return roots;
}

export const rootOf = (nodes: BubbleNode[], byMint: ByMint, n: BubbleNode): BubbleNode => rootsOf(nodes, byMint).get(n.mint) ?? n;

const row = (nodes: BubbleNode[], byMint: ByMint, n: BubbleNode, metric: number): RailRow => {
  const r = rootOf(nodes, byMint, n);
  return { node: n, parent: n.parentMint ? byMint.get(n.parentMint) ?? null : null, root: r === n ? null : r, metric };
};

/// Keeps the best `cap` items by `better` in `out` (sorted best first) with an insertion step per item.
function keepTop<T>(out: T[], item: T, cap: number, better: (a: T, b: T) => boolean) {
  if (cap <= 0) return;
  if (out.length === cap && !better(item, out[cap - 1])) return;
  let i = out.length < cap ? out.length : cap - 1;
  if (out.length < cap) out.push(item);
  while (i > 0 && better(item, out[i - 1])) { out[i] = out[i - 1]; i--; }
  out[i] = item;
}

const createdOf = (n: BubbleNode) => (typeof n.createdAt === "number" && Number.isFinite(n.createdAt) ? n.createdAt : null);

/// Newest pairs (depth ≥ 1) by createdAt; the ones that arrived live in this session come first, newest
/// first. A node without createdAt is never listed. The live rows use the current record from byMint.
export function railNew(nodes: BubbleNode[], byMint: ByMint, recent: BubbleNode[], n = 15): RailRow[] {
  const out: RailRow[] = [];
  const seen = new Set<string>();
  for (const r of recent) {
    if (out.length >= n) break;
    const cur = byMint.get(r.mint) ?? null;
    if (!cur || seen.has(cur.mint) || cur.depth < 1) continue;
    const c = createdOf(cur);
    if (c == null) continue;
    seen.add(cur.mint);
    out.push(row(nodes, byMint, cur, c));
  }
  const left = n - out.length;
  if (left <= 0) return out;
  const top: BubbleNode[] = [];
  const newer = (a: BubbleNode, b: BubbleNode) => createdOf(a)! > createdOf(b)!;
  for (const x of nodes) { if (x.depth < 1 || seen.has(x.mint) || createdOf(x) == null) continue; keepTop(top, x, left, newer); }
  for (const x of top) out.push(row(nodes, byMint, x, createdOf(x)!));
  return out;
}

/// Most traded in the last hour (heat t1h), ties by 24 h volume. Only coins on the map; [] without heat.
export function railHot(nodes: BubbleNode[], byMint: ByMint, heat: HeatIndex | null, n = 12): RailRow[] {
  if (!heat) return [];
  const top: { node: BubbleNode; t1h: number; v24: number }[] = [];
  const better = (a: { t1h: number; v24: number }, b: { t1h: number; v24: number }) => a.t1h > b.t1h || (a.t1h === b.t1h && a.v24 > b.v24);
  for (const [mint, r] of heat.rows) {
    if (r.t1h <= 0) continue;
    const node = byMint.get(mint);
    if (!node) continue;
    keepTop(top, { node, t1h: r.t1h, v24: r.v24 }, n, better);
  }
  return top.map((t) => row(nodes, byMint, t.node, t.t1h));
}

/// Counts, per root, the descendants created at or after `fromS`, best first (ties by locked value).
function growth(nodes: BubbleNode[], byMint: ByMint, fromS: number, strict: boolean, cap: number): { rows: RailRow[]; pairs: number; roots: number } {
  const per = new Map<BubbleNode, number>();
  let pairs = 0;
  const roots = rootsOf(nodes, byMint);
  for (const x of nodes) {
    if (!x.parentMint || !byMint.has(x.parentMint)) continue; // a root is not a pair
    const c = createdOf(x);
    if (c == null || (strict ? c <= fromS : c < fromS)) continue;
    pairs++;
    const r = roots.get(x.mint) ?? x;
    per.set(r, (per.get(r) ?? 0) + 1);
  }
  const top: [BubbleNode, number][] = [];
  const better = (a: [BubbleNode, number], b: [BubbleNode, number]) => a[1] > b[1] || (a[1] === b[1] && (a[0].lockedUsd ?? 0) > (b[0].lockedUsd ?? 0));
  for (const e of per) keepTop(top, e, cap, better);
  return { rows: top.map(([r, k]) => row(nodes, byMint, r, k)), pairs, roots: per.size };
}

/// Roots that gained the most descendants in the window (metric = new descendants).
export function railGrowing(nodes: BubbleNode[], byMint: ByMint, nowS: number, windowS = 86_400, n = 10): RailRow[] {
  return growth(nodes, byMint, nowS - windowS, false, n).rows;
}

/// Spore launches, largest market cap first, then newest (metric = mcap).
export function railSpore(nodes: BubbleNode[], byMint: ByMint, n = 20): RailRow[] {
  const top: BubbleNode[] = [];
  const better = (a: BubbleNode, b: BubbleNode) => (a.mcapUsd ?? -1) > (b.mcapUsd ?? -1) || ((a.mcapUsd ?? -1) === (b.mcapUsd ?? -1) && (createdOf(a) ?? 0) > (createdOf(b) ?? 0));
  for (const x of nodes) if (x.ours) keepTop(top, x, n, better);
  return top.map((x) => row(nodes, byMint, x, x.mcapUsd ?? 0));
}

/// What happened since the previous visit: pairs created after it, how many trees they landed in, and
/// the five trees that gained most (metric = new pairs). Empty on a first visit.
export function sinceDigest(nodes: BubbleNode[], byMint: ByMint, seenAtS: number | null): { pairs: number; roots: number; top: RailRow[] } {
  if (seenAtS == null || !Number.isFinite(seenAtS)) return { pairs: 0, roots: 0, top: [] };
  const g = growth(nodes, byMint, seenAtS, true, 5);
  return { pairs: g.pairs, roots: g.roots, top: g.rows };
}
