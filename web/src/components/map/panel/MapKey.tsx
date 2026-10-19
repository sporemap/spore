// The /map key: what colours, rings, sizes and motion mean. Collapsed by default to one line (depth
// swatches + "Key"); the size section draws three nested reference circles at 1-2-5 values at their TRUE
// on-screen size for the current zoom (worldRadius(v) · k), so a bubble can be read against them.
import { useState } from "react";
import { usd } from "../../../lib/format";
import type { SizeMode } from "../../../lib/map/types";
import { COLORS } from "../store";
import { useCamK, type CamStore } from "./cam";

const MAX_PX = 34, MIN_PX = 2.5;
const NICE = [1, 2, 5];

/// The three largest 1-2-5 values whose circle still fits the key at this zoom, smallest first.
export function sizeRefs(screenR: (v: number) => number): { v: number; r: number }[] {
  const seq: { v: number; r: number }[] = [];
  for (let e = 0; e <= 10; e++) for (const m of NICE) { const v = m * 10 ** e; const r = screenR(v); if (Number.isFinite(r)) seq.push({ v, r }); }
  const fit = seq.filter((x) => x.r <= MAX_PX && x.r >= MIN_PX);
  const out: { v: number; r: number }[] = [];
  for (let i = fit.length - 1; i >= 0 && out.length < 3; i--) if (!out.length || out[out.length - 1].r - fit[i].r > 0.75) out.push(fit[i]);
  return out.reverse();
}

