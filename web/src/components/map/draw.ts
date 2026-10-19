// The per-frame draw of the bubble map, written to allocate nothing per node: positions are
// interpolated into the store's typed arrays, bubbles are blitted from cached sprites, specks (sub-
// 2.5 px bubbles) are batched into a handful of Path2D fills, links into one path per colour, and
// labels are cached bitmaps culled against a fixed-size rect buffer. Only the hovered, selected and
// focused bubbles take the slow path (gradients, clipping, dashed rings), and there are at most three.
import { easeCubicOut, zoomIdentity, type ZoomBehavior, type ZoomTransform } from "d3";
import { imageFor } from "../../lib/map/images";
import type { SizeMode } from "../../lib/map/types";
import { COLORS, F_ANC, F_FOCUS, F_OURS, MapStore } from "./store";
import { GLOW, bucketR, gridPattern, labelOf, labelSprite, letterOf, nodeSprite, rgba, sharedSprite, type SpriteSet } from "./sprites";

export const GROW_MS = 700, PULSE_MS = 1_800, TWEEN_MS = 600;
/// Every bubble at least this big on screen gets its ticker (DESIGN §11.5), at most MAX_LABELS of them.
export const LABEL_R = 9, MAX_LABELS = 160, IMG_R = 9, SPECK_R = 2.5, SMALL_R = 7;
/// The biggest bubbles are named at any zoom (owner 2026-10-19: names must be readable on open, even
/// when the whole forest is in view and nothing reaches LABEL_R); overlap culling still applies.
export const ALWAYS_LABELS = 36;
const MAX_DOT_LINKS = 6000, HOT_CAP = 512;
const FADE = [0.18, 0.4, 0.6];

export type Perf = { frames: number; settling: Float32Array; settled: Float32Array; si: number; di: number; sn: number; dn: number; max: number; labels: number; drawn: number; firstPaintAt: number; dataAt: number; mountedAt: number };
export const makePerf = (): Perf => ({ frames: 0, settling: new Float32Array(900), settled: new Float32Array(900), si: 0, di: 0, sn: 0, dn: 0, max: 0, labels: 0, drawn: 0, firstPaintAt: 0, dataAt: 0, mountedAt: performance.now() });

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
};

const easeBack = (t: number) => { const c = 1.4; const u = t - 1; return 1 + (c + 1) * u * u * u + c * u * u; };

export const centerOn = (s: State, i: number, k: number) => {
  const il = s.inset?.left ?? 0, it = s.inset?.top ?? 0, ib = s.inset?.bottom ?? 0, ir = s.inset?.right ?? 0;
  return zoomIdentity.translate(il + (s.w - il - ir) / 2 - k * s.store.nx[i], it + (s.h - it - ib) / 2 - k * s.store.ny[i]).scale(k);
};

export function fitFor(s: State, pad: number): ZoomTransform | null {
  const st = s.store, n = st.n;
  if (!n) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < n; i++) { const r = st.rT[i], x = st.nx[i], y = st.ny[i]; if (x - r < x0) x0 = x - r; if (y - r < y0) y0 = y - r; if (x + r > x1) x1 = x + r; if (y + r > y1) y1 = y + r; }
  if (!Number.isFinite(x0)) return null;
  const il = s.inset?.left ?? 0, it = s.inset?.top ?? 0, ib = s.inset?.bottom ?? 0, ir = s.inset?.right ?? 0;
  const vw = Math.max(1, s.w - il - ir), vh = Math.max(1, s.h - it - ib);
  const bw = Math.max(1, x1 - x0 + pad * 2), bh = Math.max(1, y1 - y0 + pad * 2 + 18);
  const k = Math.min(s.focus ? 1.9 : 3, Math.min(vw / bw, vh / bh));
  return zoomIdentity.translate(il + vw / 2 - k * (x0 + x1) / 2, it + vh / 2 - k * (y0 + y1) / 2).scale(k);
}

/// Topmost bubble under a screen point (draw order is small-first, so scan from the end), or -1.
export function hitTest(s: State, sx: number, sy: number): number {
  const st = s.store, t = s.t;
  const wx = (sx - t.x) / t.k, wy = (sy - t.y) / t.k, slack = 4 / t.k;
  const { order, x, y, r } = st;
  for (let oi = st.n - 1; oi >= 0; oi--) { const i = order[oi]; const dx = x[i] - wx, dy = y[i] - wy, rr = r[i] + slack; if (dx * dx + dy * dy <= rr * rr) return i; }
  return -1;
}

