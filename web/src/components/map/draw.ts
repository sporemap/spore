// The per-frame draw of the bubble map, written to allocate nothing per node. Order of a frame:
//  1. positions interpolated between the last two worker frames into the store's typed arrays, radii tweened;
//  2. camera (camera.ts): a van Wijk flight, follow or auto-fit step; d3-zoom is synced when it moved;
//  3. dotted ground, then tree hulls (one neutral tint, fading out between k = 0.6 and 1.6; the active
//     tree lime, with a hairline circle at any zoom);
//  4. links batched per colour (dimmed ones apart); ambient flow dots only on links whose child traded
//     in the last 30 min, hovered links with their own dots on top;
//  5. trade fx (fx.ts): ripples, $500+ flashes and routed-buy comets;
//  6. bubbles, smallest first, in tiers by screen radius: specks (< 2.5 px) batched into rect fills;
//     small bubbles (< 7 px) as batched vectors (one halo fill, one body fill and one ring stroke per
//     colour and dim level: in software raster a sprite blit costs several times a path arc, and these
//     are the thousands); then letter avatars shared per letter + colour + size, or a per-node logo
//     sprite once the logo is decoded. Sprite builds are budgeted (12 builds or 4 ms per frame, 2 during
//     a user gesture); over budget a bubble reuses its last sprite scaled. Bubbles over 128 px are drawn
//     directly, and the hovered/selected/focused ones (at most three) take the slow path (gradients,
//     clipping, dashed rings). Under a highlight the loop runs twice: dimmed non-matches, then matches;
//  7. Spore beacons (lime ring + breathing halo, never smaller than 4 px), cluster titles at overview
//     zoom (two-tone cached bitmaps, culled on an estimated width before they are built), then node
//     labels (cached per node, fading in by size), all overlap-culled against one rect buffer.
// Colours used per frame come from precomputed rgba tables; scratch buffers are module-level.
import { easeCubicOut, select, zoomIdentity, type ZoomBehavior, type ZoomTransform } from "d3";
import { DEBUG_HOOKS } from "../../lib/map/debug";
import { imageFor } from "../../lib/map/images";
import type { SizeMode } from "../../lib/map/types";
import { stepCamera, type Flight } from "./camera";
import { drawFx, makeFx, type Fx } from "./fx";
import { COLORS, F_ANC, F_FOCUS, F_MATCH, F_MIG, F_OURS, HULL, MapStore } from "./store";
import { GLOW, MAX_SPRITE_R, MONO, SB_ANC, SB_MIG, bucketR, drawCap, gridPattern, labelOf, letterKey, letterSprite, makeSprites, renderBody, renderLabel, sharedSprite, titleSprite, type SpriteSet } from "./sprites";

export { centerOn, fitFor } from "./camera";

export const GROW_MS = 700, PULSE_MS = 1_800, TWEEN_MS = 600;
/// Every bubble at least this big on screen gets its ticker (DESIGN §11.5), at most MAX_LABELS of them.
export const LABEL_R = 9, MAX_LABELS = 160, IMG_R = 9, SPECK_R = 2.5, SMALL_R = 7;
/// The biggest bubbles are named at any zoom (owner 2026-10-19: names must be readable on open, even
/// when the whole forest is in view and nothing reaches LABEL_R); overlap culling still applies.
export const ALWAYS_LABELS = 36;
/// Cluster titles at overview zoom (fewer on a phone).
export const MAX_TITLES = 40, MAX_TITLES_PHONE = 12;
/// Spore launches are drawn at least this big (screen px), with a ring, at any zoom.
export const BEACON_R = 4;
/// Ambient link dots only on pairs that traded this recently.
export const DOT_RECENT_MS = 30 * 60_000;
const MAX_DOT_LINKS = 6000, HOT_CAP = 512, BEACON_CAP = 512;
const BUILD_MAX = 12, BUILD_GESTURE = 2, BUILD_MS = 4;
const RECTS = MAX_LABELS + MAX_TITLES;

/// Where an unloaded/loaded logo comes from; typed loosely so it works with either loader signature.
const imgFor = imageFor as unknown as (src: string | null | undefined, wantPx?: number) => CanvasImageSource | null;

export type Perf = {
  frames: number; settling: Float32Array; settled: Float32Array; si: number; di: number; sn: number; dn: number; max: number; labels: number; drawn: number; firstPaintAt: number; dataAt: number; mountedAt: number;
  /// cluster titles drawn last frame and their cluster indices; active fx slots; sprites built; Spore beacons drawn
  titles: number; titleIdx: Int32Array; fx: number; built: number; beacons: number;
};
export const makePerf = (): Perf => ({ frames: 0, settling: new Float32Array(900), settled: new Float32Array(900), si: 0, di: 0, sn: 0, dn: 0, max: 0, labels: 0, drawn: 0, firstPaintAt: 0, dataAt: 0, mountedAt: performance.now(), titles: 0, titleIdx: new Int32Array(64), fx: 0, built: 0, beacons: 0 });

export type Inset = { left?: number; top?: number; bottom?: number; right?: number } | undefined;
export type State = {
  store: MapStore; sprites: SpriteSet; mode: SizeMode;
  t: ZoomTransform; zoom: ZoomBehavior<HTMLCanvasElement, unknown> | null; w: number; h: number; dpr: number;
  hover: number; pinned: number; selected: number; focusIdx: number; follow: { i: number; k: number } | null;
  raf: number; visible: boolean; autoFit: boolean; focus: string | undefined; static: boolean; inset: Inset;
  onSelect: ((i: number) => void) | undefined; tweenUntil: number; hullTick: number;
  labelRects: Float32Array; hot: Int32Array; perf: Perf;
  /// layout inputs the worker needs again on a re-init (canvas height for the focus column, ancestor shift)
  hPx: number; hasAnc: boolean;
  /// camera flight in progress (camera.ts), the time of the last drawn frame, and the end of the current
  /// user gesture (performance.now() ms; BubbleMap sets it on wheel/pinch/pan)
  flight: Flight | null; lastFrameAt: number; zoomingUntil: number;
  /// hovered cluster (index into store.clusters, -1 none); highlight on = non-F_MATCH nodes dim
  hoverCluster: number; highlight: boolean;
  /// live trade effects
  fx: Fx;
  /// camera internals: the reusable flight record, and "s.t jumped, sync d3 on the next frame"
  flightRec?: Flight; camJump?: boolean;
};

