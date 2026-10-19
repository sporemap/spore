// Bounded image loader for the map (DESIGN §11.5 "Metadata coverage"): at most MAX_INFLIGHT requests
// at a time, newest wants first (what is on screen now beats what scrolled away), a failed set so a 404
// is never retried every frame, and a `version` counter the draw loop reads to know a sprite may now
// be upgraded from letter to logo. Everything goes through the /api/img proxy (Coin.image already does).
//
// Logos arrive at any size (a 2000 px PNG for a 20 px bubble is common), so each one is downsampled on
// load to a square, centre-cropped canvas of nextPow2(the largest size asked for), 64..256 px, and the
// decoded <img> is dropped. A bubble that later wants a sharper logo re-queues its source once per size
// step (64 → 128 → 256); the object imageFor returns then changes, which is the renderer's signal to
// rebuild that bubble's sprite. Memory is bounded by a pixel budget with least-recently-used eviction;
// an evicted logo loads again when it is wanted again (the browser's HTTP cache usually answers).
//
// Every imageFor call is O(1): it stamps the source with a use counter (`clock`). The waiting queue is a
// Map of source → stamp of its latest want, and a free slot takes the highest stamp, so the bubbles of
// the last drawn frame load first (biggest first, since the frame draws small to big) without moving
// array entries for every bubble on every frame.
export const MAX_INFLIGHT = 8;
export const PIXEL_BUDGET = 24e6; // ~96 MB of RGBA
const QUEUE_CAP = 1500;
const MIN_PX = 64, MAX_PX = 256, DEFAULT_PX = 128;

export type MapImage = HTMLCanvasElement | ImageBitmap;
type Entry = { img: MapImage; size: number; lastUse: number };

const ready = new Map<string, Entry>();
const failed = new Set<string>();
const inflight = new Set<string>();
/// Waiting sources and the stamp of their latest want.
const queued = new Map<string, number>();
/// Largest thumbnail size asked for per source, while it waits or loads (and for an upgrade).
const wantOf = new Map<string, number>();
/// Sources whose sharper reload failed: they keep the thumbnail they have and are not asked again.
const noUpgrade = new Set<string>();
let version = 0;
let clock = 0;
let pixels = 0;
let listeners: (() => void)[] = [];

/// 64, 128 or 256 for a wanted on-screen size in device pixels (128 when the caller does not say).
export const thumbSize = (wantPx?: number) => {
  if (wantPx == null || !Number.isFinite(wantPx) || wantPx <= 0) return DEFAULT_PX;
  const p = 2 ** Math.ceil(Math.log2(Math.max(1, wantPx)));
  return Math.max(MIN_PX, Math.min(MAX_PX, p));
};

/// Changes whenever an image finishes loading: a cheap "something new to draw" signal.
export const imagesVersion = () => version;
export const onImageLoaded = (f: () => void) => { listeners.push(f); return () => { listeners = listeners.filter((g) => g !== f); }; };
export const imageStats = () => ({ ready: ready.size, failed: failed.size, inflight: inflight.size, queued: queued.size, pixels, budget: PIXEL_BUDGET });

/// Square, centre-cropped downsample of a decoded image (cover fit), or null when the browser cannot draw it.
function thumb(img: HTMLImageElement, size: number): HTMLCanvasElement | null {
  const nw = img.naturalWidth, nh = img.naturalHeight;
  if (!(nw > 0 && nh > 0)) return null;
  const side = Math.min(nw, nh);
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d");
  if (!g) return null;
  g.imageSmoothingEnabled = true; g.imageSmoothingQuality = "high";
  try { g.drawImage(img, (nw - side) / 2, (nh - side) / 2, side, side, 0, 0, size, size); } catch { return null; }
  return c;
}

const release = (img: MapImage) => { if ("close" in img) img.close(); else img.width = 0; };

