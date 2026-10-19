// /embed/tree/:mint — one coin's family tree as an iframe widget (DESIGN §12). The data is
// `GET /v1/tree/:mint` (every coin from the root down, flat with `parentMint`, edge-cached); a server
// without the partner API answers with the SPA (or is rate limiting), and the page falls back to
// `/api/tree/:mint` (the coin's ancestors as a chain plus three levels below it).
// Two views of the same data, like the coin page's tree card: "branch" (default) = the coin pinned at the
// centre, its ancestors stacked above as context, everything below it around it; "tree" (`?view=tree`
// or the toggle) = the whole family from the root, siblings included, the coin still pinned. Clicks
// select instead of navigating (the frame never leaves the widget); the selected coin gets a small card
// whose links open the site in a new tab. Live while visible: trade ripples (BubbleMap `live`), new
// children (`pair`) and moving numbers (`mapdelta`) patch the set in place; it is re-read every two
// minutes and when the frame comes back on screen after that.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { api, ApiError, errorMessage, type CoinRef, type MapCoin } from "../../lib/api";
import { useEvents } from "../../lib/events";
import { applyDelta, applyPair, fromMapCoin, remove, upsert, type NodeSet } from "../../lib/map/nodes";
import type { BubbleNode } from "../../lib/map/types";
import { count, usd } from "../../lib/format";
import BubbleMap, { flattenTree, type BubbleMapHandle } from "../../components/BubbleMap";
import { nameOf, sym } from "../../components/Bits";
import { EmbedFrame, EmbedState, HeadTitle, LaunchCta, Out, SelectionCard, canLaunchUnder, compactBox, coinUrl, isMintLike, launchUrl, mapUrl, useActive, useBox, useEmbedParams, useEscape, useMaxDepth } from "./common";

type V1Tree = { root?: CoinRef; nodes?: (MapCoin & { parentMint?: string | null })[]; total?: number };
type Loaded = { nodes: BubbleNode[]; source: "v1" | "api"; at: number };
/// A coin pump.fun knows but Spore has no tree for (no child yet, or not indexed): header + empty state.
type Lone = CoinRef;

const REFRESH_MS = 120_000;
/// /v1 bodies carry absolute image URLs (for partners on other origins). The embed is a page of the site,
/// so the proxy path is used as is: the frame's own origin, whatever host served it, inside img-src 'self'.
const localImage = (src: string | null | undefined): string | null => {
  if (!src) return null;
  if (src.startsWith("/")) return src;
  try { const u = new URL(src); return u.pathname === "/api/img" && /^https?:$/.test(u.protocol) ? `${u.pathname}${u.search}` : src; } catch { return src; }
};
/// Fetch JSON and say whether it really was JSON: a server without /v1 serves the SPA (200 text/html).
async function getJson<T>(url: string, signal: AbortSignal): Promise<{ status: number; json: T | null }> {
  const res = await fetch(url, { signal, headers: { accept: "application/json" } });
  const type = res.headers.get("content-type") ?? "";
  if (!type.includes("json")) return { status: res.ok ? 0 : res.status, json: null };
  let json: T | null = null;
  try { json = (await res.json()) as T; } catch { /* malformed body: treated as missing */ }
  return { status: res.status, json };
}

/// The tree containing `mint`: /v1 first, then the /api tree (an older server, a rate-limited partner
/// API). Throws ApiError(404, "not a pump.fun coin") when /v1 says so, ApiError(404) when the /api tree
/// does not know the coin (it may still be a pump coin without a family), ApiError(400) for a bad mint.
async function loadTree(mint: string, signal: AbortSignal): Promise<Loaded> {
  try {
    const r = await getJson<V1Tree>(`/v1/tree/${encodeURIComponent(mint)}`, signal);
    if (r.status === 200 && r.json && Array.isArray(r.json.nodes)) {
      const nodes = r.json.nodes.filter((n) => n && typeof n.mint === "string").map((n) => fromMapCoin({ ...n, image: localImage(n.image) }, n.parentMint ?? null));
      const root = r.json.root;
      // the root is one of the nodes; a server that lists only what hangs below it gets it added back
      if (root?.mint && !nodes.some((n) => n.mint === root.mint)) nodes.unshift(fromMapCoin({ ...root, image: localImage(root.image), mcapUsd: null, lockedUsd: null, children: 0, descendants: 0, migrated: false, createdAt: null }, null));
      if (nodes.length) return { nodes, source: "v1", at: Date.now() };
    }
    // /v1 answered for itself: the mint is malformed, or pump.fun does not know it (the tree route looks
    // coins up live and appends an untracked one with its chain, so a 404 is final)
    if (r.status === 400) throw new ApiError("That is not a valid mint address", 400);
    if (r.status === 404 && r.json) throw new ApiError(NOT_PUMP, 404);
  } catch (e) {
    if ((e as Error).name === "AbortError" || (e instanceof ApiError && (e.status === 400 || e.message === NOT_PUMP))) throw e;
  }
  const t = await api.tree(mint, 3);
  return { nodes: flattenTree(t), source: "api", at: Date.now() };
}
const NOT_PUMP = "not a pump.fun coin";

