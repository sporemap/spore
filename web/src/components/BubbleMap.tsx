// Bubblemaps-style force map on a canvas, built for the whole pump.fun pair tree (DESIGN §11.5).
//
// Architecture (performance budget: ≤ 16 ms/frame settled, ≤ 33 ms settling at 20 k nodes):
// - Layout: d3-force runs in a Web Worker (map/layout.worker.ts). The main thread sends typed arrays
//   once (positions, radii, cluster centres, parent links) and receives positions back as transferred
//   Float32Arrays; buffers are returned after each frame, so steady state allocates nothing on either
//   side. The draw loop interpolates between the last two worker frames, so a 50 ms worker tick at
//   20 k nodes still moves bubbles at 60 fps. Clusters are placed once with d3.packSiblings (one circle
//   per root); a root that arrives later gets a spot on the periphery, never a re-pack.
// - Store: structure-of-arrays (map/store.ts): x/y/r in Float32Arrays, flags/colour/depth in byte
//   arrays, draw order as an Int32Array sorted by radius, CSR child lists for hover highlighting, hull
//   polygons of the 60 largest clusters in preallocated arrays (refreshed on worker frames, not per draw).
// - Draw (map/draw.ts): offscreen culling, three tiers by on-screen radius (specks batched into a
//   few Path2D fills, shared sprites per colour+size, per-node sprites with the glow baked in and the
//   logo once it loads), links batched per colour and skipped into specks, labels from cached bitmaps
//   for every bubble ≥ 9 px (overlap-culled, cap 160), zero per-node allocation.
// - Data changes are diffs: new nodes are placed next to their parent and relaxed with a low alpha,
//   changed values tween radius, and the simulation is never restarted. Cached positions (IndexedDB)
//   make a warm open paint settled bubbles on the first frame.
// - Images: map/images.ts loads lazily by visibility and zoom through /api/img, ≤ 8 in flight, with a
//   failed set; a bubble shows its letter until the logo arrives and swaps without a flicker.
import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from "react";
import { useNavigate } from "react-router-dom";
import { drag, easeCubicOut, pointer, scaleSqrt, select, zoom, zoomIdentity, type D3DragEvent, type D3ZoomEvent, type ZoomTransform } from "d3";
import { api, type MapNode, type TreeNode } from "../lib/api";
import { useAsync } from "../lib/hooks";
import { count, usd } from "../lib/format";
import { imageStats } from "../lib/map/images";
import { DEBUG_HOOKS } from "../lib/map/debug";
import type { BubbleNode, SizeMode } from "../lib/map/types";
import { ErrorBox, Skeleton, nameOf, sym } from "./Bits";
import { draw, fitFor, hitTest, makePerf, TWEEN_MS, type Inset, type State } from "./map/draw";
import { hexA, makeSprites } from "./map/sprites";
import { COLORS, F_ANC, F_FIXED, F_FOCUS, F_OURS, MapStore, colorIdx, valueOf } from "./map/store";
import "./bubblemap.css";

export type { BubbleNode, SizeMode } from "../lib/map/types";
export { COLORS } from "./map/store";
export type FrameStats = { frames: number; settling: { n: number; avg: number; p95: number; max: number }; settled: { n: number; avg: number; p95: number; max: number }; labels: number; drawn: number };
export type BubbleMapHandle = { fit: () => void; focusNode: (mint: string) => void; frameStats: () => FrameStats };
/// `inset` is the screen area overlays cover (the /map stats panel), so "fit" centres the bubbles in what is actually visible.
/// `focus` pins a coin at the centre with its ancestors above (coin page). `select` + `onSelect` turn
/// clicks into a selection (the /map side panel) instead of navigation; the camera glides to a newly
/// selected node and keeps it centred until the layout has settled. `fresh` holds mints that arrived
/// live (pulse ring; the set is drained once drawn); `onLayout` receives settled positions for the cache.
type Props = { nodes: BubbleNode[]; focus?: string; select?: string | null; onSelect?: (n: BubbleNode | null) => void; height: number | string; mode?: SizeMode; onModeChange?: (m: SizeMode) => void; ref?: Ref<BubbleMapHandle>; className?: string; inset?: Inset; fresh?: Set<string>; onLayout?: (pos: { mint: string; x: number; y: number }[]) => void };

