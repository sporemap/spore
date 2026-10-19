// The map camera, stepped once per drawn frame by draw(). Three motions, at most one at a time:
// - a flight (flyTo): the van Wijk & Nuij optimal zoom-and-pan path (rho = 1.4) between two views,
//   written as closed-form formulas over scalars kept in one Flight record (no per-frame arrays),
//   timed by a trapezoid ease; a slow frame advances a flight by at most 45 ms (bounded warp), so the
//   zoom never jumps by more than ~10 % between two frames even at 20 fps;
// - follow: keep a node centred at a zoom while the layout still moves it (set on landing, or directly
//   by the debug zoomTo hook), exponential smoothing with tau = 80 ms;
// - autoFit: track the whole forest while a cold layout finds its shape, tau = 120 ms.
// Smoothing is frame-rate independent (a = 1 - exp(-dt / tau)) and interpolates zoom in log space.
// Views are measured in the inset-aware viewport: the centre is (il + vw/2, it + vh/2), the width vw/k.
// fitFor/centerOn live here (draw.ts re-exports them) so camera and draw do not import each other.
import { ZoomTransform, zoomIdentity } from "d3";
import type { State } from "./draw";

export const RHO = 1.4;
const RHO2 = RHO * RHO, RHO4 = RHO2 * RHO2;
/// Flight duration bounds. The cap is 1.7 s (not 1.8) to leave room for the slow-frame time warp
/// below inside the 1.9 s landing budget.
export const FLIGHT_MIN_MS = 320, FLIGHT_MAX_MS = 1700;
/// A frame gap longer than this advances a flight by only this much (at most WARP_MS per flight), so
/// a slow frame never turns into one big zoom jump.
const FLIGHT_STEP_MS = 45, WARP_MS = 150;
const FOLLOW_TAU = 80, FIT_TAU = 120;

export type Flight = {
  /// start and end views: world centre and world width of the viewport
  ux0: number; uy0: number; w0: number; ux1: number; uy1: number; w1: number;
  /// path constants (pure = u0 ≈ u1, zoom only)
  dx: number; dy: number; d1: number; r0: number; S: number; coshR0: number; sinhR0: number; pure: boolean;
  t0: number; dur: number;
  /// flight clock (ms of path covered), time of the last step, warp still allowed
  clock: number; last: number; warpLeft: number;
  /// viewport the flight was planned in (screen centre, width)
  scx: number; scy: number; vw: number;
  target: ZoomTransform;
  follow: { i: number; k: number } | null;
};

type View = { scx: number; scy: number; vw: number; vh: number };
const view = (s: State, out: View): View => {
  const il = s.inset?.left ?? 0, it = s.inset?.top ?? 0, ib = s.inset?.bottom ?? 0, ir = s.inset?.right ?? 0;
  out.vw = Math.max(1, s.w - il - ir); out.vh = Math.max(1, s.h - it - ib);
  out.scx = il + out.vw / 2; out.scy = it + out.vh / 2;
  return out;
};
const V: View = { scx: 0, scy: 0, vw: 1, vh: 1 };

export const centerOn = (s: State, i: number, k: number) => {
  const v = view(s, V);
  return zoomIdentity.translate(v.scx - k * s.store.nx[i], v.scy - k * s.store.ny[i]).scale(k);
};

/// Transform that frames every node (or only `members`), `pad` world units around, inside the inset viewport.
export function fitFor(s: State, pad: number, members?: ArrayLike<number>): ZoomTransform | null {
  const st = s.store, n = st.n;
  if (!n) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const { rT, nx, ny } = st;
  if (members) {
    for (let q = 0; q < members.length; q++) { const i = members[q]; if (i < 0 || i >= n) continue; const r = rT[i], x = nx[i], y = ny[i]; if (x - r < x0) x0 = x - r; if (y - r < y0) y0 = y - r; if (x + r > x1) x1 = x + r; if (y + r > y1) y1 = y + r; }
  } else {
    for (let i = 0; i < n; i++) { const r = rT[i], x = nx[i], y = ny[i]; if (x - r < x0) x0 = x - r; if (y - r < y0) y0 = y - r; if (x + r > x1) x1 = x + r; if (y + r > y1) y1 = y + r; }
  }
  if (!Number.isFinite(x0) || !Number.isFinite(x1)) return null;
  const v = view(s, V);
  const bw = Math.max(1, x1 - x0 + pad * 2), bh = Math.max(1, y1 - y0 + pad * 2 + 18);
  const k = Math.min(s.focus ? 1.9 : 3, Math.min(v.vw / bw, v.vh / bh));
  return zoomIdentity.translate(v.scx - k * (x0 + x1) / 2, v.scy - k * (y0 + y1) / 2).scale(k);
}

