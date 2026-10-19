// d3-force off the main thread. The page sends typed arrays (positions, radii, cluster centres, links);
// the worker owns the simulation, ticks for ~12 ms at a time, and posts positions back as transferred
// Float32Arrays. The page returns each buffer once drawn ("buf"), so after the first few frames nothing
// is allocated on either side. Forces mirror the single-thread map this replaced: links to the parent,
// a short-range charge, collision with padding, and a pull toward the root's cluster centre.
//
// Drag (rigid subtree): "dragstart" pins the moving nodes where they are (fx/fy) without touching
// alpha, "translate" shifts them by the pointer's delta, "dragend" unpins them. A drag never reheats the
// whole layout: when it is asleep, the drop is eased by a local simulation of the moved nodes as one
// body (proxy nodes): a tether pulls a subtree back until its top is at link length from its parent,
// collisions push the body off what it was dropped on (body against the rest only: overlaps inside the
// body stay as the layout left them, so a dense family does not puff up), and a shape spring keeps each
// node at its offset from the body's centroid, so the family keeps its shape. Members of the same tree near the body make
// room (collision, and a weak spring back to their own spot); every other tree's bubbles near it are
// pinned obstacles, so no other tree moves. One tick per frame from a low alpha, written back into the
// real nodes. A whole tree that moved takes its centre (the x/y pull's target) along, so the next
// global relaxation does not pull it back.
//
// Live changes (an "add" of new coins, a "radius" tick) on a layout that is asleep relax only their
// neighbourhood (DESIGN §11.5: a local relaxation, never a full restart): every node farther than
// NB_MARGIN from a changed node is pinned for the duration (nbPin) and released when it settles. A
// cold settle was never at rest, so a global reheat at even alpha 0.02 moved ~9 000 nodes of other
// trees by up to ~120 world units on every tick. A cold settle or a size-mode change stays global.
// While a drag is held nothing else moves: a neighbourhood relaxation in progress pauses, and changes
// that arrive meanwhile (or while a drop eases) wait. On release the drop eases first, then what waited
// relaxes with the eased body held in place, so a drop never hesitates behind a live tick.
import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, quadtree, type Quadtree, type Simulation } from "d3";

type N = { index: number; x: number; y: number; vx: number; vy: number; fx?: number | null; fy?: number | null; r: number; cx: number; cy: number; depth: number; fixed: boolean };
type L = { source: N; target: N };
type Buf = { x: Float32Array; y: Float32Array };
type InitMsg = { t: "init"; n: number; x: Float32Array; y: Float32Array; r: Float32Array; cx: Float32Array; cy: Float32Array; depth: Uint8Array; fixed: Uint8Array; src: Int32Array; dst: Int32Array; alpha: number; focus: boolean; hPx: number; ancShift: number };
type AddMsg = { t: "add"; n: number; x: Float32Array; y: Float32Array; r: Float32Array; cx: Float32Array; cy: Float32Array; depth: Uint8Array; fixed: Uint8Array; src: Int32Array; dst: Int32Array; alpha: number };
type Msg = InitMsg | AddMsg
  /// global: every radius changed (a size-mode change), so the whole layout relaxes
  | { t: "radius"; idx: Int32Array; r: Float32Array; alpha: number; global?: boolean }
  /// ids: the nodes that move (sent once); root: the grabbed node (its subtree moves); whole: its whole
  /// tree moves; tree: the rest of that tree (a subtree drop may push those aside), empty for a whole tree
  | { t: "dragstart"; ids: Int32Array; root: number; whole: boolean; tree: Int32Array }
  | { t: "translate"; dx: number; dy: number }
  /// coins that arrived under a moving node during the drag: they move with it from now on
  | { t: "dragadd"; ids: Int32Array }
  /// relax: start alpha of the local relaxation (0 = none); seq: echoed in every later tick as `ack`
  | { t: "dragend"; relax: number; seq: number }
  | { t: "heat"; alpha: number }
  | { t: "buf"; x: Float32Array; y: Float32Array }
  | { t: "stop" };

