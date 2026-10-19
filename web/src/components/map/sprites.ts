// Pre-rendered bitmaps for the draw loop: a bubble with its glow baked in (one drawImage per bubble
// instead of gradient + clip + image + text + stroke per frame), small bubbles shared per colour and
// size, letter avatars shared per letter + colour + size (thousands of "S" bubbles are one bitmap),
// outlined labels, two-tone cluster titles, and the dotted ground as a fill pattern. Radii are bucketed
// geometrically so a wheel zoom re-renders a few dozen sizes and then hits the cache. Cache keys are
// small integers (no string building per frame); per-node logo sprites are owned by the store.
import { COLORS } from "./store";
export { labelOf, letterOf } from "./store";

export const BG = "#07100b";
export const MONO = `"Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace`;
export const hexA = (hex: string, a: number) => `rgba(${parseInt(hex.slice(1, 3), 16)},${parseInt(hex.slice(3, 5), 16)},${parseInt(hex.slice(5, 7), 16)},${a})`;
const rgbCache = new Map<string, string>();
/// Cached rgba() for code that is not per node; the draw loop uses precomputed tables instead.
export const rgba = (hex: string, a: number) => { const k = hex + a; let v = rgbCache.get(k); if (!v) { v = hexA(hex, a); rgbCache.set(k, v); } return v; };

/// Glow extent as a multiple of the radius: beyond ~2× it is only transparent pixels to composite.
export const GLOW = 2.0;
const PAD = 2;
/// Above this radius bucket nothing is cached: the few bubbles that big are drawn directly.
export const MAX_SPRITE_R = 128;
/// ~8 % geometric steps: 3 px → 400 px in ~60 buckets.
export const bucketR = (r: number) => Math.max(3, Math.round(Math.exp(Math.round(Math.log(r) / 0.077) * 0.077)));
/// Sprite flag bits: dashed ancestor ring, graduated cap.
export const SB_ANC = 1, SB_MIG = 2;
const CAP_COLOR = "#eef6ef";

export type SpriteSet = { shared: Map<number, HTMLCanvasElement>; letter: Map<number, HTMLCanvasElement>; node: Map<string, HTMLCanvasElement>; label: Map<string, HTMLCanvasElement>; title: Map<string, HTMLCanvasElement> };
export const makeSprites = (): SpriteSet => ({ shared: new Map(), letter: new Map(), node: new Map(), label: new Map(), title: new Map() });
export const NODE_CAP = 6000, LABEL_CAP = 3000, LETTER_CAP = 4000;
/// Drop the oldest half: a full clear in the middle of a zoom would re-render every visible sprite in one frame.
const trim = <K,>(m: Map<K, HTMLCanvasElement>, cap: number) => { if (m.size < cap) return; let k = m.size >> 1; for (const key of m.keys()) { m.delete(key); if (--k <= 0) break; } };

