import { useEffect, useRef, useSyncExternalStore } from "react";

type Spore = { x: number; y: number; r: number; vx: number; vy: number; hue: number; phase: number; speed: number; near: boolean };
const RGB = ["182,255,92", "176,140,255", "92,224,200"]; // lime, violet, teal
const LINK = 96;          // px: near spores closer than this get a faint connecting thread
const SPRITE = 48;        // base sprite radius; drawn scaled per spore
const PARALLAX = { far: 0.035, near: 0.11 };

/* ---------- motion preference: the footer toggle + the OS setting, shared with the stylesheet
   through html[data-motion]. index.html applies the stored value before the first paint; this
   module keeps it current and lets React components subscribe. */
export const MOTION_KEY = "spore:motion";
const listeners = new Set<() => void>();
const reducedQuery = () => (typeof window !== "undefined" && "matchMedia" in window ? window.matchMedia("(prefers-reduced-motion: reduce)") : null);
const readStored = () => { try { return localStorage.getItem(MOTION_KEY) === "paused"; } catch { return false; } };
let userPaused = readStored();
const apply = () => { if (typeof document !== "undefined") document.documentElement.dataset.motion = userPaused ? "paused" : "on"; };
/// Whether the OS asks for reduced motion right now.
export const prefersReducedMotion = () => reducedQuery()?.matches ?? false;
/// Pause state as the canvas sees it: the user's toggle or the OS preference.
export const motionPaused = () => userPaused || prefersReducedMotion();
export function setMotionPaused(v: boolean) {
  userPaused = v;
  try { if (v) localStorage.setItem(MOTION_KEY, "paused"); else localStorage.removeItem(MOTION_KEY); } catch { /* private mode: the choice lasts for the session */ }
  apply();
  listeners.forEach((l) => l());
}
function subscribe(l: () => void) {
  listeners.add(l);
  const q = reducedQuery();
  q?.addEventListener("change", l);
  return () => { listeners.delete(l); q?.removeEventListener("change", l); };
}
/// [paused, reducedByOS, setPaused]: the footer toggle reads this; the OS preference wins and is
/// reported separately so the control can say why it is off.
export function useMotionPref(): [boolean, boolean, (v: boolean) => void] {
  const paused = useSyncExternalStore(subscribe, motionPaused, () => false);
  const reduced = useSyncExternalStore(subscribe, prefersReducedMotion, () => false);
  return [paused, reduced, setMotionPaused];
}
apply();

/// One glow sprite per colour, rendered once: a drawImage per spore is far cheaper than a
/// radial gradient per spore per frame, which is what made the old canvas warm phones up.
function sprite(rgb: string): HTMLCanvasElement {
  const c = document.createElement("canvas");
  const s = SPRITE * 2;
  c.width = c.height = s;
  const g = c.getContext("2d");
  if (!g) return c;
  const glow = g.createRadialGradient(SPRITE, SPRITE, 0, SPRITE, SPRITE, SPRITE);
  glow.addColorStop(0, `rgba(${rgb},.6)`);
  glow.addColorStop(0.3, `rgba(${rgb},.18)`);
  glow.addColorStop(1, `rgba(${rgb},0)`);
  g.fillStyle = glow; g.fillRect(0, 0, s, s);
  g.fillStyle = `rgba(${rgb},1)`; g.beginPath(); g.arc(SPRITE, SPRITE, SPRITE / 8, 0, Math.PI * 2); g.fill();
  return c;
}

