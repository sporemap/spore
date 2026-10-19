// Bubble sizes on the forest map (DESIGN §11.5, owner 2026-10-19: "in Bubblemaps a holder with 10 % is
// drawn much bigger than the rest; here the root coins are lost in the middle of their families").
//
// Area is proportional to weight, on one scale for the whole map so trees stay comparable:
// - a coin's weight is its own value in the size mode (valueOf);
// - a family top (a node with no parent on the map: a SOL root, or a listed asset such as $PUMP that
//   coins are quoted in) weighs its WHOLE family, its own value plus every descendant's, so it is the
//   biggest bubble of its tree and its size says how big the tree is next to the others.
// Clamps: every bubble is at least `floor`; a top is at least TOP_RATIO × its largest member and at
// least floor × (TOP_MIN + TOP_LOG · log10(members)), so a crowded family whose coins hold almost
// nothing still has a visible centre. The scale's top end (`rangeR`, the radius of the heaviest weight)
// is TOP_GROW × the base largest radius (maxR), capped so that weight's bubble stays within FIT_SHARE
// of the viewport at fit zoom (estimated from the packed area of everything else).
// Pure functions over the node list (no DOM): the data effect calls them once per data change.
import type { BubbleNode, SizeMode } from "./types";

/// The heaviest weight's radius as a multiple of the base largest radius (before the fit cap).
export const TOP_GROW = 4;
/// A top is at least this many times as wide as its largest member (a hair over 1.5 so float32
/// radii never read below it).
export const TOP_RATIO = 1.52;
/// A top's floor: floor × (TOP_MIN + TOP_LOG · log10(members)) (2 members ≈ 1.8×, 100 = 3.3×, 700 ≈ 4.1×).
export const TOP_MIN = 1.5, TOP_LOG = 0.9;
/// The heaviest bubble's diameter at fit zoom stays within about this share of the viewport.
export const FIT_SHARE = 0.22;
/// The viewport's shorter side at fit zoom, in world units, per sqrt(Σ (r + 6)²) of the bubbles
/// (cluster padding, packing gaps, aspect stretch, insets): 3.3 at 1440×900 and 3.0 at 390×844 on the
/// full map (16.5 k coins, 2026-10-19). The heaviest radius R stays ≤ FIT_SHARE / 2 × that side.
const EXTENT_PER_SQRT_AREA = 2.9;

// A leaf locks nothing, so in "locked" mode it is drawn by a slice of its market cap: visible, but
// never bigger than the coins that actually hold value in their curves.
export const valueOf = (d: BubbleNode, mode: SizeMode): number | null => {
  if (mode === "mcap") return d.mcapUsd;
  if (d.lockedUsd != null && d.lockedUsd > 0) return d.lockedUsd;
  // A small, capped slice: a big market cap with nothing locked under it must not outweigh trees that
  // actually lock value (a 3-coin family with a $31M top drew bigger than the 1,300-coin $PUMP family).
  return d.mcapUsd != null ? Math.min(d.mcapUsd * 0.02, 500) : null;
};

/// Family structure of a node list, by position: parent (-1 = none on the map), family top (the same
/// walk as MapStore.rootOf: at most 16 hops), member count at each top's position, and the tops
/// themselves (a top has at least one member besides itself).
export type Families = { parent: Int32Array; top: Int32Array; members: Uint32Array; isTop: Uint8Array };
export function families(nodes: readonly BubbleNode[]): Families {
  const n = nodes.length, at = new Map<string, number>();
  for (let q = 0; q < n; q++) at.set(nodes[q].mint, q);
  const parent = new Int32Array(n), top = new Int32Array(n), members = new Uint32Array(n), isTop = new Uint8Array(n);
  for (let q = 0; q < n; q++) { const p = nodes[q].parentMint, pq = p ? at.get(p) : undefined; parent[q] = pq === undefined || pq === q ? -1 : pq; }
  for (let q = 0; q < n; q++) { let cur = q, hops = 0; while (parent[cur] >= 0 && hops++ < 16) cur = parent[cur]; top[q] = cur; members[cur]++; }
  for (let q = 0; q < n; q++) isTop[q] = top[q] === q && members[q] > 1 ? 1 : 0;
  return { parent, top, members, isTop };
}

/// Weight per node in `mode`: its own value, or for a top the sum over its family (own value
/// included). NaN = no value known (not a top).
export function familyWeights(nodes: readonly BubbleNode[], fam: Families, mode: SizeMode): Float64Array {
  const n = nodes.length, own = new Float64Array(n), sum = new Float64Array(n);
  for (let q = 0; q < n; q++) {
    const v = valueOf(nodes[q], mode);
    own[q] = v == null || !Number.isFinite(v) ? NaN : Math.max(0, v);
    if (own[q] > 0) sum[fam.top[q]] += own[q];
  }
  for (let q = 0; q < n; q++) if (fam.isTop[q]) own[q] = sum[q];
  return own;
}

/// The scale: `maxW` = the heaviest weight, drawn at radius `rangeR`; `floor` = the smallest radius;
/// `maxR` = the base largest radius (a coin with no known value is drawn at 0.4 × it).
export type SizeScale = { maxW: number; rangeR: number; floor: number; maxR: number };

/// Radius per node (world units) for weights `w` on scale `sc`.
export function familyRadii(fam: Families, w: Float64Array, sc: SizeScale): Float32Array {
  const n = w.length, r = new Float32Array(n), biggest = new Float32Array(n);
  const k = sc.rangeR / Math.sqrt(Math.max(1e-9, sc.maxW));
  for (let q = 0; q < n; q++) {
    if (fam.isTop[q]) continue;
    const v = w[q];
    r[q] = v !== v ? sc.maxR * 0.4 : Math.max(sc.floor, Math.sqrt(v) * k);
    const t = fam.top[q];
    if (t !== q && r[q] > biggest[t]) biggest[t] = r[q];
  }
  for (let q = 0; q < n; q++) {
    if (!fam.isTop[q]) continue;
    r[q] = Math.max(Math.sqrt(w[q]) * k, sc.floor * (TOP_MIN + TOP_LOG * Math.log10(fam.members[q])), TOP_RATIO * biggest[q]);
  }
  return r;
}

/// The scale's top end for these weights: TOP_GROW × maxR, lowered (never below maxR) so the heaviest
/// bubble stays within FIT_SHARE of the viewport at fit, from the packed area of every other bubble.
export function rangeFor(fam: Families, w: Float64Array, base: { maxW: number; floor: number; maxR: number }): number {
  const hi = base.maxR * TOP_GROW;
  const r = familyRadii(fam, w, { ...base, rangeR: hi });
  let heavy = -1, hw = -Infinity;
  for (let q = 0; q < w.length; q++) if (w[q] > hw) { hw = w[q]; heavy = q; }
  let area = 0;
  for (let q = 0; q < r.length; q++) if (q !== heavy) area += (r[q] + 6) ** 2;
  const cap = (FIT_SHARE / 2) * EXTENT_PER_SQRT_AREA * Math.sqrt(area);
  return Math.max(base.maxR, Math.min(hi, cap));
}
