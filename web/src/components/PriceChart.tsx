import { Component, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CandlestickSeries, ColorType, CrosshairMode, HistogramSeries, createChart, type IChartApi, type ISeriesApi, type MouseEventParams, type UTCTimestamp } from "lightweight-charts";
import { api, pumpUrl, type Candle, type Coin, type Trade } from "../lib/api";
import { useEvents } from "../lib/events";
import { useAsync, useLocalPref } from "../lib/hooks";
import { subscriptSmall, tokens, usd } from "../lib/format";
import { Empty, ErrorBox, Ext, Skeleton } from "./Bits";
import { Delta } from "./Stat";
import "./coin.css";

const RES: { label: string; sec: number }[] = [{ label: "1m", sec: 60 }, { label: "5m", sec: 300 }, { label: "15m", sec: 900 }, { label: "1h", sec: 3600 }];
const UP = "#b6ff5c", DOWN = "#ff6b7a";
type Unit = "usd" | "quote";

/// Sort, dedupe and normalise to seconds: the chart library rejects unsorted or repeated times.
function normalize(rows: Candle[]): Candle[] {
  const m = new Map<number, Candle>();
  for (const c of rows) {
    if (![c.t, c.o, c.h, c.l, c.c].every(Number.isFinite)) continue;
    const t = c.t > 1e12 ? Math.floor(c.t / 1000) : Math.floor(c.t);
    m.set(t, { ...c, t, v: Number.isFinite(c.v) ? c.v : 0 });
  }
  return [...m.values()].sort((a, b) => a.t - b.t);
}

/// Axis and legend need more resolution than the page's 3-figure usd(): candles of one coin sit
/// within a few percent of each other, so five significant digits, subscript notation for dust.
const trim = (s: string) => s.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
const fmtPrice = (unit: Unit) => (p: number) => {
  if (!(p > 0)) return "0";
  const prefix = unit === "usd" ? "$" : "";
  if (p >= 1000) return prefix + p.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (p >= 1) return prefix + trim(p.toFixed(p >= 100 ? 2 : 4));
  if (p >= 1e-6) return prefix + p.toPrecision(4); // zeros kept: "$0.001440" aligns with "$0.001424"
  return prefix + subscriptSmall(p);
};
/// Dust prices (1e-8 and below) need a minMove far below the library's default or every candle
/// rounds to zero.
const minMoveFor = (rows: Candle[]) => { const lows = rows.map((c) => c.l).filter((x) => x > 0); const min = lows.length ? Math.min(...lows) : 0; return min > 0 ? 10 ** (Math.floor(Math.log10(min)) - 3) : 1e-9; };

type Handles = { chart: IChartApi; candles: ISeriesApi<"Candlestick">; vol: ISeriesApi<"Histogram"> };
/// The histogram asserts on values above ~9e13; a volume that large is a data fault, not a bar.
const safeV = (v: number) => (Number.isFinite(v) && v > 0 ? Math.min(v, 9e13) : 0);

/// A chart failure (a bad candle from the server, a library assertion) must never take the coin
/// page down with it: the section shows the error and a retry instead.
class ChartBoundary extends Component<{ children: ReactNode; resetKey: string }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(e: unknown) { return { error: e instanceof Error ? e.message : String(e) }; }
  componentDidUpdate(prev: { resetKey: string }) { if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null }); }
  render() { return this.state.error ? <section className="card chart"><ErrorBox error={`Chart failed: ${this.state.error}`} retry={() => this.setState({ error: null })} /></section> : this.props.children; }
}

/// Candles + volume from /api/candles, in USD when the chain has a USD price, else in the quote
/// coin. The chart instance lives for the component's whole life: resolution changes swap the
/// data, live trades extend the last candle in place (no flash, no refit), and the server's own
/// aggregation is re-read at most every 30 s so what is shown converges on what it keeps.
export default function PriceChart({ coin }: { coin: Coin }) {
  return <ChartBoundary resetKey={coin.mint}><Chart coin={coin} /></ChartBoundary>;
}

