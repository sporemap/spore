// Live trade effects on the map: ripples (lime grows outward = buy, pink shrinks inward = sell, size by
// log USD), a one-off glow flash for trades of $500 or more, and comets for buys routed through the
// parent (the same signature trades the child and its parent: a head runs child → parent and the
// parent ripples when it lands). Slots are a fixed ring of typed arrays with a wrapping write index,
// so a burst of trades allocates nothing; a slot whose time is in the future is pending (drawn later).
import { GLOW, bucketR, sharedSprite, type SpriteSet } from "./sprites";
import type { MapStore } from "./store";

export const FX_SLOTS = 256;
export const RIPPLE_MS = 900, COMET_MS = 700, STATIC_RING_MS = 600;
const PAIR_MS = 1_500, COALESCE_MS = 250, COALESCE_SCAN = 32, PAIR_RING = 16, FLASH_USD = 500, FLASH_MS = 380, MAX_FLASH = 8;
const K_BUY = 0, K_SELL = 1, K_COMET = 2;
const LOG2001 = Math.log10(2001);

export type Fx = {
  node: Int32Array; t0: Float64Array; mag: Float32Array; kind: Uint8Array; peer: Int32Array; flash: Uint8Array;
  w: number;
  /// recent buys by signature, to pair the two legs of a routed buy
  pSig: (string | null)[]; pNode: Int32Array; pT: Float64Array; pw: number;
};

export function makeFx(): Fx {
  const node = new Int32Array(FX_SLOTS); node.fill(-1);
  const pNode = new Int32Array(PAIR_RING); pNode.fill(-1);
  return { node, t0: new Float64Array(FX_SLOTS), mag: new Float32Array(FX_SLOTS), kind: new Uint8Array(FX_SLOTS), peer: new Int32Array(FX_SLOTS), flash: new Uint8Array(FX_SLOTS), w: 0, pSig: Array.from({ length: PAIR_RING }, () => null), pNode, pT: new Float64Array(PAIR_RING), pw: 0 };
}

/// Empties every slot (after a store rebuild the node indices mean other coins).
export function clearFx(fx: Fx): void { fx.node.fill(-1); fx.pNode.fill(-1); fx.pSig.fill(null); fx.w = 0; fx.pw = 0; }

function slot(fx: Fx, i: number, kind: number, t0: number, mag: number, peer: number, flash: boolean) {
  const q = fx.w; fx.w = (q + 1) % FX_SLOTS;
  fx.node[q] = i; fx.kind[q] = kind; fx.t0[q] = t0; fx.mag[q] = mag; fx.peer[q] = peer; fx.flash[q] = flash ? 1 : 0;
}

/// Coalesce into a same-node, same-kind slot younger than 250 ms (a bot spraying one coin is one
/// ripple that grows, not 30 rings); returns true when it did.
function coalesce(fx: Fx, i: number, kind: number, mag: number, now: number, flash: boolean): boolean {
  for (let back = 1; back <= COALESCE_SCAN; back++) {
    const q = (fx.w - back + FX_SLOTS) % FX_SLOTS;
    if (fx.node[q] !== i || fx.kind[q] !== kind) continue;
    if (now - fx.t0[q] >= COALESCE_MS) continue;
    fx.mag[q] = Math.min(1, fx.mag[q] + mag * 0.5);
    if (flash) fx.flash[q] = 1;
    return true;
  }
  return false;
}

/// One trade on node i. Stamps the store's activity (lastTrade, t1h) whether or not it is drawn.
export function pushTrade(fx: Fx, st: MapStore, i: number, isBuy: boolean, valueUsd: number | null, sig: string, now: number): void {
  if (i < 0 || i >= st.n) return;
  st.lastTrade[i] = Date.now();
  if (st.t1h[i] < 65535) st.t1h[i]++;
  const usd = valueUsd != null && Number.isFinite(valueUsd) && valueUsd >= 0 ? valueUsd : null;
  const mag = usd == null ? 0.25 : Math.min(1, Math.max(0.15, Math.log10(1 + usd) / LOG2001));
  const flash = usd != null && usd >= FLASH_USD;
  const kind = isBuy ? K_BUY : K_SELL;
  // routed buy: the other leg of this signature, on the parent or a child of this node
  if (isBuy && sig) {
    for (let q = 0; q < PAIR_RING; q++) {
      if (fx.pSig[q] !== sig || now - fx.pT[q] > PAIR_MS) continue;
      const other = fx.pNode[q];
      if (other < 0 || other >= st.n || other === i) continue;
      let child = -1, parent = -1;
      if (st.parent[i] === other) { child = i; parent = other; } else if (st.parent[other] === i) { child = other; parent = i; }
      if (child < 0) continue;
      fx.pSig[q] = null;
      slot(fx, child, K_COMET, now, mag, parent, false);
      slot(fx, parent, K_BUY, now + COMET_MS, mag, -1, flash);
      // the child's own leg ripples now; a parent leg arriving second is the delayed ripple above
      if (i === child && !coalesce(fx, i, kind, mag, now, flash)) slot(fx, i, kind, now, mag, -1, flash);
      return;
    }
    const p = fx.pw; fx.pw = (p + 1) % PAIR_RING;
    fx.pSig[p] = sig; fx.pNode[p] = i; fx.pT[p] = now;
  }
  if (coalesce(fx, i, kind, mag, now, flash)) return;
  slot(fx, i, kind, now, mag, -1, flash);
}