const ALPHA_MIN = 0.01;
/// Local relaxation: alpha decay per tick (0.1 → 0.01 in ~37 ticks, ~0.6 s at one tick per frame), how
/// far around the moved nodes other bubbles take part as pinned obstacles (world units), the tether's
/// pull per unit of excess length and alpha (~80 % of the way back from 0.1), and the shape spring.
const LOCAL_DECAY = 0.06, LOCAL_MARGIN = 60, LOCAL_MAX_OBSTACLES = 8000, TETHER = 0.5, SHAPE = 0.3;
/// Spring of a same-tree member back to where it was at the drop (weak: collisions win, so it yields).
const YIELD = 0.06;
/// Collision padding per bubble (the map's forceCollide radius is r + 6) and strength, and the largest
/// push one overlapping pair gives per tick (world units): a member dropped deep inside a big bubble
/// otherwise jumped ~25 units in one frame and sprang back; capped, it eases out over several frames
/// instead (~5 units a tick at most once the velocity builds up).
const PAD = 6, COLLIDE = 0.9, PUSH_MAX = 4;
/// Neighbourhood relaxation: nodes within this distance (world units, rim to rim) of a changed node move.
const NB_MARGIN = 90;

/// Collisions between the body (prox[0, mn)) and everything else (prox[mn, end)) only. Pinned nodes do
/// not move; a yielding one takes its share by area. Velocity-predicted positions, like forceCollide.
function bodyCollide(prox: N[], mn: number) {
  const others = prox.slice(mn);
  let maxR = 0;
  for (const o of others) if (o.r > maxR) maxR = o.r;
  let tree: Quadtree<N> | null = null;
  return () => {
    if (!others.length) return;
    tree = quadtree<N>(others, (d) => d.x + d.vx, (d) => d.y + d.vy);
    for (let q = 0; q < mn; q++) {
      const b = prox[q];
      if (b.fx != null) continue;
      const bx = b.x + b.vx, by = b.y + b.vy, br = b.r + PAD, reach = br + maxR + PAD, b2 = b.r * b.r;
      tree.visit((node, x0, y0, x1, y1) => {
        if (!("length" in node)) {
          let leaf: typeof node | undefined = node;
          do {
            const o = leaf.data, rr = br + o.r + PAD;
            let dx = bx - (o.x + o.vx), dy = by - (o.y + o.vy), l = dx * dx + dy * dy;
            if (l < rr * rr) {
              if (dx === 0) { dx = 1e-6; l += dx * dx; }
              l = Math.sqrt(l);
              const f = (Math.min(rr - l, PUSH_MAX / COLLIDE) / l) * COLLIDE;
              const share = o.fx != null ? 1 : (o.r * o.r) / (b2 + o.r * o.r);
              b.vx += dx * f * share; b.vy += dy * f * share;
              if (o.fx == null) { o.vx -= dx * f * (1 - share); o.vy -= dy * f * (1 - share); }
            }
            leaf = leaf.next;
          } while (leaf);
          return false;
        }
        return x0 > bx + reach || x1 < bx - reach || y0 > by + reach || y1 < by - reach;
      });
    }
  };
}
let sim: Simulation<N, L> | null = null;
let nodes: N[] = [];
let links: L[] = [];
let focus = false, hPx = 600, ancShift = 0;
let free: Buf[] = [];
let running = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let ticks = 0, tickMs = 0; // instrumentation: total ticks and an EMA of the cost of one tick
/// seq of the last drag end processed: a tick carrying an older one may predate the drag's last moves.
let ack = 0;
/// The drag in progress: moving node indices, the dragged tree, whole-tree flag, accumulated delta.
let drag: { ids: Int32Array; root: number; whole: boolean; tree: Int32Array; dx: number; dy: number } | null = null;
/// A local relaxation in progress: its simulation, the real nodes and their proxies (same order).
let local: { sim: Simulation<N, L>; real: N[]; prox: N[] } | null = null;
/// A neighbourhood relaxation in progress: nbPin[i] = 1 for every node it pinned (null = none).
let nbPin: Uint8Array | null = null;
/// The nodes a drag is moving (they keep the drag's pin whatever a neighbourhood relaxation does).
let dragMark: Uint8Array | null = null;
/// The whole layout is relaxing (a cold settle, a size-mode change): changes and drops just join it.
let global = false;
/// The dropped body being eased (relaxLocal): once the ease ends it is pinned for a neighbourhood
/// relaxation that waited for it, so that one cannot bend the family it just placed.
let bodyAfterLocal: { ids: Int32Array; tree: Int32Array } | null = null;
/// Live changes that arrived during a drag or a drop's ease (relaxed right after), and a neighbourhood
/// relaxation paused by a drag.
let deferred: { idx: number[]; alpha: number } | null = null;
let paused = false;