/// Drifting glowing spores in two depth layers (far: small and dim, near: larger and brighter,
/// each with its own scroll parallax) plus faint threads between near neighbours. rAF stops
/// while the tab is hidden; a paused motion preference (OS or the footer toggle) gets one still
/// frame; dpr is capped at 1.5. Resizes are debounced so a phone's address bar does not rebuild
/// the field on every scroll.
export default function SporeCanvas({ density = 1 }: { density?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [paused] = useMotionPref();
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const still = paused;
    const sprites = RGB.map(sprite);
    let w = 0, h = 0, raf = 0, running = false, scrollY = window.scrollY, spores: Spore[] = [], near: Spore[] = [], resizeTimer = 0;
    const make = (fromBottom = false): Spore => {
      const isNear = Math.random() < 0.4;
      return {
        x: Math.random() * w, y: fromBottom ? h + 20 : Math.random() * h,
        r: isNear ? 1.6 + Math.random() * 1.8 : 0.6 + Math.random() * 0.9,
        vx: (Math.random() - 0.5) * (isNear ? 0.1 : 0.05), vy: -(isNear ? 0.06 + Math.random() * 0.14 : 0.03 + Math.random() * 0.06),
        hue: Math.random() < 0.18 ? 1 : Math.random() < 0.22 ? 2 : 0,
        phase: Math.random() * Math.PI * 2, speed: 0.4 + Math.random() * 0.8, near: isNear,
      };
    };
    // Screen y with parallax, wrapped so a scrolled page never empties the canvas.
    const screenY = (s: Spore) => { const span = h + 40; const y = (s.y - scrollY * (s.near ? PARALLAX.near : PARALLAX.far) + 20) % span; return (y < 0 ? y + span : y) - 20; };
    const draw = (t: number) => {
      ctx.clearRect(0, 0, w, h);
      ctx.globalCompositeOperation = "lighter";
      const pos = new Map<Spore, number>();
      for (const s of spores) {
        if (!still) {
          s.x += s.vx + Math.sin(t * 0.0004 * s.speed + s.phase) * (s.near ? 0.14 : 0.06);
          s.y += s.vy;
          if (s.y < -20) Object.assign(s, make(true), { near: s.near });
          if (s.x < -20) s.x = w + 20; else if (s.x > w + 20) s.x = -20;
        }
        pos.set(s, screenY(s));
      }
      ctx.lineWidth = 1;
      for (let i = 0; i < near.length; i++) {
        const a = near[i], ay = pos.get(a) ?? 0;
        for (let j = i + 1; j < near.length; j++) {
          const b = near[j], by = pos.get(b) ?? 0;
          const dx = a.x - b.x, dy = ay - by;
          const d2 = dx * dx + dy * dy;
          if (d2 > LINK * LINK) continue;
          const alpha = (1 - Math.sqrt(d2) / LINK) * 0.22;
          ctx.strokeStyle = `rgba(${RGB[a.hue]},${alpha.toFixed(3)})`;
          ctx.beginPath(); ctx.moveTo(a.x, ay); ctx.lineTo(b.x, by); ctx.stroke();
        }
      }
      for (const s of spores) {
        const twinkle = still ? 0.8 : 0.55 + 0.45 * Math.sin(t * 0.0012 * s.speed + s.phase);
        ctx.globalAlpha = twinkle * (s.near ? 0.95 : 0.42);
        const size = s.r * 16;
        ctx.drawImage(sprites[s.hue], s.x - size / 2, (pos.get(s) ?? 0) - size / 2, size, size);
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
    };
    const resize = () => {
      const dpr = Math.min(1.5, window.devicePixelRatio || 1);
      w = canvas.clientWidth; h = canvas.clientHeight;
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const n = Math.round(Math.min(130, Math.max(32, (w * h) / 14_000)) * density);
      spores = Array.from({ length: n }, () => make());
      near = spores.filter((s) => s.near);
      if (still) draw(0);
    };
    const loop = (t: number) => { if (!running) return; draw(t); raf = requestAnimationFrame(loop); };
    const start = () => { if (running || still) return; running = true; raf = requestAnimationFrame(loop); };
    const stop = () => { running = false; cancelAnimationFrame(raf); };
    const onVisibility = () => (document.hidden ? stop() : start());
    const onScroll = () => { scrollY = window.scrollY; if (still) draw(0); };
    const onResize = () => { clearTimeout(resizeTimer); resizeTimer = window.setTimeout(resize, 120); };
    resize();
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onScroll, { passive: true });
    document.addEventListener("visibilitychange", onVisibility);
    start();
    return () => { stop(); clearTimeout(resizeTimer); window.removeEventListener("resize", onResize); window.removeEventListener("scroll", onScroll); document.removeEventListener("visibilitychange", onVisibility); };
  }, [density, paused]);
  return <canvas ref={ref} className="spores" aria-hidden="true" />;
}
