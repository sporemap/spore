import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../lib/api";
import { useAsync, useDebounced, useStats } from "../lib/hooks";
import { useStreamStatus } from "../lib/events";
import { age, count, pct, usd } from "../lib/format";
import { useMapData } from "../lib/map/use-map-data";
import { DEBUG_HOOKS } from "../lib/map/debug";
import { rootCmp } from "../lib/map/nodes";
import type { BubbleNode, RootsLimit, SizeMode } from "../lib/map/types";
import BubbleMap, { COLORS, type BubbleMapHandle } from "../components/BubbleMap";
import LaunchButton, { launchBlock } from "../components/LaunchButton";
import { DepthBadge, ErrorBox, Logo, NoSpawnsYet, ProgressBar, Skeleton, nameOf, sym } from "../components/Bits";
import { LiveDot } from "../components/SpawnFeed";

const LIMITS: RootsLimit[] = ["all", 200, 60];
/// Phones default to the top 200 roots (DESIGN §11.5); "all" stays one tap away.
const PHONE_W = 700;
const STATUS_LABEL = { idle: "offline", connecting: "connecting", live: "live", reconnecting: "reconnecting" } as const;

/// The whole pump.fun pair ecosystem as one map (DESIGN §11.5): every root with a tracked child and every
/// descendant, rendered from the IndexedDB cache first and patched by `since=` deltas and live events.
/// `?focus=<mint>` selects a bubble and glides the camera to it; clicking a bubble selects it and opens
/// the side panel; Esc clears. `?roots=all|200|60` picks how many root clusters are drawn.
export default function MapPage() {
  const [params, setParams] = useSearchParams();
  const focus = params.get("focus");
  const [phone] = useState(() => typeof window !== "undefined" && window.innerWidth <= PHONE_W);
  const rootsParam = params.get("roots");
  const limit: RootsLimit = rootsParam === "all" ? "all" : rootsParam === "200" ? 200 : rootsParam === "60" ? 60 : phone ? 200 : "all";
  const stress = import.meta.env.DEV ? Math.min(100_000, Number(params.get("stress")) || 0) : 0;
  const [mode, setMode] = useState<SizeMode>("locked");
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const dq = useDebounced(q, 120);
  const map = useRef<BubbleMapHandle>(null);
  const data = useMapData({ stress });
  const { stats } = useStats();
  const status = useStreamStatus();
  const [wide, setWide] = useState(() => typeof window !== "undefined" && window.innerWidth > 900);
  useEffect(() => { const f = () => setWide(window.innerWidth > 900); window.addEventListener("resize", f); return () => window.removeEventListener("resize", f); }, []);
  // `mountedAt` is taken once: the effect re-runs as the data source changes, and a fresh stamp each time would make "paint after mount" read as 0.
  const [mountedAt] = useState(() => performance.now());
  useEffect(() => { if (DEBUG_HOOKS) (window as unknown as { __sporeMapPage?: unknown }).__sporeMapPage = { mountedAt, source: () => data.source, total: () => data.total, cacheInfo: () => data.cacheInfo, generatedAt: () => data.generatedAt, sync: data.reload }; }, [mountedAt, data.source, data.total, data.cacheInfo]);

  // The view: everything, or the subtrees of the top-n roots (server order: locked, mcap, descendants).
  const nodes = useMemo<BubbleNode[]>(() => {
    const all = data.nodes;
    if (limit === "all") return all;
    const set = new Map(all.map((n) => [n.mint, n]));
    const roots = all.filter((n) => !n.parentMint || !set.has(n.parentMint)).sort(rootCmp).slice(0, limit);
    const keep = new Set(roots.map((r) => r.mint));
    const rootOf = new Map<string, string>();
    const top = (n: BubbleNode) => { const hit = rootOf.get(n.mint); if (hit) return hit; let cur = n, hops = 0; while (cur.parentMint && set.has(cur.parentMint) && hops++ < 8) cur = set.get(cur.parentMint)!; rootOf.set(n.mint, cur.mint); return cur.mint; };
    return all.filter((n) => keep.has(top(n)));
  }, [data.nodes, limit]);
  const byMint = useMemo(() => new Map(nodes.map((n) => [n.mint, n])), [nodes]);
  const selected = focus ? byMint.get(focus) ?? null : null;
  // What the overlays cover: the stats panel on the left and, with a selection, the side panel on the right.
  const inset = useMemo(() => (wide ? { left: 340, top: 40, bottom: 40, ...(selected ? { right: 360 } : {}) } : { top: 170, bottom: selected ? 300 : 56 }), [wide, selected]);
  // Counts from what is actually drawn, so the numbers match the picture.
  const drawn = useMemo(() => { let roots = 0, locked = 0; for (const n of nodes) if (!n.parentMint || !byMint.has(n.parentMint)) { roots++; locked += n.lockedUsd ?? 0; } return { roots, coins: nodes.length, locked }; }, [nodes, byMint]);

  useEffect(() => { document.title = "Map · Spore"; return () => { document.title = "Spore"; }; }, []);

  const setFocus = useCallback((mint: string | null) => {
    setParams((p) => { const n = new URLSearchParams(p); if (mint) n.set("focus", mint); else n.delete("focus"); return n; }, { replace: true });
  }, [setParams]);
  const setLimit = useCallback((l: RootsLimit) => setParams((p) => { const n = new URLSearchParams(p); n.set("roots", String(l)); return n; }, { replace: true }), [setParams]);
  const onSelect = useCallback((n: BubbleNode | null) => setFocus(n?.mint ?? null), [setFocus]);
  // Esc anywhere on the page clears the selection (the canvas handles it too when it has focus).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && focus) { setFocus(null); } };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [focus, setFocus]);
  // A focus mint outside the drawn roots: widen to everything once, so a deep link to a small tree still lands.
  const widened = useRef(false);
  useEffect(() => {
    if (!focus || data.loading || byMint.has(focus) || widened.current || limit === "all") return;
    widened.current = true;
    setLimit("all");
  }, [focus, data.loading, byMint, limit, setLimit]);

  const results = useMemo<BubbleNode[]>(() => {
    const needle = dq.trim().toLowerCase().replace(/^\$/, "");
    if (!needle) return [];
    const score = (n: BubbleNode) => { const s = (n.symbol ?? "").toLowerCase(), m = (n.name ?? "").toLowerCase(); return s === needle ? 4 : s.startsWith(needle) ? 3 : m.startsWith(needle) ? 2 : m.includes(needle) || n.mint.toLowerCase().startsWith(needle) ? 1 : 0; };
    const hits: [BubbleNode, number][] = [];
    for (const n of nodes) { const sc = score(n); if (sc > 0) hits.push([n, sc]); }
    return hits.sort((a, b) => b[1] - a[1] || (b[0].lockedUsd ?? 0) - (a[0].lockedUsd ?? 0) || (b[0].mcapUsd ?? 0) - (a[0].mcapUsd ?? 0)).slice(0, 7).map(([n]) => n);
  }, [dq, nodes]);
  useEffect(() => setActive(0), [results]);
  const pick = (n: BubbleNode) => { setFocus(n.mint); setQ(""); };

  const ready = !data.loading || data.nodes.length > 0;
  return (
    <div className={`map-page ${selected ? "has-side" : ""}`}>
      {!ready && !data.error && <div className="map-state"><Skeleton h={600} r={0} style={{ height: "100%" }} /></div>}
      {data.error && data.nodes.length === 0 && <div className="map-state"><ErrorBox error={data.error} retry={data.reload} /></div>}
      {ready && !data.error && nodes.length === 0 && <div className="map-state launch"><NoSpawnsYet hint="The map draws every root coin a pair was opened under on pump.fun and the coins beneath it. It fills in as pairs appear." /></div>}
      {nodes.length > 0 && <BubbleMap ref={map} nodes={nodes} height="100%" mode={mode} onModeChange={setMode} className="bm-full" inset={inset} select={focus} onSelect={onSelect} fresh={data.fresh} onLayout={data.persistPositions} />}
      <div className="map-overlay">
        <div className="map-panel card">
          <h1>Ecosystem map <span className="map-live"><LiveDot short /> {STATUS_LABEL[status]}</span></h1>
          <p className="lead">{"Every cluster is a root coin and every coin paired under it on pump.fun; launches made on Spore carry a lime ring."} Bubble area is the value a coin's children have locked in their curves; dots drift from child to parent the way buys do.</p>
          <div className="map-stats">
            <div><em>roots</em><strong>{ready ? count(drawn.roots) : "—"}</strong></div>
            <div><em>coins</em><strong>{ready ? count(drawn.coins) : "—"}</strong></div>
            <div><em>locked</em><strong className="accent" title={stats ? `${usd(stats.lockedUsd)} across all ${count(stats.roots)} roots` : undefined}>{ready ? usd(drawn.locked) : "—"}</strong></div>
          </div>
          {(data.syncing || data.error) && data.nodes.length > 0 && <p className="map-sync">{data.error ? <>update failed · <button type="button" className="linkish" onClick={data.reload}>retry</button></> : data.source === "cache" ? "from cache · fetching what changed…" : "fetching what changed…"}</p>}
        </div>
        <div className="map-search" role="search">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5 14 14" /></svg>
          <input className="input" type="search" placeholder="Find a coin on the map…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find a coin on the map" autoComplete="off" spellCheck={false}
            onKeyDown={(e) => { if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(results.length - 1, a + 1)); } else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); } else if (e.key === "Enter" && results[active]) pick(results[active]); else if (e.key === "Escape") setQ(""); }} />
          {dq.trim() && (
            <div className="map-results" role="listbox">
              {results.length === 0 ? <div className="none">Not on this map{limit !== "all" ? " — try all roots" : ""}, or use the search on Explore.</div> : results.map((n, i) => (
                <button type="button" key={n.mint} role="option" aria-selected={i === active} data-active={i === active} onMouseEnter={() => setActive(i)} onClick={() => pick(n)}>
                  <i style={{ background: COLORS[Math.min(n.depth, 3)], boxShadow: `0 0 8px ${COLORS[Math.min(n.depth, 3)]}` }} /><b>{nameOf(n)}</b><span>{sym(n)} · d{n.depth}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="map-tools">
          <span className="tools-label">roots</span>
          <div className="seg" role="group" aria-label="How many roots to draw">{LIMITS.map((l) => <button type="button" key={l} aria-pressed={limit === l} onClick={() => setLimit(l)}>{l === "all" ? "all" : `top ${l}`}</button>)}</div>
        </div>
        {phone && limit !== "all" && <p className="map-note">Top {limit} roots on this screen · <button type="button" className="linkish" onClick={() => setLimit("all")}>show all {count(data.total)} coins</button></p>}
      </div>
      {selected && <SidePanel node={selected} nodes={nodes} byMint={byMint} maxDepth={stats?.maxDepth} onClose={() => setFocus(null)} onPick={(m) => setFocus(m)} onFit={() => map.current?.fit()} />}
      {focus && ready && !selected && limit === "all" && <div className="map-toast">That coin is not on the map yet. <Link to={`/c/${focus}`}>Open its page</Link> · <button type="button" className="linkish" onClick={() => setFocus(null)}>dismiss</button></div>}
      <div className="map-hint"><b>drag</b> bubbles · <b>scroll</b> to zoom · <b>click</b> to select · <b>esc</b> to clear</div>
    </div>
  );
}

/// The selected bubble: what the map already knows at once, the full numbers once /api/coin
/// answers, its parent and children as chips that move the selection, and the two actions that
/// matter — launch under it, open it.
function SidePanel({ node, nodes, byMint, maxDepth, onClose, onPick, onFit }: { node: BubbleNode; nodes: BubbleNode[]; byMint: Map<string, BubbleNode>; maxDepth: number | undefined; onClose: () => void; onPick: (mint: string) => void; onFit: () => void }) {
  const coin = useAsync(() => api.coin(node.mint), [node.mint]);
  const c = coin.data?.coin ?? null;
  const parent = node.parentMint ? byMint.get(node.parentMint) ?? null : null;
  const kids = useMemo(() => nodes.filter((n) => n.parentMint === node.mint).sort((a, b) => (b.lockedUsd ?? 0) - (a.lockedUsd ?? 0) || (b.mcapUsd ?? 0) - (a.mcapUsd ?? 0)), [nodes, node.mint]);
  const block = launchBlock({ depth: node.depth, mayhem: c?.mayhem }, maxDepth);
  return (
    <aside className="map-side card" aria-label={`${nameOf(node)} details`}>
      <button type="button" className="map-side-close" aria-label="Close" title="Close (Esc)" onClick={onClose}>×</button>
      <div className="map-side-head">
        <Logo src={node.image} label={node.symbol} size={48} className="ring" />
        <div className="map-side-title">
          <b>{nameOf(node)}</b>
          <span className="mono muted">{sym(node)}{c?.createdAt ? ` · ${age(c.createdAt)}` : node.createdAt ? ` · ${age(node.createdAt)}` : ""}</span>
        </div>
        <DepthBadge depth={node.depth} />
      </div>
      <div className="map-side-row">
        {parent ? <button type="button" className="pill parent" onClick={() => onPick(parent.mint)} title={`Select ${nameOf(parent)}`}>↳ under {sym(parent)}</button> : <span className="pill root">root</span>}
        {node.migrated ? <span className="chip good">graduated</span> : c?.complete ? <span className="chip warn">migrating</span> : null}
        {(c?.ours ?? node.ours) ? <span className="chip accent">launched on Spore</span> : c?.oursPending ? <span className="chip warn">verifying</span> : null}
      </div>
      <div className="map-side-stats">
        <div><em>mcap</em><strong>{usd(c?.mcapUsd ?? node.mcapUsd)}</strong></div>
        <div><em>locked by children</em><strong className="accent">{usd(c?.lockedUsd ?? node.lockedUsd)}</strong></div>
        <div><em>children</em><strong>{count(c?.children ?? node.children)}{c && c.descendants > c.children ? <small> / {count(c.descendants)}</small> : null}</strong></div>
        <div><em>24h volume</em><strong>{c ? usd(c.volume24hUsd) : <Skeleton w={48} h={14} />}</strong></div>
      </div>
      {c && !c.migrated && <div className="map-side-progress"><span><em>curve</em><strong>{pct(c.progress)}</strong></span><ProgressBar value={c.progress} /></div>}
      {kids.length > 0 && (
        <div className="map-side-kids">
          <em>under {sym(node)}</em>
          <div className="map-side-chips">
            {kids.slice(0, 8).map((k) => <button type="button" key={k.mint} className="map-chip" onClick={() => onPick(k.mint)} title={nameOf(k)}><i style={{ background: COLORS[Math.min(k.depth, 3)] }} />{sym(k)}</button>)}
            {kids.length > 8 && <span className="map-chip more">+{kids.length - 8}</span>}
          </div>
        </div>
      )}
      <div className="map-side-actions">
        {c ? <LaunchButton coin={c} maxDepth={maxDepth} className="block" label={`Launch under ${sym(node)}`} />
          : block ? <button type="button" className="btn accent block" disabled title={block}>Launch under {sym(node)}</button>
          : <Link to={`/launch?parent=${node.mint}`} className="btn accent block">Launch under {sym(node)}</Link>}
        <div className="map-side-links">
          <Link to={`/c/${node.mint}`} className="btn ghost sm">Open coin →</Link>
          <button type="button" className="btn ghost sm" onClick={onFit} title="Zoom back out to the whole map">Whole map</button>
        </div>
      </div>
      {coin.error && !coin.data && <p className="hint">{coin.error}</p>}
    </aside>
  );
}
