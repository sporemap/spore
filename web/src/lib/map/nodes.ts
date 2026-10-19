// The map's node set: how API shapes (tree, flat delta, live events) become BubbleNodes, how a delta
// merges into what the client holds, which roots the view shows, and the dev-only stress replicator.
// Pure functions over a Map<mint, BubbleNode>; the hook in use-map-data.ts owns the state.
import type { MapCoin, MapDeltaEntry, MapNode, MapResponse, PairEvent } from "../api";
import type { BubbleNode, RootsLimit } from "./types";

export type NodeSet = Map<string, BubbleNode>;

export const fromMapCoin = (c: MapCoin, parentMint: string | null): BubbleNode => ({
  mint: c.mint, parentMint, depth: c.depth, name: c.name ?? null, symbol: c.symbol ?? null, image: c.image ?? null,
  mcapUsd: c.mcapUsd ?? null, lockedUsd: c.lockedUsd ?? null, children: c.children ?? 0, descendants: c.descendants ?? 0, migrated: !!c.migrated,
  ours: !!c.ours, createdAt: c.createdAt ?? null, updatedAt: c.updatedAt,
});

/// Both wire shapes (§11.5) flattened to one list. A tree node's parent is the node above it; a flat
/// entry carries `parentMint` itself (a depth-0 entry without one is a root).
export function normalise(res: MapResponse): { nodes: BubbleNode[]; removed: string[]; generatedAt: number | null; tree: boolean } {
  const out: BubbleNode[] = [];
  const walk = (n: MapNode, parentMint: string | null) => { out.push(fromMapCoin(n.coin, parentMint)); for (const k of n.children ?? []) walk(k, n.coin.mint); };
  if (Array.isArray(res.roots)) for (const r of res.roots) walk(r, null);
  const flat = Array.isArray(res.nodes) ? res.nodes : Array.isArray(res.updated) ? res.updated : [];
  for (const c of flat) out.push(fromMapCoin(c, c.parentMint ?? (c.depth === 0 ? null : null)));
  const generatedAt = typeof res.generatedAt === "number" && Number.isFinite(res.generatedAt) ? res.generatedAt : null;
  return { nodes: out, removed: Array.isArray(res.removed) ? res.removed.filter((m) => typeof m === "string") : [], generatedAt, tree: Array.isArray(res.roots) };
}

const sameNode = (a: BubbleNode, b: BubbleNode) =>
  a.parentMint === b.parentMint && a.depth === b.depth && a.name === b.name && a.symbol === b.symbol && a.image === b.image &&
  a.mcapUsd === b.mcapUsd && a.lockedUsd === b.lockedUsd && a.children === b.children && (a.descendants ?? 0) === (b.descendants ?? 0) &&
  a.migrated === b.migrated && !!a.ours === !!b.ours;

/// Upserts into `set`, keeping the object identity of unchanged nodes (BubbleMap diffs by reference)
/// and the cached position of a changed one. Returns the records that changed (what to persist).
export function upsert(set: NodeSet, incoming: BubbleNode[]): BubbleNode[] {
  const changed: BubbleNode[] = [];
  for (const n of incoming) {
    const cur = set.get(n.mint);
    if (cur && sameNode(cur, n)) { if (n.updatedAt && n.updatedAt !== cur.updatedAt) cur.updatedAt = n.updatedAt; continue; }
    // A delta row without a parent for a non-root keeps the parent the client already knows.
    const merged: BubbleNode = cur ? { ...cur, ...n, parentMint: n.parentMint ?? cur.parentMint, x: cur.x, y: cur.y } : n;
    set.set(n.mint, merged);
    changed.push(merged);
  }
  return changed;
}

export function remove(set: NodeSet, mints: string[]): number { let k = 0; for (const m of mints) if (set.delete(m)) k++; return k; }

/// `mapdelta`: numbers and (when the server sends them) name/image patches. Rows for unknown mints are ignored.
export function applyDelta(set: NodeSet, entries: MapDeltaEntry[]): BubbleNode[] {
  const changed: BubbleNode[] = [];
  for (const e of entries) {
    const cur = set.get(e.mint);
    if (!cur) continue;
    const next: BubbleNode = { ...cur, mcapUsd: e.mcapUsd ?? cur.mcapUsd, lockedUsd: e.lockedUsd ?? cur.lockedUsd, children: e.children ?? cur.children, descendants: e.descendants ?? cur.descendants, migrated: e.migrated ?? cur.migrated };
    if (e.name !== undefined && e.name !== null) next.name = e.name;
    if (e.symbol !== undefined && e.symbol !== null) next.symbol = e.symbol;
    if (e.image !== undefined && e.image !== null) next.image = e.image;
    if (sameNode(cur, next)) continue;
    set.set(e.mint, next);
    changed.push(next);
  }
  return changed;
}