const take = (n: number): Buf => {
  while (free.length) { const b = free.pop()!; if (b.x.length >= n) return b; }
  const cap = n + (n >> 2) + 64;
  return { x: new Float32Array(cap), y: new Float32Array(cap) };
};

function post(settled: boolean) {
  const n = nodes.length;
  const b = take(n);
  for (let i = 0; i < n; i++) { const d = nodes[i]; b.x[i] = d.x; b.y[i] = d.y; }
  const alpha = local ? local.sim.alpha() : sim?.alpha() ?? 0;
  (self as unknown as Worker).postMessage({ t: "tick", x: b.x, y: b.y, n, alpha, settled, ticks, tickMs, ack }, [b.x.buffer, b.y.buffer]);
}

/// The map's forces on simulation `s` over `ls` (the main one, or a local relaxation's proxies).
function applyForces(s: Simulation<N, L>, ls: L[], count: number) {
  s.force("link", forceLink<N, L>(ls).distance((l) => l.source.r + l.target.r + (focus ? 46 : l.target.depth <= 1 ? 20 : 12)).strength(0.7));
  s.force("charge", forceManyBody<N>().strength((d) => -Math.max(30, d.r * (focus ? 9 : 3.5))).distanceMax(focus ? 420 : 140).theta(1.1));
  s.force("collide", forceCollide<N>().radius((d) => d.r + 6).strength(0.9).iterations(count > 8000 ? 1 : 2));
  applyPull(s);
}
/// The pull toward each node's cluster centre (d3 caches the targets: re-applied when a centre moves).
function applyPull(s: Simulation<N, L>) {
  s.force("x", forceX<N>((d) => d.cx).strength((d) => (d.depth === 0 && !focus ? 0.25 : 0.06)));
  s.force("y", forceY<N>((d) => d.cy + (ancShift && !d.fixed ? hPx * 0.1 : 0)).strength((d) => (d.depth === 0 && !focus ? 0.25 : 0.06)));
}
function forces() { if (sim) applyForces(sim, links, nodes.length); }

