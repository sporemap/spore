// Shared pieces of the embeddable pages (DESIGN §12 "Partner API & embeds"): /embed/tree/:mint and
// /embed/map are rendered by App.tsx outside the site shell (no nav, footer, official strip or
// background), so a partner can drop one iframe into a coin page. Query params: ?theme=dark|light
// (default dark), ?hideHeader=1. Every link leaves the iframe for the site in a new tab; nothing here
// navigates the frame or its parent, and nothing signs or sends anything.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../../lib/api";
import { count, usd } from "../../lib/format";
import type { BubbleNode } from "../../lib/map/types";
import { Logo, nameOf, sym } from "../../components/Bits";
import Mark from "../../components/Mark";
import "./embed.css";

export type EmbedTheme = "dark" | "light";
export type EmbedParams = { theme: EmbedTheme; hideHeader: boolean; size: "locked" | "mcap" };

const SITE = "https://sporepad.com";
const truthy = (v: string | null) => v != null && v !== "0" && v.toLowerCase() !== "false";

/// The theme and header switches every embed takes, plus `size=mcap` (bubble area by market cap).
export function useEmbedParams(): EmbedParams {
  const [p] = useSearchParams();
  return { theme: p.get("theme") === "light" ? "light" : "dark", hideHeader: truthy(p.get("hideHeader")), size: p.get("size") === "mcap" ? "mcap" : "locked" };
}

/// Absolute link to the site. Production serves the embeds from sporepad.com, so the page's own origin is
/// the site; a dev server or preview links to itself, which keeps every link testable there.
export function siteUrl(path: string): string {
  const o = typeof location !== "undefined" && /^https?:$/.test(location.protocol) ? location.origin : SITE;
  return `${o.replace(/\/$/, "")}${path}`;
}
export const coinUrl = (mint: string) => siteUrl(`/c/${encodeURIComponent(mint)}`);
export const launchUrl = (mint?: string | null) => siteUrl(mint ? `/launch?parent=${encodeURIComponent(mint)}` : "/launch");
export const mapUrl = (mint?: string | null) => siteUrl(mint ? `/map?focus=${encodeURIComponent(mint)}` : "/map");

/// A link that leaves the iframe: always a new tab, never the frame or the parent.
export const Out = ({ href, className = "", title, children }: { href: string; className?: string; title?: string; children: ReactNode }) =>
  <a className={className} href={href} target="_blank" rel="noopener" title={title}>{children}</a>;

export const isMintLike = (s: string | null | undefined): s is string => !!s && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);

/// The program's depth cap (Global.maxCurveDepth), read once per page from /api/stats; undefined until
/// it answers (or when it fails), in which case nothing is blocked here and the launch page decides.
let maxDepthP: Promise<number | undefined> | null = null;
export function useMaxDepth(): number | undefined {
  const [d, setD] = useState<number | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    (maxDepthP ??= api.stats().then((s) => (Number.isFinite(s.maxDepth) ? s.maxDepth : undefined), () => { maxDepthP = null; return undefined; }))
      .then((v) => { if (alive) setD(v); });
    return () => { alive = false; };
  }, []);
  return d;
}
export const canLaunchUnder = (n: Pick<BubbleNode, "depth"> | null | undefined, maxDepth: number | undefined) => !!n && (maxDepth === undefined || n.depth < maxDepth);

/// True while the embed is worth keeping live: the tab is visible and the frame is on screen (an
/// IntersectionObserver inside an iframe measures against the top-level viewport). Going inactive waits
/// `graceMs`, so scrolling past the frame does not reopen the event stream every time.
export function useActive(ref: RefObject<HTMLElement | null>, graceMs = 20_000): boolean {
  const [shown, setShown] = useState(() => typeof document === "undefined" || !document.hidden);
  const [onScreen, setOnScreen] = useState(true);
  useEffect(() => {
    const f = () => setShown(!document.hidden);
    document.addEventListener("visibilitychange", f);
    return () => document.removeEventListener("visibilitychange", f);
  }, []);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((es) => setOnScreen(es.some((e) => e.isIntersecting)), { threshold: 0 });
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);
  const want = shown && onScreen;
  const [active, setActive] = useState(want);
  useEffect(() => {
    if (want) { setActive(true); return; }
    const t = setTimeout(() => setActive(false), graceMs);
    return () => clearTimeout(t);
  }, [want, graceMs]);
  return active;
}

