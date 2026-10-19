import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useStats } from "../lib/hooks";
import { useStreamStatus } from "../lib/events";
import { ago, count, usd } from "../lib/format";
import { useMapData } from "../lib/map/use-map-data";
import { useMapHeat } from "../lib/map/heat";
import { formatHl, parseHl, type HlKey } from "../lib/map/highlight";
import { sinceDigest } from "../lib/map/rails";
import { DEBUG_HOOKS } from "../lib/map/debug";
import { rootCmp } from "../lib/map/nodes";
import type { BubbleNode, RootsLimit, SizeMode } from "../lib/map/types";
import BubbleMap, { type BubbleMapHandle } from "../components/BubbleMap";
import { launchBlock } from "../components/LaunchButton";
import { ErrorBox, NoSpawnsYet, Skeleton, nameOf, sym } from "../components/Bits";
import { LiveDot } from "../components/SpawnFeed";
import SidePanel, { kidCmp, usePanelCoin } from "../components/map/panel/SidePanel";
import MapSearch from "../components/map/panel/MapSearch";
import Highlights, { useHighlight } from "../components/map/panel/Highlights";
import Rails from "../components/map/panel/Rails";
import MapKey from "../components/map/panel/MapKey";
import Sheet, { type SheetState } from "../components/map/panel/Sheet";
import { createCamStore, useCamK, type CamStore } from "../components/map/panel/cam";
import { useThrottled } from "../components/map/panel/util";

const LIMITS: RootsLimit[] = ["all", 200, 60];
/// Phones default to the top 200 roots (DESIGN §11.5); "all" stays one tap away.
const PHONE_W = 700;
/// The left column, Key and side panel dock beside the map above this width; below it they become pills and a bottom sheet.
const WIDE_W = 900;
const STATUS_LABEL = { idle: "offline", connecting: "connecting", live: "live", reconnecting: "reconnecting" } as const;
const DIGEST_MIN_AGE_MS = 10 * 60_000;
const PAN_PX = 80;
type Pop = "live" | "filters" | "key" | null;

const typing = (t: EventTarget | null) => { const el = t as HTMLElement | null; return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable); };
const isRoot = (n: BubbleNode, byMint: Map<string, BubbleNode>) => !n.parentMint || !byMint.has(n.parentMint);
const depthWord = (d: number) => (d === 0 ? "root" : `d${d}`);
const sinceWord = (ms: number) => ago(Math.floor(ms / 1000));

/// The centred hint: fades out after the first gesture on the map, and while zoomed in past k 1.2.
function MapHint({ cam, gone }: { cam: CamStore; gone: boolean }) {
  const k = useCamK(cam);
  return (
    <div className={`map-hint ${gone || k > 1.2 ? "gone" : ""}`} aria-hidden={gone || k > 1.2}>
      <b>click</b> a cluster to open it · <b>scroll</b> to zoom · <b>/</b> search · <b>← ↑ → ↓</b> walk the tree
    </div>
  );
}