/// Flatten /api/tree: the focus coin's ancestors (nearest first) become a chain of nodes above it,
/// so the map can show where the coin hangs from, not only what hangs from it.
export function flattenTree(t: TreeNode): BubbleNode[] {
  const out: BubbleNode[] = [];
  const anc = t.coin.ancestors;
  anc.forEach((a, i) => out.push({ mint: a.mint, parentMint: anc[i + 1]?.mint ?? null, depth: a.depth, name: a.name, symbol: a.symbol, image: a.image, mcapUsd: null, lockedUsd: null, children: 0, migrated: false }));
  const walk = (n: TreeNode, parentMint: string | null) => {
    const c = n.coin;
    out.push({ mint: c.mint, parentMint, depth: c.depth, name: c.name, symbol: c.symbol, image: c.image, mcapUsd: c.mcapUsd, lockedUsd: c.lockedUsd, children: c.children, descendants: c.descendants, migrated: c.migrated, ours: !!c.ours });
    n.children.forEach((k) => walk(k, c.mint));
  };
  walk(t, anc[0]?.mint ?? null);
  return out;
}
export function flattenMap(roots: MapNode[]): BubbleNode[] {
  const out: BubbleNode[] = [];
  const walk = (n: MapNode, parentMint: string | null) => {
    const c = n.coin;
    out.push({ mint: c.mint, parentMint, depth: c.depth, name: c.name, symbol: c.symbol, image: c.image, mcapUsd: c.mcapUsd, lockedUsd: c.lockedUsd, children: c.children, descendants: c.descendants, migrated: c.migrated, ours: !!c.ours });
    n.children.forEach((k) => walk(k, c.mint));
  };
  roots.forEach((r) => walk(r, null));
  return out;
}

const reduced = () => typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
const GOLDEN = 2.399963;
const pct = (arr: Float32Array, n: number, p: number) => { if (!n) return 0; const a = Array.from(arr.subarray(0, Math.min(n, arr.length))).sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(a.length * p))]; };
const stat = (arr: Float32Array, n: number) => { const len = Math.min(n, arr.length); let sum = 0, max = 0; for (let i = 0; i < len; i++) { sum += arr[i]; if (arr[i] > max) max = arr[i]; } return { n, avg: len ? sum / len : 0, p95: pct(arr, n, 0.95), max }; };

type Scale = { maxV: number; maxR: number; floor: number; mode: SizeMode; focus: string | undefined; count: number };

/// Uploads nodes [from, n) and their links to the worker: "init" rebuilds the simulation, "add" appends.
/// Arrays are copies, transferred, so the store keeps its own.
function postLayout(s: State, w: Worker, from: number, type: "init" | "add", alpha: number) {
  const store = s.store;
  const cnt = store.n - from;
  const x = store.nx.slice(from, store.n), y = store.ny.slice(from, store.n), r = store.rT.slice(from, store.n), depth = store.depth.slice(from, store.n);
  const cx = new Float32Array(cnt), cy = new Float32Array(cnt), fixed = new Uint8Array(cnt);
  for (let i = from; i < store.n; i++) { const c = store.clusters[store.cluster[i]]; cx[i - from] = c?.cx ?? 0; cy[i - from] = c?.cy ?? 0; fixed[i - from] = store.flags[i] & F_FIXED ? 1 : 0; }
  const srcL: number[] = [], dstL: number[] = [];
  for (let l = 0; l < store.m; l++) if (type === "init" || store.lsrc[l] >= from || store.ldst[l] >= from) { srcL.push(store.lsrc[l]); dstL.push(store.ldst[l]); }
  const src = Int32Array.from(srcL), dst = Int32Array.from(dstL);
  w.postMessage({ t: type, n: cnt, x, y, r, cx, cy, depth, fixed, src, dst, alpha, focus: !!s.focus, hPx: s.hPx, ancShift: s.hasAnc ? 1 : 0 }, [x.buffer, y.buffer, r.buffer, cx.buffer, cy.buffer, depth.buffer, fixed.buffer, src.buffer, dst.buffer]);
}