const ctxMembers = new Int32Array(62);
/// Where a selection flies: the node with its parent and up to 60 children in frame, zoom ≤ 3; a node
/// that would stay under 12 px there is centred at the zoom that makes it 12 px instead.
export function contextTarget(s: State, i: number): ZoomTransform {
  const st = s.store;
  let m = 0;
  ctxMembers[m++] = i;
  if (st.parent[i] >= 0) ctxMembers[m++] = st.parent[i];
  for (let c = st.childStart[i] ?? 0, end = Math.min(st.childStart[i + 1] ?? 0, (st.childStart[i] ?? 0) + 60); c < end; c++) ctxMembers[m++] = st.childList[c];
  const fit = fitFor(s, 48, ctxMembers.subarray(0, m));
  const r = Math.max(0.01, st.rT[i]);
  if (!fit || r * fit.k < 12) return centerOn(s, i, Math.min(3, 12 / r));
  return fit; // fitFor already caps k at 3
}

// Trapezoid velocity profile: accelerate over the first 20 %, cruise, decelerate over the last 20 %.
// Its peak speed is 1.25× the mean (smoothstep: 1.5×), which keeps the per-frame zoom ratio low at
// 20–30 fps while start and end still ease.
const RAMP = 0.2, CRUISE = 1 / (1 - RAMP);
const ease = (u: number) => u < RAMP ? CRUISE * u * u / (2 * RAMP) : u > 1 - RAMP ? 1 - CRUISE * (1 - u) * (1 - u) / (2 * RAMP) : CRUISE * (u - RAMP / 2);

/// Starts a flight from the current view to `target` (replacing any flight, follow or autoFit).
/// `follow` is applied on landing (keeps a still-moving node centred). Reduced motion jumps.
export function flyTo(s: State, target: ZoomTransform, now: number, opts?: { follow?: { i: number; k: number } | null }): void {
  s.autoFit = false; s.follow = null; s.flight = null;
  const follow = opts?.follow ?? null;
  const t = s.t;
  if (s.static || !s.w || !s.h || !Number.isFinite(target.k) || !Number.isFinite(target.x) || !Number.isFinite(target.y)) { s.t = target; s.follow = follow; s.camJump = true; return; }
  const v = view(s, V);
  const ux0 = (v.scx - t.x) / t.k, uy0 = (v.scy - t.y) / t.k, w0 = v.vw / t.k;
  const ux1 = (v.scx - target.x) / target.k, uy1 = (v.scy - target.y) / target.k, w1 = v.vw / target.k;
  const dx = ux1 - ux0, dy = uy1 - uy0, d2 = dx * dx + dy * dy;
  let S: number, r0 = 0, d1 = 0, pure = false;
  // "pure zoom" when the centre moves by less than a pixel at either end
  if (d2 * Math.max(t.k, target.k) ** 2 < 1) { pure = true; S = Math.log(w1 / w0) / RHO; }
  else {
    d1 = Math.sqrt(d2);
    const b0 = (w1 * w1 - w0 * w0 + RHO4 * d2) / (2 * w0 * RHO2 * d1);
    const b1 = (w1 * w1 - w0 * w0 - RHO4 * d2) / (2 * w1 * RHO2 * d1);
    r0 = -Math.asinh(b0); const r1 = -Math.asinh(b1); // log(sqrt(b²+1) − b), without the cancellation
    S = (r1 - r0) / RHO;
  }
  if (!Number.isFinite(S) || Math.abs(S) < 1e-4) { s.t = target; s.follow = follow; s.camJump = true; return; }
  const dur = Math.min(FLIGHT_MAX_MS, Math.max(FLIGHT_MIN_MS, 0.8 * Math.abs(S) * 1000 * RHO / Math.SQRT2));
  const f = s.flightRec ?? (s.flightRec = { ux0: 0, uy0: 0, w0: 1, ux1: 0, uy1: 0, w1: 1, dx: 0, dy: 0, d1: 0, r0: 0, S: 0, coshR0: 1, sinhR0: 0, pure: false, t0: 0, dur: 0, clock: 0, last: 0, warpLeft: 0, scx: 0, scy: 0, vw: 1, target, follow: null });
  f.ux0 = ux0; f.uy0 = uy0; f.w0 = w0; f.ux1 = ux1; f.uy1 = uy1; f.w1 = w1; f.dx = dx; f.dy = dy; f.d1 = d1; f.r0 = r0; f.S = S;
  f.coshR0 = Math.cosh(r0); f.sinhR0 = Math.sinh(r0); f.pure = pure; f.t0 = now; f.dur = dur; f.clock = 0; f.last = now; f.warpLeft = WARP_MS;
  f.scx = v.scx; f.scy = v.scy; f.vw = v.vw; f.target = target; f.follow = follow;
  s.flight = f;
}

