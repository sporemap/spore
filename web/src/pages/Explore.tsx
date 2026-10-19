import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api, type Coin } from "../lib/api";
import { useEvents } from "../lib/events";
import { useAsync, useDebounced, useStats, useTick } from "../lib/hooks";
import { age, count, pct, usd } from "../lib/format";
import Search from "../components/Search";
import SporeCanvas from "../components/SporeCanvas";
import CoinCard, { Sparkline, useOnScreen, useSparkline } from "../components/CoinCard";
import LaunchButton from "../components/LaunchButton";
import { DepthBadge, ErrorBox, Logo, NoSpawnsYet, ParentPill, ProgressBar, SkeletonCard, SkeletonRows, nameOf, sym } from "../components/Bits";
import "../components/discover.css";

type Sort = "new" | "locked" | "mcap" | "children" | "volume";
type Tab = "coins" | "trees";
type View = "cards" | "table";
type Grad = "any" | "yes" | "no";
const SORTS: { key: Sort; label: string; hint: string }[] = [
  { key: "new", label: "New", hint: "newest launches first" },
  { key: "locked", label: "Locked", hint: "value of parent tokens locked by children" },
  { key: "mcap", label: "Mcap", hint: "market cap" },
  { key: "volume", label: "Volume", hint: "24 h traded volume" },
  { key: "children", label: "Children", hint: "direct children, then descendants" },
];
const MINS = [0, 100, 1_000, 10_000, 100_000];
const PAGE = 60;
const ROOTS_PAGE = 50;

const byNum = (f: (c: Coin) => number | null) => (a: Coin, b: Coin) => (f(b) ?? 0) - (f(a) ?? 0);
const ORDER: Record<Sort, (a: Coin, b: Coin) => number> = {
  new: byNum((c) => c.createdAt),
  locked: (a, b) => byNum((c) => c.lockedUsd)(a, b) || byNum((c) => c.mcapUsd)(a, b),
  mcap: (a, b) => byNum((c) => c.mcapUsd)(a, b) || byNum((c) => c.lockedUsd)(a, b),
  volume: (a, b) => byNum((c) => c.volume24hUsd)(a, b) || byNum((c) => c.mcapUsd)(a, b),
  children: (a, b) => byNum((c) => c.children)(a, b) || byNum((c) => c.descendants)(a, b) || byNum((c) => c.lockedUsd)(a, b),
};

/// Filter/sort/view state lives in the URL so a filtered list can be shared and survives reload;
/// defaults are omitted from the query string.
function useExploreParams() {
  const [params, setParams] = useSearchParams();
  const get = <T extends string>(k: string, dflt: T, ok: readonly T[]): T => { const v = params.get(k) as T | null; return v && ok.includes(v) ? v : dflt; };
  const state = {
    tab: get<Tab>("tab", "coins", ["coins", "trees"]),
    sort: get<Sort>("sort", "new", ["new", "locked", "mcap", "volume", "children"]),
    view: get<View>("view", "cards", ["cards", "table"]),
    grad: get<Grad>("grad", "any", ["any", "yes", "no"]),
    depth: params.get("depth") != null && /^\d$/.test(params.get("depth")!) ? Number(params.get("depth")) : -1,
    min: MINS.includes(Number(params.get("min"))) ? Number(params.get("min")) : 0,
    q: params.get("q") ?? "",
  };
  const set = useCallback((patch: Partial<typeof state>) => {
    setParams((p) => {
      const n = new URLSearchParams(p);
      const put = (k: string, v: string | number, dflt: string | number) => { if (String(v) === String(dflt)) n.delete(k); else n.set(k, String(v)); };
      if (patch.tab !== undefined) put("tab", patch.tab, "coins");
      if (patch.sort !== undefined) put("sort", patch.sort, "new");
      if (patch.view !== undefined) put("view", patch.view, "cards");
      if (patch.grad !== undefined) put("grad", patch.grad, "any");
      if (patch.depth !== undefined) put("depth", patch.depth, -1);
      if (patch.min !== undefined) put("min", patch.min, 0);
      if (patch.q !== undefined) put("q", patch.q.trim(), "");
      return n;
    }, { replace: true });
  }, [setParams]);
  return [state, set] as const;
}

