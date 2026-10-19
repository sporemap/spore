// Structure-of-arrays store for the bubbles: typed arrays the draw loop and the worker share by index,
// a parallel `data` array with the BubbleNode records, and derived structures (draw order, parent
// links, child adjacency, root clusters with their hulls and title anchors) rebuilt only when the node
// set changes. Positions come from the worker as `nx/ny`; `px/py` is the previous frame and `x/y` the
// interpolated position the frame draws, so a 50 ms worker tick still moves bubbles smoothly at 60 fps.
// Per-node render caches (last sprite, label bitmap, letter) live here too, so a store rebuild drops
// them together with the indices they belong to.
import { packSiblings, polygonHull } from "d3";
import { count as fmtCount } from "../../lib/format";
import type { BubbleNode, SizeMode } from "../../lib/map/types";

// Depth palette: root lime, d1 mint, d2 violet, d3+ amber. Same order as the DepthBadge so a colour
// means one thing everywhere on the site.
export const COLORS = ["#b6ff5c", "#5ce0c8", "#b08cff", "#ffcf5c"];
export const colorIdx = (depth: number) => Math.min(depth, COLORS.length - 1);
/// One neutral hull tint for every tree (the depth colours stay reserved for depth, and a single
/// tint passes colour-blind checks); the active tree is drawn lime instead.
export const HULL = "#a8c4b0";
/// F_MATCH is meaningful only while the draw state's `highlight` is on; F_MIG = graduated (PumpSwap).
export const F_OURS = 1, F_ANC = 2, F_FOCUS = 4, F_FIXED = 8, F_MATCH = 16, F_MIG = 32;
/// Hull glows only for this many clusters (the largest); the rest are drawn without a blob.
export const BIG_CLUSTERS = 60;
/// Clusters with fewer members than this get no title at overview zoom.
export const TITLE_MIN = 3;

export type Cluster = {
  id: string; cx: number; cy: number; R: number; hue: string; members: number[]; maxR: number; hull: Float32Array; hullN: number; big: boolean;
  /// Root node index, member count, title text (`$TICK · 716`), Σ mcap, title rank (count; ties by the root's locked value).
  root: number; title: string; count: number; mcapSum: number; score: number;
  /// Title / hit anchors in world units, refreshed on worker frames: centroid, enclosing radius, top edge.
  ccx: number; ccy: number; cr: number; minY: number;
  /// Anchors seeded once (the EMA smoothing starts from the first measurement, not from 0).
  anchored: boolean;
  /// Title bitmaps (draw.ts), valid while tspText === title.
  tsp?: HTMLCanvasElement | null; tspA?: HTMLCanvasElement | null; tspText?: string; tspW?: number; tspC?: boolean;
};
/// Per-node render cache rings: once this many logo sprites / label bitmaps exist, the oldest is dropped.
export const SPR_RING = 6000, LABEL_RING = 3000;

// A leaf locks nothing, so in "locked" mode it is drawn by a slice of its market cap: visible, but
// never bigger than the coins that actually hold value in their curves.
export const valueOf = (d: BubbleNode, mode: SizeMode): number | null => {
  if (mode === "mcap") return d.mcapUsd;
  if (d.lockedUsd != null && d.lockedUsd > 0) return d.lockedUsd;
  return d.mcapUsd != null ? d.mcapUsd * 0.15 : null;
};

export const letterOf = (symbol: string | null, name: string | null) => (symbol || name || "?").replace(/^\$/, "").slice(0, 1).toUpperCase();
/// Ticker when there is one, else the on-chain name (never a bare mint when the coin has a name).
export const labelOf = (symbol: string | null, name: string | null, mint: string) => symbol ? `$${symbol.replace(/^\$/, "")}` : name ? (name.length > 14 ? `${name.slice(0, 13)}…` : name) : `${mint.slice(0, 4)}…`;

/// EMA weight for title anchors while the layout settles (titles glide instead of jittering).
const ANCHOR_EMA = 0.35;