/// The whole pump.fun pair ecosystem as one map (DESIGN §11.5): every root with a tracked child and every
/// descendant, rendered from the IndexedDB cache first and patched by `since=` deltas and live events.
/// URL state: `?focus=<mint>` selects a coin (the camera flies to it with its parent and children),
/// `?roots=all|200|60` picks how many root clusters are drawn, `?size=mcap` sizes by market cap instead of
/// locked value, `?hl=<keys>` dims everything that does not match the highlight keys. The left column
/// holds the counters, search, highlight chips and live rails; the selected coin opens a side panel
/// (a bottom sheet on phones). Arrow keys walk the tree; Esc clears.
export default function MapPage() {
  const [params, setParams] = useSearchParams();
  const nav = useNavigate();
  const focus = params.get("focus");
  const [phone] = useState(() => typeof window !== "undefined" && window.innerWidth <= PHONE_W);
  const rootsParam = params.get("roots");
  const limit: RootsLimit = rootsParam === "all" ? "all" : rootsParam === "200" ? 200 : rootsParam === "60" ? 60 : phone ? 200 : "all";
  const mode: SizeMode = params.get("size") === "mcap" ? "mcap" : "locked";
  const hlParam = params.get("hl");
  const keys = useMemo(() => parseHl(hlParam), [hlParam]);
  const stress = import.meta.env.DEV ? Math.min(100_000, Number(params.get("stress")) || 0) : 0;
  const map = useRef<BubbleMapHandle>(null);
  const data = useMapData({ stress });
  const heat = useMapHeat(true);
  const { stats } = useStats();
  const status = useStreamStatus();
  const [wide, setWide] = useState(() => typeof window !== "undefined" && window.innerWidth > WIDE_W);
  useEffect(() => { const f = () => setWide(window.innerWidth > WIDE_W); window.addEventListener("resize", f); return () => window.removeEventListener("resize", f); }, []);
  // `mountedAt` is taken once: the effect re-runs as the data source changes, and a fresh stamp each time would make "paint after mount" read as 0.
  const [mountedAt] = useState(() => performance.now());
  const cam = useMemo(() => createCamStore(), []);

  // The view: everything, or the subtrees of the top-n roots (server order: locked, mcap, descendants).
  const allByMint = useMemo(() => new Map(data.nodes.map((n) => [n.mint, n])), [data.nodes]);
  const nodes = useMemo<BubbleNode[]>(() => {
    const all = data.nodes;
    if (limit === "all") return all;
    const set = allByMint;
    const roots = all.filter((n) => !n.parentMint || !set.has(n.parentMint)).sort(rootCmp).slice(0, limit);
    const keep = new Set(roots.map((r) => r.mint));
    const rootOf = new Map<string, string>();
    const top = (n: BubbleNode) => { const hit = rootOf.get(n.mint); if (hit) return hit; let cur = n, hops = 0; while (cur.parentMint && set.has(cur.parentMint) && hops++ < 8) cur = set.get(cur.parentMint)!; rootOf.set(n.mint, cur.mint); return cur.mint; };
    return all.filter((n) => keep.has(top(n)));
  }, [data.nodes, allByMint, limit]);
  const byMint = useMemo(() => (nodes === data.nodes ? allByMint : new Map(nodes.map((n) => [n.mint, n]))), [nodes, data.nodes, allByMint]);
  // Children of one coin among the drawn nodes, in the children-list order: one O(n) pass, only for the
  // selected coin (per version) and on an arrow key, never an index of the whole set per live event.
  const kidsOf = useCallback((mint: string) => nodes.filter((n) => n.parentMint === mint).sort(kidCmp), [nodes]);
  const selected = focus ? byMint.get(focus) ?? null : null;
  const kids = useMemo(() => (selected ? kidsOf(selected.mint) : []), [selected, kidsOf]);
  const panel = usePanelCoin(selected?.mint ?? null);
  const hl = useHighlight(nodes, byMint, keys, data.seenAt, heat);

  // Counts from what is actually drawn, so the numbers match the picture; "new pairs" from the same set.
  const drawn = useMemo(() => {
    let roots = 0, locked = 0, fresh24 = 0;
    const from = Math.floor(Date.now() / 1000) - 86_400;
    for (const n of nodes) {
      if (!n.parentMint || !byMint.has(n.parentMint)) { roots++; locked += n.lockedUsd ?? 0; }
      else if ((n.createdAt ?? 0) >= from) fresh24++;
    }
    return { roots, coins: nodes.length, locked, fresh24 };
  }, [nodes, byMint]);
  const tradesPerMin = useMemo(() => { if (!heat) return null; let t = 0; for (const r of heat.rows.values()) t += r.t1h; return t / 60; }, [heat]);
  const seenAt = data.seenAt;
  const digestNodes = useThrottled(data.nodes, 3_000);
  const digest = useMemo(() => (seenAt != null && Date.now() - seenAt > DIGEST_MIN_AGE_MS ? sinceDigest(digestNodes, new Map(digestNodes.map((n) => [n.mint, n])), Math.floor(seenAt / 1000)) : null), [seenAt, digestNodes]);

  useEffect(() => { document.title = "Map · Spore"; return () => { document.title = "Spore"; }; }, []);

  // ---- URL writers (replace: the map's state is not history)
  const limitRef = useRef(limit); limitRef.current = limit;
  const viewRef = useRef(byMint); viewRef.current = byMint;
  const allRef = useRef(allByMint); allRef.current = allByMint;
  const select = useCallback((mint: string | null) => {
    setParams((p) => {
      const n = new URLSearchParams(p);
      if (!mint) { n.delete("focus"); return n; }
      n.set("focus", mint);
      // A coin outside the drawn roots: draw everything first (the widen path frames it once it is there).
      if (limitRef.current !== "all" && !viewRef.current.has(mint) && allRef.current.has(mint)) n.set("roots", "all");
      return n;
    }, { replace: true });
  }, [setParams]);
  const setLimit = useCallback((l: RootsLimit) => setParams((p) => { const n = new URLSearchParams(p); n.set("roots", String(l)); return n; }, { replace: true }), [setParams]);
  const setMode = useCallback((m: SizeMode) => setParams((p) => { const n = new URLSearchParams(p); if (m === "mcap") n.set("size", "mcap"); else n.delete("size"); return n; }, { replace: true }), [setParams]);
  const setKeys = useCallback((ks: HlKey[]) => setParams((p) => { const n = new URLSearchParams(p); const v = formatHl(ks); if (v) n.set("hl", v); else n.delete("hl"); return n; }, { replace: true }), [setParams]);
  const toggleKey = useCallback((k: HlKey) => setKeys(keys.includes(k) ? keys.filter((x) => x !== k) : [...keys, k]), [keys, setKeys]);
  const onSelect = useCallback((n: BubbleNode | null) => select(n?.mint ?? null), [select]);
  const [pop, setPop] = useState<Pop>(null);
  const pickNode = useCallback((n: BubbleNode) => { select(n.mint); setPop(null); }, [select]);
  const hoverNode = useCallback((mint: string | null) => map.current?.hoverNode(mint), []);

  // A focus mint outside the drawn roots: widen to everything once, so a deep link to a small tree still
  // lands. Only once the set has loaded and only when the full set has the coin (else the toast explains).
  const widened = useRef(false);
  useEffect(() => {
    if (!focus || limit === "all" || widened.current) return;
    if (data.nodes.length === 0 || byMint.has(focus) || !allByMint.has(focus)) return;
    widened.current = true;
    setLimit("all");
  }, [focus, limit, data.nodes.length, byMint, allByMint, setLimit]);

  // ---- the hint goes away after the first gesture on the canvas
  const pageRef = useRef<HTMLDivElement>(null);
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    const el = pageRef.current;
    if (!el || touched) return;
    const f = (e: Event) => { if ((e.target as Element | null)?.closest?.(".bm-canvas")) setTouched(true); };
    el.addEventListener("pointerdown", f, { capture: true, passive: true });
    el.addEventListener("wheel", f, { capture: true, passive: true });
    return () => { el.removeEventListener("pointerdown", f, { capture: true }); el.removeEventListener("wheel", f, { capture: true }); };
  }, [touched]);

  // ---- measured insets: what the overlays cover, so fits and flights centre in what is visible
  const overlayRef = useRef<HTMLDivElement>(null);
  const [ov, setOv] = useState({ right: 336, bottom: 0 });
  useLayoutEffect(() => {
    const el = overlayRef.current, page = pageRef.current;
    if (!el || !page || typeof ResizeObserver === "undefined") return;
    const measure = () => { const r = el.getBoundingClientRect(), p = page.getBoundingClientRect(); const next = { right: Math.round(r.right - p.left), bottom: Math.round(r.bottom - p.top) }; setOv((o) => (o.right === next.right && o.bottom === next.bottom ? o : next)); };
    const ro = new ResizeObserver(measure);
    ro.observe(el); ro.observe(page);
    measure();
    return () => ro.disconnect();
  }, []);
  const [sideW, setSideW] = useState(340);
  const sideRo = useRef<ResizeObserver | null>(null);
  const sideRef = useCallback((el: HTMLElement | null) => {
    sideRo.current?.disconnect(); sideRo.current = null;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setSideW(Math.round(el.getBoundingClientRect().width)));
    ro.observe(el); sideRo.current = ro;
  }, []);
  const [sheet, setSheet] = useState<SheetState>("peek");
  const sheetRef = useRef(sheet); sheetRef.current = sheet;
  const [peekH, setPeekH] = useState(170);
  useEffect(() => setSheet("peek"), [focus]);
  const onSheetHeight = useCallback((h: number) => { if (sheetRef.current === "peek" && h > 0) setPeekH(h); }, []);
  const hasSel = !!selected;
  // Desktop: the column's right edge and the side panel's width. Phone: the overlay's bottom and the
  // sheet's peek height (a full sheet covers the map anyway, so the camera keeps the peek framing).
  const edge = wide ? ov.right : ov.bottom, side = wide ? sideW : peekH;
  const inset = useMemo(() => (wide
    ? { left: edge + 12, top: 16, bottom: 16, right: hasSel ? side + 28 : 16 }
    : { top: edge + 8, bottom: hasSel ? side + 8 : 56 }), [wide, edge, hasSel, side]);

  // ---- keyboard: walk the tree, open, launch, frame; zoom and pan without a selection
  const keyState = useRef({ selected, byMint, kidsOf, nodes, maxDepth: stats?.maxDepth, mayhem: panel.coin?.mayhem, pop, focus });
  keyState.current = { selected, byMint, kidsOf, nodes, maxDepth: stats?.maxDepth, mayhem: panel.coin?.mayhem, pop, focus };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = keyState.current;
      if (e.key === "Escape") { if (s.pop) setPop(null); else if (s.focus) select(null); return; }
      if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing || typing(e.target)) return;
      const m = map.current;
      const tag = (e.target as HTMLElement | null)?.tagName;
      const onControl = tag === "BUTTON" || tag === "A";
      const n = s.selected;
      let handled = true;
      if (e.key === "0") m?.fit();
      else if (e.key === "+" || e.key === "=") m?.scaleBy(1.5);
      else if (e.key === "-" || e.key === "_") m?.scaleBy(1 / 1.5);
      else if (n) {
        const siblings = () => (n.parentMint && s.byMint.has(n.parentMint) ? s.kidsOf(n.parentMint) : s.nodes.filter((x) => isRoot(x, s.byMint)).sort(kidCmp));
        if (e.key === "ArrowUp") { if (n.parentMint && s.byMint.has(n.parentMint)) select(n.parentMint); }
        else if (e.key === "ArrowDown") { const k = s.kidsOf(n.mint)[0]; if (k) select(k.mint); }
        else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
          const sib = siblings(); const i = sib.findIndex((x) => x.mint === n.mint);
          if (sib.length > 1 && i >= 0) select(sib[(i + (e.key === "ArrowRight" ? 1 : sib.length - 1)) % sib.length].mint);
        }
        else if (e.key === "Enter" && !onControl) nav(`/c/${n.mint}`);
        else if (e.key === "l" || e.key === "L") { if (!launchBlock({ depth: n.depth, mayhem: s.mayhem }, s.maxDepth)) nav(`/launch?parent=${n.mint}`); }
        else if (e.key === "f" || e.key === "F") { let r = n; for (let h = 0; r.parentMint && s.byMint.has(r.parentMint) && h < 12; h++) r = s.byMint.get(r.parentMint)!; m?.fitCluster(r.mint, { select: false }); }
        else handled = false;
      }
      else if (e.key === "ArrowLeft") m?.panBy(-PAN_PX, 0);
      else if (e.key === "ArrowRight") m?.panBy(PAN_PX, 0);
      else if (e.key === "ArrowUp") m?.panBy(0, -PAN_PX);
      else if (e.key === "ArrowDown") m?.panBy(0, PAN_PX);
      else handled = false;
      if (handled) e.preventDefault();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [select, nav]);
  const announce = selected ? `${nameOf(selected)}, ${sym(selected)}, ${depthWord(selected.depth)}, ${count(selected.children)} ${selected.children === 1 ? "child" : "children"}, ${usd(selected.lockedUsd)} locked` : "";

  // ---- debug hooks for the headless QA scripts
  const dbg = useRef({ counts: hl.counts, inset, keys });
  dbg.current = { counts: hl.counts, inset, keys };
  useEffect(() => {
    if (!DEBUG_HOOKS) return;
    (window as unknown as { __sporeMapPage?: unknown }).__sporeMapPage = { mountedAt, source: () => data.source, total: () => data.total, cacheInfo: () => data.cacheInfo, generatedAt: () => data.generatedAt, sync: data.reload, hlCounts: () => dbg.current.counts, hl: () => dbg.current.keys, inset: () => dbg.current.inset, seenAt: () => data.seenAt };
  }, [mountedAt, data.source, data.total, data.cacheInfo, data.generatedAt, data.reload, data.seenAt]);

  const ready = !data.loading || data.nodes.length > 0;
  const heatRow = selected && heat ? heat.rows.get(selected.mint) ?? null : null;
  const rootsSeg = (
    <div className="map-tools">
      <span className="tools-label">roots</span>
      <div className="seg" role="group" aria-label="How many roots to draw">{LIMITS.map((l) => <button type="button" key={l} aria-pressed={limit === l} onClick={() => setLimit(l)}>{l === "all" ? "all" : `top ${l}`}</button>)}</div>
    </div>
  );
  const heatLine = <p className="map-heatline"><b>{count(drawn.fresh24)}</b> new pairs 24h{tradesPerMin != null && <> · <b>{tradesPerMin >= 10 ? Math.round(tradesPerMin) : tradesPerMin.toFixed(1)}</b> trades/min</>}</p>;
  const digestChip = digest && digest.pairs > 0 && seenAt != null ? (
    <button type="button" className="map-digest" aria-pressed={keys.includes("since")} onClick={() => toggleKey("since")} title="Highlight the pairs created since your last visit">
      <b>{count(digest.pairs)}</b> new pair{digest.pairs === 1 ? "" : "s"} since {sinceWord(seenAt)}{digest.top[0] && <> · {sym(digest.top[0].node)} <span className="good">+{count(digest.top[0].metric)}</span></>}
    </button>
  ) : null;
  const highlights = <Highlights keys={keys} onKeys={setKeys} counts={hl.counts} seenAt={seenAt} heatOn={!!heat}>{rootsSeg}</Highlights>;
  const rails = (variant: "card" | "pop") => <Rails nodes={data.nodes} byMint={allByMint} recent={data.recent} heat={heat} version={data.version} onPick={pickNode} onHover={hoverNode} variant={variant} />;
  const worldRadius = useCallback((v: number) => map.current?.worldRadius(v) ?? 0, []);
  const panelProps = selected ? { node: selected, byMint: allByMint, kids, coin: panel.coin, coinError: panel.error, heat: heatRow, heatOn: !!heat, maxDepth: stats?.maxDepth, map, onPick: select, onClose: () => select(null) } : null;

  return (
    <div ref={pageRef} className={`map-page ${selected ? "has-side" : ""} ${wide ? "wide" : "narrow"}`}>
      {!ready && !data.error && <div className="map-state"><Skeleton h={600} r={0} style={{ height: "100%" }} /></div>}
      {data.error && data.nodes.length === 0 && <div className="map-state"><ErrorBox error={data.error} retry={data.reload} /></div>}
      {ready && !data.error && nodes.length === 0 && <div className="map-state launch"><NoSpawnsYet hint="The map draws every root coin a pair was opened under on pump.fun and the coins beneath it. It fills in as pairs appear." /></div>}
      {nodes.length > 0 && (
        <BubbleMap ref={map} nodes={nodes} height="100%" mode={mode} onModeChange={setMode} className="bm-full" inset={inset} select={focus} onSelect={onSelect}
          fresh={data.fresh} onLayout={data.persistPositions} highlight={hl.predicate} live heat={heat} hideLegend onCamera={cam.set} />
      )}
      <div className="map-overlay" ref={overlayRef}>
        {wide ? (
          <div className="map-panel card">
            <h1>Ecosystem map <span className="map-live"><LiveDot short /> {STATUS_LABEL[status]}</span></h1>
            <p className="lead">Clusters are root coins and every pair under them. The big bubble in the middle is the root: its size is the whole family. Other bubbles are sized by the value they lock. Rings flash on trades; dots flow on pairs that traded in the last 30 min. Lime ring = launched on Spore.</p>
            <div className="map-stats">
              <div><em>roots</em><strong>{ready ? count(drawn.roots) : "—"}</strong></div>
              <div><em>coins</em><strong>{ready ? count(drawn.coins) : "—"}</strong></div>
              <div><em>locked</em><strong className="accent" title={stats ? `${usd(stats.lockedUsd)} across all ${count(stats.roots)} roots` : undefined}>{ready ? usd(drawn.locked) : "—"}</strong></div>
            </div>
            {ready && heatLine}
            {digestChip}
            {(data.syncing || data.error) && data.nodes.length > 0 && <p className="map-sync">{data.error ? <>update failed · <button type="button" className="linkish" onClick={data.reload}>retry</button></> : data.source === "cache" ? "from cache · fetching what changed…" : "fetching what changed…"}</p>}
          </div>
        ) : (
          // Phones: one stats line (and the roots note), nothing transient, so the measured inset (and with it
          // the camera) does not jump while the data syncs.
          <div className="map-panel card compact">
            <h1 className="map-sr">Ecosystem map</h1>
            <p className="map-line" title={`stream ${STATUS_LABEL[status]}`}><LiveDot short /><span><b>{ready ? count(drawn.roots) : "—"}</b> roots · <b>{ready ? count(drawn.coins) : "—"}</b> coins · <b className="accent">{ready ? usd(drawn.locked) : "—"}</b> locked</span></p>
            {phone && limit !== "all" && <p className="map-line sub">top {limit} roots on this screen · <button type="button" className="linkish" onClick={() => setLimit("all")}>show all {count(data.total)}</button></p>}
            {data.error && data.nodes.length > 0 && <p className="map-line sub">update failed · <button type="button" className="linkish" onClick={data.reload}>retry</button></p>}
          </div>
        )}
        <MapSearch nodes={data.nodes} byMint={allByMint} onPick={pickNode} />
        {wide ? <>{highlights}{rails("card")}</> : (
          <div className="map-pills" role="group" aria-label="Map panels">
            <button type="button" className="map-pill" aria-expanded={pop === "live"} onClick={() => setPop((p) => (p === "live" ? null : "live"))}><LiveDot short /> Live</button>
            <button type="button" className="map-pill" aria-expanded={pop === "filters"} onClick={() => setPop((p) => (p === "filters" ? null : "filters"))}>Filters{keys.length > 0 && <b>{keys.length}</b>}</button>
            <button type="button" className="map-pill" aria-expanded={pop === "key"} onClick={() => setPop((p) => (p === "key" ? null : "key"))}>Key</button>
          </div>
        )}
        {!wide && pop && (
          <div className="map-pop card" role="dialog" aria-label={pop === "live" ? "Live rails" : pop === "filters" ? "Filters" : "Key"}>
            <button type="button" className="map-pop-close" aria-label="Close" onClick={() => setPop(null)}>×</button>
            {pop === "live" ? <>{ready && heatLine}{rails("pop")}</> : pop === "filters" ? <>{digestChip}{highlights}</> : <MapKey mode={mode} cam={cam} worldRadius={worldRadius} variant="pop" />}
          </div>
        )}
      </div>
      {wide && <MapKey mode={mode} cam={cam} worldRadius={worldRadius} />}
      {panelProps && (wide
        ? <aside ref={sideRef} className="map-side card" aria-label={`${nameOf(panelProps.node)} details`}><SidePanel {...panelProps} /></aside>
        : <Sheet state={sheet} onState={setSheet} onClose={() => select(null)} onHeight={onSheetHeight} label={`${nameOf(panelProps.node)} details`}><SidePanel {...panelProps} peek={sheet === "peek"} /></Sheet>)}
      {focus && ready && !selected && !data.loading && !data.syncing && !allByMint.has(focus) && <div className="map-toast">That coin is not on the map yet. <Link to={`/c/${focus}`}>Open its page</Link> · <button type="button" className="linkish" onClick={() => select(null)}>dismiss</button></div>}
      <MapHint cam={cam} gone={touched} />
      <div className="map-sr" aria-live="polite" aria-atomic="true">{announce}</div>
    </div>
  );
}
