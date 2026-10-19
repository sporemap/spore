// Trade activity for the map (DESIGN §11.5 "Activity (heat)"): `GET /api/map/heat` is polled every 60 s
// while the tab is visible and indexed by mint; between polls every SSE `trade` bumps its row in place, so
// "Hot" rails and the "Traded 1h" filter stay live without a request per trade. A server that predates the
// route answers 404: the hook then returns null (callers hide what depends on it) and asks again every
// 5 min, without logging anything. The returned object changes identity at most once per second.
import { useEffect, useRef, useState } from "react";
import { ApiError, api, type HeatResponse, type Trade } from "../api";
import { useEvents } from "../events";

export type HeatRow = { t1h: number; n24: number; v24: number; last: number /* unix s */; buys1h: number };
export type HeatIndex = { at: number /* unix s of the last poll */; version: number; rows: Map<string, HeatRow> };

export const HEAT_POLL_MS = 60_000, HEAT_RETRY_MS = 300_000;
const BUMP_MS = 1_000, REPLAY_S = 180;

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/// The wire's parallel arrays as a Map. Rows with a malformed mint are skipped; a short array reads as 0.
export function indexHeat(res: HeatResponse): Map<string, HeatRow> {
  const out = new Map<string, HeatRow>();
  const mints = Array.isArray(res?.mint) ? res.mint : [];
  for (let i = 0; i < mints.length; i++) {
    const m = mints[i];
    if (typeof m !== "string" || !m) continue;
    out.set(m, { t1h: num(res.t1h?.[i]), n24: num(res.n24?.[i]), v24: num(res.v24?.[i]), last: num(res.last?.[i]), buys1h: num(res.buys1h?.[i]) });
  }
  return out;
}

/// One live trade into the index (in place). Trades older than an hour only count toward the 24 h numbers.
export function applyTrade(rows: Map<string, HeatRow>, t: Pick<Trade, "mint" | "time" | "isBuy" | "valueUsd">, nowS = Math.floor(Date.now() / 1000)) {
  const time = num(t.time) || nowS;
  if (time < nowS - 86_400) return;
  let r = rows.get(t.mint);
  if (!r) { r = { t1h: 0, n24: 0, v24: 0, last: 0, buys1h: 0 }; rows.set(t.mint, r); }
  r.n24++;
  if (typeof t.valueUsd === "number" && Number.isFinite(t.valueUsd)) r.v24 = Math.round((r.v24 + t.valueUsd) * 100) / 100;
  if (time >= nowS - 3_600) { r.t1h++; if (t.isBuy) r.buys1h++; }
  if (time > r.last) r.last = time;
}

/// Polls the heat sidecar and keeps it current from the trade stream. Null until the first answer, and
/// while the server does not have the route.
export function useMapHeat(enabled = true): HeatIndex | null {
  const [heat, setHeat] = useState<HeatIndex | null>(null);
  const rows = useRef<Map<string, HeatRow> | null>(null);
  const at = useRef(0);
  const version = useRef(0);
  const lastPublish = useRef(0);
  const bumpTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Trades seen recently, replayed onto a fresh poll whose snapshot predates them (the server caches 15 s).
  const recent = useRef<{ mint: string; time: number; isBuy: boolean; valueUsd: number | null }[]>([]);
  const alive = useRef(true);

  const publish = () => {
    bumpTimer.current = null;
    if (!alive.current || !rows.current) return;
    lastPublish.current = Date.now();
    version.current++;
    setHeat({ at: at.current, version: version.current, rows: rows.current });
  };
  const schedule = () => {
    if (bumpTimer.current) return;
    bumpTimer.current = setTimeout(publish, Math.max(0, BUMP_MS - (Date.now() - lastPublish.current)));
  };

  useEffect(() => {
    alive.current = true;
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let polledAt = 0;
    let busy = false;
    let unsupported = false;
    const next = (ms: number) => { if (timer) clearTimeout(timer); timer = setTimeout(poll, ms); };
    async function poll() {
      timer = null;
      if (!alive.current || busy) return;
      if (typeof document !== "undefined" && document.hidden) return; // resumes on visibilitychange
      busy = true;
      try {
        const res = await api.heat();
        if (!alive.current) return;
        unsupported = false;
        const idx = indexHeat(res);
        const nowS = Math.floor(Date.now() / 1000);
        const snapAt = num(res.at) || nowS;
        recent.current = recent.current.filter((t) => t.time >= nowS - REPLAY_S);
        for (const t of recent.current) if (t.time > snapAt) applyTrade(idx, t, nowS);
        rows.current = idx;
        at.current = snapAt;
        polledAt = Date.now();
        if (bumpTimer.current) { clearTimeout(bumpTimer.current); bumpTimer.current = null; }
        publish();
        next(HEAT_POLL_MS);
      } catch (e) {
        if (!alive.current) return;
        polledAt = Date.now();
        if (e instanceof ApiError && e.status === 404) {
          // an older server: nothing to show, ask again later (never an error on the console)
          unsupported = true; rows.current = null; setHeat(null);
          next(HEAT_RETRY_MS);
        } else next(HEAT_POLL_MS);
      } finally { busy = false; }
    }
    const onVis = () => {
      if (document.hidden) return;
      const due = Date.now() - polledAt >= (unsupported ? HEAT_RETRY_MS : HEAT_POLL_MS);
      if (due) next(0);
      else if (!timer) next((unsupported ? HEAT_RETRY_MS : HEAT_POLL_MS) - (Date.now() - polledAt));
    };
    document.addEventListener("visibilitychange", onVis);
    next(0);
    return () => {
      alive.current = false;
      if (timer) clearTimeout(timer);
      if (bumpTimer.current) { clearTimeout(bumpTimer.current); bumpTimer.current = null; }
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [enabled]);

  useEvents({
    trade: (t) => {
      const rec = { mint: t.mint, time: num(t.time) || Math.floor(Date.now() / 1000), isBuy: !!t.isBuy, valueUsd: typeof t.valueUsd === "number" ? t.valueUsd : null };
      recent.current.push(rec);
      if (recent.current.length > 4_000) recent.current.splice(0, recent.current.length - 2_000);
      if (!rows.current) return;
      applyTrade(rows.current, rec);
      // a hidden tab keeps counting but does not re-render; the poll on return publishes everything
      if (!document.hidden) schedule();
    },
  }, enabled);

  return heat;
}