export function makeState(init: { mode: SizeMode; focus: string | undefined; inset: Inset; static: boolean }): State {
  return {
    store: new MapStore(), sprites: makeSprites(), mode: init.mode, t: zoomIdentity, zoom: null, w: 0, h: 0, dpr: 1,
    hover: -1, pinned: -1, selected: -1, focusIdx: -1, follow: null, raf: 0, visible: true, autoFit: true, focus: init.focus, static: init.static, inset: init.inset,
    onSelect: undefined, tweenUntil: 0, hullTick: 0, labelRects: new Float32Array(RECTS * 4), hot: new Int32Array(HOT_CAP), perf: makePerf(), hPx: 600, hasAnc: false,
    flight: null, lastFrameAt: 0, zoomingUntil: 0, hoverCluster: -1, highlight: false, fx: makeFx(),
  };
}

/// A State built as a literal before makeState existed gets the new fields on first use.
function ensureState(s: State) {
  const a = s as Partial<State>;
  if (a.fx === undefined) a.fx = makeFx();
  if (a.flight === undefined) a.flight = null;
  if (a.lastFrameAt === undefined) a.lastFrameAt = 0;
  if (a.zoomingUntil === undefined) a.zoomingUntil = 0;
  if (a.hoverCluster === undefined) a.hoverCluster = -1;
  if (a.highlight === undefined) a.highlight = false;
  const p = s.perf as Partial<Perf>;
  if (!p.titleIdx) { p.titleIdx = new Int32Array(64); p.titles = 0; p.fx = 0; p.built = 0; p.beacons = 0; }
  if (s.labelRects.length < RECTS * 4) s.labelRects = new Float32Array(RECTS * 4);
}

const easeBack = (t: number) => { const c = 1.4; const u = t - 1; return 1 + (c + 1) * u * u * u + c * u * u; };
const smoothstep = (e0: number, e1: number, v: number) => { const u = Math.min(1, Math.max(0, (v - e0) / (e1 - e0))); return u * u * (3 - 2 * u); };
const growOf = (b: number, now: number, still: boolean) => { if (still || !b) return 1; const u = (now - b) / GROW_MS; return u <= 0 ? 0 : u >= 1 ? 1 : easeBack(u); };

// ---- precomputed colour strings (no rgba() concatenation per frame)
const STEPS = 20;
const rgbOf = (hex: string) => `${parseInt(hex.slice(1, 3), 16)},${parseInt(hex.slice(3, 5), 16)},${parseInt(hex.slice(5, 7), 16)}`;
const table = (hex: string) => { const c = rgbOf(hex); const out: string[] = []; for (let q = 0; q <= STEPS; q++) out.push(`rgba(${c},${q / STEPS})`); return out; };
/// COLOR_A[colour][round(alpha·20)]
const COLOR_A = COLORS.map(table);
const LIME_A = COLOR_A[0];
const ca = (tab: string[], a: number) => tab[Math.max(0, Math.min(STEPS, Math.round(a * STEPS)))];
// fine-grained (1/200) tables for the faint hull alphas, which would round to 0 on a 1/20 grid
const fineTable = (hex: string) => { const c = rgbOf(hex); const out: string[] = []; for (let q = 0; q <= 60; q++) out.push(`rgba(${c},${q / 200})`); return out; };
const HULL_F = fineTable(HULL), LIME_F = fineTable(COLORS[0]);
const fa = (tab: string[], a: number) => tab[Math.max(0, Math.min(60, Math.round(a * 200)))];
const FADE = [0.18, 0.4, 0.6];
const DOT_STYLE = COLORS.flatMap((_, ci) => FADE.map((a) => ca(COLOR_A[ci], a)));
/// speck fill per (colour, level): 0 normal, 1 hover-dimmed, 2 highlight-dimmed, 3 both
const SPECK_A = [0.8, 0.18, 0.12, 0.05];
const SPECK_STYLE = [0, 1, 2, 3].flatMap((lv) => COLORS.map((_, ci) => ca(COLOR_A[ci], SPECK_A[lv])));
/// small-tier (2.5–7 px) vector bubbles per (colour, level): the sprite look in three batched ops —
/// a flat halo standing in for the glow, the body fill and the ring
const DIM_MUL = [1, 0.28, 0.15, 0.042];
const exactA = (hex: string, a: number) => `rgba(${rgbOf(hex)},${Math.round(a * 1000) / 1000})`;
const SMALL_HALO = DIM_MUL.flatMap((m) => COLORS.map((c) => exactA(c, 0.11 * m)));
const SMALL_FILL = DIM_MUL.flatMap((m) => COLORS.map((c) => exactA(c, 0.42 * m)));
const SMALL_RING = DIM_MUL.flatMap((m) => COLORS.map((c) => exactA(c, 0.8 * m)));
const HALO_R = 1.6, TAU = Math.PI * 2;
const BEACON_RING = ca(LIME_A, 0.95), BEACON_HALO = ca(LIME_A, 0.35), BEACON_DIM = ca(LIME_A, 0.3);
const fontCache = new Map<number, string>();
const letterFont = (px: number) => { let f = fontCache.get(px); if (!f) { f = `600 ${px}px ${MONO}`; fontCache.set(px, f); } return f; };

// ---- per-frame scratch (module level: a frame allocates nothing per node)
let K = 1, TX = 0, TY = 0, W = 0, H = 0, NOW = 0, DPR = 1, STILL = false;
let HOV = -1, SEL = -1, DIMMING = false, HL = false;
let curAlpha = 1, drawnN = 0;
let builds = 0, buildLimit = BUILD_MAX, buildT0 = 0, buildOver = false;
const nulls = (len: number): (Path2D | null)[] => Array.from({ length: len }, () => null);
const linkPaths = nulls(8), dotPaths = nulls(12), speckPaths = nulls(16), smallPaths = nulls(16), haloPaths = nulls(16);
const beaconX = new Float32Array(BEACON_CAP), beaconY = new Float32Array(BEACON_CAP), beaconR = new Float32Array(BEACON_CAP), beaconDim = new Uint8Array(BEACON_CAP);
let beaconN = 0;
let supp = new Uint8Array(0);
const suppList = new Int32Array(64);
let suppN = 0, rectN = 0, labelsN = 0;

const canBuild = () => { if (buildOver) return false; if (builds === 0) buildT0 = performance.now(); return true; };
const spend = () => { builds++; if (builds >= buildLimit || performance.now() - buildT0 > BUILD_MS) buildOver = true; };

