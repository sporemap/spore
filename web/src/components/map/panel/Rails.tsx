// Live rails beside the map (DESIGN §11.5 "Map v2"): the newest pairs (live arrivals flash), the most
// traded coins of the last hour (only when the heat sidecar answers), the trees that grew most in a day,
// and the Spore launches. Lists are recomputed at most every 3 s and capped at 12 rows, so the stream
// never re-renders more than a dozen buttons; hovering a row lights its bubble, clicking selects it.
import { useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useTick } from "../../../lib/hooks";
import { age, count, usd } from "../../../lib/format";
import type { HeatIndex } from "../../../lib/map/heat";
import { railGrowing, railHot, railNew, railSpore, type RailRow } from "../../../lib/map/rails";
import type { BubbleNode } from "../../../lib/map/types";
import { Logo, sym } from "../../Bits";
import { useThrottled } from "./util";

export type RailTab = "new" | "hot" | "growing" | "spore";
const ROWS = 12;
const TAB_LABEL: Record<RailTab, string> = { new: "New", hot: "Hot", growing: "Growing", spore: "Spore" };
const COLLAPSE_KEY = "spore.mapRails", TAB_KEY = "spore.mapRailTab";
const read = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* storage blocked */ } };

type Props = {
  nodes: BubbleNode[]; byMint: Map<string, BubbleNode>; recent: BubbleNode[]; heat: HeatIndex | null; version: number;
  onPick: (n: BubbleNode) => void; onHover: (mint: string | null) => void;
  /// "card": the collapsible card in the desktop column. "pop": the phone overlay (always open).
  variant?: "card" | "pop";
};

export default function Rails({ nodes, byMint, recent, heat, version, onPick, onHover, variant = "card" }: Props) {
  const [collapsed, setCollapsed] = useState(() => variant === "card" && read(COLLAPSE_KEY) === "1");
  const [tab, setTabState] = useState<RailTab>(() => { const t = read(TAB_KEY); return t === "hot" || t === "growing" || t === "spore" ? t : "new"; });
  const tabs: RailTab[] = heat ? ["new", "hot", "growing", "spore"] : ["new", "growing", "spore"];
  const cur: RailTab = tabs.includes(tab) ? tab : "new";
  const setTab = (t: RailTab) => { setTabState(t); write(TAB_KEY, t); };
  const toggle = () => { const next = !collapsed; setCollapsed(next); write(COLLAPSE_KEY, next ? "1" : "0"); };

  // The inputs as of the last 3 s tick: a burst of live events costs one recompute, not one per event.
  const v = useThrottled(version, 3_000);
  const hv = useThrottled(heat?.version ?? -1, 3_000);
  const live = useRef({ nodes, byMint, recent, heat });
  live.current = { nodes, byMint, recent, heat };
  const open = !collapsed || variant === "pop";
  const rows = useMemo<RailRow[]>(() => {
    if (!open) return [];
    const { nodes: ns, byMint: bm, recent: rc, heat: h } = live.current;
    const nowS = Math.floor(Date.now() / 1000);
    switch (cur) {
      case "new": return railNew(ns, bm, rc, ROWS);
      case "hot": return railHot(ns, bm, h, ROWS);
      case "growing": return railGrowing(ns, bm, nowS, 86_400, ROWS);
      case "spore": return railSpore(ns, bm, ROWS);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v, hv, cur, open]);
  useTick(cur === "new" && open ? 30_000 : 3_600_000);
  // Pairs that arrived live after the rail mounted flash once (CSS animation on mount of the row).
  const seenLive = useRef<Set<string> | null>(null);
  if (seenLive.current === null) seenLive.current = new Set(recent.map((r) => r.mint));
  const liveMints = useMemo(() => new Set(recent.map((r) => r.mint)), [recent]);

  const metric = (r: RailRow) => {
    switch (cur) {
      case "new": return <span className="mono">{age(r.metric)}</span>;
      case "hot": return <span className="mono"><b>{count(r.metric)}</b> trade{r.metric === 1 ? "" : "s"} 1h</span>;
      case "growing": return <span className="mono good">+{count(r.metric)} 24h</span>;
      case "spore": return <span className="mono">{usd(r.metric)}</span>;
    }
  };

  return (
    <section className={`map-rails ${variant} ${open ? "" : "collapsed"}`} aria-label="Live rails">
      <header>
        <div className="map-rail-tabs" role="tablist" aria-label="Rails">
          {tabs.map((t) => <button type="button" role="tab" key={t} aria-selected={cur === t} onClick={() => { setTab(t); if (collapsed) toggle(); }}>{TAB_LABEL[t]}</button>)}
        </div>
        {variant === "card" && <button type="button" className="map-rail-fold" onClick={toggle} aria-expanded={open} aria-label={open ? "Collapse rails" : "Expand rails"} title={open ? "Collapse" : "Expand"}><svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d={open ? "M2 6.5 5 3.5 8 6.5" : "M2 3.5 5 6.5 8 3.5"} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg></button>}
      </header>
      {open && (
        <div className="map-rail-body" role="tabpanel" aria-label={TAB_LABEL[cur]}>
          {rows.length === 0
            ? <p className="map-rail-empty">{cur === "hot" ? "No trades in the last hour." : cur === "growing" ? "No new pairs in the last 24 h." : cur === "spore" ? "No Spore launches on the map yet." : "No new pairs yet."}</p>
            : (
              <ul onMouseLeave={() => onHover(null)}>
                {rows.map((r) => {
                  const flash = cur === "new" && liveMints.has(r.node.mint) && !seenLive.current!.has(r.node.mint);
                  return (
                    <li key={r.node.mint}>
                      <button type="button" className={`map-rail-row ${flash ? "flash" : ""}`} onClick={() => onPick(r.node)} onMouseEnter={() => onHover(r.node.mint)} onFocus={() => onHover(r.node.mint)} title={r.node.name ?? undefined}>
                        <Logo src={r.node.image} label={r.node.symbol} size={22} />
                        <span className="map-rail-name"><b>{sym(r.node)}</b>{r.parent ? <span>↳ {sym(r.parent)}</span> : r.node.depth === 0 ? <span>root</span> : null}</span>
                        <span className="map-rail-metric">{metric(r)}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          {cur === "spore" && <Link to="/launch" className={`btn ${rows.length < 5 ? "accent" : "ghost"} sm map-rail-cta`}>Launch yours</Link>}
        </div>
      )}
    </section>
  );
}
