// The selected coin beside the map (desktop) or in the bottom sheet (phone). Numbers that describe the
// tree (mcap, locked by children, children, descendants) come from the map node: that is the all-scope
// truth, while /api/coin is scoped to Spore launches in production and reports 0 there. Trading numbers
// (price, 24 h volume, curve, socials, ours) come from a light /api/coin call (no children, no trades),
// debounced so an arrow-key walk does not fire a request per step; the sparkline reads
// /api/candles?scope=all and shows "—" when the server has none (or predates the route).
import { useEffect, useMemo, useState, type RefObject } from "react";
import { Link } from "react-router-dom";
import { api, xShareUrl, type Candles, type Coin } from "../../../lib/api";
import { copyText, useAsync, useDebounced } from "../../../lib/hooks";
import { age, ago, count, pct, short, signedPct, usd } from "../../../lib/format";
import type { HeatRow } from "../../../lib/map/heat";
import { mapLink, shareText } from "../../../lib/map/share";
import type { BubbleNode } from "../../../lib/map/types";
import type { BubbleMapHandle } from "../../BubbleMap";
import { DepthBadge, Logo, ProgressBar, Skeleton, nameOf, sym } from "../../Bits";
import LaunchButton, { launchBlock } from "../../LaunchButton";
import { useToast } from "../../Toast";
import Sparkline, { candleChange, spanLabel } from "./Sparkline";

const PAGE = 40;
export type KidSort = "locked" | "mcap" | "new";
/// The children-list order (and what ↓ / ← / → walk): locked value, then market cap.
export const kidCmp = (a: BubbleNode, b: BubbleNode) => (b.lockedUsd ?? 0) - (a.lockedUsd ?? 0) || (b.mcapUsd ?? 0) - (a.mcapUsd ?? 0) || (a.mint < b.mint ? -1 : a.mint > b.mint ? 1 : 0);
const SORTS: Record<KidSort, (a: BubbleNode, b: BubbleNode) => number> = {
  locked: kidCmp,
  mcap: (a, b) => (b.mcapUsd ?? 0) - (a.mcapUsd ?? 0) || kidCmp(a, b),
  new: (a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0) || kidCmp(a, b),
};
const httpUrl = (u: string | null | undefined): string | null => { if (!u) return null; try { const x = new URL(u); return x.protocol === "https:" || x.protocol === "http:" ? x.href : null; } catch { return null; } };

/// /api/coin for the selected mint, light (children=0, trades=0) and debounced 150 ms. The result is only
/// returned while it belongs to `mint`, so a fast walk never shows the previous coin's numbers.
export function usePanelCoin(mint: string | null): { coin: Coin | null; error: string | null } {
  const dm = useDebounced(mint, 150);
  const a = useAsync(() => (dm ? api.coin(dm, { children: false, trades: false }) : Promise.resolve(null)), [dm]);
  const coin = a.data && mint && a.data.coin.mint === mint ? a.data.coin : null;
  return { coin, error: dm === mint && !coin ? a.error : null };
}

/// 5-minute candles of any tracked coin; an error (404 on an older server in ours mode) reads as "none".
function useCandles(mint: string): Candles | null | undefined {
  const dm = useDebounced(mint, 150);
  const a = useAsync<Candles>(() => api.candles(dm, 300, "all").catch(() => ({ candles: [], priceKey: "usd" as const })), [dm]);
  return dm !== mint || a.loading ? undefined : a.data;
}

const Icon = {
  x: <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M17.8 3h3.1l-6.8 7.8 8 10.2h-6.3l-4.9-6.4L5.3 21H2.2l7.3-8.3L1.8 3h6.4l4.4 5.9L17.8 3Zm-1.1 16.2h1.7L7.4 4.7H5.6l11.1 14.5Z" /></svg>,
  tg: <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M21.9 4.3 18.8 19c-.2 1-.9 1.3-1.7.8l-4.8-3.5-2.3 2.2c-.3.3-.5.5-1 .5l.3-4.9 8.9-8c.4-.3-.1-.5-.6-.2L6.6 12.8 1.9 11.3c-1-.3-1-1 .2-1.5L20.5 2.7c.9-.3 1.6.2 1.4 1.6Z" /></svg>,
  web: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9S14.5 18.4 12 21c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3Z" /></svg>,
  copy: <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><rect x="5" y="5" width="8.5" height="8.5" rx="2" /><path d="M10.5 3.5V3A1.5 1.5 0 0 0 9 1.5H3A1.5 1.5 0 0 0 1.5 3v6A1.5 1.5 0 0 0 3 10.5h.5" /></svg>,
};

type Props = {
  node: BubbleNode; byMint: Map<string, BubbleNode>;
  /// Direct children on the map, in kidCmp order.
  kids: BubbleNode[];
  coin: Coin | null; coinError: string | null;
  heat: HeatRow | null; heatOn: boolean;
  maxDepth: number | undefined;
  map: RefObject<BubbleMapHandle | null>;
  onPick: (mint: string) => void; onClose: () => void;
  /// Phone peek: the coin, its market cap and change, and the two actions only.
  peek?: boolean;
};