export default function BubbleMap({ nodes, focus, select: selectProp, onSelect, height, mode: modeProp = "locked", onModeChange, ref, className = "", inset, fresh, onLayout }: Props) {
  const nav = useNavigate();
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const tipEl = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<SizeMode>(modeProp);
  const [hover, setHover] = useState<number>(-1);
  useEffect(() => setMode(modeProp), [modeProp]);

  // Everything the render loop touches lives in refs: React re-renders only for the tooltip and the
  // small DOM controls, never per frame.
  const st = useRef<State>(null as unknown as State);
  if (!st.current) st.current = { store: new MapStore(), sprites: makeSprites(), mode, t: zoomIdentity, zoom: null, w: 0, h: 0, dpr: 1, hover: -1, pinned: -1, selected: -1, focusIdx: -1, follow: null, raf: 0, visible: true, autoFit: true, focus, static: reduced(), inset, onSelect: undefined, tweenUntil: 0, hullTick: 0, labelRects: new Float32Array(160 * 4), hot: new Int32Array(512), perf: makePerf(), hPx: 600, hasAnc: false };
  st.current.focus = focus; st.current.inset = inset; st.current.mode = mode;
  st.current.onSelect = onSelect ? (i) => onSelect(i >= 0 ? st.current.store.data[i] : null) : undefined;
  const worker = useRef<Worker | null>(null);
  const workerInfo = useRef<{ ticks: number; tickMs: number; frames: number; n: number; alpha: number; settled: boolean; at: number } | null>(null);
  const scale = useRef<Scale | null>(null);
  const layoutSavedAt = useRef(0);
  const onLayoutRef = useRef(onLayout); onLayoutRef.current = onLayout;

  // ---- worker: created once per mount, positions come back as transferred buffers
  useEffect(() => {
    const s = st.current;
    const w = new Worker(new URL("./map/layout.worker.ts", import.meta.url), { type: "module" });
    worker.current = w;
    // a worker that dies would otherwise fail silently: surface it (the perf script fails on console errors)
    w.onerror = (e) => console.error("map layout worker error", e.message, e.filename, e.lineno);
    w.onmessageerror = () => console.error("map layout worker: message could not be deserialised");
    let frames = 0;
    w.onmessage = (ev: MessageEvent<{ t: string; x: Float32Array; y: Float32Array; n: number; alpha: number; settled: boolean; ticks: number; tickMs: number }>) => {
      const m = ev.data;
      if (m.t !== "tick") return;
      workerInfo.current = { ticks: m.ticks, tickMs: m.tickMs, frames: frames + 1, n: m.n, alpha: m.alpha, settled: m.settled, at: performance.now() };
      const store = s.store;
      const n = Math.min(m.n, store.n);
      const now = performance.now();
      if (store.settled) { store.px.set(store.x.subarray(0, n)); store.py.set(store.y.subarray(0, n)); }
      else { store.px.set(store.nx.subarray(0, n)); store.py.set(store.ny.subarray(0, n)); }
      store.nx.set(m.x.subarray(0, n)); store.ny.set(m.y.subarray(0, n));
      const dt = now - store.tickAt;
      store.tickDt = store.tickAt ? Math.min(120, Math.max(8, store.tickDt * 0.6 + dt * 0.4)) : 40;
      store.tickAt = now;
      store.alpha = m.alpha;
      store.settled = m.settled;
      if (m.settled) { store.x.set(store.nx.subarray(0, n)); store.y.set(store.ny.subarray(0, n)); }
      frames++;
      if (m.settled || frames % 3 === 0) store.refreshHulls();
      // Positions go to the cache once the layout is quiet (settled, or nearly: a live stream nudging
      // radii every few seconds must not keep the next open from painting instantly). The worker sends
      // no tick after it settles, so the first settled tick always saves even inside the 10 s window
      // (a cold layout settles ~7 s after navigation; without this the cache held nodes but no positions).
      const due = now - layoutSavedAt.current > 10_000 || (m.settled && !layoutSavedAt.current);
      if ((m.settled || m.alpha < 0.03) && due && store.n && onLayoutRef.current) { layoutSavedAt.current = now; onLayoutRef.current(store.positions()); }
      w.postMessage({ t: "buf", x: m.x, y: m.y }, [m.x.buffer, m.y.buffer]);
    };
    // A populated store (StrictMode double-mount, remount) must reach the new worker too.
    if (s.store.n) { s.store.settled = s.store.settled && true; postLayout(s, w, 0, "init", s.store.settled ? 0 : 0.3); }
    // Leaving the page (route change, reload, tab close) saves the layout so the next open paints it as is.
    const save = () => { if (s.store.n && onLayoutRef.current && s.store.alpha < 0.1) onLayoutRef.current(s.store.positions()); };
    window.addEventListener("pagehide", save);
    return () => { save(); window.removeEventListener("pagehide", save); w.postMessage({ t: "stop" }); w.terminate(); worker.current = null; };
  }, []);

  // ---- data → store (a diff: survivors keep their position, newcomers sit next to their parent)
  useEffect(() => {
    const s = st.current, store = s.store, w = worker.current;
    const now = performance.now();
    if (!s.w && box.current) { const b = box.current.getBoundingClientRect(); s.w = Math.round(b.width); s.h = Math.round(b.height); }
    if (nodes.length && !s.perf.dataAt) s.perf.dataAt = now;
    const hPx = typeof height === "number" ? height : s.h || 600;
    const focusNode = focus ? nodes.find((n) => n.mint === focus) : undefined;
    const hasAnc = !!focusNode && nodes.some((n) => n.depth < focusNode.depth);
    s.hPx = hPx; s.hasAnc = hasAnc;

    // Radius scale: kept across small changes so a live insert does not resize the whole map; recomputed
    // when the mode/focus changes, the set grows a lot, or the largest value moves by more than 15 %.
    let maxV = 1; for (const n of nodes) { const v = valueOf(n, mode) ?? 0; if (v > maxV) maxV = v; }
    const sc = scale.current;
    const rescale = !sc || sc.mode !== mode || sc.focus !== focus || maxV > sc.maxV * 1.15 || maxV < sc.maxV * 0.6 || nodes.length > sc.count * 1.5 || nodes.length < sc.count * 0.6;
    if (rescale) {
      const maxR = focus ? Math.max(18, Math.min(44, hPx / 11)) : Math.max(18, Math.min(52, hPx / (nodes.length > 150 ? 16 : nodes.length > 60 ? 13 : 10)));
      scale.current = { maxV, maxR, floor: nodes.length > 150 ? 5 : 7, mode, focus, count: nodes.length };
    }
    const { maxR, floor } = scale.current!;
    const rScale = scaleSqrt().domain([0, scale.current!.maxV]).range([0, maxR]);
    const radiusOf = (d: BubbleNode) => {
      const v = valueOf(d, mode);
      const anc = !!focusNode && d.depth < focusNode.depth && d.mint !== focus;
      let r = v == null ? maxR * (anc ? 0.55 : 0.4) : Math.max(floor, rScale(v));
      if (d.mint === focus) r = Math.max(r, maxR * 0.85);
      return r;
    };
    const flagsOf = (d: BubbleNode) => (d.ours ? F_OURS : 0) | (focusNode && d.depth < focusNode.depth && d.mint !== focus ? F_ANC : 0) | (d.mint === focus ? F_FOCUS : 0);

    // removals → rebuild the store (rare: roots limit change); positions survive through the records
    const keep = new Set<string>();
    for (const n of nodes) keep.add(n.mint);
    let removed = 0;
    for (let i = 0; i < store.n; i++) if (!keep.has(store.ids[i])) removed++;
    const cold = store.n === 0;
    let hadPositions = 0;
    if (removed) {
      for (let i = 0; i < store.n; i++) { const d = store.data[i]; if (keep.has(d.mint) && store.settled) { d.x = store.nx[i]; d.y = store.ny[i]; } }
      Object.assign(store, new MapStore());
      scale.current = { ...scale.current!, count: nodes.length };
      s.hover = -1; s.pinned = -1; s.selected = -1; setHover(-1);
    }
    const oldN = store.n;
    const added: number[] = [];
    let radiiChanged = 0;
    const idxOf = new Int32Array(nodes.length);
    for (let q = 0; q < nodes.length; q++) {
      const d = nodes[q];
      let i = store.idx.get(d.mint);
      const r = radiusOf(d);
      if (i === undefined) {
        const hasPos = d.x != null && d.y != null && Number.isFinite(d.x) && Number.isFinite(d.y);
        if (hasPos) hadPositions++;
        i = store.add(d, hasPos ? d.x! : NaN, hasPos ? d.y! : NaN, r, 0, flagsOf(d));
        added.push(i);
      } else {
        if (store.data[i] !== d) {
          if (store.data[i].image !== d.image) store.gen[i]++;
          store.data[i] = d;
          store.flags[i] = (store.flags[i] & F_FIXED) | flagsOf(d);
          store.depth[i] = Math.min(255, d.depth); store.color[i] = colorIdx(d.depth);
        }
        if (Math.abs(store.rT[i] - r) > 0.25) { store.r0[i] = store.r[i]; store.rT[i] = r; store.rt0[i] = now; radiiChanged++; }
      }
      idxOf[q] = i;
    }
    if (rescale && !added.length) { for (let i = 0; i < store.n; i++) { const r = radiusOf(store.data[i]); if (Math.abs(store.rT[i] - r) > 0.25) { store.r0[i] = store.r[i]; store.rT[i] = r; store.rt0[i] = now; radiiChanged++; } } }
    if (!store.n) { s.focusIdx = -1; return; }
    const parentChanged = !added.length && nodes.some((d, q) => { const pi = d.parentMint ? store.idx.get(d.parentMint) : undefined; return (pi ?? -1) !== store.parent[idxOf[q]]; });
    if (added.length || parentChanged) store.rebuildLinks();
    s.focusIdx = focus ? store.idx.get(focus) ?? -1 : -1;

    const aspect = Math.max(1, s.w - (inset?.left ?? 0)) / Math.max(1, s.h - (inset?.top ?? 0) - (inset?.bottom ?? 0));
    if (added.length) {
      // Clusters: a cold start packs them; otherwise existing centres stay and new roots go to the rim.
      const allCached = cold && hadPositions === nodes.length;
      store.rebuildClusters(cold && !allCached && !focus, aspect);
      if (allCached || (cold && hadPositions)) {
        // the cached layout decides where clusters are: centres = centroids of what is cached
        for (const c of store.clusters) { let sx = 0, sy = 0, k = 0; for (const i of c.members) if (Number.isFinite(store.nx[i])) { sx += store.nx[i]; sy += store.ny[i]; k++; } if (k) { c.cx = sx / k; c.cy = sy / k; } }
        let ext = 0; for (const c of store.clusters) if (Number.isFinite(c.cx)) ext = Math.max(ext, Math.hypot(c.cx, c.cy) + c.R);
        let q = 0; for (const c of store.clusters) if (!Number.isFinite(c.cx)) { const a = q * GOLDEN; const dd = ext + c.R + 20; c.cx = Math.cos(a) * dd; c.cy = Math.sin(a) * dd; q++; }
      }
      // Initial positions for newcomers: next to the parent when it has one, else a sunflower around
      // the cluster centre (root at the middle, biggest children innermost). The force only polishes.
      const perCluster = new Map<number, number>();
      const stagger = cold && !s.static && !hadPositions;
      for (const i of added) {
        const d = store.data[i];
        const ci = store.cluster[i], c = store.clusters[ci];
        const p = store.parent[i];
        if (Number.isFinite(store.nx[i])) { /* cached */ }
        else if (p >= 0 && Number.isFinite(store.nx[p]) && !cold) {
          const a = Math.random() * Math.PI * 2, dd = store.rT[p] + store.rT[i] + 8;
          store.nx[i] = store.nx[p] + Math.cos(a) * dd; store.ny[i] = store.ny[p] + Math.sin(a) * dd;
        } else if (p < 0 || d.depth === 0) { store.nx[i] = c.cx + (Math.random() - 0.5) * 2; store.ny[i] = c.cy + (Math.random() - 0.5) * 2; }
        else {
          const k = perCluster.get(ci) ?? 0; perCluster.set(ci, k + 1);
          const a = k * GOLDEN, dd = (c.R * 0.9) * Math.sqrt((k + 1) / Math.max(2, c.members.length)) + store.rT[store.rootOf(i)] + 4;
          store.nx[i] = c.cx + Math.cos(a) * dd; store.ny[i] = c.cy + Math.sin(a) * dd;
          if (d.depth >= 2 && p >= 0 && Number.isFinite(store.nx[p])) { store.nx[i] = store.nx[p] + Math.cos(a) * (store.rT[p] + store.rT[i] + 6); store.ny[i] = store.ny[p] + Math.sin(a) * (store.rT[p] + store.rT[i] + 6); }
        }
        store.x[i] = store.px[i] = store.nx[i]; store.y[i] = store.py[i] = store.ny[i];
        store.born[i] = s.static ? 0 : cold ? (stagger ? now + d.depth * 160 + (i % 7) * 40 : 0) : now;
        if (fresh?.has(d.mint)) { store.pulse[i] = now; fresh.delete(d.mint); }
      }
      // focus layout: the coin at the origin, its ancestors stacked upward, all pinned
      if (s.focusIdx >= 0) {
        const f = s.focusIdx; store.nx[f] = store.ny[f] = 0; store.flags[f] |= F_FIXED;
        let up = f, level = 1;
        while (store.parent[up] >= 0) { const a = store.parent[up]; store.nx[a] = 0; store.ny[a] = -(hPx * 0.22) * level; store.flags[a] |= F_FIXED; up = a; level++; }
        for (const i of added) { store.x[i] = store.px[i] = store.nx[i]; store.y[i] = store.py[i] = store.ny[i]; }
      }
      store.rebuildOrder();
      if (w) {
        // warm: cached positions are final (alpha 0); a few newcomers get a gentle relaxation; cold: full settle
        if (cold) { store.settled = hadPositions === nodes.length; postLayout(s, w, 0, "init", hadPositions === nodes.length ? 0 : hadPositions ? 0.06 : 1); }
        else if (removed) { store.settled = true; postLayout(s, w, 0, "init", 0.12); }
        else { store.settled = false; store.tickAt = 0; postLayout(s, w, oldN, "add", Math.min(0.25, 0.06 + added.length * 0.002)); }
      }
      if (cold) { store.refreshHulls(); s.autoFit = !s.follow; }
    } else if (parentChanged) {
      store.rebuildClusters(false, aspect);
      store.rebuildOrder();
    }
    if (radiiChanged) {
      s.tweenUntil = now + TWEEN_MS + 30;
      if (w && !added.length) {
        const idxL: number[] = []; let maxD = 0;
        for (let i = 0; i < store.n; i++) if (store.rt0[i]) { idxL.push(i); const dd = Math.abs(store.rT[i] - store.r0[i]); if (dd > maxD) maxD = dd; }
        const idx = Int32Array.from(idxL), r = new Float32Array(idx.length);
        for (let q = 0; q < idx.length; q++) r[q] = store.rT[idx[q]];
        // A mode change re-sizes everything (real reheat); a live value tick only needs a nudge, and a
        // sub-pixel one needs none: the worker just learns the new collision radii.
        const alpha = rescale ? 0.3 : maxD > 1.5 ? 0.02 : 0;
        if (alpha > 0) { store.settled = false; store.tickAt = 0; }
        w.postMessage({ t: "radius", idx, r, alpha }, [idx.buffer, r.buffer]);
      }
      if (rescale) { for (const c of store.clusters) { let mx = 0; for (const i of c.members) if (store.rT[i] > mx) mx = store.rT[i]; c.maxR = mx; } }
    }
    if (s.hover >= store.n) { s.hover = -1; setHover(-1); }
    if (s.pinned >= store.n) s.pinned = -1;
    if (s.selected >= store.n) s.selected = -1;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, mode, focus, height]);

  // ---- selection from the outside (?focus=<mint>, search, the side panel's child chips)
  useEffect(() => {
    const s = st.current;
    if (!onSelect) return;
    const i = selectProp ? s.store.idx.get(selectProp) ?? -1 : -1;
    if (i === s.selected) return;
    s.selected = i;
    s.pinned = -1;
    if (i >= 0) { s.follow = { i, k: Math.max(s.t.k, Math.min(3, 70 / s.store.rT[i])) }; s.autoFit = false; }
  }, [selectProp, nodes, onSelect]);

  // ---- canvas sizing + zoom/drag behaviours
  useEffect(() => {
    const el = box.current, cv = canvas.current;
    if (!el || !cv) return;
    const s = st.current;
    const resize = () => {
      const r = el.getBoundingClientRect();
      s.w = Math.max(1, Math.round(r.width)); s.h = Math.max(1, Math.round(r.height)); s.dpr = Math.min(2, window.devicePixelRatio || 1);
      cv.width = Math.round(s.w * s.dpr); cv.height = Math.round(s.h * s.dpr);
      if (!s.t || s.t === zoomIdentity) s.t = zoomIdentity.translate(s.w / 2, s.h / 2);
    };
    resize();
    const ro = new ResizeObserver(() => { const w = s.w, h = s.h; resize(); if (w && h) s.t = zoomIdentity.translate(s.t.x + (s.w - w) / 2, s.t.y + (s.h - h) / 2).scale(s.t.k); });
    ro.observe(el);
    const setHov = (i: number) => { if (i !== s.hover) { s.store.setRelated(s.hover, i); s.hover = i; setHover(i); cv.style.cursor = i >= 0 ? "pointer" : "grab"; } };

    const z = zoom<HTMLCanvasElement, unknown>().scaleExtent([0.05, 6])
      .filter((ev: Event & { button?: number; ctrlKey?: boolean }) => { if (ev.type === "wheel") return true; if (ev.type === "mousedown" || ev.type === "touchstart") { const [x, y] = pointer(ev, cv); return !ev.button && hitTest(s, x, y) < 0; } return !ev.button; })
      .on("zoom", (ev: D3ZoomEvent<HTMLCanvasElement, unknown>) => { s.t = ev.transform; if (ev.sourceEvent) { s.autoFit = false; s.follow = null; } });
    s.zoom = z;
    const sel = select(cv);
    sel.call(z).call(z.transform, zoomIdentity.translate(s.w / 2, s.h / 2)).on("dblclick.zoom", null);
    const dg = drag<HTMLCanvasElement, unknown, { i: number; x: number; y: number }>()
      .subject((ev: D3DragEvent<HTMLCanvasElement, unknown, unknown>) => { const i = hitTest(s, ev.x, ev.y); if (i < 0) return null as never; return { i, x: s.store.x[i] * s.t.k + s.t.x, y: s.store.y[i] * s.t.k + s.t.y }; })
      .on("start", (ev) => { const i = ev.subject.i; s.autoFit = false; s.follow = null; el.classList.add("dragging"); const [wx, wy] = s.t.invert([ev.x, ev.y]); worker.current?.postMessage({ t: "drag", i, x: wx, y: wy, phase: "start" }); })
      .on("drag", (ev) => { const i = ev.subject.i; const [wx, wy] = s.t.invert([ev.x, ev.y]); const st = s.store; st.x[i] = st.px[i] = st.nx[i] = wx; st.y[i] = st.py[i] = st.ny[i] = wy; worker.current?.postMessage({ t: "drag", i, x: wx, y: wy, phase: "move" }); })
      .on("end", (ev) => { const i = ev.subject.i; el.classList.remove("dragging"); const st = s.store; worker.current?.postMessage({ t: "drag", i, x: st.nx[i], y: st.ny[i], phase: "end" }); });
    sel.call(dg);

    const move = (ev: MouseEvent) => { const [x, y] = pointer(ev, cv); const i = hitTest(s, x, y); if (i !== s.hover) { s.pinned = -1; setHov(i); } };
    const leave = () => { if (s.hover >= 0 && s.pinned < 0) setHov(-1); cv.style.cursor = "grab"; };
    const click = (ev: MouseEvent) => {
      const [x, y] = pointer(ev, cv); const i = hitTest(s, x, y);
      if (s.onSelect) { s.onSelect(i); return; }
      if (i >= 0 && !(s.store.flags[i] & F_FOCUS)) nav(`/c/${s.store.ids[i]}`);
    };
    const key = (ev: KeyboardEvent) => { if (ev.key === "Escape") { s.pinned = -1; setHov(-1); if (s.onSelect && s.selected >= 0) s.onSelect(-1); } };
    cv.addEventListener("mousemove", move); cv.addEventListener("mouseleave", leave); cv.addEventListener("click", click); el.addEventListener("keydown", key);
    return () => { ro.disconnect(); sel.on(".zoom", null).on(".drag", null); cv.removeEventListener("mousemove", move); cv.removeEventListener("mouseleave", leave); cv.removeEventListener("click", click); el.removeEventListener("keydown", key); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const animateTo = useCallback((t: ZoomTransform, ms = 650) => {
    const s = st.current; const cv = canvas.current; if (!cv || !s.zoom) return;
    s.autoFit = false; s.follow = null;
    if (s.static || ms === 0) select(cv).call(s.zoom.transform, t);
    else select(cv).transition().duration(ms).ease(easeCubicOut).call(s.zoom.transform, t);
  }, []);
  const fit = useCallback(() => { const t = fitFor(st.current, 36); if (t) animateTo(t); }, [animateTo]);
  const scaleBy = useCallback((f: number) => { const s = st.current; animateTo(zoomIdentity.translate(s.w / 2, s.h / 2).scale(s.t.k * f).translate(-(s.w / 2 - s.t.x) / s.t.k, -(s.h / 2 - s.t.y) / s.t.k), 300); }, [animateTo]);
  // Glide to a node and keep it centred while the layout still moves (the follow camera in draw()).
  const focusNode = useCallback((mint: string) => {
    const s = st.current; const i = s.store.idx.get(mint); if (i === undefined) return;
    s.follow = { i, k: Math.max(s.t.k, Math.min(3, 70 / s.store.rT[i])) }; s.autoFit = false;
    if (s.onSelect) { s.selected = i; s.onSelect(i); } else { s.pinned = i; s.store.setRelated(s.hover, i); s.hover = i; setHover(i); }
  }, []);
  const frameStats = useCallback((): FrameStats => { const p = st.current.perf; return { frames: p.frames, settling: stat(p.settling, p.sn), settled: stat(p.settled, p.dn), labels: p.labels, drawn: p.drawn }; }, []);
  useImperativeHandle(ref, () => ({ fit, focusNode, frameStats }), [fit, focusNode, frameStats]);
  // Dev only: lets the headless perf script (web/test/map-perf.mts) read timings and poke the map.
  useEffect(() => {
    if (!DEBUG_HOOKS) return;
    const s = st.current;
    const dbg = {
      frameStats, resetFrames: () => { const p = s.perf; p.sn = p.dn = p.si = p.di = 0; p.max = 0; },
      nodes: () => s.store.n, labels: () => s.perf.labels, drawn: () => s.perf.drawn, settled: () => s.store.settled, alpha: () => s.store.alpha,
      has: (mint: string) => s.store.idx.has(mint), node: (mint: string) => { const i = s.store.idx.get(mint); return i === undefined ? null : { ...s.store.data[i], r: s.store.rT[i], x: s.store.nx[i], y: s.store.ny[i] }; }, images: imageStats, worker: () => workerInfo.current,
      firstPaintAt: () => s.perf.firstPaintAt, dataAt: () => s.perf.dataAt, mountedAt: () => s.perf.mountedAt,
      anyRoot: () => { for (let i = 0; i < s.store.n; i++) if (s.store.parent[i] < 0) return s.store.ids[i]; return null; },
      screenOf: (mint: string) => { const i = s.store.idx.get(mint); if (i === undefined) return null; const b = canvas.current!.getBoundingClientRect(); const t = s.t; return { x: b.left + s.store.x[i] * t.k + t.x, y: b.top + s.store.y[i] * t.k + t.y, r: s.store.r[i] * t.k }; },
      fit, zoom: () => s.t.k,
      zoomTo: (mint: string, k: number) => { const i = s.store.idx.get(mint); if (i === undefined) return false; s.follow = { i, k }; s.autoFit = false; return true; },
    };
    (window as unknown as { __sporeMap?: unknown }).__sporeMap = dbg;
    return () => { if ((window as unknown as { __sporeMap?: unknown }).__sporeMap === dbg) delete (window as unknown as { __sporeMap?: unknown }).__sporeMap; };
  }, [frameStats, fit]);

  // ---- render loop: runs only while the element is on screen and the tab is visible
  useEffect(() => {
    const el = box.current, cv = canvas.current;
    if (!el || !cv) return;
    const s = st.current;
    const ctx = cv.getContext("2d")!;
    let running = false;
    const frame = () => {
      s.raf = 0;
      if (!running) return;
      const t0 = performance.now();
      draw(ctx, s, tipEl.current, t0);
      const dt = performance.now() - t0;
      const p = s.perf; p.frames++; if (dt > p.max) p.max = dt;
      if (s.store.n) { if (s.store.settled && !s.tweenUntil) { p.settled[p.di] = dt; p.di = (p.di + 1) % p.settled.length; p.dn++; } else { p.settling[p.si] = dt; p.si = (p.si + 1) % p.settling.length; p.sn++; } }
      s.raf = requestAnimationFrame(frame);
    };
    const update = () => {
      const want = s.visible && !document.hidden;
      if (want && !running) { running = true; s.raf = requestAnimationFrame(frame); }
      if (!want && running) { running = false; if (s.raf) cancelAnimationFrame(s.raf); s.raf = 0; }
    };
    const io = new IntersectionObserver((es) => { s.visible = es.some((e) => e.isIntersecting); update(); }, { threshold: 0 });
    io.observe(el);
    document.addEventListener("visibilitychange", update);
    update();
    return () => { running = false; if (s.raf) cancelAnimationFrame(s.raf); io.disconnect(); document.removeEventListener("visibilitychange", update); };
  }, []);

  const changeMode = (m: SizeMode) => { setMode(m); onModeChange?.(m); };
  const store = st.current.store;
  const hov = hover >= 0 && hover < store.n ? store.data[hover] : null;
  const hovFlags = hover >= 0 && hover < store.n ? store.flags[hover] : 0;
  const parentOf = hov?.parentMint ? store.data[store.idx.get(hov.parentMint) ?? -1] ?? null : null;
  const hasAnc = useMemo(() => (focus ? nodes.some((n) => { const f = nodes.find((x) => x.mint === focus); return f && n.depth < f.depth; }) : false), [nodes, focus]);
  const hasOurs = useMemo(() => nodes.some((n) => n.ours), [nodes]);
  const showTip = !!hov && (!onSelect || hover !== st.current.selected);
  const hovColor = hov ? COLORS[colorIdx(hov.depth)] : COLORS[0];

  return (
    <div ref={box} className={`bm ${className}`} style={{ height }} tabIndex={-1} role="img" aria-label="Bubble map of the coin family">
      <canvas ref={canvas} className="bm-canvas" />
      <div className="bm-vignette" aria-hidden="true" />
      {showTip && hov && (
        <div ref={tipEl} className="bm-tip" role="tooltip">
          <div className="bm-tip-head"><i style={{ background: hovColor, boxShadow: `0 0 10px ${hovColor}` }} /><b>{nameOf(hov)}</b><span className="mono">{sym(hov)}</span></div>
          <div className="bm-tip-row"><em>depth</em><strong className={`depth d${Math.min(hov.depth, 3)}`}>d{hov.depth}</strong></div>
          {hov.mcapUsd != null && <div className="bm-tip-row"><em>mcap</em><strong>{usd(hov.mcapUsd)}</strong></div>}
          {hov.lockedUsd != null && <div className="bm-tip-row"><em>locked by children</em><strong>{usd(hov.lockedUsd)}</strong></div>}
          <div className="bm-tip-row"><em>children</em><strong>{count(hov.children)}</strong></div>
          {parentOf && <div className="bm-tip-under">↳ under {sym(parentOf)}</div>}
          {hov.migrated && <div className="bm-tip-under good">graduated · PumpSwap</div>}
          {hov.ours && <div className="bm-tip-under accent">launched on Spore</div>}
          <div className="bm-tip-cta">{hovFlags & F_FOCUS ? "this coin" : onSelect ? "click to select" : "click to open"}</div>
        </div>
      )}
      <div className="bm-controls" role="group" aria-label="Map controls">
        <button type="button" onClick={() => scaleBy(1.5)} aria-label="Zoom in" title="Zoom in">+</button>
        <button type="button" onClick={() => scaleBy(1 / 1.5)} aria-label="Zoom out" title="Zoom out">−</button>
        <button type="button" onClick={fit} aria-label="Fit to view" title="Fit"><svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M1 5V1h4M9 1h4v4M13 9v4H9M5 13H1V9" /></svg></button>
      </div>
      <div className="bm-size seg" role="group" aria-label="Size bubbles by">
        <span className="bm-size-label">size</span>
        <button type="button" aria-pressed={mode === "locked"} onClick={() => changeMode("locked")}>locked</button>
        <button type="button" aria-pressed={mode === "mcap"} onClick={() => changeMode("mcap")}>mcap</button>
      </div>
      <div className="bm-legend">
        {focus && <span><i className="focus" /> this coin</span>}
        {hasAnc && <span><i style={{ borderStyle: "dashed", borderColor: COLORS[0] }} /> ancestors</span>}
        {hasOurs && <span><i style={{ borderColor: COLORS[0], borderWidth: 2, boxShadow: `0 0 6px ${hexA(COLORS[0], .6)}` }} /> launched on Spore</span>}
        <span><i style={{ background: hexA(COLORS[0], .25), borderColor: COLORS[0] }} /> root</span>
        <span><i style={{ background: hexA(COLORS[1], .25), borderColor: COLORS[1] }} /> d1</span>
        <span><i style={{ background: hexA(COLORS[2], .25), borderColor: COLORS[2] }} /> d2</span>
        <span className="muted bm-legend-note" title="Dots travel from child to parent the way buys do: every buy of a child buys its parent first.">area = {mode === "locked" ? "locked value" : "market cap"}</span>
      </div>
    </div>
  );
}

// Inside the card the size toggle (top right) and legend (bottom left) cover the canvas edges, so
// the fit centres on the strip between them; otherwise a leaf's pinned bubble ends up under the legend.
const CARD_INSET = { top: 44, bottom: 60 };

/// The coin page's family tree: this coin in the middle, ancestors above, descendants (3 levels)
/// around it. Fetches /api/tree itself so the page only has to place it.
export function CoinBubbleMap({ mint, height = 520 }: { mint: string; height?: number }) {
  const data = useAsync(() => api.tree(mint, 3), [mint]);
  const nodes = useMemo(() => (data.data ? flattenTree(data.data) : []), [data.data]);
  if (data.loading) return <Skeleton h={height} r={16} />;
  if (data.error && !data.data) return <ErrorBox error={data.error} retry={data.reload} />;
  return <BubbleMap nodes={nodes} focus={mint} height={height} mode="locked" className="bm-card" inset={CARD_INSET} />;
}