export class MapStore {
  n = 0; cap = 0;
  ids: string[] = []; data: BubbleNode[] = []; idx = new Map<string, number>();
  x = new Float32Array(0); y = new Float32Array(0); px = new Float32Array(0); py = new Float32Array(0); nx = new Float32Array(0); ny = new Float32Array(0);
  r = new Float32Array(0); rT = new Float32Array(0); r0 = new Float32Array(0); rt0 = new Float64Array(0);
  born = new Float64Array(0); pulse = new Float64Array(0);
  depth = new Uint8Array(0); color = new Uint8Array(0); flags = new Uint8Array(0); gen = new Uint16Array(0);
  parent = new Int32Array(0); cluster = new Int32Array(0); rel = new Uint8Array(0);
  /// Live activity: epoch ms of the node's last trade (0 = none) and trades in the last hour (saturating).
  lastTrade = new Float64Array(0); t1h = new Uint16Array(0);
  order = new Int32Array(0);
  m = 0; lsrc = new Int32Array(0); ldst = new Int32Array(0); lseed = new Float32Array(0);
  childStart = new Int32Array(1); childList = new Int32Array(0);
  clusters: Cluster[] = []; clusterOf = new Map<string, number>();
  /// Cluster indices with ≥ TITLE_MIN members, best title first.
  titleOrder = new Int32Array(0);
  // ---- render caches (draw.ts owns their meaning; reset with the store)
  /// The node's last logo sprite, its radius bucket, the image object and gen it was built from, and its flag bits.
  spr: (HTMLCanvasElement | null)[] = []; sprRi = new Uint16Array(0); sprImg: (CanvasImageSource | null)[] = []; sprGen = new Uint16Array(0); sprBits = new Uint8Array(0);
  /// Label bitmap per node, the record it was built for and its variant (0 normal, 1 big, 2 focus).
  labelSp: (HTMLCanvasElement | null)[] = []; labelOwner: (BubbleNode | null)[] = []; labelVariant = new Uint8Array(0);
  /// First letter (char code) for the letter avatar, valid while letterOwner[i] === data[i].
  letter = new Uint16Array(0); letterOwner: (BubbleNode | null)[] = [];
  /// Eviction rings for the two per-node bitmap caches above (node indices, -1 = empty).
  sprRing = new Int32Array(SPR_RING).fill(-1); sprRingW = 0; labelRing = new Int32Array(LABEL_RING).fill(-1); labelRingW = 0;
  // worker frame interpolation
  tickAt = 0; tickDt = 40; settled = true; alpha = 0; tweening = false; maxR = 1;

  grow(min: number) {
    if (min <= this.cap) return;
    const cap = Math.max(min, Math.ceil(this.cap * 1.5), 256);
    const f32 = (a: Float32Array) => { const b = new Float32Array(cap); b.set(a); return b; };
    const f64 = (a: Float64Array) => { const b = new Float64Array(cap); b.set(a); return b; };
    this.x = f32(this.x); this.y = f32(this.y); this.px = f32(this.px); this.py = f32(this.py); this.nx = f32(this.nx); this.ny = f32(this.ny);
    this.r = f32(this.r); this.rT = f32(this.rT); this.r0 = f32(this.r0); this.rt0 = f64(this.rt0); this.born = f64(this.born); this.pulse = f64(this.pulse);
    this.lastTrade = f64(this.lastTrade);
    const u8 = (a: Uint8Array) => { const b = new Uint8Array(cap); b.set(a); return b; };
    this.depth = u8(this.depth); this.color = u8(this.color); this.flags = u8(this.flags); this.rel = u8(this.rel);
    this.sprBits = u8(this.sprBits); this.labelVariant = u8(this.labelVariant);
    const u16 = (a: Uint16Array) => { const b = new Uint16Array(cap); b.set(a); return b; };
    this.gen = u16(this.gen); this.t1h = u16(this.t1h); this.sprRi = u16(this.sprRi); this.sprGen = u16(this.sprGen); this.letter = u16(this.letter);
    const i32 = (a: Int32Array) => { const b = new Int32Array(cap); b.set(a); return b; };
    this.parent = i32(this.parent); this.cluster = i32(this.cluster);
    // object arrays stay packed (no holes): the draw loop reads them for every visible node
    for (let i = this.spr.length; i < cap; i++) { this.spr.push(null); this.sprImg.push(null); this.labelSp.push(null); this.labelOwner.push(null); this.letterOwner.push(null); }
    this.cap = cap;
  }

  /// Appends a node at (x, y) with radius r. Links/adjacency/order are rebuilt by the caller afterwards.
  add(d: BubbleNode, x: number, y: number, r: number, now: number, flags = 0): number {
    const i = this.n;
    this.grow(i + 1);
    this.ids[i] = d.mint; this.data[i] = d; this.idx.set(d.mint, i);
    this.x[i] = this.px[i] = this.nx[i] = x; this.y[i] = this.py[i] = this.ny[i] = y;
    this.r[i] = this.rT[i] = this.r0[i] = r; this.rt0[i] = 0;
    this.born[i] = now; this.pulse[i] = 0;
    this.depth[i] = Math.min(255, d.depth); this.color[i] = colorIdx(d.depth); this.flags[i] = flags | (d.ours ? F_OURS : 0) | (d.migrated ? F_MIG : 0); this.gen[i] = 0;
    this.parent[i] = -1; this.cluster[i] = -1; this.rel[i] = 0;
    this.lastTrade[i] = 0; this.t1h[i] = 0;
    this.spr[i] = null; this.sprImg[i] = null; this.sprRi[i] = 0; this.sprGen[i] = 0; this.sprBits[i] = 0;
    this.labelSp[i] = null; this.labelOwner[i] = null; this.labelVariant[i] = 0; this.letter[i] = 0; this.letterOwner[i] = null;
    this.n = i + 1;
    return i;
  }