/// `pair`: the child, and its parent when the map does not hold it yet (a root seen for the first time).
/// Every ancestor the set holds counts the newcomers at once (the direct parent's `children` too), so a
/// root's descendant count is right before the next `mapdelta` carries the server's numbers.
export function applyPair(set: NodeSet, p: PairEvent): BubbleNode[] {
  const out: BubbleNode[] = [];
  const parentMint = p.parent?.mint ?? p.coin.parentMint ?? null;
  const parent = parentMint ? set.get(parentMint) : undefined;
  const childIsNew = !!p.coin.mint && !set.has(p.coin.mint);
  // `added` nodes join the subtree of `anc`; `anc` is their nearest ancestor already in the set
  let added = childIsNew ? 1 : 0;
  let anc: BubbleNode | undefined = parent;
  if (p.parent?.mint && !parent) {
    out.push(fromMapCoin(p.parent, p.parent.parentMint ?? null));
    added++;
    anc = p.parent.parentMint ? set.get(p.parent.parentMint) : undefined;
  }
  if (added && anc) {
    const seen = new Set<string>();
    for (let cur: BubbleNode | undefined = anc, first = true, hops = 0; cur && !seen.has(cur.mint) && hops < 32; hops++, first = false) {
      seen.add(cur.mint);
      // the direct parent of the topmost newcomer gains a child; everything above only descendants
      out.push({ ...cur, children: cur.children + (first ? 1 : 0), descendants: (cur.descendants ?? 0) + added });
      cur = cur.parentMint ? set.get(cur.parentMint) : undefined;
    }
  }
  out.push(fromMapCoin(p.coin, parentMint));
  return upsert(set, out);
}

/// Server order for roots (api.mjs `cmp`): locked, then mcap, then descendants.
export const rootCmp = (a: BubbleNode, b: BubbleNode) => (b.lockedUsd ?? -1) - (a.lockedUsd ?? -1) || (b.mcapUsd ?? -1) - (a.mcapUsd ?? -1) || (b.descendants ?? 0) - (a.descendants ?? 0);

/// A root is a node whose parent the set does not hold (depth 0, or an orphaned subtree).
export const isRoot = (n: BubbleNode, set: NodeSet) => !n.parentMint || !set.has(n.parentMint);

/// The nodes drawn for a roots limit: everything, or the subtrees of the top-n roots. Orphans whose
/// parent is missing are kept under their own root so nothing silently disappears.
export function selectView(set: NodeSet, limit: RootsLimit): BubbleNode[] {
  const all = Array.from(set.values());
  if (limit === "all") return all;
  const roots = all.filter((n) => isRoot(n, set)).sort(rootCmp).slice(0, limit);
  const keep = new Set(roots.map((r) => r.mint));
  const rootOf = new Map<string, string | null>();
  const top = (n: BubbleNode): string | null => {
    const hit = rootOf.get(n.mint);
    if (hit !== undefined) return hit;
    let cur: BubbleNode | undefined = n; let hops = 0;
    while (cur.parentMint && set.has(cur.parentMint) && hops++ < 8) cur = set.get(cur.parentMint)!;
    const r = cur.mint;
    rootOf.set(n.mint, r);
    return r;
  };
  return all.filter((n) => { const r = top(n); return r !== null && keep.has(r); });
}

/// Dev stress: clones root subtrees with synthetic mints until the set holds `target` nodes. Images are
/// dropped on clones so the proxy is not hammered; names keep a suffix so labels stay distinct.
export function stress(set: NodeSet, target: number): BubbleNode[] {
  const all = Array.from(set.values());
  const out = all.slice();
  const roots = all.filter((n) => isRoot(n, set)).sort(rootCmp);
  if (!roots.length) return out;
  const kids = new Map<string, BubbleNode[]>();
  for (const n of all) if (n.parentMint) { const g = kids.get(n.parentMint); if (g) g.push(n); else kids.set(n.parentMint, [n]); }
  let round = 0;
  while (out.length < target) {
    round++;
    for (const r of roots) {
      if (out.length >= target) break;
      const sfx = `#s${round}`;
      const walk = (n: BubbleNode, parentMint: string | null) => {
        if (out.length >= target) return;
        out.push({ ...n, mint: n.mint + sfx, parentMint, image: null, symbol: n.symbol ? `${n.symbol}${round}` : null, x: undefined, y: undefined });
        for (const k of kids.get(n.mint) ?? []) walk(k, n.mint + sfx);
      };
      walk(r, null);
    }
    if (round > 500) break;
  }
  return out;
}
