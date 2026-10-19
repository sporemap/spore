// Bounded image loader for the map (DESIGN §11.5 "Metadata coverage"): at most MAX_INFLIGHT requests
// at a time, newest wants first (what is on screen now beats what scrolled away), a failed set so a 404
// is never retried every frame, and a `version` counter the draw loop reads to know a sprite may now
// be upgraded from letter to logo. Everything goes through the /api/img proxy (Coin.image already does).
export const MAX_INFLIGHT = 8;
const QUEUE_CAP = 1500;

const ready = new Map<string, HTMLImageElement>();
const failed = new Set<string>();
const inflight = new Set<string>();
const queued = new Set<string>();
const queue: string[] = [];
let version = 0;
let listeners: (() => void)[] = [];

/// Changes whenever an image finishes loading: a cheap "something new to draw" signal.
export const imagesVersion = () => version;
export const onImageLoaded = (f: () => void) => { listeners.push(f); return () => { listeners = listeners.filter((g) => g !== f); }; };
export const imageStats = () => ({ ready: ready.size, failed: failed.size, inflight: inflight.size, queued: queue.length });

function pump() {
  while (inflight.size < MAX_INFLIGHT && queue.length) {
    const src = queue.pop()!;
    queued.delete(src);
    if (ready.has(src) || failed.has(src) || inflight.has(src)) continue;
    inflight.add(src);
    const img = new Image();
    img.decoding = "async";
    img.onload = () => { inflight.delete(src); if (img.naturalWidth > 0) { ready.set(src, img); version++; for (const f of listeners) f(); } else failed.add(src); pump(); };
    img.onerror = () => { inflight.delete(src); failed.add(src); pump(); };
    img.src = src;
  }
}

/// The decoded image when it is here; otherwise null now, and the URL joins the queue (once).
export function imageFor(src: string | null | undefined): HTMLImageElement | null {
  if (!src) return null;
  const img = ready.get(src);
  if (img) return img;
  if (failed.has(src) || inflight.has(src)) return null;
  if (queued.has(src)) {
    // bump to the front: it was wanted again, so it is probably still on screen
    const i = queue.lastIndexOf(src);
    if (i >= 0 && i !== queue.length - 1) { queue.splice(i, 1); queue.push(src); }
    return null;
  }
  queued.add(src);
  queue.push(src);
  if (queue.length > QUEUE_CAP) { const drop = queue.shift()!; queued.delete(drop); }
  pump();
  return null;
}
export const imageReady = (src: string | null | undefined) => !!src && ready.has(src);
export const imageFailed = (src: string | null | undefined) => !!src && failed.has(src);