/// Effective screen radius: what the frame draws (Spore launches ≥ 4 px, highlight matches ≥ 2.5 px).
const effR = (s: State, i: number, sr: number) => {
  const fl = s.store.flags[i];
  if (fl & F_OURS) return sr < BEACON_R ? BEACON_R : sr;
  if (s.highlight && fl & F_MATCH) return sr < SPECK_R ? SPECK_R : sr;
  return sr;
};

/// On-screen radius of node i as drawn (px).
export function screenR(s: State, i: number): number {
  const st = s.store;
  if (i < 0 || i >= st.n) return 0;
  return effR(s, i, st.r[i] * s.t.k);
}

/// Topmost bubble under a screen point (draw order is small-first, so scan from the end), or -1.
/// Bubbles still growing in (under half size) are not hit.
export function hitTest(s: State, sx: number, sy: number): number {
  const st = s.store, t = s.t, k = t.k;
  const wx = (sx - t.x) / k, wy = (sy - t.y) / k, slack = 4 / k;
  const { order, x, y, r, born, flags } = st;
  const now = performance.now(), still = s.static, hl = !!s.highlight;
  const minOurs = BEACON_R / k, minMatch = SPECK_R / k;
  for (let oi = st.n - 1; oi >= 0; oi--) {
    const i = order[oi];
    const dx = x[i] - wx, dy = y[i] - wy;
    let rr = r[i];
    const fl = flags[i];
    if (fl & F_OURS) { if (rr < minOurs) rr = minOurs; } else if (hl && fl & F_MATCH && rr < minMatch) rr = minMatch;
    rr += slack;
    if (dx * dx + dy * dy > rr * rr) continue;
    if (born[i] && growOf(born[i], now, still) < 0.5) continue;
    return i;
  }
  return -1;
}

/// Smallest cluster whose screen circle contains the point, among clusters 6–240 px across in radius; or -1.
export function clusterAt(s: State, sx: number, sy: number): number {
  const st = s.store, cl = st.clusters, t = s.t, k = t.k;
  let best = -1, bestR = Infinity;
  for (let ci = 0; ci < cl.length; ci++) {
    const c = cl[ci];
    if (!c.anchored) continue;
    const cr = c.cr * k;
    if (cr < 6 || cr > 240 || cr >= bestR) continue;
    const dx = c.ccx * k + t.x - sx, dy = c.ccy * k + t.y - sy;
    if (dx * dx + dy * dy <= cr * cr) { best = ci; bestR = cr; }
  }
  return best;
}

function ringPush(ring: Int32Array, w: number, i: number, evict: (j: number) => void): number {
  const j = ring[w];
  if (j >= 0 && j !== i) evict(j);
  ring[w] = i;
  return (w + 1) % ring.length;
}