/// Size of an element (ResizeObserver), for the layout switches CSS cannot make (BubbleMap's legend).
export function useBox(ref: RefObject<HTMLElement | null>): { w: number; h: number } {
  const [box, setBox] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => { const r = el.getBoundingClientRect(); const w = Math.round(r.width), h = Math.round(r.height); setBox((b) => (b.w === w && b.h === h ? b : { w, h })); };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return box;
}

/// Title, robots and the document classes the embed stylesheet keys on (no site background, the theme's
/// own page colour, no page scroll). Restored on unmount.
function useEmbedDocument(theme: EmbedTheme, title: string) {
  useLayoutEffect(() => {
    const html = document.documentElement;
    html.classList.add("embed-doc");
    html.dataset.embedTheme = theme;
    return () => { html.classList.remove("embed-doc"); delete html.dataset.embedTheme; };
  }, [theme]);
  useEffect(() => { document.title = title; }, [title]);
  useEffect(() => {
    // An embed is a widget, not a page to list in search results.
    let meta = document.querySelector<HTMLMetaElement>('meta[name="robots"]');
    const prev = meta?.getAttribute("content") ?? null;
    if (!meta) { meta = document.createElement("meta"); meta.name = "robots"; document.head.appendChild(meta); }
    meta.setAttribute("content", "noindex, nofollow");
    return () => { if (prev == null) meta?.remove(); else meta?.setAttribute("content", prev); };
  }, []);
}

/// The embed's frame: theme root, optional compact header, and the body the map fills. "Powered by
/// Spore" sits in the body's bottom-left corner whether or not the header is shown (attribution).
export function EmbedFrame({ params, title, head, children, bodyRef }: { params: EmbedParams; title: string; head: ReactNode; children: ReactNode; bodyRef?: RefObject<HTMLDivElement | null> }) {
  useEmbedDocument(params.theme, title);
  return (
    <div className="embed" data-theme={params.theme}>
      {!params.hideHeader && <header className="embed-head">{head}</header>}
      <div className="embed-body" ref={bodyRef}>
        {children}
        <Out href={siteUrl("/")} className="embed-powered" title="Spore: the pump.fun family-tree launchpad">Powered by <Mark size={13} /> <b>Spore</b></Out>
      </div>
    </div>
  );
}

/// The header's title block: mark or coin logo, a label and the ticker.
export function HeadTitle({ label, node, loading }: { label: string; node?: Pick<BubbleNode, "mint" | "name" | "symbol" | "image"> | null; loading?: boolean }) {
  return (
    <div className="embed-title">
      {node ? <Logo src={node.image} label={node.symbol ?? node.name} size={22} /> : <Mark size={20} />}
      <h1><span>{label}</span>{node && <><i aria-hidden="true">·</i><b title={nameOf(node)}>{sym(node)}</b></>}{loading && !node && <><i aria-hidden="true">·</i><em className="embed-sk" /></>}</h1>
    </div>
  );
}

const Arrow = () => <span className="embed-arrow" aria-hidden="true">↗</span>;

