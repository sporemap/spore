import { useCallback, useState, type CSSProperties, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { solscanAccount, type CoinRef } from "../lib/api";
import { pct, short } from "../lib/format";

/// Coin image with a letter fallback; a broken image proxy swaps to the letter instead of a
/// browser placeholder icon. `onLoad` receives the element so a card can sample its colour; the
/// ref callback covers images that were already cached when the element mounted.
export function Logo({ src, label, size = 36, className = "", style, onLoad }: { src: string | null | undefined; label: string | null | undefined; size?: number; className?: string; style?: CSSProperties; onLoad?: (img: HTMLImageElement) => void }) {
  const [broken, setBroken] = useState(false);
  const letter = (label || "?").replace(/^\$/, "").slice(0, 1).toUpperCase();
  const s = { width: size, height: size, fontSize: Math.max(11, Math.round(size * 0.38)), ...style };
  return src && !broken
    ? <img className={`logo ${className}`} src={src} alt="" width={size} height={size} style={s} loading="lazy" decoding="async" onError={() => setBroken(true)}
        onLoad={onLoad ? (e) => onLoad(e.currentTarget) : undefined} ref={onLoad ? (el) => { if (el && el.complete && el.naturalWidth) onLoad(el); } : undefined} />
    : <div className={`logo letter ${className}`} style={s} aria-hidden="true">{letter}</div>;
}

/* ---------- dominant colour of a coin image, as an "r,g,b" triplet for the --tint variable */
const tintCache = new Map<string, string>();
const hslToRgb = (h: number, s: number, l: number) => {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)].map((v) => Math.round(v * 255)).join(",");
};
const rgbToHsl = (r: number, g: number, b: number): [number, number, number] => {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  if (d === 0) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? ((g - b) / d + (g < b ? 6 : 0)) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
};
/// Deterministic fallback hue from the mint, so a card without an image still gets its own tint.
export function hashTint(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return hslToRgb(h % 360, 0.8, 0.62);
}
/// Average of the image's vivid pixels (saturation-weighted, ignoring black/white backgrounds),
/// then lifted so it reads on a dark surface. Null when the canvas is tainted (cross-origin).
export function sampleTint(img: HTMLImageElement): string | null {
  try {
    const n = 14;
    const c = document.createElement("canvas");
    c.width = c.height = n;
    const g = c.getContext("2d", { willReadFrequently: true });
    if (!g) return null;
    g.drawImage(img, 0, 0, n, n);
    const d = g.getImageData(0, 0, n, n).data;
    let r = 0, gg = 0, b = 0, w = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 120) continue;
      const R = d[i], G = d[i + 1], B = d[i + 2];
      const max = Math.max(R, G, B), min = Math.min(R, G, B);
      const lum = (max + min) / 510;
      if (lum < 0.08 || lum > 0.94) continue;
      const sat = max === 0 ? 0 : (max - min) / max;
      const wt = 0.05 + sat * sat;
      r += R * wt; gg += G * wt; b += B * wt; w += wt;
    }
    if (w < 0.5) return null;
    const [h, s, l] = rgbToHsl(r / w, gg / w, b / w);
    return hslToRgb(h, Math.max(0.55, Math.min(0.95, s * 1.25)), Math.max(0.56, Math.min(0.7, l)));
  } catch { return null; }
}
/// [tint, onImageLoad]: starts from the cached or hash tint and upgrades once the image is sampled.
export function useTint(src: string | null | undefined, seed: string): [string, (img: HTMLImageElement) => void] {
  const key = src ?? "";
  const [sampled, setSampled] = useState<{ key: string; tint: string } | null>(null);
  const onLoad = useCallback((img: HTMLImageElement) => {
    if (!key) return;
    let t = tintCache.get(key);
    if (!t) { t = sampleTint(img) ?? hashTint(seed); tintCache.set(key, t); }
    const tint = t;
    setSampled((cur) => (cur && cur.key === key && cur.tint === tint ? cur : { key, tint }));
  }, [key, seed]);
  const tint = sampled && sampled.key === key ? sampled.tint : (tintCache.get(key) ?? hashTint(seed));
  return [tint, onLoad];
}

export const sym = (c: { symbol: string | null; mint: string } | null | undefined) => (c ? (c.symbol ? `$${c.symbol}` : short(c.mint)) : "—");
export const nameOf = (c: { name: string | null; symbol: string | null; mint: string }) => c.name || c.symbol || short(c.mint, 6);

