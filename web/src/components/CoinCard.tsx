import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { api, type Coin } from "../lib/api";
import { age, count, pct, usd } from "../lib/format";
import { DepthBadge, Logo, ParentPill, ProgressBar, nameOf, sym, useTint } from "./Bits";
import "./discover.css";

/* ---------- sparkline data: one request per mint, shared by every card on the page, 2 min TTL.
   Candles are built from live trades, so a quiet coin has none: the card then shows a flat
   "no trades yet" line instead of an empty box. */
type Spark = { points: number[]; change: number | null } | null;
const SPARK_TTL = 120_000, SPARK_RES = 900, SPARK_WINDOW = 24 * 3600;
const sparkCache = new Map<string, { at: number; p: Promise<Spark> }>();
export function loadSpark(mint: string): Promise<Spark> {
  const hit = sparkCache.get(mint);
  if (hit && Date.now() - hit.at < SPARK_TTL) return hit.p;
  const p = api.candles(mint, SPARK_RES).then((r) => {
    const since = Date.now() / 1000 - SPARK_WINDOW;
    const day = r.candles.filter((c) => c.t >= since);
    // Fewer than two points in the last day: fall back to everything the server has.
    const use = day.length >= 2 ? day : r.candles;
    if (use.length < 2) return null;
    const points = use.map((c) => c.c);
    const first = use[0].o || use[0].c;
    return { points, change: first > 0 ? (points[points.length - 1] - first) / first : null };
  }).catch(() => null);
  sparkCache.set(mint, { at: Date.now(), p });
  return p;
}
/// undefined = not loaded yet, null = nothing to draw. Fetches only once the card is on screen.
export function useSparkline(mint: string, visible: boolean): Spark | undefined {
  const [spark, setSpark] = useState<Spark | undefined>(undefined);
  useEffect(() => {
    if (!visible) return;
    let alive = true;
    loadSpark(mint).then((s) => { if (alive) setSpark(s); });
    return () => { alive = false; };
  }, [mint, visible]);
  return spark;
}
/// Defers work until the element scrolls into view (a grid of 200 cards must not fire 200 fetches).
export function useOnScreen<T extends Element>(): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    if (typeof IntersectionObserver === "undefined") { setSeen(true); return; }
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { setSeen(true); io.disconnect(); } }, { rootMargin: "240px" });
    io.observe(el);
    return () => io.disconnect();
  }, [seen]);
  return [ref, seen];
}

const W = 100, H = 32;
/// The 24 h close series as a filled line. `tone` colours the line by the day's direction.
export function Sparkline({ points, tone }: { points: number[]; tone: "up" | "down" | "flat" }) {
  const d = useMemo(() => {
    const min = Math.min(...points), max = Math.max(...points), span = max - min || max || 1;
    const step = points.length > 1 ? W / (points.length - 1) : W;
    const xy = points.map((p, i) => [i * step, H - 3 - ((p - min) / span) * (H - 6)] as const);
    const line = xy.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
    return { line, area: `${line} L${W} ${H} L0 ${H} Z`, last: xy[xy.length - 1] };
  }, [points]);
  return (
    <svg className={`spark ${tone}`} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id={`sg-${tone}`} x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="currentColor" stopOpacity=".32" /><stop offset="1" stopColor="currentColor" stopOpacity="0" /></linearGradient>
      </defs>
      <path className="spark-area" d={d.area} fill={`url(#sg-${tone})`} />
      <path className="spark-line" d={d.line} />
      <circle className="spark-dot" cx={d.last[0]} cy={d.last[1]} r="2.2" />
    </svg>
  );
}

/// The card used in grids and feeds. The whole card is the link; the parent pill is its own link.
/// `--tint` is the coin image's dominant colour (hash hue until the image loads) and drives the
/// soft backdrop, the logo ring and the hover bloom. `lg` is the trading-card size for roots.
/// `action` is a slot under the metrics (the "Launch a coin" button); clicks inside it stay
/// inside it, so pressing the button never also opens the card.
export default function CoinCard({ coin, fresh = false, size = "md", rank, action, spark = true }: { coin: Coin; fresh?: boolean; size?: "md" | "lg"; rank?: number; action?: ReactNode; spark?: boolean }) {
  const nav = useNavigate();
  const [tint, onImg] = useTint(coin.image, coin.mint);
  const [ref, seen] = useOnScreen<HTMLElement>();
  const sp = useSparkline(coin.mint, spark && seen);
  const go = () => nav(`/c/${coin.mint}`);
  const tone = sp?.change == null ? "flat" : sp.change > 0.0005 ? "up" : sp.change < -0.0005 ? "down" : "flat";
  const filled = coin.migrated ? "on PumpSwap" : `${pct(coin.progress)} filled`;
  return (
    <article ref={ref} className={`coin-card ${size} ${fresh ? "fresh" : ""} ${coin.oursPending ? "pending" : ""}`} style={{ "--tint": tint } as CSSProperties} onClick={go} onKeyDown={(e) => { if (e.key === "Enter") go(); }} tabIndex={0} role="link" aria-label={`${nameOf(coin)} ${sym(coin)}`}>
      {rank != null && <span className="coin-card-rank" aria-hidden="true">{rank}</span>}
      <div className="coin-card-head">
        <Logo src={coin.image} label={coin.symbol} size={size === "lg" ? 56 : 44} className="ring" onLoad={onImg} />
        <div className="coin-card-title">
          <b>{nameOf(coin)}</b>
          <span className="muted mono">{sym(coin)}<i className="coin-card-age" title={coin.createdAt ? new Date(coin.createdAt * 1000).toLocaleString() : undefined}> · {age(coin.createdAt)}</i></span>
        </div>
        <DepthBadge depth={coin.depth} />
      </div>
      <div className="coin-card-row">
        <ParentPill parent={coin.parent} />
        {coin.migrated ? <span className="chip good">graduated</span> : coin.complete ? <span className="chip warn">migrating</span> : null}
        {coin.oursPending && <span className="chip warn" title="Reported as a Spore launch; the fee split is being verified on-chain">verifying</span>}
      </div>
      {spark && (
        <div className="coin-card-spark" aria-hidden="true">
          {sp === undefined ? <span className="spark-skel" /> : sp === null ? <span className="spark-none"><i />no trades in 24h</span> : <Sparkline points={sp.points} tone={tone} />}
          {sp?.change != null && <span className={`spark-change ${tone}`}>{sp.change > 0 ? "+" : ""}{(sp.change * 100).toFixed(Math.abs(sp.change) < 0.1 ? 1 : 0)}%</span>}
        </div>
      )}
      <div className="coin-card-metrics">
        <div><span>mcap</span><b>{usd(coin.mcapUsd)}</b></div>
        <div><span>locked</span><b className="accent">{usd(coin.lockedUsd)}</b></div>
        <div><span>children</span><b>{count(coin.children)}{coin.descendants > coin.children ? <small> / {count(coin.descendants)}</small> : null}</b></div>
        <div><span>24h vol</span><b>{usd(coin.volume24hUsd)}</b></div>
      </div>
      <ProgressBar value={coin.progress} label={`${pct(coin.progress)} of the curve`} />
      <div className="coin-card-foot"><span>{filled}</span><span>{coin.trades24h > 0 ? `${count(coin.trades24h)} trades · 24h` : "quiet"}</span></div>
      {action && <div className="coin-card-action" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>{action}</div>}
    </article>
  );
}