// ripple colours: 2 kinds × 3 alpha buckets, precomputed
const BUY_RGB = "182,255,92", SELL_RGB = "255,92,138";
const BUCKET_A = [0.2, 0.45, 0.8];
const RIP_STYLE = [BUY_RGB, SELL_RGB].flatMap((c) => BUCKET_A.map((a) => `rgba(${c},${a})`));
const COMET_HEAD = `rgba(${BUY_RGB},0.95)`, COMET_TAIL = `rgba(${BUY_RGB},0.45)`, STATIC_RING = [`rgba(${BUY_RGB},0.6)`, `rgba(${SELL_RGB},0.6)`];
const ripPaths: (Path2D | null)[] = [null, null, null, null, null, null];
const flashIdx = new Int32Array(MAX_FLASH), flashA = new Float32Array(MAX_FLASH);
const easeInOut = (u: number) => (u < 0.5 ? 2 * u * u : 1 - 2 * (1 - u) * (1 - u));

/// Draws every live slot (after links, before bubbles). Returns the number of active slots.
export function drawFx(ctx: CanvasRenderingContext2D, fx: Fx, st: MapStore, sprites: SpriteSet, k: number, tx: number, ty: number, w: number, h: number, now: number, still: boolean): number {
  const { node, t0, mag, kind, peer } = fx;
  const { x, y, r, born, color } = st;
  const n = st.n;
  let active = 0, flashes = 0, heads: Path2D | null = null, tails = false;
  for (let p = 0; p < 6; p++) ripPaths[p] = null;
  for (let q = 0; q < FX_SLOTS; q++) {
    const i = node[q];
    if (i < 0) continue;
    if (i >= n) { node[q] = -1; continue; }
    const kd = kind[q];
    const age = now - t0[q];
    const life = kd === K_COMET ? COMET_MS : still ? STATIC_RING_MS : RIPPLE_MS;
    if (age >= life) { node[q] = -1; continue; }
    active++;
    if (age < 0) continue; // pending (the parent leg of a comet)
    if (born[i] > now) continue;
    const u = age / life, m = mag[q];
    const sx = x[i] * k + tx, sy = y[i] * k + ty, base = Math.max(r[i] * k, 2);
    if (kd === K_COMET) {
      if (still) continue;
      const pi = peer[q];
      if (pi < 0 || pi >= n) continue;
      const px = x[pi] * k + tx, py = y[pi] * k + ty;
      if ((sx < -20 && px < -20) || (sy < -20 && py < -20) || (sx > w + 20 && px > w + 20) || (sy > h + 20 && py > h + 20)) continue;
      const dx = px - sx, dy = py - sy, len = Math.sqrt(dx * dx + dy * dy);
      if (len < 1) continue;
      const e = easeInOut(u), hx = sx + dx * e, hy = sy + dy * e;
      const tl = Math.min(14, len * e), ux = dx / len, uy = dy / len;
      if (!heads) heads = new Path2D();
      heads.moveTo(hx + 2.2, hy); heads.arc(hx, hy, 2.2, 0, Math.PI * 2);
      if (!tails) { ctx.beginPath(); tails = true; }
      ctx.moveTo(hx, hy); ctx.lineTo(hx - ux * tl, hy - uy * tl);
      continue;
    }
    const ext = base + 30;
    if (sx + ext < 0 || sy + ext < 0 || sx - ext > w || sy - ext > h) continue;
    let rad: number, a: number;
    if (still) { rad = base + 4; a = 0.7; }
    else {
      rad = kd === K_BUY ? base + 3 + u * (8 + 18 * m) : base + (1 - u) * (14 + 10 * m);
      a = (1 - u) * (0.55 + 0.4 * m);
    }
    const b = a < 0.3 ? 0 : a < 0.6 ? 1 : 2, pk = kd * 3 + b;
    let path = ripPaths[pk]; if (!path) { path = new Path2D(); ripPaths[pk] = path; }
    path.moveTo(sx + rad, sy); path.arc(sx, sy, rad, 0, Math.PI * 2);
    if (fx.flash[q] && age < FLASH_MS && flashes < MAX_FLASH && !still) { flashIdx[flashes] = i; flashA[flashes] = (1 - age / FLASH_MS) * 0.7; flashes++; }
  }
  if (tails) { ctx.strokeStyle = COMET_TAIL; ctx.lineWidth = 1.6; ctx.lineCap = "round"; ctx.stroke(); }
  if (heads) { ctx.fillStyle = COMET_HEAD; ctx.fill(heads); }
  ctx.lineWidth = 1.5;
  for (let pk = 0; pk < 6; pk++) { const path = ripPaths[pk]; if (!path) continue; ctx.strokeStyle = still ? STATIC_RING[pk / 3 | 0] : RIP_STYLE[pk]; ctx.stroke(path); }
  if (flashes) {
    ctx.save(); ctx.globalCompositeOperation = "lighter";
    for (let f = 0; f < flashes; f++) {
      const i = flashIdx[f], sr = Math.max(2, r[i] * k), ri = Math.min(128, bucketR(sr));
      const sp = sharedSprite(sprites, ri, color[i], 0);
      const dw = sp.width * (sr / ri);
      if (dw > w * 2 * GLOW) continue;
      ctx.globalAlpha = flashA[f];
      ctx.drawImage(sp, x[i] * k + tx - dw / 2, y[i] * k + ty - dw / 2, dw, dw);
    }
    ctx.restore();
  }
  return active;
}
