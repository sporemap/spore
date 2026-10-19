// One shared SSE connection to /api/events, opened when the first component subscribes and closed
// when the last one leaves. Reconnects with exponential backoff; a tab coming back from the
// background resets the backoff so the feed is live again immediately.
import { useEffect, useRef, useState } from "react";
import { api, type Coin, type MapDeltaEvent, type PairEvent, type Stats, type Trade } from "./api";

/// `pair` and `mapdelta` are the map's live feed (DESIGN §11.5): every new custom pair on pump.fun and
/// the numbers that moved, whatever the listing mode. `coin` keeps its ours-only meaning.
export type Handlers = { coin?: (c: Coin) => void; trade?: (t: Trade) => void; stats?: (s: Stats) => void; pair?: (p: PairEvent) => void; mapdelta?: (d: MapDeltaEvent) => void };
export type StreamStatus = "idle" | "connecting" | "live" | "reconnecting";

const subs = new Set<Handlers>();
// The last few launches seen on this stream. A ticker that mounts after a launch landed (back
// navigation, a lazy section) can replay them instead of starting blank.
const RECENT = 24;
const recent: Coin[] = [];
export const recentCoins = (): Coin[] => recent.slice();
const statusSubs = new Set<(s: StreamStatus) => void>();
let source: EventSource | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let attempt = 0;
let status: StreamStatus = "idle";

const setStatus = (s: StreamStatus) => { if (status !== s) { status = s; statusSubs.forEach((f) => f(s)); } };
const dispatch = <K extends keyof Handlers>(kind: K, data: Parameters<NonNullable<Handlers[K]>>[0]) => {
  for (const h of subs) {
    const f = h[kind] as ((d: typeof data) => void) | undefined;
    try { f?.(data); } catch (e) { console.error("sse handler", e); }
  }
};
const parse = <T,>(ev: MessageEvent): T | null => { try { return JSON.parse(ev.data) as T; } catch { return null; } };

function open() {
  if (source || subs.size === 0) return;
  setStatus(attempt ? "reconnecting" : "connecting");
  const es = new EventSource(api.eventsUrl);
  source = es;
  es.onopen = () => { attempt = 0; setStatus("live"); };
  es.addEventListener("coin", (ev) => {
    const c = parse<Coin>(ev as MessageEvent);
    if (!c?.mint) return;
    if (!recent.some((x) => x.mint === c.mint)) { recent.unshift(c); if (recent.length > RECENT) recent.length = RECENT; }
    dispatch("coin", c);
  });
  es.addEventListener("trade", (ev) => { const t = parse<Trade>(ev as MessageEvent); if (t?.mint) dispatch("trade", t); });
  es.addEventListener("stats", (ev) => { const s = parse<Stats>(ev as MessageEvent); if (s) dispatch("stats", s); });
  es.addEventListener("pair", (ev) => { const p = parse<PairEvent>(ev as MessageEvent); if (p?.coin?.mint) dispatch("pair", p); });
  es.addEventListener("mapdelta", (ev) => { const d = parse<MapDeltaEvent>(ev as MessageEvent); if (d && Array.isArray(d.updated)) dispatch("mapdelta", d); });
  es.onerror = () => {
    es.close();
    if (source !== es) return;
    source = null;
    if (subs.size === 0) { setStatus("idle"); return; }
    setStatus("reconnecting");
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5)) * (0.8 + Math.random() * 0.4);
    attempt += 1;
    timer = setTimeout(() => { timer = null; open(); }, delay);
  };
}
function closeAll() {
  if (timer) { clearTimeout(timer); timer = null; }
  source?.close();
  source = null;
  attempt = 0;
  setStatus("idle");
}
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && subs.size > 0 && !source) { if (timer) { clearTimeout(timer); timer = null; } attempt = 0; open(); }
  });
}

export function subscribe(h: Handlers): () => void {
  subs.add(h);
  open();
  return () => { subs.delete(h); if (subs.size === 0) closeAll(); };
}

/// Subscribe with always-fresh handlers (read through a ref) so callers can pass inline closures
/// without re-opening the stream on every render.
export function useEvents(handlers: Handlers, enabled = true) {
  const ref = useRef(handlers);
  ref.current = handlers;
  useEffect(() => {
    if (!enabled) return;
    return subscribe({ coin: (c) => ref.current.coin?.(c), trade: (t) => ref.current.trade?.(t), stats: (s) => ref.current.stats?.(s), pair: (p) => ref.current.pair?.(p), mapdelta: (d) => ref.current.mapdelta?.(d) });
  }, [enabled]);
}

export function useStreamStatus(): StreamStatus {
  const [s, set] = useState<StreamStatus>(status);
  useEffect(() => { statusSubs.add(set); set(status); return () => { statusSubs.delete(set); }; }, []);
  return s;
}