/// Stops every camera motion (the user took the wheel, or a drag started).
export function cancelFlight(s: State): void { s.flight = null; s.follow = null; s.autoFit = false; }

const setView = (s: State, ux: number, uy: number, k: number, scx: number, scy: number) => { s.t = new ZoomTransform(k, scx - ux * k, scy - uy * k); };

/// Advances the camera to `now`. Returns true when s.t changed (draw() then syncs d3-zoom).
export function stepCamera(s: State, now: number): boolean {
  const dt = Math.min(100, Math.max(0, now - (s.lastFrameAt || now - 16)));
  s.lastFrameAt = now;
  if (s.camJump) { s.camJump = false; if (!s.flight && !s.follow && !s.autoFit) return true; }
  const st = s.store, n = st.n;
  const f = s.flight;
  if (f) {
    let adv = Math.max(0, now - f.last);
    f.last = now;
    if (adv > FLIGHT_STEP_MS && f.warpLeft > 0) { const cut = Math.min(adv - FLIGHT_STEP_MS, f.warpLeft); adv -= cut; f.warpLeft -= cut; }
    f.clock += adv;
    const u = f.clock / f.dur;
    if (u >= 1) { s.t = f.target; s.flight = null; s.follow = f.follow; return true; }
    const e = ease(Math.max(0, u)), sp = e * f.S;
    let ux: number, uy: number, w: number;
    if (f.pure) { ux = f.ux0 + e * f.dx; uy = f.uy0 + e * f.dy; w = f.w0 * Math.exp(RHO * sp); }
    else {
      const q = RHO * sp + f.r0;
      const uu = f.w0 / (RHO2 * f.d1) * (f.coshR0 * Math.tanh(q) - f.sinhR0);
      ux = f.ux0 + uu * f.dx; uy = f.uy0 + uu * f.dy; w = f.w0 * f.coshR0 / Math.cosh(q);
    }
    if (!(w > 0) || !Number.isFinite(ux) || !Number.isFinite(uy)) { s.t = f.target; s.flight = null; s.follow = f.follow; return true; }
    setView(s, ux, uy, f.vw / w, f.scx, f.scy);
    return true;
  }
  const settling = !st.settled;
  if (s.follow) {
    const fo = s.follow;
    if (fo.i < 0 || fo.i >= n) { s.follow = null; return false; }
    const v = view(s, V);
    const kT = fo.k, uxT = st.nx[fo.i], uyT = st.ny[fo.i];
    if (s.static) { setView(s, uxT, uyT, kT, v.scx, v.scy); s.follow = null; return true; }
    const t = s.t, a = 1 - Math.exp(-dt / FOLLOW_TAU);
    const ux = (v.scx - t.x) / t.k, uy = (v.scy - t.y) / t.k;
    const k = Math.exp(Math.log(t.k) + (Math.log(kT) - Math.log(t.k)) * a);
    const nux = ux + (uxT - ux) * a, nuy = uy + (uyT - uy) * a;
    setView(s, nux, nuy, k, v.scx, v.scy);
    const close = Math.abs((uxT - nux) * k) < 0.5 && Math.abs((uyT - nuy) * k) < 0.5 && Math.abs(Math.log(kT / k)) < 0.001;
    if (close && !settling) { setView(s, uxT, uyT, kT, v.scx, v.scy); s.follow = null; }
    return true;
  }
  if (s.autoFit && n) {
    const target = fitFor(s, 36);
    if (!target) return false;
    if (!settling || s.static) { s.t = target; s.autoFit = false; return true; }
    const v = view(s, V);
    const t = s.t, a = 1 - Math.exp(-dt / FIT_TAU);
    const ux = (v.scx - t.x) / t.k, uy = (v.scy - t.y) / t.k;
    const uxT = (v.scx - target.x) / target.k, uyT = (v.scy - target.y) / target.k;
    const k = Math.exp(Math.log(t.k) + (Math.log(target.k) - Math.log(t.k)) * a);
    setView(s, ux + (uxT - ux) * a, uy + (uyT - uy) * a, k, v.scx, v.scy);
    return true;
  }
  return false;
}