export default function SidePanel({ node, byMint, kids, coin: c, coinError, heat, heatOn, maxDepth, map, onPick, onClose, peek = false }: Props) {
  const toast = useToast();
  const candles = useCandles(node.mint);
  const change = candleChange(candles?.candles);
  const parent = node.parentMint ? byMint.get(node.parentMint) ?? null : null;
  const chain = useMemo(() => {
    const out: BubbleNode[] = [];
    let cur: BubbleNode | undefined = node;
    for (let hops = 0; cur && hops < 12; hops++) { out.unshift(cur); cur = cur.parentMint ? byMint.get(cur.parentMint) : undefined; }
    return out;
  }, [node, byMint]);
  const root = chain[0] ?? node;
  const [sort, setSort] = useState<KidSort>("locked");
  const [shown, setShown] = useState(PAGE);
  useEffect(() => setShown(PAGE), [node.mint]);
  const sorted = useMemo(() => (sort === "locked" ? kids : kids.slice().sort(SORTS[sort])), [kids, sort]);
  const created = c?.createdAt ?? node.createdAt ?? null;
  const ours = c?.ours ?? node.ours;
  const block = launchBlock({ depth: node.depth, mayhem: c?.mayhem }, maxDepth);
  const link = mapLink(node.mint);
  const copy = async (text: string, what: string) => { if (await copyText(text)) toast.success(`${what} copied`); else toast.error("Could not copy"); };
  const changeEl = change
    ? <span className={`map-chg ${change.ratio >= 0 ? "up" : "down"}`} title={`Change over the candles the indexer has (${spanLabel(change.spanS)})`}>{signedPct(change.ratio)} · {spanLabel(change.spanS)}</span>
    : <span className="map-chg none" title="No candles for this coin yet">—</span>;
  // A long ticker is cut so the button keeps one line beside "Open coin".
  const tick = sym(node);
  const launchLabel = `Launch under ${tick.length > 7 ? `${tick.slice(0, 6)}…` : tick}`;
  const launch = c ? <LaunchButton coin={c} maxDepth={maxDepth} className="block" label={launchLabel} />
    : block ? <button type="button" className="btn accent block" disabled title={block}>{launchLabel}</button>
    : <Link to={`/launch?parent=${node.mint}`} className="btn accent block launch-cta" title={`Launch a coin under ${tick}`}>{launchLabel}</Link>;
  const mainActs = <div className="map-side-main">{launch}<Link to={`/c/${node.mint}`} className="btn ghost">Open coin →</Link></div>;
  const close = <button type="button" className="map-side-close" aria-label="Close" title="Close (Esc)" onClick={onClose}>×</button>;

  if (peek) {
    return (
      <div className="map-side-in peek">
        {close}
        <div className="map-side-head">
          <Logo src={node.image} label={node.symbol} size={36} className="ring" />
          <div className="map-side-title"><b>{nameOf(node)}</b><span className="mono muted">{sym(node)} · {usd(node.mcapUsd)} mcap</span></div>
          {changeEl}
        </div>
        {mainActs}
      </div>
    );
  }

  const tw = httpUrl(c?.twitter), tg = httpUrl(c?.telegram), web = httpUrl(c?.website);
  return (
    <div className="map-side-in">
      {close}
      <div className="map-side-head">
        <Logo src={node.image} label={node.symbol} size={44} className="ring" />
        <div className="map-side-title">
          <b title={nameOf(node)}>{nameOf(node)}</b>
          <span className="mono muted">{sym(node)}{created ? ` · ${age(created)}` : ""}</span>
          <span className="map-side-ids">
            <button type="button" className="map-ca" onClick={() => copy(node.mint, "Contract address")} title={`Copy ${node.mint}`}>{short(node.mint, 4)} {Icon.copy}</button>
            {tw && <a className="map-soc" href={tw} target="_blank" rel="noopener noreferrer" aria-label="X / Twitter" title={tw}>{Icon.x}</a>}
            {tg && <a className="map-soc" href={tg} target="_blank" rel="noopener noreferrer" aria-label="Telegram" title={tg}>{Icon.tg}</a>}
            {web && <a className="map-soc" href={web} target="_blank" rel="noopener noreferrer" aria-label="Website" title={web}>{Icon.web}</a>}
          </span>
        </div>
        <DepthBadge depth={node.depth} />
      </div>
      <nav className="map-crumbs" aria-label="Family">
        <ol>
          {chain.map((n, i) => (
            <li key={n.mint}>{i > 0 && <span className="sep" aria-hidden="true">›</span>}{n === node ? <b aria-current="true">{sym(n)}</b> : <button type="button" onClick={() => onPick(n.mint)} title={`Select ${nameOf(n)}`}>{sym(n)}</button>}</li>
          ))}
        </ol>
        <button type="button" className="map-frame" onClick={() => map.current?.fitCluster(root.mint, { select: false })} title={`Frame the whole ${sym(root)} tree (F)`}>Frame tree</button>
      </nav>
      {(node.migrated || c?.complete || ours || c?.oursPending) && (
        <div className="map-side-row">
          {node.migrated ? <span className="chip good">graduated</span> : c?.complete ? <span className="chip warn">migrating</span> : null}
          {ours ? <span className="chip accent">launched on Spore</span> : c?.oursPending ? <span className="chip warn">verifying</span> : null}
        </div>
      )}
      <div className="map-side-market">
        <div className="map-side-price">
          <em>price</em>
          <strong>{c ? usd(c.priceUsd) : coinError ? "—" : <Skeleton w={60} h={15} />}</strong>
          {candles === undefined ? <Skeleton w={70} h={12} /> : changeEl}
        </div>
        <div className="map-side-spark">{candles === undefined ? <Skeleton w={120} h={32} /> : candles && candles.candles.length >= 2 ? <Sparkline candles={candles.candles} title={`${sym(node)} price, last ${spanLabel(change?.spanS ?? 0)}`} /> : <span className="map-spark-none">—</span>}</div>
      </div>
      {heatOn && <p className="map-side-heat">{heat && heat.t1h > 0 ? <><b>{count(heat.t1h)}</b> trade{heat.t1h === 1 ? "" : "s"} 1h</> : "no trades 1h"}{heat && heat.last > 0 ? <> · last trade {ago(heat.last)}</> : null}</p>}
      <div className="map-side-stats">
        <div><em>mcap</em><strong>{usd(node.mcapUsd)}</strong></div>
        <div><em>locked by children</em><strong className="accent">{usd(node.lockedUsd)}</strong></div>
        <div><em>children</em><strong>{count(node.children)}{(node.descendants ?? 0) > node.children ? <small> / {count(node.descendants)}</small> : null}</strong></div>
        <div><em>24h volume</em><strong>{c ? usd(c.volume24hUsd) : coinError ? "—" : <Skeleton w={48} h={14} />}{c && c.trades24h > 0 ? <small> · {count(c.trades24h)} tx</small> : null}</strong></div>
      </div>
      {c && !c.migrated && <div className="map-side-progress"><span><em>curve</em><strong>{pct(c.progress)}</strong></span><ProgressBar value={c.progress} /></div>}
      <div className="map-side-actions">
        {mainActs}
        <div className="map-side-links">
          <button type="button" className="btn ghost sm" onClick={() => copy(link, "Map link")} title={link}>Share</button>
          <a className="btn ghost sm" href={xShareUrl(shareText(node, parent), link)} target="_blank" rel="noopener noreferrer" title="Post this coin's family tree on X">Post on X</a>
          <button type="button" className="btn ghost sm" onClick={() => copy(node.mint, "Contract address")}>Copy CA</button>
          <button type="button" className="btn ghost sm" onClick={() => map.current?.fit()} title="Zoom back out to the whole map (0)">Whole map</button>
        </div>
      </div>
      {kids.length > 0 && (
        <section className="map-kids" aria-label={`Coins under ${sym(node)}`}>
          <header>
            <em>under {sym(node)} · {count(kids.length)}</em>
            <div className="seg sm" role="group" aria-label="Sort children">{(["locked", "mcap", "new"] as const).map((k) => <button type="button" key={k} aria-pressed={sort === k} onClick={() => setSort(k)}>{k}</button>)}</div>
          </header>
          <ul onMouseLeave={() => map.current?.hoverNode(null)}>
            {sorted.slice(0, shown).map((k) => (
              <li key={k.mint}>
                <button type="button" className="map-kid" onClick={() => onPick(k.mint)} onMouseEnter={() => map.current?.hoverNode(k.mint)} onFocus={() => map.current?.hoverNode(k.mint)} title={nameOf(k)}>
                  <Logo src={k.image} label={k.symbol} size={18} />
                  <b>{sym(k)}</b>
                  <span className="mono" title="market cap">{usd(k.mcapUsd)}</span>
                  <span className="mono accent" title="locked by its children">{k.lockedUsd ? usd(k.lockedUsd) : "—"}</span>
                  <span className="mono muted" title="age">{k.createdAt ? age(k.createdAt) : "—"}</span>
                </button>
              </li>
            ))}
          </ul>
          {sorted.length > shown && <button type="button" className="map-more linkish" onClick={() => setShown((s) => s + PAGE)}>show {Math.min(PAGE, sorted.length - shown)} more of {count(sorted.length - shown)}</button>}
        </section>
      )}
      {coinError && !c && <p className="hint">{coinError}</p>}
    </div>
  );
}