/// Evicts the least recently used logos until the cache is back under 90 % of the budget.
function evict() {
  if (pixels <= PIXEL_BUDGET) return;
  const all = Array.from(ready.entries()).sort((a, b) => a[1].lastUse - b[1].lastUse);
  for (const [src, e] of all) {
    if (pixels <= PIXEL_BUDGET * 0.9) break;
    ready.delete(src);
    pixels -= e.size * e.size;
    release(e.img);
  }
}

/// The waiting source wanted most recently (O(queue), once per started load).
function nextQueued(): string | null {
  let best: string | null = null, bestAt = -1;
  for (const [src, at] of queued) if (at > bestAt) { bestAt = at; best = src; }
  return best;
}

function pump() {
  while (inflight.size < MAX_INFLIGHT && queued.size) {
    const src = nextQueued()!;
    queued.delete(src);
    if (failed.has(src) || inflight.has(src)) continue;
    const cur = ready.get(src);
    if (cur && thumbSize(wantOf.get(src)) <= cur.size) { wantOf.delete(src); continue; } // already as sharp as wanted
    inflight.add(src);
    const img = new Image();
    img.decoding = "async";
    const fail = () => { img.onload = img.onerror = null; inflight.delete(src); wantOf.delete(src); if (ready.has(src)) noUpgrade.add(src); else failed.add(src); pump(); };
    img.onload = () => {
      const finish = () => {
        img.onload = img.onerror = null;
        const size = thumbSize(wantOf.get(src));
        const c = thumb(img, size); // the decoded original is dropped with `img`
        if (!c) { fail(); return; }
        inflight.delete(src);
        const old = ready.get(src);
        if (old) { pixels -= old.size * old.size; release(old.img); }
        ready.set(src, { img: c, size, lastUse: ++clock });
        pixels += size * size;
        wantOf.delete(src);
        evict();
        version++;
        for (const f of listeners) f();
        pump();
      };
      // decode off the main thread first where the browser can, so the downsample does not stall a frame
      if (typeof img.decode === "function") img.decode().then(finish, finish); else finish();
    };
    img.onerror = fail;
    img.src = src;
  }
}

/// Stamps a want; a new source joins the queue (the stalest tenth is dropped when it is full).
function want(src: string) {
  const isNew = !queued.has(src);
  queued.set(src, ++clock);
  if (!isNew) return;
  if (queued.size > QUEUE_CAP) {
    const old = Array.from(queued.entries()).sort((a, b) => a[1] - b[1]).slice(0, Math.ceil(QUEUE_CAP / 10));
    for (const [s] of old) { queued.delete(s); if (!inflight.has(s)) wantOf.delete(s); }
  }
  pump();
}

/// The logo thumbnail when it is here; otherwise null now, and the source joins the queue (once).
/// `wantPx` is the on-screen diameter in device pixels: it picks the thumbnail size, and a later call
/// that wants more than 1.25× the current size (below 256) re-queues the source at the larger size.
export function imageFor(src: string | null | undefined, wantPx?: number): MapImage | null {
  if (!src) return null;
  const e = ready.get(src);
  if (e) {
    e.lastUse = ++clock;
    if (wantPx != null && e.size < MAX_PX && wantPx > e.size * 1.25 && !noUpgrade.has(src) && !inflight.has(src)) {
      const size = thumbSize(wantPx);
      if (size > e.size) {
        if ((wantOf.get(src) ?? 0) < size) wantOf.set(src, size);
        want(src); // keeps a pending upgrade at the front while the bubble stays on screen
      }
    }
    return e.img;
  }
  if (failed.has(src)) return null;
  const size = thumbSize(wantPx);
  if ((wantOf.get(src) ?? 0) < size) wantOf.set(src, size);
  if (inflight.has(src)) return null;
  want(src);
  return null;
}
export const imageReady = (src: string | null | undefined) => !!src && ready.has(src);
export const imageFailed = (src: string | null | undefined) => !!src && failed.has(src);