export function draw(ctx: CanvasRenderingContext2D, s: State, tip: HTMLDivElement | null, now: number) {
  if (!s.fx) ensureState(s);
  const st = s.store, n = st.n, { w, h, dpr } = s;
  const settling = !st.settled;
  const { x, y, r, order, flags, color, parent, born } = st;
  // ---- positions: interpolate between the last two worker frames; radii: tween toward their targets
  if (settling) {
    const u = Math.min(1, (now - st.tickAt) / st.tickDt);
    const { px, py, nx, ny } = st;
    for (let i = 0; i < n; i++) { x[i] = px[i] + (nx[i] - px[i]) * u; y[i] = py[i] + (ny[i] - py[i]) * u; }
  }
  if (s.tweenUntil) {
    const { rT, r0, rt0 } = st;
    if (now < s.tweenUntil) { for (let i = 0; i < n; i++) { if (!rt0[i]) continue; const u = (now - rt0[i]) / TWEEN_MS; if (u >= 1) { r[i] = rT[i]; rt0[i] = 0; } else r[i] = r0[i] + (rT[i] - r0[i]) * easeCubicOut(Math.max(0, u)); } }
    else { for (let i = 0; i < n; i++) { r[i] = rT[i]; rt0[i] = 0; } s.tweenUntil = 0; st.rebuildOrder(); }
  }
  // ---- camera: flight, follow or auto-fit (camera.ts); d3-zoom learns the new transform
  if (stepCamera(s, now) && s.zoom) s.zoom.transform(selectCanvas(ctx.canvas), s.t);

  const t = s.t, k = t.k, tx = t.x, ty = t.y;
  K = k; TX = tx; TY = ty; W = w; H = h; NOW = now; DPR = dpr; STILL = s.static;
  builds = 0; buildOver = false; buildLimit = s.zoomingUntil > now ? BUILD_GESTURE : BUILD_MAX;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  // dotted world grid: gives zoom and pan a sense of ground
  const step = 56 * k * (k < 0.6 ? 2 : 1);
  if (step > 14) {
    const p = gridPattern(ctx, step);
    if (p) { ctx.save(); ctx.translate(((tx % step) + step) % step, ((ty % step) + step) % step); ctx.fillStyle = p; ctx.fillRect(-step, -step, w + step * 2, h + step * 2); ctx.restore(); }
  }

  const hov = s.pinned >= 0 ? s.pinned : s.hover >= 0 ? s.hover : s.selected;
  const dimming = hov >= 0;
  const hl = !!s.highlight;
  HOV = hov; SEL = s.selected; DIMMING = dimming; HL = hl;
  const clusters = st.clusters;
  const hcRaw = s.hoverCluster >= 0 ? s.hoverCluster : hov >= 0 ? st.cluster[hov] : -1;
  const hc = hcRaw >= 0 && hcRaw < clusters.length ? hcRaw : -1;

  // ---- tree hulls: one soft blob per big cluster, hugging where its members are (hull of the
  // member centres stroked with a fat round-joined line, which pads it into a rounded shape). They
  // fade out between k = 0.6 and 1.6: zoomed in, the bubbles themselves show the tree.
  if (!s.focus) {
    const fadeK = Math.min(1, Math.max(0, (1.6 - k) / 1.0));
    ctx.lineJoin = "round"; ctx.lineCap = "round";
    if (fadeK > 0) {
      for (let ci = 0; ci < clusters.length; ci++) {
        const c = clusters[ci];
        if (!c.big || c.hullN === 0) continue;
        const hull = c.hull, hn = c.hullN;
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (let q = 0; q < hn; q++) { const px = hull[q * 2] * k + tx, py = hull[q * 2 + 1] * k + ty; if (px < x0) x0 = px; if (py < y0) y0 = py; if (px > x1) x1 = px; if (py > y1) y1 = py; }
        const pad = (c.maxR + 14) * k;
        if (x1 + pad < 0 || y1 + pad < 0 || x0 - pad > w || y0 - pad > h) continue;
        const on = hc === ci, dimmed = dimming && !on;
        const m = fadeK * (dimmed ? 0.5 : 1);
        const tab = on ? LIME_F : HULL_F;
        ctx.beginPath();
        ctx.moveTo(hull[0] * k + tx, hull[1] * k + ty);
        if (hn === 1) ctx.lineTo(hull[0] * k + tx + 0.01, hull[1] * k + ty);
        for (let q = 1; q < hn; q++) ctx.lineTo(hull[q * 2] * k + tx, hull[q * 2 + 1] * k + ty);
        ctx.closePath();
        ctx.lineWidth = pad * 2;
        ctx.strokeStyle = fa(tab, (on ? 0.1 : 0.05) * m);
        ctx.stroke();
        ctx.fillStyle = fa(tab, (on ? 0.06 : 0.04) * m);
        ctx.fill();
        // a thin rim so the blob has an edge instead of fading into the grid
        ctx.lineWidth = pad * 2 + 2;
        ctx.strokeStyle = fa(tab, (on ? 0.22 : 0.09) * m);
        ctx.save(); ctx.globalCompositeOperation = "destination-over"; ctx.stroke(); ctx.restore();
      }
    }
    // the active tree's boundary at any zoom (small trees have no hull)
    if (hc >= 0) {
      const c = clusters[hc];
      if (c.anchored && c.cr * k >= 6) { ctx.beginPath(); ctx.arc(c.ccx * k + tx, c.ccy * k + ty, c.cr * k, 0, Math.PI * 2); ctx.lineWidth = 1; ctx.strokeStyle = ca(LIME_A, 0.22); ctx.stroke(); }
    }
  }

  // ---- links: one path per parent colour (dimmed ones apart), the hovered ones on top with a
  // gradient; dots travel child → parent (buys flow upward), batched by colour and fade bucket, and
  // only on pairs whose child traded in the last 30 min. A link into a speck is not drawn: at that
  // size it is only noise, and it is what bounds the work when 20 k bubbles are on screen.
  ctx.lineCap = "round";
  for (let q = 0; q < 8; q++) linkPaths[q] = null;
  for (let q = 0; q < 12; q++) dotPaths[q] = null;
  let hotN = 0, visibleLinks = 0;
  const { lsrc, ldst, lseed, m, lastTrade } = st;
  const speed = 0.00022; // cycles per ms; ~4.5 s to travel a link
  const wantDots = !s.static && !dimming;
  const wallNow = Date.now(), recentAfter = wallNow - DOT_RECENT_MS;
  for (let l = 0; l < m; l++) {
    const a = lsrc[l], b = ldst[l];
    const ga = growOf(born[a], now, STILL), gb = growOf(born[b], now, STILL);
    if (ga <= 0 || gb <= 0) continue;
    const rb = r[b] * k * gb;
    const on = dimming && (a === hov || b === hov);
    if (!on && rb < 1.5) continue;
    const ax = x[a] * k + tx, ay = y[a] * k + ty, bx = x[b] * k + tx, by = y[b] * k + ty;
    if ((ax < -40 && bx < -40) || (ay < -40 && by < -40) || (ax > w + 40 && bx > w + 40) || (ay > h + 40 && by > h + 40)) continue;
    const dx = bx - ax, dy = by - ay, len = Math.sqrt(dx * dx + dy * dy);
    if (len < 1) continue;
    const ra = r[a] * k * ga;
    const inner = len - ra - rb;
    if (inner < 2) continue;
    if (on) { if (hotN < HOT_CAP) s.hot[hotN++] = l; continue; }
    const ux = dx / len, uy = dy / len;
    const x0 = ax + ux * ra, y0 = ay + uy * ra, x1 = bx - ux * rb, y1 = by - uy * rb;
    const ci = color[a];
    const faint = hl && !(flags[a] & F_MATCH) && !(flags[b] & F_MATCH);
    const pk = ci + (faint ? 4 : 0);
    let p = linkPaths[pk]; if (!p) { p = new Path2D(); linkPaths[pk] = p; }
    p.moveTo(x0, y0); p.lineTo(x1, y1);
    visibleLinks++;
    if (!wantDots || faint || inner < 24 || visibleLinks > MAX_DOT_LINKS || lastTrade[b] < recentAfter) continue;
    const nDots = inner > 140 ? 3 : inner > 70 ? 2 : 1;
    for (let q = 0; q < nDots; q++) {
      const prog = 1 - ((now * speed + lseed[l] + q / nDots) % 1); // 1 → 0 = child → parent
      const px = x0 + (x1 - x0) * prog, py = y0 + (y1 - y0) * prog;
      const fade = Math.sin(prog * Math.PI);
      const bucket = fade < 0.35 ? 0 : fade < 0.75 ? 1 : 2;
      const dk = ci * 3 + bucket;
      let dp = dotPaths[dk]; if (!dp) { dp = new Path2D(); dotPaths[dk] = dp; }
      dp.moveTo(px + 1.6, py); dp.arc(px, py, 1.6, 0, Math.PI * 2);
    }
  }
  ctx.lineWidth = 1;
  for (let pk = 0; pk < 8; pk++) { const p = linkPaths[pk]; if (p) { ctx.strokeStyle = ca(COLOR_A[pk & 3], pk >= 4 || dimming ? 0.05 : 0.3); ctx.stroke(p); } }
  for (let dk = 0; dk < 12; dk++) { const p = dotPaths[dk]; if (p) { ctx.fillStyle = DOT_STYLE[dk]; ctx.fill(p); } }
  for (let q = 0; q < hotN; q++) {
    const l = s.hot[q], a = lsrc[l], b = ldst[l];
    const ax = x[a] * k + tx, ay = y[a] * k + ty, bx = x[b] * k + tx, by = y[b] * k + ty;
    const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy); const ux = dx / len, uy = dy / len;
    const ra = r[a] * k * growOf(born[a], now, STILL), rb = r[b] * k * growOf(born[b], now, STILL);
    const x0 = ax + ux * ra, y0 = ay + uy * ra, x1 = bx - ux * rb, y1 = by - uy * rb;
    const grad = ctx.createLinearGradient(x0, y0, x1, y1);
    grad.addColorStop(0, ca(COLOR_A[color[a]], 0.9)); grad.addColorStop(1, ca(COLOR_A[color[b]], 0.7));
    ctx.strokeStyle = grad; ctx.lineWidth = 1.8;
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    if (s.static) continue;
    const inner = len - ra - rb;
    const nDots = Math.max(1, Math.min(4, Math.round(inner / 70)));
    const tab = COLOR_A[color[a]];
    for (let i = 0; i < nDots; i++) {
      const prog = 1 - ((now * speed + lseed[l] + i / nDots) % 1);
      const px = x0 + (x1 - x0) * prog, py = y0 + (y1 - y0) * prog;
      ctx.fillStyle = ca(tab, 0.9 * Math.sin(prog * Math.PI));
      ctx.beginPath(); ctx.arc(px, py, 2.2, 0, Math.PI * 2); ctx.fill();
    }
  }

  // ---- trade fx: ripples, flashes and comets under the bubbles
  s.perf.fx = drawFx(ctx, s.fx, st, s.sprites, k, tx, ty, w, h, now, s.static);

  // ---- bubbles, smallest first so big bubbles and their labels sit on top. Under a highlight the
  // dimmed non-matches go first and the matches over them (two globalAlpha levels per frame).
  curAlpha = 1; ctx.globalAlpha = 1;
  drawnN = 0; beaconN = 0;
  for (let q = 0; q < 16; q++) speckPaths[q] = null;
  if (hl) { bubblePass(ctx, s, 1); fillSpecks(ctx); bubblePass(ctx, s, 2); }
  else { bubblePass(ctx, s, 0); fillSpecks(ctx); }
  if (curAlpha !== 1) { ctx.globalAlpha = 1; curAlpha = 1; }
  s.perf.drawn = drawnN;

  // ---- Spore beacons: a lime ring and a breathing halo around every visible Spore launch
  if (beaconN) {
    const breathe = s.static ? 0 : 2 * Math.sin(now / 600);
    let ring: Path2D | null = null, halo: Path2D | null = null, dim: Path2D | null = null;
    for (let q = 0; q < beaconN; q++) {
      const bx = beaconX[q], by = beaconY[q], br = beaconR[q];
      if (beaconDim[q]) { if (!dim) dim = new Path2D(); dim.moveTo(bx + br + 3, by); dim.arc(bx, by, br + 3, 0, Math.PI * 2); continue; }
      if (!ring) { ring = new Path2D(); halo = new Path2D(); }
      ring.moveTo(bx + br + 3, by); ring.arc(bx, by, br + 3, 0, Math.PI * 2);
      const hr = br + 6 + breathe; halo!.moveTo(bx + hr, by); halo!.arc(bx, by, hr, 0, Math.PI * 2);
    }
    if (ring) { ctx.lineWidth = 1.6; ctx.strokeStyle = BEACON_RING; ctx.stroke(ring); ctx.lineWidth = 1; ctx.strokeStyle = BEACON_HALO; ctx.stroke(halo!); }
    if (dim) { ctx.lineWidth = 1.2; ctx.strokeStyle = BEACON_DIM; ctx.stroke(dim); }
  }
  s.perf.beacons = beaconN;

  // ---- labels: the three special bubbles first, then cluster titles (overview), then biggest-first
  // bubble labels; a label that would sit on another is dropped so dense clusters stay readable
  // (hover still names everything).
  rectN = 0; labelsN = 0; suppN = 0;
  if (supp.length < st.cap) supp = new Uint8Array(st.cap);
  if (hov >= 0) putLabel(ctx, s, hov, true, true, 1);
  if (SEL >= 0 && SEL !== hov) putLabel(ctx, s, SEL, true, true, 1);
  if (s.focusIdx >= 0 && s.focusIdx !== hov && s.focusIdx !== SEL) putLabel(ctx, s, s.focusIdx, true, true, 1);
  s.perf.titles = s.focus ? 0 : titlePass(ctx, s, hc);
  const minWorldR = LABEL_R / k;
  const always = ALWAYS_LABELS;
  for (let oi = n - 1; oi >= 0 && labelsN < MAX_LABELS; oi--) {
    const i = order[oi];
    if (i === hov || i === SEL || i === s.focusIdx) continue;
    if (hl && !(flags[i] & F_MATCH)) continue;
    const srT = st.rT[i] * k;
    const special = (s.focusIdx >= 0 && parent[i] === s.focusIdx) || ((flags[i] & F_ANC) !== 0 && srT >= 6);
    if (st.rT[i] < minWorldR && !special) {
      if (srT < 3) break;                                          // biggest-first: everything after is smaller
      if (labelsN >= always) { if (srT < 6) break; continue; }
      if (!supp[i]) putLabel(ctx, s, i, false, false, 1);          // one of the biggest on screen: named anyway
      continue;
    }
    if (supp[i]) continue;                                         // its tree's title names it
    putLabel(ctx, s, i, false, false, special ? 1 : Math.min(1, Math.max(0, (srT - (LABEL_R - 3)) / 6)));
  }
  for (let q = 0; q < suppN; q++) supp[suppList[q]] = 0;
  s.perf.labels = labelsN;
  s.perf.built = builds;

  // tooltip follows its node (or the hovered tree's title) while the layout is still moving
  const tipNode = s.pinned >= 0 ? s.pinned : s.hover;
  if (tip) {
    if (tipNode >= 0) {
      const px = x[tipNode] * k + tx, py = y[tipNode] * k + ty - r[tipNode] * k - 10;
      const flip = py < 150;
      tip.style.transform = `translate(${Math.round(Math.max(90, Math.min(w - 90, px)))}px, ${Math.round(flip ? py + r[tipNode] * k * 2 + 20 : py)}px) translate(-50%, ${flip ? "0" : "-100%"})`;
    } else if (s.hoverCluster >= 0 && s.hoverCluster < clusters.length) {
      const c = clusters[s.hoverCluster];
      const px = c.ccx * k + tx, top = c.minY * k + ty - 26;
      const flip = top < 150;
      const py = flip ? (c.ccy + c.cr) * k + ty + 10 : top;
      tip.style.transform = `translate(${Math.round(Math.max(90, Math.min(w - 90, px)))}px, ${Math.round(py)}px) translate(-50%, ${flip ? "0" : "-100%"})`;
    }
  }
  if (!s.perf.firstPaintAt && drawnN > 0) s.perf.firstPaintAt = now;
  // headless QA (web/test/map-perf.mts) reads the renderer's counters of the last drawn map
  if (DEBUG_HOOKS) (globalThis as { __sporeRender?: Perf }).__sporeRender = s.perf;
}