/// d0 lime (roots) · d1 teal · d2 violet · d3+ amber: the depth is the first thing to read on a card.
export const DepthBadge = ({ depth, title }: { depth: number; title?: string }) => <span className={`depth d${Math.min(depth, 3)}`} title={title ?? `depth ${depth}: ${depth === 0 ? "root, quoted in a listed mint" : `${depth} hop${depth === 1 ? "" : "s"} from a root`}`}>d{depth}</span>;

export const ParentPill = ({ parent }: { parent: CoinRef | null }) => parent
  ? <Link to={`/c/${parent.mint}`} className="pill parent" title={parent.name || parent.mint} onClick={(e) => e.stopPropagation()}>↳ under {sym(parent)}</Link>
  : <span className="pill root">root</span>;

export const Chip = ({ children, tone = "", title }: { children: ReactNode; tone?: "" | "good" | "warn" | "bad" | "accent" | "violet"; title?: string }) => <span className={`chip ${tone}`} title={title}>{children}</span>;

export const Addr = ({ a, n = 4, className = "" }: { a: string; n?: number; className?: string }) => <a className={`mono addr ${className}`} href={solscanAccount(a)} target="_blank" rel="noreferrer" title={a}>{short(a, n)}</a>;
export const Ext = ({ href, children, className = "", title }: { href: string; children: ReactNode; className?: string; title?: string }) => <a className={className} href={href} target="_blank" rel="noreferrer" title={title}>{children}</a>;

export const ProgressBar = ({ value, label }: { value: number; label?: string }) => (
  <div className="progress" role="progressbar" aria-valuenow={Math.round(value * 100)} aria-valuemin={0} aria-valuemax={100} title={label ?? `${pct(value)} of the curve filled`}>
    <i style={{ width: `${Math.max(1, Math.min(100, value * 100))}%` }} />
  </div>
);

export const Skeleton = ({ w, h = 14, r, className = "", style }: { w?: number | string; h?: number; r?: number; className?: string; style?: CSSProperties }) => <span className={`sk ${className}`} style={{ width: w ?? "100%", height: h, borderRadius: r, ...style }} aria-hidden="true" />;
export const SkeletonCard = () => (
  <div className="coin-card sk-card" aria-hidden="true">
    <div className="coin-card-head"><Skeleton w={44} h={44} r={22} /><div className="stack-2" style={{ flex: 1 }}><Skeleton w="55%" h={14} /><Skeleton w="35%" h={11} /></div></div>
    <div className="coin-card-metrics"><Skeleton h={28} /><Skeleton h={28} /><Skeleton h={28} /></div>
    <Skeleton h={4} />
  </div>
);
export const SkeletonRows = ({ n = 6, h = 44 }: { n?: number; h?: number }) => <div className="stack-2" aria-hidden="true">{Array.from({ length: n }, (_, i) => <Skeleton key={i} h={h} r={8} />)}</div>;

export const Empty = ({ title, hint, action }: { title: string; hint?: ReactNode; action?: ReactNode }) => (
  <div className="empty"><b>{title}</b>{hint && <p>{hint}</p>}{action && <div className="empty-action">{action}</div>}</div>
);
/// The launchpad's empty state (DESIGN §11.1): Spore lists only coins launched here, so before
/// the first launch every listing is empty by design, and the page must say so instead of looking
/// broken. `compact` fits inside a section; the default is a full-width card.
export const NoSpawnsYet = ({ compact = false, hint }: { compact?: boolean; hint?: ReactNode }) => (
  <div className={`empty launch-empty ${compact ? "compact" : ""}`}>
    <span className="launch-empty-glyph" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="10" cy="13" r="5" /><circle cx="17" cy="7" r="1.6" /><circle cx="19.5" cy="12" r="1.2" /><circle cx="15" cy="18.5" r="1.2" /></svg></span>
    <b>Nothing launched yet — launch the first coin</b>
    <p>{hint ?? "Spore shows only coins launched here. The first coin of a tree is launched with SOL; every coin after that can grow under it."}</p>
    <div className="empty-action"><Link to="/launch" className="btn accent">Launch a coin</Link><Link to="/how" className="btn ghost">How it works</Link></div>
  </div>
);
export const ErrorBox = ({ error, retry, compact = false }: { error: string; retry?: () => void; compact?: boolean }) => (
  <div className={`notice bad ${compact ? "compact" : ""}`} role="alert">
    <span><b>Could not load.</b> {error}</span>
    {retry && <button type="button" className="btn sm ghost" onClick={retry}>Retry</button>}
  </div>
);