  /// Letter avatar char code for node i (cached per record; the data effect swaps records on change).
  letterCode(i: number): number {
    const d = this.data[i];
    if (this.letterOwner[i] !== d) { this.letterOwner[i] = d; this.letter[i] = letterOf(d.symbol, d.name).charCodeAt(0) || 63; }
    return this.letter[i];
  }

  /// Parent indices and the link arrays, from the records' parentMint.
  rebuildLinks() {
    const n = this.n;
    let m = 0;
    for (let i = 0; i < n; i++) { const p = this.data[i].parentMint; const pi = p ? this.idx.get(p) : undefined; this.parent[i] = pi === undefined || pi === i ? -1 : pi; if (this.parent[i] >= 0) m++; }
    if (this.lsrc.length < m) { this.lsrc = new Int32Array(m + (m >> 2) + 64); this.ldst = new Int32Array(this.lsrc.length); const s = new Float32Array(this.lsrc.length); for (let i = 0; i < s.length; i++) s[i] = Math.random(); this.lseed = s; }
    let k = 0;
    for (let i = 0; i < n; i++) if (this.parent[i] >= 0) { this.lsrc[k] = this.parent[i]; this.ldst[k] = i; k++; }
    this.m = k;
    // CSR child lists (hover highlighting, side panel chips)
    const start = new Int32Array(n + 1);
    for (let i = 0; i < n; i++) if (this.parent[i] >= 0) start[this.parent[i] + 1]++;
    for (let i = 0; i < n; i++) start[i + 1] += start[i];
    const list = new Int32Array(Math.max(1, start[n]));
    const fill = start.slice();
    for (let i = 0; i < n; i++) if (this.parent[i] >= 0) list[fill[this.parent[i]]++] = i;
    this.childStart = start; this.childList = list;
  }

  /// Draw order: small first so big bubbles and their labels sit on top. Rebuilt when radii settle.
  rebuildOrder() {
    const n = this.n;
    if (this.order.length !== n) this.order = new Int32Array(n);
    const o = this.order;
    for (let i = 0; i < n; i++) o[i] = i;
    const rT = this.rT;
    // a typed array sort with a comparator is fine at 20k (~6 ms) and happens on data changes only
    o.sort((a, b) => rT[a] - rT[b]);
    let mx = 1; for (let i = 0; i < n; i++) if (rT[i] > mx) mx = rT[i];
    this.maxR = mx;
  }

  rootOf(i: number): number { let cur = i, hops = 0; while (this.parent[cur] >= 0 && hops++ < 16) cur = this.parent[cur]; return cur; }

  /// Clusters = root subtrees. Existing clusters keep their centre; new roots get a centre on the
  /// periphery of the packed arrangement (a fresh root is one bubble and must not shove the rest).
  rebuildClusters(pack: boolean, aspect: number) {
    const n = this.n;
    const groups = new Map<number, number[]>();
    for (let i = 0; i < n; i++) { const r = this.rootOf(i); const g = groups.get(r); if (g) g.push(i); else groups.set(r, [i]); }
    const prev = new Map(this.clusters.map((c) => [c.id, c]));
    const next: Cluster[] = [];
    for (const [root, members] of groups) {
      const id = this.ids[root];
      const old = prev.get(id);
      let sum = 0, maxR = 0, mcapSum = 0;
      for (const i of members) { const r = this.rT[i]; sum += (r + 6) ** 2; if (r > maxR) maxR = r; const mc = this.data[i].mcapUsd; if (mc != null && Number.isFinite(mc)) mcapSum += mc; }
      const R = Math.sqrt(sum) * 1.15 + 10;
      const d = this.data[root];
      const title = `${labelOf(d.symbol, d.name, d.mint)} · ${fmtCount(members.length)}`;
      const c: Cluster = old
        ? Object.assign(old, { R, members, maxR, hullN: 0, root, title, count: members.length, mcapSum, score: members.length })
        : { id, cx: NaN, cy: NaN, R, hue: HULL, members, maxR, hull: new Float32Array(0), hullN: 0, big: false, root, title, count: members.length, mcapSum, score: members.length, ccx: 0, ccy: 0, cr: 0, minY: 0, anchored: false };
      if (c.hull.length < members.length * 2 + 2) c.hull = new Float32Array(members.length * 2 + 64);
      next.push(c);
    }
    next.sort((a, b) => b.members.length - a.members.length || b.R - a.R);
    next.forEach((c, i) => { c.big = i < BIG_CLUSTERS; });
    if (pack) {
      const circles = next.map((c) => ({ c, r: c.R, x: 0, y: 0 }));
      packSiblings(circles);
      const stretch = Math.min(1.6, aspect >= 1 ? aspect : 1 / aspect);
      for (const o of circles) { o.c.cx = aspect >= 1 ? o.x * stretch : o.x; o.c.cy = aspect >= 1 ? o.y : o.y * stretch; }
    } else {
      // periphery placement for clusters without a centre: golden-angle spiral outside the current extent
      let ext = 0; for (const c of next) if (Number.isFinite(c.cx)) ext = Math.max(ext, Math.hypot(c.cx, c.cy) + c.R);
      let k = 0;
      for (const c of next) if (!Number.isFinite(c.cx)) { const a = k * 2.399963; const d = ext + c.R + 20 + k * 2; c.cx = Math.cos(a) * d; c.cy = Math.sin(a) * d; k++; }
    }
    this.clusters = next;
    this.clusterOf = new Map(next.map((c, i) => [c.id, i]));
    for (const c of next) { const ci = this.clusterOf.get(c.id)!; for (const i of c.members) this.cluster[i] = ci; }
    // title ranking: member count, ties by the root's locked value
    const ranked: number[] = [];
    for (let ci = 0; ci < next.length; ci++) if (next[ci].count >= TITLE_MIN) ranked.push(ci);
    const lockedOf = (ci: number) => this.data[next[ci].root].lockedUsd ?? 0;
    ranked.sort((a, b) => next[b].score - next[a].score || lockedOf(b) - lockedOf(a));
    this.titleOrder = Int32Array.from(ranked);
  }

