// /embed/map[?focus=<mint>] — the whole ecosystem map as an iframe widget (DESIGN §12). Same data layer as
// the /map page (lib/map/use-map-data: IndexedDB cache first, `since=` deltas, live `pair`/`mapdelta`) and
// the same BubbleMap, without the page's side panel, rails or filters. `?focus=` selects a coin and the
// camera frames it with its parent and children; clicks select (a small card with links to the site in a
// new tab), never navigate the frame. `?roots=all|200|60` caps the root clusters (phones default to the top
// 200, like /map; a focus outside them widens to all), `?size=mcap` sizes by market cap.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useMapData } from "../../lib/map/use-map-data";
import { useMapHeat } from "../../lib/map/heat";
import { rootCmp } from "../../lib/map/nodes";
import type { BubbleNode, RootsLimit } from "../../lib/map/types";
import { count, usd } from "../../lib/format";
import BubbleMap, { type BubbleMapHandle } from "../../components/BubbleMap";
import { sym } from "../../components/Bits";
import { EmbedFrame, EmbedState, HeadTitle, LaunchCta, Out, SelectionCard, compactBox, coinUrl, isMintLike, mapUrl, useActive, useBox, useEmbedParams, useEscape, useMaxDepth } from "./common";

/// Devices whose screen is at most this wide draw the top 200 roots by default (the /map page's phone rule).
/// The screen, not the frame: a small iframe on a desktop draws everything as fast as the full page does.
const PHONE_W = 700;
const isPhone = () => typeof screen !== "undefined" && screen.width > 0 && screen.width <= PHONE_W;

export default function EmbedMap() {
  const params = useEmbedParams();
  const [search] = useSearchParams();
  const focusParam = search.get("focus");
  const rootsParam = search.get("roots");
  const [selected, setSelected] = useState<string | null>(() => (isMintLike(focusParam) ? focusParam : null));
  useEffect(() => { setSelected(isMintLike(focusParam) ? focusParam : null); }, [focusParam]);
  const bodyRef = useRef<HTMLDivElement>(null);
  const map = useRef<BubbleMapHandle>(null);
  const box = useBox(bodyRef);
  const active = useActive(bodyRef);
  const maxDepth = useMaxDepth();
  const data = useMapData();
  const heat = useMapHeat(true);
  const [phone] = useState(isPhone);
  const [widened, setWidened] = useState(false);
  const limit: RootsLimit = widened || rootsParam === "all" ? "all" : rootsParam === "200" ? 200 : rootsParam === "60" ? 60 : phone ? 200 : "all";

  // The drawn set: everything, or the subtrees of the top-n roots (server order: locked, mcap, descendants).
  const allByMint = useMemo(() => new Map(data.nodes.map((n) => [n.mint, n])), [data.nodes]);
  const nodes = useMemo<BubbleNode[]>(() => {
    const all = data.nodes;
    if (limit === "all") return all;
    const roots = all.filter((n) => !n.parentMint || !allByMint.has(n.parentMint)).sort(rootCmp).slice(0, limit);
    const keep = new Set(roots.map((r) => r.mint));
    const rootOf = new Map<string, string>();
    const top = (n: BubbleNode) => { const hit = rootOf.get(n.mint); if (hit) return hit; let cur = n, hops = 0; while (cur.parentMint && allByMint.has(cur.parentMint) && hops++ < 8) cur = allByMint.get(cur.parentMint)!; rootOf.set(n.mint, cur.mint); return cur.mint; };
    return all.filter((n) => keep.has(top(n)));
  }, [data.nodes, allByMint, limit]);
  // a drawn subtree hangs from a drawn root, so "root" can be read against the whole set
  const drawn = useMemo(() => { let roots = 0; for (const n of nodes) if (!n.parentMint || !allByMint.has(n.parentMint)) roots++; return { roots, coins: nodes.length }; }, [nodes, allByMint]);
  // A focus outside the drawn roots: draw everything once the set has it.
  useEffect(() => { if (selected && limit !== "all" && allByMint.has(selected) && !nodes.some((n) => n.mint === selected)) setWidened(true); }, [selected, limit, allByMint, nodes]);

  const sel = selected ? allByMint.get(selected) ?? null : null;
  const selParent = sel?.parentMint ? allByMint.get(sel.parentMint) ?? null : null;
  const onSelect = useCallback((n: BubbleNode | null) => setSelected(n?.mint ?? null), []);
  useEscape(() => setSelected(null));
  const compact = compactBox(box);
  const tiny = box.w > 0 && box.w < 400;
  const ready = !data.loading || data.nodes.length > 0;
  const lost = !!selected && ready && !data.loading && !data.syncing && !allByMint.has(selected);
  // the selection card covers the top-left: flights frame the coin below it
  const inset = useMemo(() => ({ top: sel ? (compact ? 96 : 150) : 12, bottom: 40 }), [sel, compact]);
  const lockedTotal = useMemo(() => { let l = 0; for (const n of nodes) if (!n.parentMint || !allByMint.has(n.parentMint)) l += n.lockedUsd ?? 0; return l; }, [nodes, allByMint]);

  const head = (
    <>
      <HeadTitle label={tiny && sel ? "Map" : "Ecosystem map"} node={sel} />
      {ready && !tiny && !sel && nodes.length > 0 && <p className="embed-meta"><b>{count(drawn.roots)}</b> trees · <b>{count(drawn.coins)}</b> coins{!compact && lockedTotal > 0 && <> · <b>{usd(lockedTotal)}</b> locked</>}</p>}
      <div className="embed-head-acts">
        {sel ? <LaunchCta node={sel} maxDepth={maxDepth} compact={tiny} /> : <Out href={mapUrl(null)} className="embed-cta" title="The full map on Spore (opens in a new tab)">{tiny ? "Full map" : "Open the full map"} <span className="embed-arrow" aria-hidden="true">↗</span></Out>}
      </div>
    </>
  );

  return (
    <EmbedFrame params={params} title={sel ? `Ecosystem map · ${sym(sel)} · Spore` : "Ecosystem map · Spore"} head={head} bodyRef={bodyRef}>
      {!ready && !data.error ? <div className="embed-loading" aria-label="Loading the map"><i /><i /><i /></div>
        : data.error && data.nodes.length === 0 ? <EmbedState tone="bad" title="The map could not load" hint={data.error} action={<button type="button" className="embed-btn" onClick={data.reload}>Retry</button>} />
        : nodes.length === 0 ? <EmbedState title="The map is empty" hint="It fills in as pairs appear on pump.fun." />
        : <>
            <BubbleMap ref={map} nodes={nodes} height="100%" mode={params.size} className="bm-full embed-map" inset={inset} select={selected} onSelect={onSelect}
              fresh={data.fresh} onLayout={data.persistPositions} live={active} heat={heat} hideLegend={compact} />
            {sel && <SelectionCard node={sel} parent={selParent} maxDepth={maxDepth} onClose={() => setSelected(null)}
              extra={!compact ? <Out href={mapUrl(sel.mint)} className="embed-btn ghost" title="This coin on the full Spore map">Map <span aria-hidden="true">↗</span></Out> : null} />}
            {lost && selected && (
              <div className="embed-note" role="status">
                <span>That coin is not on the map yet.</span>
                <Out href={coinUrl(selected)} className="embed-link">Open it on Spore <span aria-hidden="true">↗</span></Out>
              </div>
            )}
          </>}
    </EmbedFrame>
  );
}