function fillSpecks(ctx: CanvasRenderingContext2D) {
  if (curAlpha !== 1) { ctx.globalAlpha = 1; curAlpha = 1; }
  for (let key = 0; key < 16; key++) { const p = haloPaths[key]; if (p) { ctx.fillStyle = SMALL_HALO[key]; ctx.fill(p); haloPaths[key] = null; } }
  ctx.lineWidth = 1.1;
  for (let key = 0; key < 16; key++) { const p = smallPaths[key]; if (p) { ctx.fillStyle = SMALL_FILL[key]; ctx.fill(p); ctx.strokeStyle = SMALL_RING[key]; ctx.stroke(p); smallPaths[key] = null; } }
  for (let key = 0; key < 16; key++) { const p = speckPaths[key]; if (p) { ctx.fillStyle = SPECK_STYLE[key]; ctx.fill(p); speckPaths[key] = null; } }
}

/// One pass over the draw order. which: 0 every node, 1 highlight non-matches (dimmed), 2 matches.
function bubblePass(ctx: CanvasRenderingContext2D, s: State, which: 0 | 1 | 2) {
  const st = s.store, n = st.n;
  const { x, y, r, order, flags, color, rel, born, pulse, gen } = st;
  const k = K, tx = TX, ty = TY, w = W, h = H, now = NOW, hov = HOV, sel = SEL;
  const sprites = s.sprites;
  for (let oi = 0; oi < n; oi++) {
    const i = order[oi];
    const fl = flags[i];
    if (which !== 0 && ((fl & F_MATCH) !== 0) !== (which === 2)) continue;
    const g = growOf(born[i], now, STILL);
    if (g <= 0) continue;
    let sr = r[i] * k * g;
    const ours = (fl & F_OURS) !== 0;
    if (ours) { if (sr < BEACON_R) sr = BEACON_R; } else if (which === 2 && sr < SPECK_R) sr = SPECK_R;
    const sx = x[i] * k + tx, sy = y[i] * k + ty;
    const ext = sr * GLOW + 2;
    if (sx + ext < 0 || sy + ext < 0 || sx - ext > w || sy - ext > h) continue;
    drawnN++;
    const on = i === hov;
    const isFocus = (fl & F_FOCUS) !== 0;
    const hdim = DIMMING && !rel[i] && !on;
    const ldim = which === 1;
    // pulse ring for a freshly spawned child
    if (pulse[i]) {
      if (now - pulse[i] < PULSE_MS && !STILL) {
        const u = (now - pulse[i]) / PULSE_MS;
        if (curAlpha !== 1) { ctx.globalAlpha = 1; curAlpha = 1; }
        ctx.strokeStyle = ca(COLOR_A[color[i]], (1 - u) * 0.9); ctx.lineWidth = 2 * (1 - u) + 0.5;
        ctx.beginPath(); ctx.arc(sx, sy, sr + 4 + u * 48, 0, Math.PI * 2); ctx.stroke();
      } else pulse[i] = 0;
    }
    if (ours && beaconN < BEACON_CAP) { beaconX[beaconN] = sx; beaconY[beaconN] = sy; beaconR[beaconN] = sr; beaconDim[beaconN] = hdim || ldim ? 1 : 0; beaconN++; }
    if (sr < SPECK_R && !on && !isFocus && i !== sel) {
      const sz = Math.max(1.2, sr * 2);
      const key = color[i] + (hdim ? 4 : 0) + (ldim ? 8 : 0);
      let p = speckPaths[key]; if (!p) { p = new Path2D(); speckPaths[key] = p; }
      p.rect(sx - sz / 2, sy - sz / 2, sz, sz);
      continue;
    }
    const a = (hdim ? 0.28 : 1) * (ldim ? 0.15 : 1);
    if (a !== curAlpha) { ctx.globalAlpha = a; curAlpha = a; }
    const bits = (fl & F_ANC ? SB_ANC : 0) | (fl & F_MIG ? SB_MIG : 0);
    const ci = color[i];
    if (on || isFocus || i === sel) { slowPath(ctx, s, i, sx, sy, sr, on, isFocus, a); continue; }
    const ri = bucketR(sr);
    if (sr < SMALL_R) {
      // small tier: batched vectors (a blit costs ~3.5 µs in software raster, an arc in a shared
      // path a fraction of that): halo + body + ring per colour and dim level, flushed with the specks
      if (!(bits & SB_ANC)) {
        const key = ((hdim ? 1 : 0) + (ldim ? 2 : 0)) * 4 + ci;
        let p = smallPaths[key]; if (!p) { p = new Path2D(); smallPaths[key] = p; }
        p.moveTo(sx + sr, sy); p.arc(sx, sy, sr, 0, TAU);
        let hp = haloPaths[key]; if (!hp) { hp = new Path2D(); haloPaths[key] = hp; }
        const hr = sr * HALO_R; hp.moveTo(sx + hr, sy); hp.arc(sx, sy, hr, 0, TAU);
        continue;
      }
      const sp = sharedSprite(sprites, ri, ci, bits);
      const dw = sp.width * (sr / ri);
      ctx.drawImage(sp, sx - dw / 2, sy - dw / 2, dw, dw);
      continue;
    }
    const d = st.data[i];
    const img = sr >= IMG_R && d.image ? imgFor(d.image, Math.ceil(2 * sr * DPR)) : null;
    if (ri > MAX_SPRITE_R) { drawBig(ctx, s, i, sx, sy, sr, img, bits); continue; }
    let sp: HTMLCanvasElement | null = null, spR = ri;
    if (img) {
      const cur = st.spr[i];
      if (cur && st.sprRi[i] === ri && st.sprImg[i] === img && st.sprGen[i] === gen[i] && st.sprBits[i] === bits) sp = cur;
      else if (canBuild()) {
        sp = renderBody(ri, COLORS[ci], img, "", bits, true); spend();
        if (!st.sprImg[i]) st.sprRingW = ringPush(st.sprRing, st.sprRingW, i, (j) => { if (st.sprImg[j]) { st.spr[j] = null; st.sprImg[j] = null; } });
        st.spr[i] = sp; st.sprRi[i] = ri; st.sprImg[i] = img; st.sprGen[i] = gen[i]; st.sprBits[i] = bits;
      } else if (cur && st.sprImg[i] && st.sprGen[i] === gen[i]) { sp = cur; spR = st.sprRi[i]; } // this coin's last logo (any size or thumbnail), scaled: no letter flash
    }
    if (!sp) {
      const code = st.letterCode(i);
      let lsp = sprites.letter.get(letterKey(code, ci, ri, bits)) ?? null;
      if (!lsp && canBuild()) { lsp = letterSprite(sprites, code, ci, ri, bits); spend(); }
      if (lsp) {
        sp = lsp;
        if (!st.sprImg[i]) { st.spr[i] = lsp; st.sprRi[i] = ri; st.sprBits[i] = bits; }
      } else if (st.spr[i]) { sp = st.spr[i]; spR = st.sprRi[i]; }
      else sp = sharedSprite(sprites, ri, ci, bits);
    }
    const dw = sp!.width * (sr / spR);
    ctx.drawImage(sp!, sx - dw / 2, sy - dw / 2, dw, dw);
  }
}