/// Name, ticker and logo of a coin the /api tree does not have (live lookup on the server), or null when
/// pump.fun does not know it. Only reached on a server without /v1.
async function lookupCoin(mint: string): Promise<Lone | null> {
  try { const { coin } = await api.coin(mint, { children: false, trades: false }); return { mint: coin.mint, name: coin.name, symbol: coin.symbol, image: coin.image, depth: coin.depth }; }
  catch (e) { if (e instanceof ApiError && e.status === 404) return null; throw e; }
}

export type TreeView = "branch" | "tree";
/// An ancestor drawn as context (dashed, fixed size, like the coin page): same node without its numbers,
/// cached per node object so an unchanged ancestor keeps its identity for BubbleMap's diff.
const ancestorViews = new WeakMap<BubbleNode, BubbleNode>();
const asAncestor = (n: BubbleNode) => { let v = ancestorViews.get(n); if (!v) { v = { ...n, mcapUsd: null, lockedUsd: null }; ancestorViews.set(n, v); } return v; };

/// The branch of `focus`: its ancestors (as context, nearest first) and everything below it.
export function branchOf(set: NodeSet, focus: string): BubbleNode[] {
  const f = set.get(focus);
  if (!f) return Array.from(set.values());
  const kids = new Map<string, BubbleNode[]>();
  for (const n of set.values()) if (n.parentMint) { const g = kids.get(n.parentMint); if (g) g.push(n); else kids.set(n.parentMint, [n]); }
  const out: BubbleNode[] = [];
  const seen = new Set<string>([focus]);
  for (let p = f.parentMint ? set.get(f.parentMint) : undefined, h = 0; p && !seen.has(p.mint) && h < 16; p = p.parentMint ? set.get(p.parentMint) : undefined, h++) { seen.add(p.mint); out.push(asAncestor(p)); }
  const stack = [f];
  while (stack.length) { const n = stack.pop()!; out.push(n); for (const k of kids.get(n.mint) ?? []) if (!seen.has(k.mint)) { seen.add(k.mint); stack.push(k); } }
  return out;
}