/// Bubble body at radius `ri` (integer, bucketed): glow, fill, image or letter, ring, dashed ancestor
/// ring (SB_ANC) and the graduated cap (SB_MIG). `img` null = letter avatar (or plain when no letter).
/// The Spore ring is not baked in: beacons are drawn by their own pass so they show at any size.
export function renderBody(ri: number, color: string, img: CanvasImageSource | null, letter: string, bits: number, glow: boolean): HTMLCanvasElement {
  const ext = glow ? ri * GLOW : ri + 4;
  const size = Math.ceil(ext * 2 + PAD * 2);
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d")!;
  const x = size / 2, y = size / 2;
  if (glow) {
    const grad = g.createRadialGradient(x, y, ri * 0.6, x, y, ext);
    grad.addColorStop(0, hexA(color, 0.38)); grad.addColorStop(0.5, hexA(color, 0.1)); grad.addColorStop(1, hexA(color, 0));
    g.fillStyle = grad; g.fillRect(0, 0, size, size);
  }
  g.beginPath(); g.arc(x, y, ri, 0, Math.PI * 2);
  g.fillStyle = hexA(color, 0.2); g.fill();
  if (img && ri >= 7) {
    g.save(); g.beginPath(); g.arc(x, y, ri - 0.5, 0, Math.PI * 2); g.clip();
    g.drawImage(img, x - ri, y - ri, ri * 2, ri * 2);
    // tint keeps the bubble reading as a bubble, not a sticker
    g.fillStyle = hexA(color, 0.14); g.fillRect(x - ri, y - ri, ri * 2, ri * 2);
    g.restore();
  } else if (ri >= 7 && letter) {
    g.fillStyle = color; g.font = `600 ${Math.max(9, Math.round(ri * 0.9))}px ${MONO}`; g.textAlign = "center"; g.textBaseline = "middle";
    g.fillText(letter, x, y + 0.5);
  }
  const anc = (bits & SB_ANC) !== 0;
  g.beginPath(); g.arc(x, y, ri, 0, Math.PI * 2);
  g.strokeStyle = hexA(color, anc ? 0.95 : 0.8); g.lineWidth = 1.1;
  if (anc) g.setLineDash([4, 4]);
  g.stroke();
  if (bits & SB_MIG && ri >= 7) drawCap(g, x, y, ri);
  return c;
}

/// Graduated cap: a small solid dot on the rim at 45° (top right), outlined so it reads on any logo.
export function drawCap(g: CanvasRenderingContext2D, x: number, y: number, r: number) {
  const a = -Math.PI / 4, cx = x + Math.cos(a) * r, cy = y + Math.sin(a) * r;
  g.setLineDash([]);
  g.beginPath(); g.arc(cx, cy, 2.5, 0, Math.PI * 2);
  g.fillStyle = CAP_COLOR; g.fill();
  g.lineWidth = 1; g.strokeStyle = BG; g.stroke();
}

/// Plain bubbles (no letter, no image) share one bitmap per (size, colour, bits).
export function sharedSprite(set: SpriteSet, ri: number, colorIdx: number, bits: number): HTMLCanvasElement {
  const key = (ri * 4 + colorIdx) * 4 + bits;
  let c = set.shared.get(key);
  if (!c) { c = renderBody(ri, COLORS[colorIdx], null, "", bits, true); set.shared.set(key, c); }
  return c;
}
export const sharedReady = (set: SpriteSet, ri: number, colorIdx: number, bits: number) => set.shared.get((ri * 4 + colorIdx) * 4 + bits) ?? null;

/// Letter avatars shared by letter + colour + size + bits. `code` is the letter's char code.
export const letterKey = (code: number, colorIdx: number, ri: number, bits: number) => ((code * 4 + colorIdx) * 160 + ri) * 4 + bits;
export function letterSprite(set: SpriteSet, code: number, colorIdx: number, ri: number, bits: number): HTMLCanvasElement {
  const key = letterKey(code, colorIdx, ri, bits);
  let c = set.letter.get(key);
  if (!c) { trim(set.letter, LETTER_CAP); c = renderBody(ri, COLORS[colorIdx], null, String.fromCharCode(code), bits, true); set.letter.set(key, c); }
  return c;
}

/// Per-node bubbles keyed by node + gen + size (kept for callers outside the draw loop; the draw loop
/// caches logo sprites in the store instead).
export function nodeSprite(set: SpriteSet, nodeIdx: number, gen: number, ri: number, colorIdx: number, img: CanvasImageSource | null, letter: string, bits: number): HTMLCanvasElement {
  const key = `${nodeIdx}|${gen}|${ri}|${img ? 1 : 0}|${bits}`;
  let c = set.node.get(key);
  if (!c) { trim(set.node, NODE_CAP); c = renderBody(ri, COLORS[colorIdx], img, letter, bits, true); set.node.set(key, c); }
  return c;
}

