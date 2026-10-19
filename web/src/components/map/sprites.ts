// Pre-rendered bitmaps for the draw loop: a bubble with its glow baked in (one drawImage per bubble
// instead of gradient + clip + image + text + stroke per frame), shared small bubbles keyed by colour
// and size, outlined labels, and the dotted ground as a fill pattern. Radii are bucketed geometrically
// so a wheel zoom re-renders a few dozen sizes and then hits the cache.
import { COLORS } from "./store";

export const BG = "#07100b";
export const MONO = `"Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace`;
export const hexA = (hex: string, a: number) => `rgba(${parseInt(hex.slice(1, 3), 16)},${parseInt(hex.slice(3, 5), 16)},${parseInt(hex.slice(5, 7), 16)},${a})`;
const rgbCache = new Map<string, string>();
export const rgba = (hex: string, a: number) => { const k = hex + a; let v = rgbCache.get(k); if (!v) { v = hexA(hex, a); rgbCache.set(k, v); } return v; };

/// Glow extent as a multiple of the radius: beyond ~2× it is only transparent pixels to composite.
export const GLOW = 2.0;
const PAD = 2;
/// ~8 % geometric steps: 3 px → 400 px in ~60 buckets.
export const bucketR = (r: number) => Math.max(3, Math.round(Math.exp(Math.round(Math.log(r) / 0.077) * 0.077)));

export type SpriteSet = { shared: Map<string, HTMLCanvasElement>; node: Map<string, HTMLCanvasElement>; label: Map<string, HTMLCanvasElement> };
export const makeSprites = (): SpriteSet => ({ shared: new Map(), node: new Map(), label: new Map() });
const NODE_CAP = 6000, LABEL_CAP = 3000;
/// Drop the oldest half: a full clear in the middle of a zoom would re-render every visible sprite in one frame.
const trim = (m: Map<string, HTMLCanvasElement>, cap: number) => { if (m.size < cap) return; let k = m.size >> 1; for (const key of m.keys()) { m.delete(key); if (--k <= 0) break; } };

/// Bubble body at radius `ri` (integer, bucketed): glow, fill, image or letter, ring, optional
/// Spore ring (`ours`) and dashed ancestor ring (`anc`). `img` null = letter avatar.
export function renderBody(ri: number, color: string, img: HTMLImageElement | null, letter: string, ours: boolean, anc: boolean, glow: boolean): HTMLCanvasElement {
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
  g.beginPath(); g.arc(x, y, ri, 0, Math.PI * 2);
  g.strokeStyle = hexA(color, anc ? 0.95 : 0.8); g.lineWidth = 1.1;
  if (anc) g.setLineDash([4, 4]);
  g.stroke();
  if (ours) { g.setLineDash([]); g.beginPath(); g.arc(x, y, ri + 3, 0, Math.PI * 2); g.strokeStyle = hexA(COLORS[0], 0.95); g.lineWidth = 1.6; g.stroke(); }
  return c;
}

/// Small bubbles (no letter, no image) share one bitmap per (colour, size, flags).
export function sharedSprite(set: SpriteSet, ri: number, colorIdx: number, ours: boolean, anc: boolean): HTMLCanvasElement {
  const key = `${colorIdx}|${ri}|${ours ? 1 : 0}${anc ? 1 : 0}`;
  let c = set.shared.get(key);
  if (!c) { c = renderBody(ri, COLORS[colorIdx], null, "", ours, anc, true); set.shared.set(key, c); }
  return c;
}
/// Per-node bubbles (letter or logo). `gen` changes when the node's image URL changes, `hasImg` when it loads.
export function nodeSprite(set: SpriteSet, nodeIdx: number, gen: number, ri: number, colorIdx: number, img: HTMLImageElement | null, letter: string, ours: boolean, anc: boolean): HTMLCanvasElement {
  const key = `${nodeIdx}|${gen}|${ri}|${img ? 1 : 0}|${ours ? 1 : 0}${anc ? 1 : 0}`;
  let c = set.node.get(key);
  if (!c) { trim(set.node, NODE_CAP); c = renderBody(ri, COLORS[colorIdx], img, letter, ours, anc, true); set.node.set(key, c); }
  return c;
}

/// Label bitmap: outlined mono text, drawn centred at the anchor by the draw loop.
export function labelSprite(set: SpriteSet, text: string, big: boolean, color: string): HTMLCanvasElement {
  const key = `${big ? 1 : 0}|${color}|${text}`;
  let c = set.label.get(key);
  if (c) return c;
  trim(set.label, LABEL_CAP);
  const font = `${big ? 600 : 500} ${big ? 12 : 11}px ${MONO}`;
  const probe = document.createElement("canvas").getContext("2d")!;
  probe.font = font;
  const w = Math.ceil(probe.measureText(text).width) + 8, h = big ? 18 : 16;
  c = document.createElement("canvas"); c.width = w; c.height = h;
  const g = c.getContext("2d")!;
  g.font = font; g.textAlign = "center"; g.textBaseline = "middle"; g.lineJoin = "round";
  g.lineWidth = 3.5; g.strokeStyle = BG; g.strokeText(text, w / 2, h / 2 + 0.5);
  g.fillStyle = color; g.fillText(text, w / 2, h / 2 + 0.5);
  set.label.set(key, c);
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

export const letterOf = (symbol: string | null, name: string | null) => (symbol || name || "?").replace(/^\$/, "").slice(0, 1).toUpperCase();
/// Ticker when there is one, else the on-chain name (never a bare mint when the coin has a name).
export const labelOf = (symbol: string | null, name: string | null, mint: string) => symbol ? `$${symbol.replace(/^\$/, "")}` : name ? (name.length > 14 ? `${name.slice(0, 13)}…` : name) : `${mint.slice(0, 4)}…`;