export function draw(ctx: CanvasRenderingContext2D, s: State, tip: HTMLDivElement | null, now: number) {
  const st = s.store, n = st.n, { w, h, dpr } = s;
  const settling = !st.settled;
  const { x, y, r, order, flags, color, rel, parent, born, pulse } = st;
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
  // ---- camera: auto-fit while the layout finds its shape, or follow a selected node until it stops
  // moving; either ends the moment the user takes the wheel.
  const lerp = (target: ZoomTransform, a: number) => { const t = s.t; s.t = zoomIdentity.translate(t.x + (target.x - t.x) * a, t.y + (target.y - t.y) * a).scale(t.k + (target.k - t.k) * a); };
  if (s.follow) {
    if (s.follow.i < 0 || s.follow.i >= n) s.follow = null;
    else {
      const target = centerOn(s, s.follow.i, s.follow.k);
      lerp(target, 0.14);
      const close = Math.abs(target.x - s.t.x) < 0.5 && Math.abs(target.y - s.t.y) < 0.5 && Math.abs(target.k - s.t.k) < 0.001;
      if ((!settling && close) || s.static) { s.t = target; s.follow = null; }
      if (s.zoom) s.zoom.transform(selectCanvas(ctx.canvas), s.t);
    }
  } else if (s.autoFit && n) {
    const target = fitFor(s, 36);
    if (target) {
      lerp(target, 0.12);
      if (!settling || s.static) { s.t = target; s.autoFit = false; }
      if (s.zoom) s.zoom.transform(selectCanvas(ctx.canvas), s.t);
    }
  }
  const t = s.t, k = t.k, tx = t.x, ty = t.y;
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
  const grown = (i: number) => { const b = born[i]; if (s.static || !b) return 1; const u = (now - b) / GROW_MS; return u <= 0 ? 0 : u >= 1 ? 1 : easeBack(u); };

  // ---- tree hulls: one soft blob per big cluster, hugging where its members are (hull of the
  // member centres stroked with a fat round-joined line, which pads it into a rounded shape).
  if (!s.focus) {
    ctx.lineJoin = "round"; ctx.lineCap = "round";
    const clusters = st.clusters;
    const hovCluster = hov >= 0 ? st.cluster[hov] : -1;
    for (let ci = 0; ci < clusters.length; ci++) {
      const c = clusters[ci];
      if (!c.big || c.hullN === 0) continue;
      const hull = c.hull, hn = c.hullN;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let q = 0; q < hn; q++) { const px = hull[q * 2] * k + tx, py = hull[q * 2 + 1] * k + ty; if (px < x0) x0 = px; if (py < y0) y0 = py; if (px > x1) x1 = px; if (py > y1) y1 = py; }
      const pad = (c.maxR + 14) * k;
      if (x1 + pad < 0 || y1 + pad < 0 || x0 - pad > w || y0 - pad > h) continue;
      const on = hovCluster === ci, dimmed = dimming && !on;
      ctx.beginPath();
      ctx.moveTo(hull[0] * k + tx, hull[1] * k + ty);
      if (hn === 1) ctx.lineTo(hull[0] * k + tx + 0.01, hull[1] * k + ty);
      for (let q = 1; q < hn; q++) ctx.lineTo(hull[q * 2] * k + tx, hull[q * 2 + 1] * k + ty);
      ctx.closePath();
      ctx.lineWidth = pad * 2;
      ctx.strokeStyle = rgba(c.hue, dimmed ? 0.025 : on ? 0.13 : 0.06);
      ctx.stroke();
      ctx.fillStyle = rgba(c.hue, dimmed ? 0.02 : on ? 0.1 : 0.05);
      ctx.fill();
      // a thin rim so the blob has an edge instead of fading into the grid
      ctx.lineWidth = pad * 2 + 2;
      ctx.strokeStyle = rgba(c.hue, dimmed ? 0.03 : on ? 0.3 : 0.11);
      ctx.save(); ctx.globalCompositeOperation = "destination-over"; ctx.stroke(); ctx.restore();
    }
  }

  // ---- links: one path per parent colour (dimmed ones apart), the hovered ones on top with a
  // gradient; dots travel child → parent (buys flow upward), batched by colour and fade bucket.
  // A link into a speck is not drawn: at that size it is only noise, and it is what bounds the work
  // when 20 k bubbles are on screen.
  ctx.lineCap = "round";
  const paths: (Path2D | null)[] = [null, null, null, null], dots: (Path2D | null)[] = new Array(12).fill(null);
  let hotN = 0, visibleLinks = 0;
  const { lsrc, ldst, lseed, m } = st;
  const speed = 0.00022; // cycles per ms; ~4.5 s to travel a link
  const wantDots = !s.static && !dimming;
  for (let l = 0; l < m; l++) {
    const a = lsrc[l], b = ldst[l];
    const ga = grown(a), gb = grown(b);
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
    let p = paths[ci]; if (!p) { p = new Path2D(); paths[ci] = p; }
    p.moveTo(x0, y0); p.lineTo(x1, y1);
    visibleLinks++;
    if (!wantDots || inner < 24 || visibleLinks > MAX_DOT_LINKS) continue;
    const nDots = inner > 140 ? 3 : inner > 70 ? 2 : 1;
    for (let q = 0; q < nDots; q++) {
      const prog = 1 - ((now * speed + lseed[l] + q / nDots) % 1); // 1 → 0 = child → parent
      const px = x0 + (x1 - x0) * prog, py = y0 + (y1 - y0) * prog;
      const fade = Math.sin(prog * Math.PI);
      const bucket = fade < 0.35 ? 0 : fade < 0.75 ? 1 : 2;
      const dk = ci * 3 + bucket;
      let dp = dots[dk]; if (!dp) { dp = new Path2D(); dots[dk] = dp; }
      dp.moveTo(px + 1.6, py); dp.arc(px, py, 1.6, 0, Math.PI * 2);
    }
  }
  ctx.lineWidth = 1;
  for (let ci = 0; ci < 4; ci++) { const p = paths[ci]; if (p) { ctx.strokeStyle = rgba(COLORS[ci], dimming ? 0.05 : 0.3); ctx.stroke(p); } }
  for (let dk = 0; dk < 12; dk++) { const p = dots[dk]; if (p) { ctx.fillStyle = rgba(COLORS[dk / 3 | 0], FADE[dk % 3]); ctx.fill(p); } }
  for (let q = 0; q < hotN; q++) {
    const l = s.hot[q], a = lsrc[l], b = ldst[l];
    const ax = x[a] * k + tx, ay = y[a] * k + ty, bx = x[b] * k + tx, by = y[b] * k + ty;
    const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy); const ux = dx / len, uy = dy / len;
    const ra = r[a] * k * grown(a), rb = r[b] * k * grown(b);
    const x0 = ax + ux * ra, y0 = ay + uy * ra, x1 = bx - ux * rb, y1 = by - uy * rb;
    const grad = ctx.createLinearGradient(x0, y0, x1, y1);
    grad.addColorStop(0, rgba(COLORS[color[a]], 0.9)); grad.addColorStop(1, rgba(COLORS[color[b]], 0.7));
    ctx.strokeStyle = grad; ctx.lineWidth = 1.8;
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    if (s.static) continue;
    const inner = len - ra - rb;
    const nDots = Math.max(1, Math.min(4, Math.round(inner / 70)));
    for (let i = 0; i < nDots; i++) {
      const prog = 1 - ((now * speed + lseed[l] + i / nDots) % 1);
      const px = x0 + (x1 - x0) * prog, py = y0 + (y1 - y0) * prog;
      ctx.fillStyle = rgba(COLORS[color[a]], Math.round(0.9 * Math.sin(prog * Math.PI) * 10) / 10);
      ctx.beginPath(); ctx.arc(px, py, 2.2, 0, Math.PI * 2); ctx.fill();
    }
  }

  // ---- bubbles, smallest first so big bubbles and their labels sit on top. Three tiers by screen
  // radius: specks batched per colour, shared sprites, per-node sprites (letter, then logo).
  const specks: (Path2D | null)[] = new Array(8).fill(null);
  let curAlpha = 1; ctx.globalAlpha = 1;
  let drawn = 0;
  const sel = s.selected;
  for (let oi = 0; oi < n; oi++) {
    const i = order[oi];
    const g = grown(i);
    if (g <= 0) continue;
    const sx = x[i] * k + tx, sy = y[i] * k + ty, sr = r[i] * k * g;
    const ext = sr * GLOW + 2;
    if (sx + ext < 0 || sy + ext < 0 || sx - ext > w || sy - ext > h) continue;
    drawn++;
    const dim = dimming && !rel[i] && i !== hov;
    const on = i === hov;
    const fl = flags[i];
    const isFocus = (fl & F_FOCUS) !== 0;
    // pulse ring for a freshly spawned child
    if (pulse[i]) {
      if (now - pulse[i] < PULSE_MS && !s.static) {
        const u = (now - pulse[i]) / PULSE_MS;
        if (curAlpha !== 1) { ctx.globalAlpha = 1; curAlpha = 1; }
        ctx.strokeStyle = rgba(COLORS[color[i]], Math.round((1 - u) * 9) / 10); ctx.lineWidth = 2 * (1 - u) + 0.5;
        ctx.beginPath(); ctx.arc(sx, sy, sr + 4 + u * 48, 0, Math.PI * 2); ctx.stroke();
      } else pulse[i] = 0;
    }
    if (sr < SPECK_R && !on && !isFocus && i !== sel) {
      const sz = Math.max(1.2, sr * 2);
      const key = color[i] + (dim ? 4 : 0);
      let p = specks[key]; if (!p) { p = new Path2D(); specks[key] = p; }
      p.rect(sx - sz / 2, sy - sz / 2, sz, sz);
      continue;
    }
    const a = dim ? 0.28 : 1;
    if (a !== curAlpha) { ctx.globalAlpha = a; curAlpha = a; }
    const ours = (fl & F_OURS) !== 0, anc = (fl & F_ANC) !== 0;
    const d = st.data[i];
    if (!on && !isFocus && i !== sel) {
      const ri = bucketR(sr);
      let sp: HTMLCanvasElement;
      if (sr < SMALL_R) sp = sharedSprite(s.sprites, ri, color[i], ours, anc);
      else { const img = sr >= IMG_R ? imageFor(d.image) : null; sp = nodeSprite(s.sprites, i, st.gen[i], ri, color[i], img, letterOf(d.symbol, d.name), ours, anc); }
      const dw = sp.width * (sr / ri);
      ctx.drawImage(sp, sx - dw / 2, sy - dw / 2, dw, dw);
      continue;
    }
    // slow path: the hovered / selected / focused bubble
    const col = COLORS[color[i]];
    const glow = sharedSprite(s.sprites, bucketR(Math.max(3, sr)), color[i], false, false);
    const gw = glow.width * (sr / bucketR(Math.max(3, sr)));
    ctx.globalAlpha = on ? 1 : 0.9; ctx.drawImage(glow, sx - gw / 2, sy - gw / 2, gw, gw); ctx.globalAlpha = a; curAlpha = a;
    ctx.beginPath(); ctx.arc(sx, sy, sr, 0, Math.PI * 2);
    ctx.fillStyle = rgba(col, on ? 0.34 : 0.2); ctx.fill();
    const img = sr >= 7 ? imageFor(d.image) : null;
    if (img) {
      ctx.save(); ctx.beginPath(); ctx.arc(sx, sy, sr - 0.5, 0, Math.PI * 2); ctx.clip();
      ctx.drawImage(img, sx - sr, sy - sr, sr * 2, sr * 2);
      ctx.fillStyle = rgba(col, on ? 0.08 : 0.14); ctx.fillRect(sx - sr, sy - sr, sr * 2, sr * 2);
      ctx.restore();
    } else if (sr >= 7) {
      ctx.fillStyle = col; ctx.font = `600 ${Math.max(9, Math.round(sr * 0.9))}px "Geist Mono", ui-monospace, Menlo, monospace`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(letterOf(d.symbol, d.name), sx, sy + 0.5);
    }
    ctx.beginPath(); ctx.arc(sx, sy, sr, 0, Math.PI * 2);
    ctx.strokeStyle = on ? "#ffffff" : rgba(col, anc ? 0.95 : 0.8); ctx.lineWidth = on ? 2 : isFocus ? 1.6 : 1.1;
    if (anc) ctx.setLineDash([4, 4]);
    ctx.stroke(); ctx.setLineDash([]);
    if (ours) { ctx.beginPath(); ctx.arc(sx, sy, sr + 3, 0, Math.PI * 2); ctx.strokeStyle = rgba(COLORS[0], 0.95); ctx.lineWidth = 1.6; ctx.stroke(); }
    if (isFocus || i === sel) {
      // slowly rotating dashed accent ring marks "you are here" / the selection
      ctx.save(); ctx.translate(sx, sy); ctx.rotate(s.static ? 0 : (now / 9000) % (Math.PI * 2));
      ctx.beginPath(); ctx.arc(0, 0, sr + 7, 0, Math.PI * 2); ctx.strokeStyle = i === sel && !isFocus ? "rgba(255,255,255,.9)" : rgba(COLORS[0], 0.9); ctx.lineWidth = 1.5; ctx.setLineDash([3, 6]); ctx.stroke();
      ctx.restore(); ctx.setLineDash([]);
    }
  }
  if (curAlpha !== 1) { ctx.globalAlpha = 1; curAlpha = 1; }
  for (let key = 0; key < 8; key++) { const p = specks[key]; if (p) { ctx.fillStyle = rgba(COLORS[key & 3], key >= 4 ? 0.18 : 0.8); ctx.fill(p); } }
  s.perf.drawn = drawn;

  // ---- labels: the three special bubbles first, then biggest-first; a label that would sit on
  // another is dropped so dense clusters stay readable (hover still names everything).
  const rects = s.labelRects;
  let placed = 0;
  const putLabel = (i: number, big: boolean, force: boolean): boolean => {
    if (placed >= MAX_LABELS) return false;
    const g = grown(i);
    if (g <= 0.6) return false;
    const sx = x[i] * k + tx, sy = y[i] * k + ty, sr = r[i] * k * g;
    if (sx < -60 || sy < -40 || sx > w + 60 || sy > h + 20) return false;
    const d = st.data[i];
    const fl = flags[i], isFocus = (fl & F_FOCUS) !== 0;
    const sp = labelSprite(s.sprites, labelOf(d.symbol, d.name, d.mint), big, isFocus ? COLORS[0] : big ? "#ffffff" : "#d8e8da");
    const lx = sx - sp.width / 2, ly = sy + sr + (isFocus ? 10 : 3);
    const x0 = lx + 2, y0 = ly + 1, x1 = lx + sp.width - 2, y1 = ly + sp.height - 1;
    if (!force) for (let q = 0; q < placed; q++) { const o = q * 4; if (rects[o] < x1 && rects[o + 2] > x0 && rects[o + 1] < y1 && rects[o + 3] > y0) return false; }
    const o = placed * 4; rects[o] = x0; rects[o + 1] = y0; rects[o + 2] = x1; rects[o + 3] = y1; placed++;
    const dim = dimming && !rel[i] && i !== hov;
    if (dim) ctx.globalAlpha = 0.3;
    ctx.drawImage(sp, Math.round(lx), Math.round(ly));
    if (dim) ctx.globalAlpha = 1;
    return true;
  };
  if (hov >= 0) putLabel(hov, true, true);
  if (sel >= 0 && sel !== hov) putLabel(sel, true, true);
  if (s.focusIdx >= 0 && s.focusIdx !== hov && s.focusIdx !== sel) putLabel(s.focusIdx, true, true);
  const minWorldR = LABEL_R / k;
  for (let oi = n - 1; oi >= 0 && placed < MAX_LABELS; oi--) {
    const i = order[oi];
    if (i === hov || i === sel || i === s.focusIdx) continue;
    const special = (s.focusIdx >= 0 && parent[i] === s.focusIdx) || ((flags[i] & F_ANC) !== 0 && st.rT[i] * k >= 6);
    if (st.rT[i] < minWorldR && !special) {
      const sr = st.rT[i] * k;
      if (sr < 3) break;                                          // biggest-first: everything after is smaller
      if (placed >= ALWAYS_LABELS) { if (sr < 6) break; continue; }
      putLabel(i, false, false); continue;                        // one of the biggest on screen: named anyway
    }
    putLabel(i, false, false);
  }
  s.perf.labels = placed;

  // tooltip follows its node while the layout is still moving
  const tipNode = s.pinned >= 0 ? s.pinned : s.hover;
  if (tipNode >= 0 && tip) {
    const px = x[tipNode] * k + tx, py = y[tipNode] * k + ty - r[tipNode] * k - 10;
    const flip = py < 150;
    tip.style.transform = `translate(${Math.round(Math.max(90, Math.min(w - 90, px)))}px, ${Math.round(flip ? py + r[tipNode] * k * 2 + 20 : py)}px) translate(-50%, ${flip ? "0" : "-100%"})`;
  }
  if (!s.perf.firstPaintAt && drawn > 0) s.perf.firstPaintAt = now;
}

// d3-zoom wants a selection; this is the one place the draw loop touches d3's DOM side.
import { select } from "d3";
const selectCanvas = (cv: HTMLCanvasElement) => select(cv);