/// The feed, page by page (`before` = oldest createdAt seen), plus live prepends from SSE.
function useFeedPages() {
  const [coins, setCoins] = useState<Coin[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [done, setDone] = useState(false);
  const busy = useRef(false);
  const merge = (cur: Coin[], add: Coin[], front = false) => { const seen = new Set(cur.map((c) => c.mint)); const fresh = add.filter((c) => !seen.has(c.mint)); return front ? [...fresh, ...cur] : [...cur, ...fresh]; };
  const load = useCallback(async (before?: number) => {
    if (busy.current) return;
    busy.current = true;
    if (before === undefined) { setState("loading"); setDone(false); } else setMore(true);
    try {
      const r = await api.feed(PAGE, before);
      setCoins((cur) => (before === undefined ? r.coins : merge(cur, r.coins)));
      // A page shorter than asked, or one with no usable cursor, is the end of the feed.
      if (r.coins.length < PAGE || !r.coins.some((c) => c.createdAt != null)) setDone(true);
      setState("ready"); setError(null);
    } catch (e) {
      setError((e as Error).message);
      if (before === undefined) setState("error");
    } finally { busy.current = false; setMore(false); }
  }, []);
  useEffect(() => { load(); }, [load]);
  const loadMore = useCallback(() => {
    if (done || busy.current) return;
    const oldest = coins.reduce<number | null>((m, c) => (c.createdAt != null && (m === null || c.createdAt < m) ? c.createdAt : m), null);
    if (oldest === null) { setDone(true); return; }
    load(oldest);
  }, [coins, done, load]);
  useEvents({ coin: (c: Coin) => setCoins((cur) => merge(cur, [c], true)) });
  return { coins, state, error, more, done, loadMore, reload: () => load() };
}

const matches = (c: Coin, needle: string) => {
  if (!needle) return true;
  const n = needle.toLowerCase().replace(/^\$/, "");
  return (c.symbol ?? "").toLowerCase().startsWith(n) || (c.name ?? "").toLowerCase().includes(n) || c.mint.toLowerCase().startsWith(n) || (c.parent?.symbol ?? "").toLowerCase() === n;
};

/// Every coin launched through Spore: filters, sorts, search-as-you-type, cards or a table, pages
/// that load as you scroll, all in the URL. "Trees" is the root leaderboard the launches grew under.
export default function Explore() {
  const [st, set] = useExploreParams();
  const { stats } = useStats();
  const ours = stats?.mode === "ours";
  const feed = useFeedPages();
  const [fresh, setFresh] = useState<Set<string>>(() => new Set());
  const dq = useDebounced(st.q, 120);
  useTick(30_000);
  useEffect(() => { document.title = "Explore · Spore"; return () => { document.title = "Spore"; }; }, []);
  useEvents({ coin: (c: Coin) => { setFresh((s) => new Set(s).add(c.mint)); setTimeout(() => setFresh((s) => { const n = new Set(s); n.delete(c.mint); return n; }), 5_000); } });

  const depths = useMemo(() => Array.from({ length: (stats?.maxDepth ?? 2) + 1 }, (_, d) => d), [stats?.maxDepth]);
  const filtered = useMemo(() => feed.coins.filter((c) => (st.depth < 0 || c.depth === st.depth) && (st.grad === "any" || (st.grad === "yes") === c.migrated) && ((c.lockedUsd ?? 0) >= st.min) && matches(c, dq)).sort(ORDER[st.sort]), [feed.coins, st.depth, st.grad, st.min, st.sort, dq]);
  const filtering = st.depth >= 0 || st.grad !== "any" || st.min > 0 || dq.trim() !== "";
  // Infinite scroll: a sentinel under the list asks for the next page; with filters on, keep
  // paging while the visible list is short so a narrow filter still finds older matches.
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || feed.done || st.tab !== "coins") return;
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) feed.loadMore(); }, { rootMargin: "600px" });
    io.observe(el);
    return () => io.disconnect();
  }, [feed.done, feed.loadMore, st.tab]);
  useEffect(() => { if (filtering && !feed.done && feed.state === "ready" && filtered.length < 12) feed.loadMore(); }, [filtering, filtered.length, feed.done, feed.state, feed.loadMore]);

  const n = filtered.length, total = feed.coins.length;
  const reset = () => set({ depth: -1, grad: "any", min: 0, q: "", sort: "new" });

  return (
    <>
      <SporeCanvas density={0.5} />
      <div className="container">
        <div className="page-head">
          <span className="eyebrow">Explore</span>
          <h1>Launched on <em>Spore</em>.</h1>
          <p className="lead">{ours ? "Every coin launched here, roots and children alike. Press “Launch a coin” on any of them to grow the tree under it." : "Every coin in the indexed tree. Press “Launch a coin” on any of them to grow the tree under it."}</p>
        </div>

        <div className="explore-bar">
          <div className="explore-row">
            <div className="seg lg" role="tablist" aria-label="Listing">
              <button type="button" role="tab" aria-selected={st.tab === "coins"} aria-pressed={st.tab === "coins"} onClick={() => set({ tab: "coins" })}>Coins</button>
              <button type="button" role="tab" aria-selected={st.tab === "trees"} aria-pressed={st.tab === "trees"} onClick={() => set({ tab: "trees" })} title="The depth-0 roots our launches grew under">Trees</button>
            </div>
            {st.tab === "coins" ? (
              <>
                <div className="filter-search">
                  <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5 14 14" /></svg>
                  <input className="input" type="search" value={st.q} onChange={(e) => set({ q: e.target.value })} placeholder="Filter by name, ticker, parent or mint…" aria-label="Filter launches" autoComplete="off" spellCheck={false} />
                  {st.q && <button type="button" className="clear" aria-label="Clear filter" onClick={() => set({ q: "" })}>×</button>}
                </div>
                <div className="view-toggle" role="group" aria-label="View">
                  <button type="button" aria-pressed={st.view === "cards"} title="Cards" onClick={() => set({ view: "cards" })}><svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true"><rect x="1" y="1" width="5" height="5" rx="1" /><rect x="8" y="1" width="5" height="5" rx="1" /><rect x="1" y="8" width="5" height="5" rx="1" /><rect x="8" y="8" width="5" height="5" rx="1" /></svg></button>
                  <button type="button" aria-pressed={st.view === "table"} title="Table" onClick={() => set({ view: "table" })}><svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true"><rect x="1" y="1.5" width="12" height="2" rx="1" /><rect x="1" y="6" width="12" height="2" rx="1" /><rect x="1" y="10.5" width="12" height="2" rx="1" /></svg></button>
                </div>
              </>
            ) : <Search placeholder="Jump to any pump.fun coin…" />}
          </div>
          {st.tab === "coins" && (
            <div className="filters">
              <div className="filter"><em>sort</em><div className="seg" role="group" aria-label="Sort">{SORTS.map((s) => <button key={s.key} type="button" aria-pressed={st.sort === s.key} title={s.hint} onClick={() => set({ sort: s.key })}>{s.label}</button>)}</div></div>
              <div className="filter"><em>depth</em><div className="seg" role="group" aria-label="Depth"><button type="button" aria-pressed={st.depth < 0} onClick={() => set({ depth: -1 })}>any</button>{depths.map((d) => <button key={d} type="button" aria-pressed={st.depth === d} onClick={() => set({ depth: d })}>d{d}</button>)}</div></div>
              <div className="filter"><em>graduated</em><div className="seg" role="group" aria-label="Graduated"><button type="button" aria-pressed={st.grad === "any"} onClick={() => set({ grad: "any" })}>any</button><button type="button" aria-pressed={st.grad === "yes"} onClick={() => set({ grad: "yes" })}>yes</button><button type="button" aria-pressed={st.grad === "no"} onClick={() => set({ grad: "no" })}>on curve</button></div></div>
              <div className="filter"><em>min locked</em><select className="filter-sel" aria-label="Minimum locked value" value={st.min} onChange={(e) => set({ min: Number(e.target.value) })}>{MINS.map((m) => <option key={m} value={m}>{m === 0 ? "any" : `≥ ${usd(m)}`}</option>)}</select></div>
              {filtering || st.sort !== "new" ? <button type="button" className="btn sm ghost reset" onClick={reset}>Reset</button> : null}
            </div>
          )}
        </div>

        {st.tab === "trees" ? <Roots /> : (
          <div className="explore-body">
            {feed.state === "loading" ? (st.view === "table" ? <SkeletonRows n={10} h={56} /> : <div className="grid-cards">{[0, 1, 2, 3, 4, 5, 6, 7].map((i) => <SkeletonCard key={i} />)}</div>)
              : feed.state === "error" ? <ErrorBox error={feed.error ?? "unknown"} retry={feed.reload} />
              // An empty grid is the launchpad's starting state, not a broken page: the card says so.
              : total === 0 ? <NoSpawnsYet hint={ours ? "Spore lists only coins launched here. The first one is launched with SOL; after that any coin on this page can be a parent." : "Coins appear once the indexer sees a launch."} />
              : <>
                  <p className="explore-meta"><span><b>{count(n)}</b> of {count(total)}{feed.done ? "" : "+"} coin{total === 1 ? "" : "s"}{filtering ? " match" : ""} · sorted by {SORTS.find((s) => s.key === st.sort)?.label.toLowerCase()}</span>{filtering && <button type="button" className="linkish" onClick={reset}>clear filters</button>}</p>
                  {n === 0 ? <div className="explore-none"><b>No launch matches these filters{feed.done ? "" : " yet"}.</b><span>{feed.done ? "Loosen a filter or clear them all." : "Older pages are still loading…"}</span><button type="button" className="btn sm ghost" onClick={reset}>Clear filters</button></div>
                    : st.view === "table" ? <CoinTable coins={filtered} sort={st.sort} onSort={(s) => set({ sort: s })} maxDepth={stats?.maxDepth} fresh={fresh} />
                    : <div className="grid-cards">{filtered.map((c) => <CoinCard key={c.mint} coin={c} fresh={fresh.has(c.mint)} action={<LaunchButton coin={c} maxDepth={stats?.maxDepth} className="block" />} />)}</div>}
                  <div ref={sentinel} className="explore-sentinel" aria-hidden="true" />
                  {feed.more ? <div className="explore-more"><span className="search-busy" style={{ position: "static", margin: 0 }} aria-hidden="true" />loading older launches…</div>
                    : feed.done ? <div className="explore-end">{total === 0 ? "" : `that's every launch · ${count(total)} coin${total === 1 ? "" : "s"}`}</div>
                    : <div className="explore-more"><button type="button" className="btn ghost sm" onClick={feed.loadMore}>Load older</button></div>}
                  {feed.error && feed.state === "ready" && <ErrorBox error={feed.error} retry={feed.loadMore} compact />}
                </>}
          </div>
        )}
      </div>
    </>
  );
}

