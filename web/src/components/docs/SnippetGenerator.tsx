import { useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../../lib/api";
import { useDebounced } from "../../lib/hooks";
import { Logo, DepthBadge } from "../Bits";
import { CodeBlock } from "./CodeBlock";
import { API_ORIGIN, attr, mintIn } from "./util";
import { SPORE_MINT } from "./examples";

type Widget = "tree" | "map";
type Theme = "dark" | "light";
const PRESETS = [
  { id: "sidebar", label: "Sidebar", w: 360, h: 520 },
  { id: "panel", label: "Panel", w: 640, h: 420 },
  { id: "square", label: "Square", w: 480, h: 480 },
  { id: "wide", label: "Full width", w: null, h: 560 },
] as const;
type PresetId = (typeof PRESETS)[number]["id"];


type Lookup = { state: "idle" | "busy" } | { state: "ok"; name: string | null; symbol: string | null; image: string | null; depth: number } | { state: "missing" } | { state: "error"; message: string };

/// Builds the iframe snippet for the two widgets and previews it live on this page. The preview
/// loads the same-origin /embed path; the snippet points at sporepad.com, which is where partners
/// will load it from.
export default function SnippetGenerator() {
  const [widget, setWidget] = useState<Widget>("tree");
  const [input, setInput] = useState(SPORE_MINT);
  const [theme, setTheme] = useState<Theme>("dark");
  const [hideHeader, setHideHeader] = useState(false);
  const [preset, setPreset] = useState<PresetId>("panel");
  const mint = mintIn(input);
  const debounced = useDebounced(mint, 350);
  const [lookup, setLookup] = useState<Lookup>({ state: "idle" });

  // Confirms the mint is a pump.fun coin and shows which one, so a typo is caught before the
  // snippet is pasted into a terminal's coin page.
  useEffect(() => {
    if (!debounced) { setLookup({ state: "idle" }); return; }
    let live = true;
    setLookup({ state: "busy" });
    api.coin(debounced, { children: false, trades: false })
      .then((r) => { if (live) setLookup({ state: "ok", name: r.coin.name, symbol: r.coin.symbol, image: r.coin.image, depth: r.coin.depth }); })
      .catch((e) => { if (live) setLookup(e instanceof ApiError && (e.status === 404 || e.status === 400) ? { state: "missing" } : { state: "error", message: e instanceof Error ? e.message : String(e) }); });
    return () => { live = false; };
  }, [debounced]);

  const p = PRESETS.find((x) => x.id === preset) ?? PRESETS[1];
  const needsMint = widget === "tree";
  const ready = needsMint ? !!mint : true;
  const query = useMemo(() => {
    const q = new URLSearchParams();
    if (widget === "map" && mint) q.set("focus", mint);
    if (theme !== "dark") q.set("theme", theme);
    if (hideHeader) q.set("hideHeader", "1");
    const s = q.toString();
    return s ? `?${s}` : "";
  }, [widget, mint, theme, hideHeader]);
  const path = widget === "tree" ? `/embed/tree/${mint ?? "<mint>"}` : "/embed/map";
  const label = lookup.state === "ok" && lookup.symbol ? `$${lookup.symbol}` : null;
  const title = widget === "tree" ? `Spore family tree${label ? ` · ${label}` : ""}` : "Spore ecosystem map";
  const snippet = [
    "<iframe",
    `  src="${API_ORIGIN}${path}${query}"`,
    `  width="${p.w ?? "100%"}" height="${p.h}"`,
    `  style="border:0;border-radius:12px;max-width:100%"`,
    `  title="${attr(title)}"`,
    `  loading="lazy"`,
    `  referrerpolicy="strict-origin-when-cross-origin"></iframe>`,
  ].join("\n");

  return (
    <div className="docs-gen card">
      <div className="docs-gen-controls">
        <div className="docs-gen-form">
          <div className="docs-gen-row">
            <span className="docs-gen-label" id="gen-widget">Widget</span>
            <div className="seg lg" role="group" aria-labelledby="gen-widget">
              <button type="button" aria-pressed={widget === "tree"} onClick={() => setWidget("tree")}>Family tree</button>
              <button type="button" aria-pressed={widget === "map"} onClick={() => setWidget("map")}>Ecosystem map</button>
            </div>
          </div>
          <label className="field docs-gen-mint">
            <span>{widget === "tree" ? "Coin mint or link" : "Focus coin (optional)"}</span>
            <input className="input mono" type="text" inputMode="text" autoComplete="off" spellCheck={false} value={input}
              onChange={(e) => setInput(e.target.value)} placeholder="Paste a mint, or a pump.fun / terminal link"
              aria-invalid={needsMint && !mint && input.trim() !== ""} aria-describedby="gen-mint-status" />
          </label>
          <div id="gen-mint-status" className="docs-gen-status" aria-live="polite">
            {!mint ? (input.trim() ? <span className="bad">No Solana mint found in that text.</span> : needsMint ? <span className="muted">The family tree needs a coin.</span> : <span className="muted">Without a coin the map opens on the whole ecosystem.</span>)
              : lookup.state === "ok" ? <span className="docs-gen-coin"><Logo src={lookup.image} label={lookup.symbol ?? lookup.name} size={22} /><b>{lookup.name ?? "Unnamed"}</b><span className="muted">{lookup.symbol ? `$${lookup.symbol}` : ""}</span><DepthBadge depth={lookup.depth} /></span>
              : lookup.state === "missing" ? <span className="warn">Not a pump.fun coin this index knows. The widget will say so too.</span>
              : lookup.state === "error" ? <span className="muted">Could not check the coin right now ({lookup.message}); the snippet still works.</span>
              : <span className="muted">Checking the coin…</span>}
          </div>
          <div className="docs-gen-row wrap">
            <span className="docs-gen-label" id="gen-theme">Theme</span>
            <div className="seg" role="group" aria-labelledby="gen-theme">
              <button type="button" aria-pressed={theme === "dark"} onClick={() => setTheme("dark")}>dark</button>
              <button type="button" aria-pressed={theme === "light"} onClick={() => setTheme("light")}>light</button>
            </div>
            <label className="docs-check"><input type="checkbox" checked={hideHeader} onChange={(e) => setHideHeader(e.target.checked)} /><span>Hide header</span></label>
          </div>
          <div className="docs-gen-row wrap">
            <span className="docs-gen-label" id="gen-size">Size</span>
            <div className="seg" role="group" aria-labelledby="gen-size">
              {PRESETS.map((x) => <button key={x.id} type="button" aria-pressed={preset === x.id} onClick={() => setPreset(x.id)} title={`${x.w ? `${x.w}px` : "100%"} × ${x.h}px`}>{x.label}</button>)}
            </div>
            <span className="docs-gen-dim mono">{p.w ? `${p.w}` : "100%"} × {p.h}</span>
          </div>
        </div>
        <div className="docs-gen-code"><CodeBlock code={snippet} lang="html" title="Embed code" wrap caption={ready ? "Paste it into your coin page. It needs no script, no key and no cookies." : "Add a coin to finish the snippet."} /></div>
      </div>
      <div className="docs-gen-preview">
        <div className="docs-gen-preview-bar"><span className="live live"><i />preview</span><a href={`${path}${query}`} target="_blank" rel="noreferrer" className="docs-gen-open">Open alone ↗</a></div>
        <div className={`docs-gen-frame ${theme}`} style={{ width: p.w ? `${p.w}px` : "100%", height: p.h }}>
          {ready ? (
            <iframe key={widget} src={`${path}${query}`} title={`${title} (preview)`} loading="lazy" width={p.w ?? undefined} height={p.h} />
          ) : (
            <div className="docs-gen-empty">Paste a coin to preview its family tree.</div>
          )}
        </div>
      </div>
    </div>
  );
}
