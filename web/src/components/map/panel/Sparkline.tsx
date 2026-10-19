// A tiny inline-SVG price line for the map's side panel: close prices of the candle window, lime when
// the window ends higher than it opened, pink when lower. No axes, no library: 120×32 px, one path.
import { useId } from "react";
import type { Candle } from "../../../lib/api";

/// The window's change as last close over first open, and its real span in seconds (first candle to last).
export function candleChange(candles: Candle[] | null | undefined): { ratio: number; spanS: number } | null {
  if (!candles || candles.length < 2) return null;
  const first = candles[0], last = candles[candles.length - 1];
  if (!(first.o > 0) || !Number.isFinite(last.c)) return null;
  return { ratio: last.c / first.o - 1, spanS: Math.max(0, last.t - first.t) };
}

/// "8h", "45m", "3d": how much time the candles cover, for the change label.
export function spanLabel(s: number): string {
  if (s < 3_600) return `${Math.max(1, Math.round(s / 60))}m`;
  if (s < 86_400) return `${Math.round(s / 3_600)}h`;
  return `${Math.round(s / 86_400)}d`;
}

export default function Sparkline({ candles, w = 120, h = 32, title }: { candles: Candle[]; w?: number; h?: number; title?: string }) {
  const id = `spark${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  if (candles.length < 2) return null;
  let lo = Infinity, hi = -Infinity;
  for (const c of candles) { if (c.l < lo) lo = c.l; if (c.h > hi) hi = c.h; if (c.c < lo) lo = c.c; if (c.c > hi) hi = c.c; }
  const span = hi - lo || Math.abs(hi) || 1;
  const t0 = candles[0].t, dt = candles[candles.length - 1].t - t0 || 1;
  const pad = 2;
  const px = (t: number) => pad + ((t - t0) / dt) * (w - 2 * pad);
  const py = (v: number) => pad + (1 - (v - lo) / span) * (h - 2 * pad);
  let d = "";
  for (let i = 0; i < candles.length; i++) d += `${i ? "L" : "M"}${px(candles[i].t).toFixed(1)} ${py(candles[i].c).toFixed(1)}`;
  const up = candles[candles.length - 1].c >= candles[0].o;
  const tone = up ? "var(--accent)" : "#ff5c8a";
  const area = `${d}L${px(candles[candles.length - 1].t).toFixed(1)} ${h}L${px(t0).toFixed(1)} ${h}Z`;
  return (
    <svg className="map-spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={title ?? "price over the candle window"}>
      <defs><linearGradient id={id} x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor={tone} stopOpacity=".28" /><stop offset="1" stopColor={tone} stopOpacity="0" /></linearGradient></defs>
      <path d={area} fill={`url(#${id})`} />
      <path d={d} fill="none" stroke={tone} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