export default function EmbedTree() {
  const { mint = "" } = useParams();
  const params = useEmbedParams();
  const [search] = useSearchParams();
  const valid = isMintLike(mint);
  const set = useRef<NodeSet>(new Map());
  const fresh = useRef(new Set<string>());
  const [version, setVersion] = useState(0);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState<{ coin: Lone | null } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState<TreeView>(() => (search.get("view") === "tree" ? "tree" : "branch"));
  const bodyRef = useRef<HTMLDivElement>(null);
  const map = useRef<BubbleMapHandle>(null);
  const box = useBox(bodyRef);
  const active = useActive(bodyRef);
  const maxDepth = useMaxDepth();
  const loadedAt = useRef(0);
  const inflight = useRef<AbortController | null>(null);

  const load = useCallback((quiet: boolean) => {
    if (!valid) return;
    inflight.current?.abort();
    const ac = new AbortController();
    inflight.current = ac;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ac.abort(); }, 30_000);
    const current = () => inflight.current === ac;
    loadTree(mint, ac.signal).then((res) => {
      if (!current()) return;
      // A re-read is a diff: unchanged nodes keep their objects (BubbleMap diffs by reference) and
      // coins the server no longer lists in this tree are dropped.
      const keep = new Set(res.nodes.map((n) => n.mint));
      const gone = remove(set.current, Array.from(set.current.keys()).filter((m) => !keep.has(m)));
      const moved = upsert(set.current, res.nodes).length;
      loadedAt.current = res.at;
      setLoaded(res); setError(null); setMissing(null);
      if (gone || moved) setVersion((v) => v + 1);
    }).catch(async (e) => {
      if (!current()) return;
      if ((e as Error).name === "AbortError") { if (timedOut && (!quiet || !set.current.size)) setError("The tree took too long to load"); return; }
      if (e instanceof ApiError && e.status === 404) {
        // a lookup that fails (RPC down) is an error to retry, not a verdict on the mint
        let coin: Lone | null = null;
        if (e.message !== NOT_PUMP) { try { coin = await lookupCoin(mint); } catch (err) { if (current()) setError(errorMessage(err)); return; } }
        if (current()) setMissing({ coin });
        return;
      }
      if (!quiet || !set.current.size) setError(errorMessage(e));
    }).finally(() => clearTimeout(timer));
  }, [mint, valid]);

  useEffect(() => {
    set.current = new Map(); setLoaded(null); setError(null); setMissing(null); setSelected(null); setVersion((v) => v + 1);
    load(false);
    return () => inflight.current?.abort();
  }, [load]);
  // re-read while live, and at once when the frame comes back after a while
  useEffect(() => {
    if (!active || !valid) return;
    if (loadedAt.current && Date.now() - loadedAt.current > REFRESH_MS) load(true);
    const t = setInterval(() => { if (!document.hidden) load(true); }, REFRESH_MS);
    return () => clearInterval(t);
  }, [active, valid, load]);

  // live patches: a new child of any coin in this tree, and the numbers that moved
  const bump = useRef<ReturnType<typeof setTimeout> | null>(null);
  const changed = useCallback(() => { if (bump.current) return; bump.current = setTimeout(() => { bump.current = null; setVersion((v) => v + 1); }, 120); }, []);
  useEffect(() => () => { if (bump.current) clearTimeout(bump.current); }, []);
  useEvents({
    pair: (p) => {
      const pm = p.parent?.mint ?? p.coin.parentMint;
      if (!pm || !set.current.has(pm) || set.current.has(p.coin.mint)) return;
      const ch = applyPair(set.current, p);
      if (ch.length) { fresh.current.add(p.coin.mint); changed(); }
    },
    mapdelta: (d) => { if (applyDelta(set.current, d.updated).length) changed(); },
  }, active && !!loaded);

  // everything below reads the set through `version` (it is mutated in place)
  /* eslint-disable react-hooks/exhaustive-deps */
  const all = useMemo(() => Array.from(set.current.values()), [version]);
  const branch = useMemo(() => branchOf(set.current, mint), [version, mint]);
  const focusNode = useMemo(() => set.current.get(mint) ?? null, [version, mint]);
  const root = useMemo(() => { const s = set.current; let r = focusNode; for (let h = 0; r?.parentMint && s.has(r.parentMint) && h < 16; h++) r = s.get(r.parentMint)!; return r; }, [version, focusNode]);
  /* eslint-enable react-hooks/exhaustive-deps */
  // The whole tree is a separate view only when it holds more than the branch (a child with siblings).
  const hasTree = loaded?.source === "v1" && all.length > branch.length;
  const shown = hasTree && view === "tree" ? all : branch;
  const sel = selected ? set.current.get(selected) ?? null : null;
  const selParent = sel?.parentMint ? set.current.get(sel.parentMint) ?? null : null;
  const compact = compactBox(box);
  const tiny = box.w > 0 && box.w < 400;
  const onSelect = useCallback((n: BubbleNode | null) => setSelected(n?.mint ?? null), []);
  useEscape(() => setSelected(null));
  // a selection outside the view (the branch after "whole tree") is dropped with it
  useEffect(() => { if (selected && !shown.some((n) => n.mint === selected)) setSelected(null); }, [shown, selected]);

  const headNode = focusNode ?? missing?.coin ?? null;
  const total = all.length;
  const title = `Family tree · ${headNode ? sym(headNode) : "Spore"}`;
  const head = (
    <>
      <HeadTitle label="Family tree" node={headNode} loading={valid && !loaded && !missing && !error} />
      {loaded && root && <p className="embed-meta"><b>{count(total)}</b> coin{total === 1 ? "" : "s"}{root.lockedUsd != null && root.lockedUsd > 0 && <> · <b>{usd(root.lockedUsd)}</b> locked</>}</p>}
      <div className="embed-head-acts">
        {headNode && <LaunchCta node={headNode} maxDepth={maxDepth} compact={tiny} />}
      </div>
    </>
  );

  const lonely = !!loaded && !!focusNode && focusNode.children === 0;
  const top = (hasTree ? 40 : 0) + (sel ? (compact ? 96 : 150) : 12);
  // The bottom overlays sit at 44 px, above "Powered by": the legend (up to two rows) when it is
  // shown, and the "No coins under" note on a leaf. The fit keeps the coin and its label clear of them.
  const bottom = Math.max(40, compact ? 0 : 100, lonely && !sel ? 78 : 0);
  const inset = useMemo(() => ({ top, bottom }), [top, bottom]);
  const siblings = focusNode?.parentMint ? (set.current.get(focusNode.parentMint)?.children ?? 1) - 1 : 0;
  return (
    <EmbedFrame params={params} title={title} head={head} bodyRef={bodyRef}>
      {!valid ? <EmbedState tone="bad" title="Not a mint address" hint={<>The embed URL ends in a coin's mint: <code>/embed/tree/&lt;mint&gt;</code>.</>} />
        : error && !all.length ? <EmbedState tone="bad" title="The tree could not load" hint={error} action={<button type="button" className="embed-btn" onClick={() => load(false)}>Retry</button>} />
        : missing ? (missing.coin
          ? <EmbedState title={`No family yet for ${sym(missing.coin)}`} hint="Nothing trades under this coin on pump.fun yet. A coin launched under it would be the first branch of its tree." action={<Out href={launchUrl(missing.coin.mint)} className="embed-btn accent">Launch the first one <span aria-hidden="true">↗</span></Out>} />
          : <EmbedState tone="bad" title="Not a pump.fun coin" hint="Spore draws family trees of pump.fun coins. This mint is not one." />)
        : !loaded ? <div className="embed-loading" aria-label="Loading the family tree"><i /><i /><i /></div>
        : <>
            <BubbleMap ref={map} nodes={shown} focus={focusNode ? mint : undefined} select={selected} onSelect={onSelect} height="100%" mode={params.size}
              className="bm-full embed-map" inset={inset} fresh={fresh.current} live={active} hideLegend={compact} />
            {hasTree && (
              <div className="embed-view seg" role="group" aria-label="What to draw">
                <button type="button" aria-pressed={view === "branch"} onClick={() => setView("branch")} title={`${sym(focusNode)}, its ancestors and everything below it`}>branch</button>
                <button type="button" aria-pressed={view === "tree"} onClick={() => setView("tree")} title={siblings > 0 ? `The whole family from ${sym(root)}: ${count(total)} coins, ${count(siblings)} sibling${siblings === 1 ? "" : "s"} of ${sym(focusNode)}` : `The whole family from ${sym(root)}`}>whole tree <b>{count(total)}</b></button>
              </div>
            )}
            {sel && <SelectionCard node={sel} parent={selParent} maxDepth={maxDepth} onClose={() => setSelected(null)}
              extra={!compact && sel.mint !== mint ? <Out href={mapUrl(sel.mint)} className="embed-btn ghost" title="This coin on the full Spore map">Map <span aria-hidden="true">↗</span></Out> : null} />}
            {lonely && !sel && focusNode && (
              <div className="embed-note" role="status">
                <span>No coins under {sym(focusNode)} yet.</span>
                {canLaunchUnder(focusNode, maxDepth) ? <Out href={launchUrl(mint)} className="embed-link">Launch the first <span aria-hidden="true">↗</span></Out>
                  : <Out href={coinUrl(mint)} className="embed-link" title={`${nameOf(focusNode)} on Spore`}>Open on Spore <span aria-hidden="true">↗</span></Out>}
              </div>
            )}
          </>}
    </EmbedFrame>
  );
}