/// Sparkline cell for the table: fetched when the row is on screen, cached with the cards.
function RowSpark({ mint }: { mint: string }) {
  const [ref, seen] = useOnScreen<HTMLDivElement>();
  const sp = useSparkline(mint, seen);
  const tone = sp?.change == null ? "flat" : sp.change > 0.0005 ? "up" : sp.change < -0.0005 ? "down" : "flat";
  return <div ref={ref} className="ctable-spark c-spark" aria-hidden="true">{sp ? <Sparkline points={sp.points} tone={tone} /> : null}</div>;
}

function CoinTable({ coins, sort, onSort, maxDepth, fresh }: { coins: Coin[]; sort: Sort; onSort: (s: Sort) => void; maxDepth: number | undefined; fresh: Set<string> }) {
  const nav = useNavigate();
  const Head = ({ k, children, className = "" }: { k?: Sort; children: React.ReactNode; className?: string }) => k
    ? <span className={className}><button type="button" aria-pressed={sort === k} onClick={() => onSort(k)}>{children}{sort === k ? " ↓" : ""}</button></span>
    : <span className={className}>{children}</span>;
  return (
    <div className="ctable card">
      <div className="ctable-row head" aria-hidden="true">
        <Head className="c-coin">coin</Head><Head>under</Head><Head k="mcap" className="num c-mcap">mcap</Head><Head k="locked" className="num">locked</Head><Head k="volume" className="num c-vol">24h vol</Head><Head k="children" className="num">children</Head><Head className="c-spark">24h</Head><Head className="num">curve</Head><Head className="c-act">{""}</Head>
      </div>
      {coins.map((c) => (
        <div key={c.mint} className={`ctable-row ${fresh.has(c.mint) ? "fresh" : ""}`} role="link" tabIndex={0} onClick={() => nav(`/c/${c.mint}`)} onKeyDown={(e) => { if (e.key === "Enter") nav(`/c/${c.mint}`); }}>
          <span className="ctable-coin c-coin"><Logo src={c.image} label={c.symbol} size={34} /><span className="ctable-name"><b>{nameOf(c)}</b><span>{sym(c)} · {age(c.createdAt)}{c.migrated ? " · graduated" : ""}</span></span></span>
          <span className="ctable-parent"><ParentPill parent={c.parent} /><DepthBadge depth={c.depth} /></span>
          <span className="num c-mcap">{usd(c.mcapUsd)}</span>
          <span className="num accent">{usd(c.lockedUsd)}</span>
          <span className="num c-vol">{usd(c.volume24hUsd)}</span>
          <span className="num">{count(c.children)}{c.descendants > c.children ? <small className="muted"> / {count(c.descendants)}</small> : null}</span>
          <RowSpark mint={c.mint} />
          <span className="ctable-progress"><span>{c.migrated ? "PumpSwap" : pct(c.progress)}</span><ProgressBar value={c.progress} /></span>
          {/* Nested anchors are invalid HTML, so the row is a div and this cell keeps its clicks. */}
          <span className="ctable-action c-act" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}><LaunchButton coin={c} maxDepth={maxDepth} size="sm" label="Launch" /></span>
        </div>
      ))}
    </div>
  );
}