function loop() {
  timer = null;
  if (!running) return;
  if (local) {
    // one tick per frame: a few hundred to a few thousand nodes tick in ~1–3 ms, and the drop should
    // ease in over ~0.6 s instead of finishing inside one 12 ms burst
    const a = performance.now();
    local.sim.tick(); ticks++; tickMs = tickMs ? tickMs * 0.8 + (performance.now() - a) * 0.2 : performance.now() - a;
    const { real, prox } = local;
    // (a node pinned by a waiting neighbourhood relaxation stays pinned, at its new spot)
    for (let q = 0; q < real.length; q++) { const d = real[q], p = prox[q]; d.x = p.x; d.y = p.y; if (d.fx != null) { d.fx = d.x; d.fy = d.y; } }
    // (the main simulation does not tick meanwhile: a global start ends the local relaxation first)
    const done = local.sim.alpha() < ALPHA_MIN;
    if (done) {
      local = null;
      // what waited for the ease: changes that arrived meanwhile, or a neighbourhood relaxation a drag
      // paused; it resumes with the eased body held where it is
      runDeferred();
      if (nbPin && sim && sim.alpha() >= ALPHA_MIN) { post(false); timer = setTimeout(loop, Math.max(0, 16 - (performance.now() - a))); return; }
    }
    post(done);
    if (done) { running = false; return; }
    timer = setTimeout(loop, Math.max(0, 16 - (performance.now() - a)));
    return;
  }
  if (!sim) { running = false; return; }
  const t0 = performance.now();
  let settled = false;
  do { const a = performance.now(); sim.tick(); ticks++; tickMs = tickMs ? tickMs * 0.8 + (performance.now() - a) * 0.2 : performance.now() - a; if (sim.alpha() < ALPHA_MIN) { settled = true; break; } } while (performance.now() - t0 < 12);
  if (settled) { global = false; releaseNb(); }
  post(settled);
  if (settled) { running = false; return; }
  const spent = performance.now() - t0;
  timer = setTimeout(loop, Math.max(0, 16 - spent));
}
function schedule() { if (!running) { running = true; if (!timer) timer = setTimeout(loop, 0); } }
function start(alpha: number) {
  if (!sim) return;
  sim.alpha(Math.max(sim.alpha(), alpha));
  if (sim.alpha() < ALPHA_MIN) { if (!running) post(true); return; }
  stopLocal(); // the whole layout moves now: it relaxes the drop as part of that
  releaseNb(); // ... and every neighbourhood with it, and whatever waited
  bodyAfterLocal = null; deferred = null; paused = false;
  global = true;
  schedule();
}

/// Pins the body a drop just eased for the neighbourhood relaxation in progress (no-op without one),
/// except the nodes in `free` (changed ones, e.g. a coin that arrived during the drag, which relax).
function holdBody(free?: ArrayLike<number>) {
  const ids = bodyAfterLocal?.ids;
  bodyAfterLocal = null;
  if (!ids || !nbPin) return;
  if (nbPin.length < nodes.length) { const p = new Uint8Array(nodes.length + 256); p.set(nbPin); nbPin = p; }
  const skip = free && free.length ? new Set(Array.from(free)) : null;
  for (let q = 0; q < ids.length; q++) { const i = ids[q], d = nodes[i]; if (d && !d.fixed && d.fx == null && !skip?.has(i)) { d.fx = d.x; d.fy = d.y; d.vx = 0; d.vy = 0; nbPin[i] = 1; } }
}
/// Relaxes what waited for a drag or a drop's ease, holding the dropped body (its new coins excepted).
function runDeferred() {
  const d = deferred, body = bodyAfterLocal;
  deferred = null;
  if (d) relaxAround(d.idx, d.alpha);
  if (body && nbPin) shield(body.ids, body.tree);
  holdBody(d?.idx);
}
/// Pins (for the neighbourhood relaxation in progress) every bubble of another tree around a dropped
/// body: the drop's ease already slid it off them, and they must not be shoved by it afterwards.
/// `tree` = the rest of the body's own tree (a subtree drop), which may still make room.
function shield(ids: Int32Array, tree: Int32Array) {
  if (!nbPin) return;
  const n = nodes.length;
  if (nbPin.length < n) { const p = new Uint8Array(n + 256); p.set(nbPin); nbPin = p; }
  const mine = new Uint8Array(n);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, maxR = 0;
  for (let q = 0; q < ids.length; q++) { const i = ids[q], d = nodes[i]; if (!d) continue; mine[i] = 1; if (d.x - d.r < x0) x0 = d.x - d.r; if (d.y - d.r < y0) y0 = d.y - d.r; if (d.x + d.r > x1) x1 = d.x + d.r; if (d.y + d.r > y1) y1 = d.y + d.r; if (d.r > maxR) maxR = d.r; }
  for (let q = 0; q < tree.length; q++) if (tree[q] < n) mine[tree[q]] = 1;
  const m = NB_MARGIN + maxR;
  x0 -= m; y0 -= m; x1 += m; y1 += m;
  for (let i = 0; i < n; i++) {
    const d = nodes[i];
    if (mine[i] || d.fixed || d.fx != null || dragMark?.[i]) continue;
    if (d.x + d.r < x0 || d.x - d.r > x1 || d.y + d.r < y0 || d.y - d.r > y1) continue;
    d.fx = d.x; d.fy = d.y; d.vx = 0; d.vy = 0; nbPin[i] = 1;
  }
}