/// A bubble too big for a cached sprite: the shared glow scaled, then fill, logo or letter, ring.
function drawBig(ctx: CanvasRenderingContext2D, s: State, i: number, sx: number, sy: number, sr: number, img: CanvasImageSource | null, bits: number) {
  const st = s.store, ci = st.color[i], tab = COLOR_A[ci];
  const glow = sharedSprite(s.sprites, MAX_SPRITE_R, ci, 0);
  const gw = glow.width * (sr / MAX_SPRITE_R);
  ctx.drawImage(glow, sx - gw / 2, sy - gw / 2, gw, gw);
  if (img) {
    ctx.save(); ctx.beginPath(); ctx.arc(sx, sy, sr - 0.5, 0, Math.PI * 2); ctx.clip();
    ctx.drawImage(img, sx - sr, sy - sr, sr * 2, sr * 2);
    ctx.fillStyle = ca(tab, 0.15); ctx.fillRect(sx - sr, sy - sr, sr * 2, sr * 2);
    ctx.restore();
  } else {
    ctx.fillStyle = COLORS[ci]; ctx.font = letterFont(Math.round(sr * 0.9)); ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(String.fromCharCode(st.letterCode(i)), sx, sy + 0.5);
  }
  const anc = (bits & SB_ANC) !== 0;
  ctx.beginPath(); ctx.arc(sx, sy, sr, 0, Math.PI * 2);
  ctx.strokeStyle = ca(tab, anc ? 0.95 : 0.8); ctx.lineWidth = 1.1;
  if (anc) ctx.setLineDash([4, 4]);
  ctx.stroke();
  if (anc) ctx.setLineDash([]);
  if (bits & SB_MIG) drawCap(ctx, sx, sy, sr);
}