function SizeKey({ mode, cam, worldRadius }: { mode: SizeMode; cam: CamStore; worldRadius: (v: number) => number }) {
  const k = useCamK(cam);
  // worldRadius is 0 until the map has sized its bubbles: draw nothing rather than a wrong scale.
  const ready = worldRadius(1e9) > 0;
  const refs = ready ? sizeRefs((v) => worldRadius(v) * k) : [];
  if (!ready) return null;
  const W = 150, H = MAX_PX * 2 + 4, cx = MAX_PX + 2;
  // Largest circle first; each label sits level with its circle's top, pushed down to keep 11 px apart.
  const big = refs.slice().reverse();
  const labelY: number[] = [];
  for (const x of big) { const top = H - 1 - 2 * x.r; labelY.push(Math.max(labelY.length ? labelY[labelY.length - 1] + 11 : 8, top + 3)); }
  return (
    <section className="map-key-sec">
      <h4>Size <span>area = {mode === "locked" ? "locked value" : "market cap"}</span></h4>
      {refs.length === 0
        ? <p className="map-key-note">Zoomed in past the key: every bubble here is larger than {MAX_PX * 2} px.</p>
        : (
          <svg className="map-key-size" width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Reference sizes at this zoom: ${refs.map((x) => usd(x.v)).join(", ")}`}>
            {big.map((x) => <circle key={x.v} cx={cx} cy={H - 1 - x.r} r={x.r} />)}
            {big.map((x, i) => { const y = H - 1 - 2 * x.r; const ty = labelY[i]; return <g key={x.v}><path d={`M${cx} ${y}H${cx + MAX_PX + 8}L${cx + MAX_PX + 12} ${ty - 3}`} /><text x={cx + MAX_PX + 16} y={ty}>{usd(x.v)}</text></g>; })}
          </svg>
        )}
      <p className="map-key-note">true size at this zoom</p>
    </section>
  );
}

const Swatch = ({ d }: { d: number }) => <i className="map-key-sw" style={{ background: COLORS[d], boxShadow: `0 0 8px ${COLORS[d]}` }} />;

/// `variant="dock"`: the collapsible card at the bottom left of a wide map. `variant="pop"`: the body only,
/// for the phone popover the page opens from its "Key" pill.
export default function MapKey({ mode, cam, worldRadius, variant = "dock", defaultOpen = false }: { mode: SizeMode; cam: CamStore; worldRadius: ((v: number) => number) | null; variant?: "dock" | "pop"; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const body = (
    <div className="map-key-body" id="map-key-body">
      <section className="map-key-sec">
        <h4>Colour</h4>
        <ul className="map-key-list">
          <li><Swatch d={0} /> root coin</li>
          <li><Swatch d={1} /> d1 · paired under a root</li>
          <li><Swatch d={2} /> d2 · paired under a d1</li>
        </ul>
      </section>
      <section className="map-key-sec">
        <h4>Rings</h4>
        <ul className="map-key-list">
          <li><svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="8.5" fill="none" stroke="var(--accent)" strokeOpacity=".35" /><circle cx="10" cy="10" r="6" fill="none" stroke="var(--accent)" strokeWidth="1.6" /><circle cx="10" cy="10" r="3.5" fill="#5ce0c8" /></svg> launched on Spore</li>
          <li><svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7" fill="#5ce0c8" fillOpacity=".5" stroke="#5ce0c8" /><circle cx="14.95" cy="5.05" r="2" fill="#eef6ef" /></svg> graduated (dot on the rim)</li>
          <li><svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7.5" fill="none" stroke="var(--accent)" strokeWidth="1.4" strokeDasharray="3 2.5" /></svg> selected</li>
        </ul>
      </section>
      {worldRadius ? <SizeKey mode={mode} cam={cam} worldRadius={worldRadius} /> : null}
      <section className="map-key-sec">
        <h4>Motion</h4>
        <ul className="map-key-list">
          <li><svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="3" fill="#b6ff5c" /><circle cx="10" cy="10" r="6" fill="none" stroke="#b6ff5c" strokeOpacity=".7" /><circle cx="10" cy="10" r="9" fill="none" stroke="#b6ff5c" strokeOpacity=".3" /></svg> ring grows outward · buy</li>
          <li><svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="3" fill="#ff5c8a" /><circle cx="10" cy="10" r="6" fill="none" stroke="#ff5c8a" strokeOpacity=".7" /><circle cx="10" cy="10" r="9" fill="none" stroke="#ff5c8a" strokeOpacity=".3" strokeDasharray="2 2" /></svg> ring shrinks inward · sell</li>
          <li><svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><path d="M3 16 14 6" stroke="#b6ff5c" strokeOpacity=".45" strokeWidth="1.6" strokeLinecap="round" /><circle cx="14.5" cy="5.5" r="2.4" fill="#b6ff5c" /></svg> comet · a buy routed through the parent</li>
          <li><svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><path d="M2 10H18" stroke="var(--line-2)" /><circle cx="6" cy="10" r="1.6" fill="var(--accent)" /><circle cx="13" cy="10" r="1.6" fill="var(--accent)" /></svg> dots · pair traded in the last 30 min</li>
        </ul>
      </section>
      <section className="map-key-sec">
        <h4>Keys</h4>
        <dl className="map-key-keys">
          <dt>/</dt><dd>search</dd>
          <dt>← ↑ → ↓</dt><dd>walk the tree</dd>
          <dt>Enter</dt><dd>open coin</dd>
          <dt>L</dt><dd>launch under it</dd>
          <dt>F</dt><dd>frame its tree</dd>
          <dt>0 · + · −</dt><dd>whole map · zoom</dd>
          <dt>Esc</dt><dd>clear</dd>
        </dl>
      </section>
    </div>
  );
  if (variant === "pop") return <div className="map-key pop">{body}</div>;
  return (
    <div className={`map-key dock ${open ? "open" : ""}`}>
      <button type="button" className="map-key-toggle" aria-expanded={open} aria-controls="map-key-body" onClick={() => setOpen((o) => !o)}>
        <span className="map-key-sws" aria-hidden="true"><Swatch d={0} /><Swatch d={1} /><Swatch d={2} /></span>
        Key
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d={open ? "M2 3.5 5 6.5 8 3.5" : "M2 6.5 5 3.5 8 6.5"} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
      </button>
      {open && body}
    </div>
  );
}