/// Unpins what a neighbourhood relaxation pinned (a node a drag holds stays pinned by the drag).
function releaseNb() {
  if (!nbPin) return;
  const pin = nbPin;
  nbPin = null;
  for (let i = 0; i < nodes.length && i < pin.length; i++) if (pin[i] && !nodes[i].fixed && !dragMark?.[i]) { nodes[i].fx = null; nodes[i].fy = null; }
}

/// Relaxes the nodes within NB_MARGIN of the `changed` ones from `alpha`; every other node is pinned
/// until the layout settles again (see nbPin). A second change while one runs widens it (the union).
/// When the whole layout is moving anyway (a cold settle, a mode change), the change just joins that.
function relaxAround(changed: ArrayLike<number>, alpha: number) {
  if (!sim) return;
  if (alpha < ALPHA_MIN || global) { start(alpha); return; }
  if (drag || local) { const d = deferred ?? (deferred = { idx: [], alpha: 0 }); for (let q = 0; q < changed.length; q++) d.idx.push(changed[q]); if (alpha > d.alpha) d.alpha = alpha; return; }
  stopLocal();
  const n = nodes.length;
  const first = !nbPin;
  if (!nbPin || nbPin.length < n) { const p = new Uint8Array(n + 256); if (nbPin) p.set(nbPin); nbPin = p; }
  const pts: N[] = [];
  let maxR = 0;
  for (let q = 0; q < changed.length; q++) { const d = nodes[changed[q]]; if (d && Number.isFinite(d.x) && Number.isFinite(d.y)) { pts.push(d); if (d.r > maxR) maxR = d.r; } }
  if (!pts.length) { if (first) nbPin = null; if (!running) post(true); return; }
  const qt = quadtree<N>(pts, (d) => d.x, (d) => d.y);
  const pin = nbPin;
  for (let i = 0; i < n; i++) {
    const d = nodes[i];
    if (d.fixed || dragMark?.[i]) continue;
    const near = qt.find(d.x, d.y, NB_MARGIN + d.r + maxR) !== undefined;
    if (near) { if (pin[i]) { pin[i] = 0; d.fx = null; d.fy = null; } }
    else if (first && d.fx == null) { pin[i] = 1; d.fx = d.x; d.fy = d.y; d.vx = 0; d.vy = 0; }
  }
  sim.alpha(Math.max(sim.alpha(), alpha));
  schedule();
}

/// Ends a local relaxation where it stands (its positions are already in the real nodes).
function stopLocal() {
  if (!local) return;
  for (const d of local.real) { d.vx = 0; d.vy = 0; }
  local = null;
}