  /// Hull polygons of the big clusters and the title anchors of every cluster, in world units, into
  /// preallocated arrays. Called on worker frames (every few while settling, once when settled), never
  /// per drawn frame. While the layout settles the anchors are smoothed so titles glide.
  refreshHulls() {
    const { nx, ny, rT } = this;
    const ema = !this.settled;
    for (const c of this.clusters) {
      // anchors: centroid, enclosing radius, top edge (O(members))
      const mem = c.members, mn = mem.length;
      let sx = 0, sy = 0, k = 0;
      for (let q = 0; q < mn; q++) { const i = mem[q], x = nx[i], y = ny[i]; if (x === x && y === y) { sx += x; sy += y; k++; } }
      if (k) {
        const cx = sx / k, cy = sy / k;
        let cr = 0, minY = Infinity;
        for (let q = 0; q < mn; q++) { const i = mem[q], x = nx[i], y = ny[i]; if (x !== x || y !== y) continue; const dx = x - cx, dy = y - cy, d = Math.sqrt(dx * dx + dy * dy) + rT[i]; if (d > cr) cr = d; const top = y - rT[i]; if (top < minY) minY = top; }
        if (ema && c.anchored) { c.ccx += (cx - c.ccx) * ANCHOR_EMA; c.ccy += (cy - c.ccy) * ANCHOR_EMA; c.cr += (cr - c.cr) * ANCHOR_EMA; c.minY += (minY - c.minY) * ANCHOR_EMA; }
        else { c.ccx = cx; c.ccy = cy; c.cr = cr; c.minY = minY; c.anchored = true; }
      }
      if (!c.big) { c.hullN = 0; continue; }
      const pts: [number, number][] = [];
      let maxR = 0;
      for (const i of c.members) { pts.push([nx[i], ny[i]]); if (rT[i] > maxR) maxR = rT[i]; }
      c.maxR = maxR;
      const hull = pts.length >= 3 ? polygonHull(pts) ?? pts : pts;
      if (c.hull.length < hull.length * 2) c.hull = new Float32Array(hull.length * 2 + 64);
      for (let q = 0; q < hull.length; q++) { c.hull[q * 2] = hull[q][0]; c.hull[q * 2 + 1] = hull[q][1]; }
      c.hullN = hull.length;
    }
  }

  /// Marks the hovered node and its parent/children for the highlight pass; clears the previous mark.
  setRelated(prev: number, cur: number) {
    const mark = (i: number, v: number) => { if (i < 0) return; this.rel[i] = v; const p = this.parent[i]; if (p >= 0) this.rel[p] = v; for (let k = this.childStart[i]; k < this.childStart[i + 1]; k++) this.rel[this.childList[k]] = v; };
    mark(prev, 0); mark(cur, 1);
  }

  /// Settled positions for the cache. Allocates (one object per node): called when the layout settles, not per frame.
  positions(): { mint: string; x: number; y: number }[] {
    return Array.from({ length: this.n }, (_, i) => ({ mint: this.ids[i], x: Math.round(this.nx[i] * 10) / 10, y: Math.round(this.ny[i] * 10) / 10 }));
  }
}