// one probe context for every measureText
let probeCtx: CanvasRenderingContext2D | null = null;
const probe = () => probeCtx ?? (probeCtx = document.createElement("canvas").getContext("2d")!);

/// Label bitmap: outlined mono text, drawn centred at the anchor by the draw loop.
export function labelSprite(set: SpriteSet, text: string, big: boolean, color: string): HTMLCanvasElement {
  const key = `${big ? 1 : 0}|${color}|${text}`;
  let c = set.label.get(key);
  if (c) return c;
  trim(set.label, LABEL_CAP);
  c = renderLabel(text, big, color);
  set.label.set(key, c);
  return c;
}
export function renderLabel(text: string, big: boolean, color: string): HTMLCanvasElement {
  const font = `${big ? 600 : 500} ${big ? 12 : 11}px ${MONO}`;
  const p = probe(); p.font = font;
  const w = Math.ceil(p.measureText(text).width) + 8, h = big ? 18 : 16;
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const g = c.getContext("2d")!;
  g.font = font; g.textAlign = "center"; g.textBaseline = "middle"; g.lineJoin = "round";
  g.lineWidth = 3.5; g.strokeStyle = BG; g.strokeText(text, w / 2, h / 2 + 0.5);
  g.fillStyle = color; g.fillText(text, w / 2, h / 2 + 0.5);
  return c;
}

/// Cluster title: '$PAIR' in 13 px/600 light and ' · 716' in 12 px muted, outlined in the background
/// colour. `active` (hovered/selected tree) is lime. `compact` (narrow screens) keeps only the ticker,
/// in 12 px, so neighbouring trees on a phone can each carry a name.
export function titleSprite(set: SpriteSet, clusterId: string, text: string, active: boolean, compact = false): HTMLCanvasElement {
  const key = `${active ? 1 : 0}${compact ? 1 : 0}|${clusterId}|${text}`;
  let c = set.title.get(key);
  if (c) return c;
  trim(set.title, LABEL_CAP);
  const cut = text.lastIndexOf(" · ");
  const head = cut >= 0 ? text.slice(0, cut) : text, tail = cut >= 0 && !compact ? text.slice(cut) : "";
  const f1 = `600 ${compact ? 12 : 13}px ${MONO}`, f2 = `500 12px ${MONO}`;
  const p = probe();
  p.font = f1; const w1 = p.measureText(head).width;
  p.font = f2; const w2 = tail ? p.measureText(tail).width : 0;
  const w = Math.ceil(w1 + w2) + 10, h = 20;
  c = document.createElement("canvas"); c.width = w; c.height = h;
  const g = c.getContext("2d")!;
  g.textBaseline = "middle"; g.textAlign = "left"; g.lineJoin = "round"; g.lineWidth = 4; g.strokeStyle = BG;
  const y = h / 2 + 0.5;
  g.font = f1; g.strokeText(head, 5, y); g.fillStyle = active ? COLORS[0] : "#eef6ef"; g.fillText(head, 5, y);
  if (tail) { g.font = f2; g.strokeText(tail, 5 + w1, y); g.fillStyle = active ? "#cfe9b0" : "#8fa597"; g.fillText(tail, 5 + w1, y); }
  set.title.set(key, c);
  return c;
}

const patterns = new Map<number, CanvasPattern>();

/// The dotted world grid as a repeating tile: one fill per frame instead of a few hundred fillRects.
export function gridPattern(ctx: CanvasRenderingContext2D, step: number): CanvasPattern | null {
  const s = Math.max(8, Math.round(step));
  const hit = patterns.get(s);
  if (hit) return hit;
  const c = document.createElement("canvas"); c.width = c.height = s;
  const g = c.getContext("2d")!;
  g.fillStyle = "rgba(182,255,92,.07)"; g.fillRect(0, 0, 1, 1);
  const p = ctx.createPattern(c, "repeat");
  if (p) patterns.set(s, p);
  return p;
}