/// The hovered / selected / focused bubble: gradients, clipping and rings drawn live.
function slowPath(ctx: CanvasRenderingContext2D, s: State, i: number, sx: number, sy: number, sr: number, on: boolean, isFocus: boolean, a: number) {
  const st = s.store, d = st.data[i], ci = st.color[i], tab = COLOR_A[ci];
  const anc = (st.flags[i] & F_ANC) !== 0;
  const gr = Math.min(MAX_SPRITE_R, bucketR(Math.max(3, sr)));
  const glow = sharedSprite(s.sprites, gr, ci, 0);
  const gw = glow.width * (sr / gr);
  ctx.globalAlpha = on ? 1 : 0.9; ctx.drawImage(glow, sx - gw / 2, sy - gw / 2, gw, gw); ctx.globalAlpha = a; curAlpha = a;
  ctx.beginPath(); ctx.arc(sx, sy, sr, 0, Math.PI * 2);
  ctx.fillStyle = ca(tab, on ? 0.34 : 0.2); ctx.fill();
  const img = sr >= 7 ? imgFor(d.image, Math.ceil(2 * sr * DPR)) : null;
  if (img) {
    ctx.save(); ctx.beginPath(); ctx.arc(sx, sy, sr - 0.5, 0, Math.PI * 2); ctx.clip();
    ctx.drawImage(img, sx - sr, sy - sr, sr * 2, sr * 2);
    ctx.fillStyle = ca(tab, on ? 0.08 : 0.14); ctx.fillRect(sx - sr, sy - sr, sr * 2, sr * 2);
    ctx.restore();
  } else if (sr >= 7) {
    ctx.fillStyle = COLORS[ci]; ctx.font = letterFont(Math.max(9, Math.round(sr * 0.9))); ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(String.fromCharCode(st.letterCode(i)), sx, sy + 0.5);
  }
  ctx.beginPath(); ctx.arc(sx, sy, sr, 0, Math.PI * 2);
  ctx.strokeStyle = on ? "#ffffff" : ca(tab, anc ? 0.95 : 0.8); ctx.lineWidth = on ? 2 : isFocus ? 1.6 : 1.1;
  if (anc) ctx.setLineDash([4, 4]);
  ctx.stroke(); ctx.setLineDash([]);
  if (st.flags[i] & F_MIG && sr >= 7) drawCap(ctx, sx, sy, sr);
  if (isFocus || i === SEL) {
    // slowly rotating dashed accent ring marks "you are here" / the selection
    ctx.save(); ctx.translate(sx, sy); ctx.rotate(s.static ? 0 : (NOW / 9000) % (Math.PI * 2));
    ctx.beginPath(); ctx.arc(0, 0, sr + 7, 0, Math.PI * 2); ctx.strokeStyle = i === SEL && !isFocus ? "rgba(255,255,255,.9)" : ca(LIME_A, 0.9); ctx.lineWidth = 1.5; ctx.setLineDash([3, 6]); ctx.stroke();
    ctx.restore(); ctx.setLineDash([]);
  }
}

/// Title bitmap height (sprites.titleSprite) and a width estimate from the text (mono: 0.6 em per
/// character, wide scripts 1 em) so a title is culled before its bitmap is built.
const TITLE_H = 20;
const titleWidth = (text: string, compact: boolean) => {
  const end = compact && text.lastIndexOf(" · ") >= 0 ? text.lastIndexOf(" · ") : text.length;
  let w = 10; for (let q = 0; q < end; q++) w += text.charCodeAt(q) >= 0x2e80 ? (compact ? 12 : 13) : compact ? 7.2 : 7.7;
  return Math.ceil(w);
};