/// The former leaderboard: depth-0 coins our launches grew under, by locked value, with load more.
function Roots() {
  const [extra, setExtra] = useState<Coin[]>([]);
  const [more, setMore] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const { stats } = useStats();
  const nav = useNavigate();
  const page = useAsync(() => api.roots("locked", ROOTS_PAGE, 0), []);
  const rows = [...(page.data?.roots ?? []), ...extra];
  // The locked mini-bar is relative to the largest locked value on screen.
  const topLocked = rows.reduce((m, c) => Math.max(m, c.lockedUsd ?? 0), 0);
  async function loadMore() {
    setMore(true); setMoreError(null);
    try { const r = await api.roots("locked", ROOTS_PAGE, rows.length); setExtra((x) => [...x, ...r.roots]); if (r.roots.length < ROOTS_PAGE) setExhausted(true); }
    catch (e) { setMoreError((e as Error).message); }
    finally { setMore(false); }
  }
  if (!page.loading && !(page.error && !page.data) && rows.length === 0) return <NoSpawnsYet hint="Roots are the SOL-quoted coins our launches grew under. They appear with the first coin launched on Spore." />;
  return (
    <>
      <div className="board card">
        <div className="board-row head" aria-hidden="true"><span>#</span><span>root</span><span className="num">mcap</span><span className="num">locked</span><span className="num">children</span><span className="num vol">24h vol</span><span className="num age">launch</span></div>
        {page.loading ? <div className="board-pad"><SkeletonRows n={8} h={48} /></div>
          : page.error && !page.data ? <div className="board-pad"><ErrorBox error={page.error} retry={page.reload} /></div>
          : rows.map((c, i) => (
            <div key={c.mint} className="board-row" role="link" tabIndex={0} onClick={() => nav(`/c/${c.mint}`)} onKeyDown={(e) => { if (e.key === "Enter") nav(`/c/${c.mint}`); }}>
              <span className={`mono rank ${i < 3 ? "top" : ""}`}>{i + 1}</span>
              <span className="board-coin">
                <Logo src={c.image} label={c.symbol} size={36} />
                <span className="board-name"><b>{nameOf(c)}</b><span><span className="mono muted t">{sym(c)}</span><span className="qpill">{c.quoteSymbol}</span><span className="muted t"> · {age(c.createdAt)}</span></span></span>
                <DepthBadge depth={c.depth} />
              </span>
              <span className="num mono">{usd(c.mcapUsd)}</span>
              <span className="num mono accent locked-cell">{usd(c.lockedUsd)}<span className="locked-bar" aria-hidden="true"><i style={{ "--w": `${topLocked > 0 ? Math.max(1.5, ((c.lockedUsd ?? 0) / topLocked) * 100) : 0}%` } as CSSProperties} /></span></span>
              <span className="num mono">{count(c.children)}{c.descendants > c.children ? <small className="muted"> / {count(c.descendants)}</small> : null}</span>
              <span className="num mono vol">{usd(c.volume24hUsd)}</span>
              {/* Nested anchors are invalid HTML, so the row is a div and this cell keeps its clicks. */}
              <span className="num age board-action" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}><LaunchButton coin={c} maxDepth={stats?.maxDepth} size="sm" label="Launch" /></span>
            </div>
          ))}
      </div>
      {moreError && <ErrorBox error={moreError} compact />}
      {rows.length >= ROOTS_PAGE && !exhausted && <div className="center"><button type="button" className="btn ghost" disabled={more} onClick={loadMore}>{more ? "Loading…" : "Load more"}</button></div>}
    </>
  );
}