/// The header's call to action for one coin: launch under it on Spore, or open it there when the coin is
/// at the depth cap (a child would be refused). Without a coin: launch a root.
export function LaunchCta({ node, maxDepth, compact }: { node: Pick<BubbleNode, "mint" | "symbol" | "name" | "depth"> | null; maxDepth: number | undefined; compact?: boolean }) {
  if (!node) return <Out href={launchUrl(null)} className="embed-cta" title="Launch a coin on Spore (opens in a new tab)">{compact ? "Launch" : "Launch on Spore"} <Arrow /></Out>;
  if (!canLaunchUnder(node, maxDepth)) return <Out href={coinUrl(node.mint)} className="embed-cta ghost" title={`${sym(node)} is at the depth cap (${maxDepth}), so nothing can launch under it. Opens its page on Spore.`}>{compact ? "Open" : "Open on Spore"} <Arrow /></Out>;
  return <Out href={launchUrl(node.mint)} className="embed-cta" title={`Launch a coin under ${sym(node)} on Spore (opens in a new tab)`}>{compact ? "Launch under" : "Launch under on Spore"} <Arrow /></Out>;
}

/// The coin a click selected: what it is, its numbers and where to go on the site.
export function SelectionCard({ node, parent, maxDepth, onClose, extra }: { node: BubbleNode; parent: BubbleNode | null; maxDepth: number | undefined; onClose: () => void; extra?: ReactNode }) {
  const kids = node.children;
  return (
    <div className="embed-sel" role="region" aria-label={`${nameOf(node)} details`}>
      <div className="embed-sel-top">
        <Logo src={node.image} label={node.symbol ?? node.name} size={28} />
        <div className="embed-sel-name">
          <b title={nameOf(node)}>{nameOf(node)}</b>
          <span><span className="mono">{sym(node)}</span><span className={`embed-depth d${Math.min(node.depth, 3)}`}>{node.depth === 0 ? "root" : `d${node.depth}`}</span>{node.ours && <span className="embed-ours" title="Launched on Spore">Spore</span>}</span>
        </div>
        <button type="button" className="embed-x" aria-label="Close" onClick={onClose}>×</button>
      </div>
      <dl className="embed-sel-stats">
        <div><dt>mcap</dt><dd>{usd(node.mcapUsd)}</dd></div>
        <div><dt>locked</dt><dd>{usd(node.lockedUsd)}</dd></div>
        <div><dt>{kids === 1 ? "child" : "children"}</dt><dd>{count(kids)}</dd></div>
      </dl>
      {parent && <p className="embed-sel-under">under <b>{sym(parent)}</b></p>}
      <div className="embed-sel-acts">
        <Out href={coinUrl(node.mint)} className="embed-btn">Open on Spore <Arrow /></Out>
        {canLaunchUnder(node, maxDepth) && <Out href={launchUrl(node.mint)} className="embed-btn accent">Launch under <Arrow /></Out>}
        {extra}
      </div>
    </div>
  );
}

/// A centred message over the body (loading, errors, empty families).
export function EmbedState({ title, hint, action, tone = "" }: { title: string; hint?: ReactNode; action?: ReactNode; tone?: "" | "bad" }) {
  return (
    <div className={`embed-state ${tone}`} role={tone === "bad" ? "alert" : "status"}>
      <b>{title}</b>
      {hint && <p>{hint}</p>}
      {action && <div className="embed-state-acts">{action}</div>}
    </div>
  );
}

/// Layout switches by size of the body: below these the built-in legend and size toggle would cover the map.
export const compactBox = (b: { w: number; h: number }) => b.w > 0 && (b.w < 560 || b.h < 340);

/// Escape clears the selection (BubbleMap handles it only while its own box has focus).
export function useEscape(f: () => void) {
  const ref = useRef(f); ref.current = f;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") ref.current(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
}

/// Any other /embed/ path: the frame with a pointer to the two widgets.
export function EmbedNotFound() {
  const params = useEmbedParams();
  return (
    <EmbedFrame params={params} title="Embed · Spore" head={<HeadTitle label="Spore embeds" />}>
      <EmbedState tone="bad" title="No such embed" hint={<>Use <code>/embed/tree/&lt;mint&gt;</code> or <code>/embed/map</code>. The API docs at <Out href={siteUrl("/docs/api")} className="embed-link">sporepad.com/docs/api</Out> list both.</>} />
    </EmbedFrame>
  );
}