const overlaps = (rects: Float32Array, x0: number, y0: number, x1: number, y1: number) => {
  for (let q = 0; q < rectN; q++) { const o = q * 4; if (rects[o] < x1 && rects[o + 2] > x0 && rects[o + 1] < y1 && rects[o + 3] > y0) return true; }
  return false;
};
const reserve = (rects: Float32Array, x0: number, y0: number, x1: number, y1: number) => {
  if (rectN >= RECTS) return;
  const o = rectN * 4; rects[o] = x0; rects[o + 1] = y0; rects[o + 2] = x1; rects[o + 3] = y1; rectN++;
};

/// One bubble label from the node's cached bitmap (built on demand within the frame's budget; forced
/// labels — hovered, selected, focused — are exempt from both the budget and the overlap test).
function putLabel(ctx: CanvasRenderingContext2D, s: State, i: number, big: boolean, force: boolean, alpha: number): boolean {
  if (labelsN >= MAX_LABELS || alpha <= 0.02) return false;
  const st = s.store;
  const g = growOf(st.born[i], NOW, STILL);
  if (g <= 0.6) return false;
  const sx = st.x[i] * K + TX, sy = st.y[i] * K + TY, sr = effR(s, i, st.r[i] * K * g);
  if (sx < -60 || sy < -40 || sx > W + 60 || sy > H + 20) return false;
  const d = st.data[i];
  const isFocus = (st.flags[i] & F_FOCUS) !== 0;
  const variant = isFocus ? 2 : big ? 1 : 0;
  let sp = st.labelSp[i];
  if (!sp || st.labelOwner[i] !== d || st.labelVariant[i] !== variant) {
    if (!force && !canBuild()) return false;
    sp = renderLabel(labelOf(d.symbol, d.name, d.mint), big, isFocus ? COLORS[0] : big ? "#ffffff" : "#d8e8da");
    if (!force) spend();
    if (!st.labelSp[i]) st.labelRingW = ringPush(st.labelRing, st.labelRingW, i, (j) => { st.labelSp[j] = null; st.labelOwner[j] = null; });
    st.labelSp[i] = sp; st.labelOwner[i] = d; st.labelVariant[i] = variant;
  }
  const lx = sx - sp.width / 2, ly = sy + sr + (isFocus ? 10 : 3);
  const x0 = lx + 2, y0 = ly + 1, x1 = lx + sp.width - 2, y1 = ly + sp.height - 1;
  const rects = s.labelRects;
  if (!force && overlaps(rects, x0, y0, x1, y1)) return false;
  reserve(rects, x0, y0, x1, y1); labelsN++;
  const dim = DIMMING && !st.rel[i] && i !== HOV;
  const a = alpha * (dim ? 0.3 : 1);
  if (a !== 1) ctx.globalAlpha = a;
  ctx.drawImage(sp, Math.round(lx), Math.round(ly));
  if (a !== 1) ctx.globalAlpha = 1;
  return true;
}

/// Cluster titles at overview zoom: biggest trees first, each above its tree's top edge, culled
/// against each other and the forced labels; the active tree's title always shows (lime). A title
/// fades out as its root grows big enough to carry its own label, and suppresses that label meanwhile.
function titlePass(ctx: CanvasRenderingContext2D, s: State, hc: number): number {
  const st = s.store, cl = st.clusters, order = st.titleOrder, perf = s.perf;
  const compact = W < 600;
  const maxT = Math.min(perf.titleIdx.length, compact ? MAX_TITLES_PHONE : MAX_TITLES);
  // narrow screens: trees are smaller at fit, so titles (ticker only) start at 10 px instead of 14
  const lo = compact ? 10 : 14, full = compact ? 16 : 22;
  let shown = 0;
  const one = (ci: number, active: boolean) => {
    const c = cl[ci];
    if (!c || !c.anchored || c.root < 0 || c.root >= st.n) return;
    const scr = c.cr * K;
    const rootR = st.r[c.root] * K;
    let a: number;
    if (active) { if (scr < 6 || rootR >= 20) return; a = 1; }
    else {
      if (scr < lo || scr > 260) return;
      a = smoothstep(lo, full, scr) * (1 - smoothstep(12, 20, rootR));
      if (a < 0.05) return;
    }
    if (c.tspText !== c.title || c.tspC !== compact) { c.tsp = null; c.tspA = null; c.tspText = c.title; c.tspC = compact; c.tspW = titleWidth(c.title, compact); }
    let sp = active ? c.tspA : c.tsp;
    // cull on the bitmap's size, or its estimate before it exists: only titles that will show are built
    const sw = sp ? sp.width : c.tspW ?? 120;
    const ax = c.ccx * K + TX, ay = c.minY * K + TY - 4;
    const x0 = ax - sw / 2 + 4, x1 = ax + sw / 2 - 4, y0 = ay - TITLE_H + 2, y1 = ay - 1;
    if (x1 < 0 || x0 > W || y1 < 0 || y0 > H) return;
    const rects = s.labelRects;
    if (!active && overlaps(rects, x0, y0, x1, y1)) return;
    if (!sp) {
      if (!active && !canBuild()) return;
      sp = titleSprite(s.sprites, c.id, c.title, active, compact);
      if (!active) spend();
      if (active) c.tspA = sp; else c.tsp = sp;
    }
    reserve(rects, ax - sp.width / 2 + 4, y0, ax + sp.width / 2 - 4, y1);
    const alpha = a * (active ? 1 : 0.9) * (HL ? 0.6 : 1);
    ctx.globalAlpha = alpha;
    ctx.drawImage(sp, Math.round(ax - sp.width / 2), Math.round(ay - sp.height));
    ctx.globalAlpha = 1;
    perf.titleIdx[shown++] = ci;
    if (a > 0.5 && suppN < suppList.length) { supp[c.root] = 1; suppList[suppN++] = c.root; }
  };
  if (hc >= 0) one(hc, true);
  for (let q = 0; q < order.length && shown < maxT; q++) { const ci = order[q]; if (ci !== hc) one(ci, false); }
  return shown;
}

// d3-zoom wants a selection; this is the one place the draw loop touches d3's DOM side.
const selectCanvas = (cv: HTMLCanvasElement) => select(cv);
export type { Flight } from "./camera";