/// Eases the dropped nodes `ids` (grabbed node `root`) as one body from `alpha`. Proxies: the body, then
/// the members of `tree` within LOCAL_MARGIN of the body's bounds (they yield), then the parent and every
/// other bubble there as pinned obstacles. Forces: collision; on the body the tether from `root` to its
/// parent (when it has one and is not pinned) and the shape spring; on the yielding nodes the spring
/// back to their own spot.
function relaxLocal(ids: Int32Array, tree: Int32Array, root: number, alpha: number) {
  stopLocal();
  const n = nodes.length;
  const slot = new Int32Array(n).fill(-1);
  const prox: N[] = [], real: N[] = [];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, maxR = 0;
  for (let q = 0; q < ids.length; q++) {
    const i = ids[q], d = nodes[i];
    if (!d || slot[i] >= 0 || !Number.isFinite(d.x) || !Number.isFinite(d.y)) continue;
    slot[i] = prox.length;
    real.push(d);
    prox.push({ index: 0, x: d.x, y: d.y, vx: 0, vy: 0, fx: d.fx ?? null, fy: d.fy ?? null, r: d.r, cx: d.cx, cy: d.cy, depth: d.depth, fixed: d.fixed });
    if (d.x - d.r < x0) x0 = d.x - d.r; if (d.y - d.r < y0) y0 = d.y - d.r; if (d.x + d.r > x1) x1 = d.x + d.r; if (d.y + d.r > y1) y1 = d.y + d.r;
  }
  const mn = real.length;
  if (!mn) { post(true); return; }
  for (const d of nodes) if (d.r > maxR) maxR = d.r;
  const m = LOCAL_MARGIN + maxR;
  x0 -= m; y0 -= m; x1 += m; y1 += m;
  const inBox = (d: N) => d.x + d.r >= x0 && d.x - d.r <= x1 && d.y + d.r >= y0 && d.y - d.r <= y1;
  const pin = (i: number) => { const d = nodes[i]; slot[i] = prox.length; prox.push({ index: 0, x: d.x, y: d.y, vx: 0, vy: 0, fx: d.x, fy: d.y, r: d.r, cx: d.cx, cy: d.cy, depth: d.depth, fixed: true }); };
  const top = nodes[root];
  const parentLink = top && !top.fixed ? links.find((l) => l.target === top) : undefined;
  const parent = parentLink ? parentLink.source.index : -1;
  // same-tree members near the body yield; their own spot is where the spring pulls them (proxies of
  // real nodes come first, in the order of `real`)
  for (let q = 0; q < tree.length; q++) {
    const i = tree[q], d = nodes[i];
    if (!d || slot[i] >= 0 || i === parent || d.fixed || !inBox(d)) continue;
    slot[i] = prox.length;
    real.push(d);
    prox.push({ index: 0, x: d.x, y: d.y, vx: 0, vy: 0, fx: null, fy: null, r: d.r, cx: d.cx, cy: d.cy, depth: d.depth, fixed: false });
  }
  const mt = real.length;
  const home = new Float64Array((mt - mn) * 2);
  for (let q = mn; q < mt; q++) { home[(q - mn) * 2] = real[q].x; home[(q - mn) * 2 + 1] = real[q].y; }
  // the parent stays put, even when the drop left it far outside the bounds (the tree's top does not
  // wander toward a dropped child)
  if (parent >= 0 && slot[parent] < 0) pin(parent);
  // the tether: the grabbed node's link to its parent, as long as the map's link force wants it
  let tRoot: N | null = null, tParent: N | null = null, rest = 0;
  if (parentLink && slot[root] >= 0 && slot[root] < mn) {
    const l = parentLink;
    tRoot = prox[slot[root]]; tParent = prox[slot[l.source.index]]; rest = l.source.r + l.target.r + (focus ? 46 : l.target.depth <= 1 ? 20 : 12);
  }
  let obstacles = 0;
  for (let i = 0; i < n && obstacles < LOCAL_MAX_OBSTACLES; i++) {
    if (slot[i] >= 0) continue;
    const d = nodes[i];
    if (!inBox(d)) continue;
    pin(i);
    obstacles++;
  }
  // offsets from the body's centroid at the drop: the shape the spring keeps
  let cx = 0, cy = 0;
  for (let q = 0; q < mn; q++) { cx += prox[q].x; cy += prox[q].y; }
  cx /= mn; cy /= mn;
  const off = new Float64Array(mn * 2);
  for (let q = 0; q < mn; q++) { off[q * 2] = prox[q].x - cx; off[q * 2 + 1] = prox[q].y - cy; }
  const body = (a: number) => {
    let sx = 0, sy = 0;
    for (let q = 0; q < mn; q++) { sx += prox[q].x; sy += prox[q].y; }
    sx /= mn; sy /= mn;
    let ax = 0, ay = 0;
    if (tRoot && tParent) {
      const dx = tParent.x - tRoot.x, dy = tParent.y - tRoot.y, dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > rest) { const f = ((dist - rest) / dist) * TETHER * a; ax = dx * f; ay = dy * f; }
    }
    for (let q = 0; q < mn; q++) { const p = prox[q]; p.vx += ax + (sx + off[q * 2] - p.x) * SHAPE; p.vy += ay + (sy + off[q * 2 + 1] - p.y) * SHAPE; }
    for (let q = mn; q < mt; q++) { const p = prox[q], h = (q - mn) * 2; p.vx += (home[h] - p.x) * YIELD; p.vy += (home[h + 1] - p.y) * YIELD; }
  };
  const s = forceSimulation<N, L>(prox).stop().alphaDecay(LOCAL_DECAY).velocityDecay(0.45).alphaMin(ALPHA_MIN).alpha(alpha);
  s.force("collide", bodyCollide(prox, mn));
  s.force("body", body);
  local = { sim: s, real, prox: prox.slice(0, mt) };
  schedule();
}

