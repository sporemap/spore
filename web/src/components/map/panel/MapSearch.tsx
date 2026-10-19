// The map's find box (DESIGN §11.5 "Map v2"). Searches the FULL node set (not only the drawn roots) by
// ticker and name, resolves a pasted mint or pump.fun coin URL, and below the local hits asks the API
// for coins that are not on the map yet (with "Open coin" / "Launch under it"). Focused and empty, it
// lists the last picks. ↑/↓/Enter/Esc drive the list; the `.map-search input` selector is what the
// global "/" shortcut focuses.
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, type Coin } from "../../../lib/api";
import { useDebounced } from "../../../lib/hooks";
import { count, usd } from "../../../lib/format";
import type { BubbleNode } from "../../../lib/map/types";
import { Logo, nameOf, sym } from "../../Bits";

const MAX_LOCAL = 8, MAX_REMOTE = 5, MAX_RECENT = 8;
const RECENT_KEY = "spore.mapRecent";
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const PUMP_URL = /pump\.fun\/(?:[^\s?#]*\/)?coin\/([1-9A-HJ-NP-Za-km-z]{32,44})/i;

/// A mint from a pasted value: a bare base58 address, or a pump.fun …/coin/<mint> link. Null otherwise.
export function extractMint(q: string): string | null {
  const t = q.trim();
  if (BASE58.test(t)) return t;
  const m = PUMP_URL.exec(t);
  return m ? m[1] : null;
}

type Recent = { mint: string; symbol: string | null; name: string | null; image: string | null };
export function readRecent(): Recent[] {
  try { const raw = localStorage.getItem(RECENT_KEY); const v = raw ? JSON.parse(raw) : []; return Array.isArray(v) ? v.filter((x) => x && typeof x.mint === "string").slice(0, MAX_RECENT) : []; } catch { return []; }
}
export function pushRecent(n: Pick<BubbleNode, "mint" | "symbol" | "name" | "image">) {
  try {
    const list = [{ mint: n.mint, symbol: n.symbol, name: n.name, image: n.image }, ...readRecent().filter((x) => x.mint !== n.mint)].slice(0, MAX_RECENT);
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch { /* storage blocked: recents are a convenience */ }
}

type Index = { src: BubbleNode[]; sym: string[]; name: string[] };
const score = (s: string, m: string, needle: string) => (s === needle ? 4 : s.startsWith(needle) ? 3 : m.startsWith(needle) ? 2 : s.includes(needle) || m.includes(needle) ? 1 : 0);

type Props = {
  nodes: BubbleNode[]; byMint: Map<string, BubbleNode>;
  /// Selecting a coin on the map (the page widens the roots when it is outside the drawn ones).
  onPick: (n: BubbleNode) => void;
};

type Option = { kind: "local"; node: BubbleNode } | { kind: "recent"; node: BubbleNode };

export default function MapSearch({ nodes, byMint, onPick }: Props) {
  const [q, setQ] = useState("");
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState(0);
  const [recent, setRecent] = useState<Recent[]>([]);
  const dq = useDebounced(q, 120);
  const rq = useDebounced(q, 250);
  const index = useRef<Index | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  // The node set changes identity on every live event: effects read it through a ref so a burst of
  // events never re-fires a lookup or a remote search for the same query.
  const byMintRef = useRef(byMint); byMintRef.current = byMint;
  const onPickRef = useRef(onPick); onPickRef.current = onPick;
  const mintQ = useMemo(() => extractMint(dq), [dq]);
  // A pasted mint or pump.fun link of a coin on the map selects it straight away.
  useEffect(() => {
    if (!mintQ) return;
    const n = byMintRef.current.get(mintQ);
    if (n) { pushRecent(n); onPickRef.current(n); setQ(""); input.current?.blur(); }
  }, [mintQ]);

  const local = useMemo<BubbleNode[]>(() => {
    const needle = dq.trim().toLowerCase().replace(/^\$/, "");
    if (!needle || mintQ) return [];
    // The lowercase index is rebuilt only when the node list changed since the last search.
    if (!index.current || index.current.src !== nodes) index.current = { src: nodes, sym: nodes.map((n) => (n.symbol ?? "").toLowerCase()), name: nodes.map((n) => (n.name ?? "").toLowerCase()) };
    const ix = index.current;
    const hits: [BubbleNode, number][] = [];
    for (let i = 0; i < ix.src.length; i++) { const sc = score(ix.sym[i], ix.name[i], needle); if (sc > 0) hits.push([ix.src[i], sc]); }
    hits.sort((a, b) => b[1] - a[1] || (b[0].lockedUsd ?? 0) - (a[0].lockedUsd ?? 0) || (b[0].mcapUsd ?? 0) - (a[0].mcapUsd ?? 0));
    return hits.slice(0, MAX_LOCAL).map(([n]) => n);
  }, [dq, nodes, mintQ]);

  // Remote: what pump.fun has that the map does not (yet). A pasted mint not on the map asks for that mint.
  const [remote, setRemote] = useState<{ q: string; coins: Coin[]; done: boolean } | null>(null);
  useEffect(() => {
    const m = extractMint(rq);
    const term = (m ?? rq).trim();
    if (term.length < 2 || (m && byMintRef.current.has(m))) { setRemote(null); return; }
    const ac = new AbortController();
    setRemote((r) => (r && r.q === term ? r : { q: term, coins: [], done: false }));
    api.search(term, ac.signal).then((res) => { if (!ac.signal.aborted) setRemote({ q: term, coins: res.coins ?? [], done: true }); }).catch(() => { if (!ac.signal.aborted) setRemote({ q: term, coins: [], done: true }); });
    return () => ac.abort();
  }, [rq]);
  const offMap = useMemo(() => (remote?.coins ?? []).filter((c) => !byMint.has(c.mint)).slice(0, MAX_REMOTE), [remote, byMint]);

  const showRecent = focused && !q.trim();
  const recentNodes = useMemo(() => (showRecent ? recent.map((r) => byMint.get(r.mint)).filter((n): n is BubbleNode => !!n) : []), [showRecent, recent, byMint]);
  const options: Option[] = useMemo(() => (showRecent ? recentNodes.map((node) => ({ kind: "recent" as const, node })) : local.map((node) => ({ kind: "local" as const, node }))), [showRecent, recentNodes, local]);
  useEffect(() => setActive(0), [options]);

  const pick = (n: BubbleNode) => { pushRecent(n); onPick(n); setQ(""); setFocused(false); input.current?.blur(); };
  // Close on a click outside the box.
  useEffect(() => {
    if (!focused) return;
    const f = (e: PointerEvent) => { if (box.current && !box.current.contains(e.target as Node)) setFocused(false); };
    document.addEventListener("pointerdown", f);
    return () => document.removeEventListener("pointerdown", f);
  }, [focused]);

  const term = q.trim();
  const notOnMap = mintQ && !byMint.has(mintQ) ? mintQ : null;
  const notOnMapCoin = notOnMap ? (remote?.coins ?? []).find((c) => c.mint === notOnMap) ?? null : null;
  const open = focused && (showRecent ? recentNodes.length > 0 : !!term);

  const row = (n: BubbleNode, i: number) => {
    const parent = n.parentMint ? byMint.get(n.parentMint) ?? null : null;
    const ctx = parent ? `under ${sym(parent)}` : `root · ${count(n.descendants ?? n.children)} coin${(n.descendants ?? n.children) === 1 ? "" : "s"}`;
    return (
      <button type="button" key={n.mint} role="option" id={`map-opt-${i}`} aria-selected={i === active} data-active={i === active} className="map-result" onMouseEnter={() => setActive(i)} onClick={() => pick(n)}>
        <Logo src={n.image} label={n.symbol} size={20} />
        <span className="map-result-main">
          <span className="map-result-top"><b>{nameOf(n)}</b><span className="mono">{sym(n)}</span>{n.ours && <span className="map-badge spore" title="Launched on Spore">spore</span>}{n.migrated && <span className="map-badge grad" title="Graduated to PumpSwap">grad</span>}</span>
          <span className="map-result-ctx">{ctx}</span>
        </span>
        <span className="map-result-mcap mono">{usd(n.mcapUsd)}</span>
      </button>
    );
  };

  return (
    <div className="map-search" role="search" ref={box}>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5 14 14" /></svg>
      <input ref={input} className="input" type="search" placeholder="Find a coin, paste a mint or pump.fun link…" value={q} aria-label="Find a coin on the map" autoComplete="off" spellCheck={false}
        role="combobox" aria-expanded={open} aria-controls="map-results" aria-activedescendant={open && options[active] ? `map-opt-${active}` : undefined}
        onFocus={() => { setFocused(true); setRecent(readRecent()); }}
        // Focus leaving the box (Tab, a click elsewhere) closes the list; clicks inside keep the input focused (mousedown below).
        onBlur={(e) => { if (!box.current?.contains(e.relatedTarget as Node | null)) setFocused(false); }}
        onChange={(e) => { setQ(e.target.value); setFocused(true); }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(options.length - 1, a + 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
          else if (e.key === "Enter") { const o = options[active]; if (o) { e.preventDefault(); pick(o.node); } }
          else if (e.key === "Escape") { e.stopPropagation(); if (q) setQ(""); else { setFocused(false); input.current?.blur(); } }
        }} />
      {open && (
        <div className="map-results" id="map-results" role="listbox" aria-label="Search results" onMouseDown={(e) => e.preventDefault()}>
          {showRecent && <><div className="map-results-head">Recent</div>{recentNodes.map((n, i) => row(n, i))}</>}
          {!showRecent && (
            <>
              {notOnMap ? (
                <div className="map-offmap">
                  <div className="map-offmap-title">{notOnMapCoin ? <><Logo src={notOnMapCoin.image} label={notOnMapCoin.symbol} size={20} /><b>{nameOf(notOnMapCoin)}</b><span className="mono">{sym(notOnMapCoin)}</span></> : <span className="mono">{notOnMap.slice(0, 4)}…{notOnMap.slice(-4)}</span>}</div>
                  <p>Not on the map yet{remote && !remote.done ? " · looking it up…" : ""}</p>
                  <div className="map-offmap-acts"><Link to={`/c/${notOnMap}`} className="btn ghost sm">Open coin</Link><Link to={`/launch?parent=${notOnMap}`} className="btn ghost sm">Launch under it</Link></div>
                </div>
              ) : (
                <>
                  <div className="map-results-head">On the map</div>
                  {local.length === 0 ? <div className="none">{dq.trim() === term ? "No coin on the map matches." : "Searching…"}</div> : local.map((n, i) => row(n, i))}
                  {offMap.length > 0 && (
                    <>
                      <div className="map-results-head">On pump.fun · not on the map yet</div>
                      {offMap.map((c) => (
                        <div className="map-remote" key={c.mint}>
                          <Logo src={c.image} label={c.symbol} size={20} />
                          <span className="map-result-main"><span className="map-result-top"><b>{nameOf(c)}</b><span className="mono">{sym(c)}</span></span><span className="map-result-ctx">{c.parent ? `under ${sym(c.parent)}` : "root"} · {usd(c.mcapUsd)}</span></span>
                          <span className="map-remote-acts"><Link to={`/c/${c.mint}`}>Open coin</Link><Link to={`/launch?parent=${c.mint}`}>Launch under it</Link></span>
                        </div>
                      ))}
                    </>
                  )}
                </>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