function Chart({ coin }: { coin: Coin }) {
  const [res, setRes] = useLocalPref<number>("chart-res", 300);
  const [unitPref, setUnitPref] = useLocalPref<string>("chart-unit", "usd");
  const data = useAsync(() => api.candles(coin.mint, res), [coin.mint, res]);
  const priceKey: Unit = data.data?.priceKey ?? "usd";
  // Server candles are in `priceKey`; the other unit is derived with the coin's current USD-per-
  // quote rate, so historical candles in the derived unit are an approximation (flagged in the UI).
  const rate = coin.priceUsd != null && coin.priceQuote != null && coin.priceQuote > 0 ? coin.priceUsd / coin.priceQuote : null;
  const canToggle = rate != null && coin.quoteSymbol !== "USDC";
  const unit: Unit = canToggle ? (unitPref === "quote" ? "quote" : "usd") : priceKey;
  const factor = unit === priceKey ? 1 : rate == null ? 1 : unit === "usd" ? rate : 1 / rate;
  const unitLabel = unit === "usd" ? "USD" : coin.quoteSymbol;
  // A quote-keyed series carries volume in raw quote units (the indexer sums quoteAmount as
  // stored); USD series are already in dollars. SOL has 9 decimals, pump coins and USDC 6.
  const quoteDecimals = (coin as Coin & { quoteDecimals?: number }).quoteDecimals ?? (coin.quoteMint === null ? 9 : 6);
  const vScale = priceKey === "usd" ? 1 : 1 / 10 ** quoteDecimals;

  const box = useRef<HTMLDivElement>(null);
  const handles = useRef<Handles | null>(null);
  const rows = useRef<Candle[]>([]);
  const [version, setVersion] = useState(0);
  const [hover, setHover] = useState<Candle | null>(null);
  const lastReload = useRef(0);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const chart = createChart(el, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: "#8ea596", fontFamily: '"Geist Mono", ui-monospace, monospace', fontSize: 11, attributionLogo: false },
      grid: { vertLines: { color: "rgba(232,243,232,.05)" }, horzLines: { color: "rgba(232,243,232,.05)" } },
      crosshair: { mode: CrosshairMode.Normal, vertLine: { color: "rgba(182,255,92,.35)", labelBackgroundColor: "#1b2f22" }, horzLine: { color: "rgba(182,255,92,.35)", labelBackgroundColor: "#1b2f22" } },
      rightPriceScale: { borderColor: "rgba(182,255,92,.12)", scaleMargins: { top: 0.08, bottom: 0.24 } },
      timeScale: { borderColor: "rgba(182,255,92,.12)", timeVisible: true, secondsVisible: false, rightOffset: 3 },
      handleScale: { axisPressedMouseMove: true }, handleScroll: { vertTouchDrag: false },
    });
    const candles = chart.addSeries(CandlestickSeries, { upColor: UP, downColor: DOWN, borderVisible: false, wickUpColor: UP, wickDownColor: DOWN, priceLineColor: "rgba(182,255,92,.7)", priceLineStyle: 2, lastValueVisible: true });
    const vol = chart.addSeries(HistogramSeries, { priceScaleId: "vol", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    chart.subscribeCrosshairMove((p: MouseEventParams) => {
      const t = typeof p.time === "number" ? p.time : null;
      setHover(t == null ? null : rows.current.find((c) => c.t === t) ?? null);
    });
    handles.current = { chart, candles, vol };
    return () => { chart.remove(); handles.current = null; };
  }, []);

  // Full (re)load: resolution or unit changed, or the server series was re-read.
  useEffect(() => {
    const h = handles.current; const d = data.data;
    if (!h || !d) return;
    const base = normalize(d.candles);
    rows.current = base.map((c) => ({ ...c, o: c.o * factor, h: c.h * factor, l: c.l * factor, c: c.c * factor, v: c.v * vScale }));
    const fmt = fmtPrice(unit);
    h.chart.applyOptions({ localization: { priceFormatter: fmt } });
    h.candles.applyOptions({ priceFormat: { type: "custom", formatter: fmt, minMove: minMoveFor(rows.current) } });
    h.candles.setData(rows.current.map((c) => ({ time: c.t as UTCTimestamp, open: c.o, high: c.h, low: c.l, close: c.c })));
    h.vol.setData(rows.current.map((c) => ({ time: c.t as UTCTimestamp, value: safeV(c.v), color: c.c >= c.o ? "rgba(182,255,92,.28)" : "rgba(255,107,122,.28)" })));
    h.chart.timeScale().fitContent();
    setVersion((v) => v + 1);
  }, [data.data, factor, unit, vScale]);

  // Live: extend or open the last candle from the trade event, then let the server re-aggregate.
  useEvents({ trade: (t: Trade) => {
    if (t.mint !== coin.mint) return;
    const h = handles.current;
    const raw = priceKey === "usd" ? t.priceUsd : t.priceQuote;
    if (h && raw != null && raw > 0 && rows.current.length) {
      const price = raw * factor;
      const bucket = Math.floor(t.time / res) * res;
      const last = rows.current[rows.current.length - 1];
      // Volume in the unit the rows hold: USD for a USD series, whole quote tokens otherwise.
      const v = priceKey === "usd" ? ((t as Trade & { valueUsd?: number }).valueUsd ?? (t.priceUsd ?? 0) * tokens(t.baseAmount, coin.decimals)) : tokens(t.quoteAmount, quoteDecimals);
      let c: Candle;
      if (bucket === last.t) c = { ...last, h: Math.max(last.h, price), l: Math.min(last.l, price), c: price, v: last.v + v };
      else if (bucket > last.t) c = { t: bucket, o: last.c, h: Math.max(last.c, price), l: Math.min(last.c, price), c: price, v };
      else return; // older than the last bucket: the server's re-read below will place it
      if (bucket === last.t) rows.current[rows.current.length - 1] = c; else rows.current.push(c);
      h.candles.update({ time: c.t as UTCTimestamp, open: c.o, high: c.h, low: c.l, close: c.c });
      h.vol.update({ time: c.t as UTCTimestamp, value: safeV(c.v), color: c.c >= c.o ? "rgba(182,255,92,.28)" : "rgba(255,107,122,.28)" });
      setVersion((x) => x + 1);
    }
    const now = Date.now();
    if (now - lastReload.current > 30_000) { lastReload.current = now; data.reload(); }
  } });

  const n = rows.current.length;
  const first = rows.current[0], last = rows.current[n - 1];
  const shown = hover ?? last ?? null;
  const change = useMemo(() => (first && last && first.o > 0 ? last.c / first.o - 1 : null), [first, last, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const fmt = fmtPrice(unit);
  const span = first && last ? last.t - first.t + res : 0;
  const spanLabel = span >= 86400 * 2 ? `${Math.round(span / 86400)}d` : span >= 3600 * 2 ? `${Math.round(span / 3600)}h` : `${Math.max(1, Math.round(span / 60))}m`;
  const notOurs = data.error && !data.data && /not a spore coin/i.test(data.error);
  const overlay = data.loading ? <Skeleton h={300} r={12} className="chart-sk" />
    // In "ours" mode the server keeps candles only for Spore launches (DESIGN §11.1); a parent
    // from the wider tree is not an error, it just has no chart here.
    : notOurs ? <Empty title="No price history here" hint={<>Spore keeps charts for its own launches. <Ext href={pumpUrl(coin.mint)}>See this coin's chart on pump.fun ↗</Ext></>} />
    : data.error && !data.data ? <ErrorBox error={data.error} retry={data.reload} />
    : data.data && n < 2 ? <Empty title="Not enough trades yet" hint={n === 0 ? "The chart fills in as trades stream in; the indexer only keeps what it has watched live." : "One candle so far. The chart draws once a second one closes; live trades extend it as they land."} />
    : null;

  return (
    <section className={`card chart ${overlay ? "empty-state" : ""}`}>
      <div className="chart-head">
        <div className="chart-legend">
          <b>Price</b>
          {shown ? (
            <span className={`ohlc mono ${hover ? "hovering" : ""}`}>
              <span className="ohl"><i>O</i>{fmt(shown.o)}</span> <span className="ohl"><i>H</i>{fmt(shown.h)}</span> <span className="ohl"><i>L</i>{fmt(shown.l)}</span> <span><i>C</i><em className={shown.c >= shown.o ? "good" : "bad"}>{fmt(shown.c)}</em></span> <span><i>V</i>{unit === "usd" ? usd(shown.v) : shown.v.toLocaleString("en-US", { maximumFractionDigits: 0 })}</span>
            </span>
          ) : <span className="muted">· {unitLabel}</span>}
          {!hover && change != null && n >= 2 && <Delta ratio={change} label={spanLabel} title={`From the first candle's open to the last close (${n} candles, ${spanLabel})`} />}
        </div>
        <div className="chart-ctl">
          {canToggle && (
            <span className="seg" role="tablist" aria-label="Price unit">
              <button type="button" role="tab" aria-pressed={unit === "usd"} aria-selected={unit === "usd"} onClick={() => setUnitPref("usd")}>USD</button>
              <button type="button" role="tab" aria-pressed={unit === "quote"} aria-selected={unit === "quote"} onClick={() => setUnitPref("quote")} title={priceKey === "usd" ? `Converted at today's ${coin.quoteSymbol} price` : undefined}>{coin.quoteSymbol}</button>
            </span>
          )}
          <span className="seg" role="tablist" aria-label="Candle size">
            {RES.map((r) => <button key={r.sec} type="button" role="tab" aria-selected={res === r.sec} aria-pressed={res === r.sec} onClick={() => setRes(r.sec)}>{r.label}</button>)}
          </span>
        </div>
      </div>
      <div className="chart-stage">
        <div ref={box} className="chart-box" aria-hidden={!!overlay} />
        {overlay && <div className="chart-overlay">{overlay}</div>}
      </div>
      {!overlay && <div className="chart-foot muted">{n} candles · {unitLabel}{unit !== priceKey ? ` · converted at today's ${coin.quoteSymbol} rate` : ""} · live</div>}
    </section>
  );
}