function build(m: InitMsg | AddMsg, base: number) {
  for (let i = 0; i < m.n; i++) nodes.push({ index: base + i, x: m.x[i], y: m.y[i], vx: 0, vy: 0, fx: m.fixed[i] ? m.x[i] : null, fy: m.fixed[i] ? m.y[i] : null, r: m.r[i], cx: m.cx[i], cy: m.cy[i], depth: m.depth[i], fixed: !!m.fixed[i] });
  for (let i = 0; i < m.src.length; i++) { const a = nodes[m.src[i]], b = nodes[m.dst[i]]; if (a && b) links.push({ source: a, target: b }); }
}

self.onmessage = (ev: MessageEvent<Msg>) => {
  const m = ev.data;
  switch (m.t) {
    case "init": {
      if (timer) { clearTimeout(timer); timer = null; }
      running = false; nodes = []; links = []; free = []; drag = null; local = null; nbPin = null; dragMark = null; bodyAfterLocal = null; deferred = null; paused = false; global = false;
      focus = m.focus; hPx = m.hPx; ancShift = m.ancShift;
      build(m, 0);
      sim = forceSimulation<N, L>(nodes).stop().alphaDecay(nodes.length > 8000 ? 0.05 : 0.04).velocityDecay(0.45).alphaMin(ALPHA_MIN).alpha(0);
      forces();
      if (m.alpha >= ALPHA_MIN) start(m.alpha); else post(true);
      break;
    }
    case "add": {
      if (!sim) return;
      const base = nodes.length;
      build(m, base);
      sim.nodes(nodes);
      forces();
      // a node being dragged stays pinned through the re-initialisation; the newcomers relax with their
      // neighbourhood only (or with the whole layout when it is moving anyway)
      const idx = new Int32Array(m.n);
      for (let q = 0; q < m.n; q++) idx[q] = base + q;
      relaxAround(idx, m.alpha);
      break;
    }
    case "radius": {
      if (!sim) return;
      for (let i = 0; i < m.idx.length; i++) { const d = nodes[m.idx[i]]; if (d) d.r = m.r[i]; }
      forces();
      if (m.global) start(m.alpha); else relaxAround(m.idx, m.alpha);
      break;
    }
    case "dragstart": {
      if (!sim) return;
      stopLocal(); holdBody(); // a drop still easing stops where it is (held for a waiting neighbourhood relaxation)
      // nothing else moves while the drag is held (a cold settle or a mode change keeps going around it)
      if (running && !global) { if (timer) clearTimeout(timer); timer = null; running = false; paused = !!nbPin; }
      // pinned where they are; alpha untouched: a running layout keeps going around them, a settled one
      // stays asleep (the page draws the moving nodes itself)
      if (!dragMark || dragMark.length < nodes.length) dragMark = new Uint8Array(nodes.length + 256); else dragMark.fill(0);
      for (let q = 0; q < m.ids.length; q++) { const i = m.ids[q], d = nodes[i]; if (!d) continue; d.vx = 0; d.vy = 0; d.fx = d.x; d.fy = d.y; dragMark[i] = 1; if (nbPin && i < nbPin.length) nbPin[i] = 0; }
      drag = { ids: m.ids, root: m.root, whole: m.whole, tree: m.tree, dx: 0, dy: 0 };
      break;
    }
    case "translate": {
      if (!drag) return;
      const { dx, dy } = m;
      drag.dx += dx; drag.dy += dy;
      const ids = drag.ids;
      for (let q = 0; q < ids.length; q++) { const d = nodes[ids[q]]; if (!d) continue; d.x += dx; d.y += dy; d.fx = d.x; d.fy = d.y; d.vx = 0; d.vy = 0; }
      break;
    }
    case "dragadd": {
      if (!drag) return;
      if (!dragMark || dragMark.length < nodes.length) { const p = new Uint8Array(nodes.length + 256); if (dragMark) p.set(dragMark); dragMark = p; }
      const ids = new Int32Array(drag.ids.length + m.ids.length);
      ids.set(drag.ids); ids.set(m.ids, drag.ids.length);
      drag.ids = ids;
      for (let q = 0; q < m.ids.length; q++) { const i = m.ids[q], d = nodes[i]; if (!d) continue; d.vx = 0; d.vy = 0; d.fx = d.x; d.fy = d.y; dragMark[i] = 1; if (nbPin && i < nbPin.length) nbPin[i] = 0; }
      break;
    }
    case "dragend": {
      ack = m.seq;
      if (!sim || !drag) { drag = null; dragMark = null; if (sim && paused) { paused = false; schedule(); } else if (sim && !running) post(true); return; }
      const g = drag; drag = null; dragMark = null;
      paused = false; // a neighbourhood relaxation the drag paused resumes after the drop's ease (or now)
      for (let q = 0; q < g.ids.length; q++) { const d = nodes[g.ids[q]]; if (!d) continue; d.vx = 0; d.vy = 0; if (!d.fixed) { d.fx = null; d.fy = null; } }
      // a whole tree takes its centre along, so the pull toward it does not drag the tree back
      if (g.whole && (g.dx || g.dy)) { for (let q = 0; q < g.ids.length; q++) { const d = nodes[g.ids[q]]; if (d) { d.cx += g.dx; d.cy += g.dy; } } applyPull(sim); }
      if (global) { schedule(); break; } // the whole layout is moving anyway: it relaxes the drop
      // the drop eases first (one body, everything else still); what waited follows with the body held
      if (m.relax >= ALPHA_MIN && (g.dx || g.dy)) { relaxLocal(g.ids, g.tree, g.root, m.relax); bodyAfterLocal = { ids: g.ids, tree: g.tree }; break; }
      bodyAfterLocal = { ids: g.ids, tree: g.tree }; runDeferred();
      if (nbPin && sim.alpha() >= ALPHA_MIN) { schedule(); break; }
      post(true);
      break;
    }
    case "heat": { start(m.alpha); break; }
    case "buf": { free.push({ x: m.x, y: m.y }); break; }
    case "stop": { if (timer) clearTimeout(timer); timer = null; running = false; sim?.stop(); sim = null; nodes = []; links = []; free = []; drag = null; local = null; nbPin = null; dragMark = null; bodyAfterLocal = null; deferred = null; paused = false; global = false; break; }
  }
};
