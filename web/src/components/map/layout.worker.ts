// d3-force off the main thread. The page sends typed arrays (positions, radii, cluster centres, links);
// the worker owns the simulation, ticks for ~12 ms at a time, and posts positions back as transferred
// Float32Arrays. The page returns each buffer once drawn ("buf"), so after the first few frames nothing
// is allocated on either side. Forces mirror the single-thread map this replaced: links to the parent,
// a short-range charge, collision with padding, and a pull toward the root's cluster centre.
import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type Simulation } from "d3";

type N = { index: number; x: number; y: number; vx: number; vy: number; fx?: number | null; fy?: number | null; r: number; cx: number; cy: number; depth: number; fixed: boolean };
type L = { source: N; target: N };
type Buf = { x: Float32Array; y: Float32Array };
type InitMsg = { t: "init"; n: number; x: Float32Array; y: Float32Array; r: Float32Array; cx: Float32Array; cy: Float32Array; depth: Uint8Array; fixed: Uint8Array; src: Int32Array; dst: Int32Array; alpha: number; focus: boolean; hPx: number; ancShift: number };
type AddMsg = { t: "add"; n: number; x: Float32Array; y: Float32Array; r: Float32Array; cx: Float32Array; cy: Float32Array; depth: Uint8Array; fixed: Uint8Array; src: Int32Array; dst: Int32Array; alpha: number };
type Msg = InitMsg | AddMsg
  | { t: "radius"; idx: Int32Array; r: Float32Array; alpha: number }
  | { t: "drag"; i: number; x: number; y: number; phase: "start" | "move" | "end" }
  | { t: "heat"; alpha: number }
  | { t: "buf"; x: Float32Array; y: Float32Array }
  | { t: "stop" };

const ALPHA_MIN = 0.01;
let sim: Simulation<N, L> | null = null;
let nodes: N[] = [];
let links: L[] = [];
let focus = false, hPx = 600, ancShift = 0;
let free: Buf[] = [];
let running = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let ticks = 0, tickMs = 0; // instrumentation: total ticks and an EMA of the cost of one tick

const take = (n: number): Buf => {
  while (free.length) { const b = free.pop()!; if (b.x.length >= n) return b; }
  const cap = n + (n >> 2) + 64;
  return { x: new Float32Array(cap), y: new Float32Array(cap) };
};

function post(settled: boolean) {
  const n = nodes.length;
  const b = take(n);
  for (let i = 0; i < n; i++) { const d = nodes[i]; b.x[i] = d.x; b.y[i] = d.y; }
  (self as unknown as Worker).postMessage({ t: "tick", x: b.x, y: b.y, n, alpha: sim?.alpha() ?? 0, settled, ticks, tickMs }, [b.x.buffer, b.y.buffer]);
}

function forces() {
  if (!sim) return;
  sim.force("link", forceLink<N, L>(links).distance((l) => l.source.r + l.target.r + (focus ? 46 : l.target.depth <= 1 ? 20 : 12)).strength(0.7));
  sim.force("charge", forceManyBody<N>().strength((d) => -Math.max(30, d.r * (focus ? 9 : 3.5))).distanceMax(focus ? 420 : 140).theta(1.1));
  sim.force("collide", forceCollide<N>().radius((d) => d.r + 6).strength(0.9).iterations(nodes.length > 8000 ? 1 : 2));
  sim.force("x", forceX<N>((d) => d.cx).strength((d) => (d.depth === 0 && !focus ? 0.25 : 0.06)));
  sim.force("y", forceY<N>((d) => d.cy + (ancShift && !d.fixed ? hPx * 0.1 : 0)).strength((d) => (d.depth === 0 && !focus ? 0.25 : 0.06)));
}

function loop() {
  timer = null;
  if (!sim || !running) return;
  const t0 = performance.now();
  let settled = false;
  do { const a = performance.now(); sim.tick(); ticks++; tickMs = tickMs ? tickMs * 0.8 + (performance.now() - a) * 0.2 : performance.now() - a; if (sim.alpha() < ALPHA_MIN) { settled = true; break; } } while (performance.now() - t0 < 12);
  post(settled);
  if (settled) { running = false; return; }
  const spent = performance.now() - t0;
  timer = setTimeout(loop, Math.max(0, 16 - spent));
}
function start(alpha: number) {
  if (!sim) return;
  sim.alpha(Math.max(sim.alpha(), alpha));
  if (sim.alpha() < ALPHA_MIN) { post(true); return; }
  if (!running) { running = true; if (!timer) timer = setTimeout(loop, 0); }
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
      running = false; nodes = []; links = []; free = [];
      focus = m.focus; hPx = m.hPx; ancShift = m.ancShift;
      build(m, 0);
      sim = forceSimulation<N, L>(nodes).stop().alphaDecay(nodes.length > 8000 ? 0.05 : 0.04).velocityDecay(0.45).alphaMin(ALPHA_MIN).alpha(0);
      forces();
      if (m.alpha >= ALPHA_MIN) start(m.alpha); else post(true);
      break;
    }
    case "add": {
      if (!sim) return;
      build(m, nodes.length);
      sim.nodes(nodes);
      forces();
      start(m.alpha);
      break;
    }
    case "radius": {
      if (!sim) return;
      for (let i = 0; i < m.idx.length; i++) { const d = nodes[m.idx[i]]; if (d) d.r = m.r[i]; }
      forces();
      start(m.alpha);
      break;
    }
    case "drag": {
      if (!sim) return;
      const d = nodes[m.i]; if (!d) return;
      d.fx = m.x; d.fy = m.y;
      if (m.phase === "start") { sim.alphaTarget(0.25); start(0.3); }
      else if (m.phase === "end") { sim.alphaTarget(0); if (!d.fixed) { d.fx = null; d.fy = null; } start(ALPHA_MIN); }
      else if (!running) start(0.1);
      break;
    }
    case "heat": { start(m.alpha); break; }
    case "buf": { free.push({ x: m.x, y: m.y }); break; }
    case "stop": { if (timer) clearTimeout(timer); timer = null; running = false; sim?.stop(); sim = null; nodes = []; links = []; free = []; break; }
  }
};
