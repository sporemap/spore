import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { NavLink, Route, Routes, useLocation, useNavigate, useNavigationType } from "react-router-dom";
import { SPORE_COIN } from "./lib/policy";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import Mark from "./components/Mark";
import { ToastProvider } from "./components/Toast";
import OfficialCoin from "./components/OfficialCoin";
import { LiveDot } from "./components/SpawnFeed";
import { useMotionPref } from "./components/SporeCanvas";
import { useStats } from "./lib/hooks";
import { count } from "./lib/format";
import Home from "./pages/Home";
import Explore from "./pages/Explore";
import MapPage from "./pages/Map";
import CoinPage from "./pages/Coin";
import Launch from "./pages/Launch";
import How from "./pages/How";
import Fees from "./pages/Fees";
import NotFound from "./pages/NotFound";
import "./components/brand.css";

export const BRAND = { name: "Spore", tagline: "Coins that grow coins.", title: "Spore — coins that grow coins" };
const PRIMARY = [["/explore", "Explore"], ["/map", "Map"], ["/launch", "Launch"], ["/how", "How it works"]] as const;

/// Finds a search box on the current page and focuses it. The pages own their search components;
/// this only knows their markup (the shared Search box and the map's find box).
function focusSearch(): boolean {
  const el = document.querySelector<HTMLInputElement>('.search input, .map-search input, input[type="search"]');
  if (!el) return false;
  el.focus(); el.select();
  return true;
}
const typing = (t: EventTarget | null) => { const el = t as HTMLElement | null; return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable); };

/// Back/forward return to where the reader was; a new page starts at the top (instantly, so the
/// smooth scroll-behavior does not animate a page change); a hash scrolls to its element. Pages
/// load their data after mounting, so a restored position is retried once the content has grown.
function useScrollRestoration() {
  const loc = useLocation();
  const type = useNavigationType();
  const positions = useRef(new Map<string, number>());
  useLayoutEffect(() => { try { window.history.scrollRestoration = "manual"; } catch { /* older engines */ } }, []);
  useLayoutEffect(() => {
    const save = () => positions.current.set(loc.key, window.scrollY);
    window.addEventListener("scroll", save, { passive: true });
    return () => { save(); window.removeEventListener("scroll", save); };
  }, [loc.key]);
  useLayoutEffect(() => {
    if (loc.hash) { const el = document.getElementById(loc.hash.slice(1)); if (el) { el.scrollIntoView(); return; } }
    const y = type === "POP" ? (positions.current.get(loc.key) ?? 0) : 0;
    window.scrollTo({ top: y, behavior: "instant" });
    if (y > 0) { const t = window.setTimeout(() => { if (Math.abs(window.scrollY - y) > 2) window.scrollTo({ top: y, behavior: "instant" }); }, 300); return () => clearTimeout(t); }
  }, [loc.key, loc.hash, type]);
}

/// `/` focuses search (jumping to Explore when the page has none), `L` opens the launch page.
/// Nothing fires while typing or with a modifier held, so browser shortcuts keep working.
function useShortcuts() {
  const nav = useNavigate();
  const loc = useLocation();
  const wantSearch = useRef(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing || typing(e.target)) return;
      if (e.key === "/") { e.preventDefault(); if (!focusSearch()) { wantSearch.current = true; nav("/explore"); } }
      else if (e.key === "l" || e.key === "L") { e.preventDefault(); nav("/launch"); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [nav]);
  useEffect(() => {
    if (!wantSearch.current) return;
    wantSearch.current = false;
    const raf = requestAnimationFrame(() => { if (!focusSearch()) setTimeout(focusSearch, 120); });
    return () => cancelAnimationFrame(raf);
  }, [loc.pathname]);
}

/// Canonical and og:url follow the route (the origin comes from the page itself; index.html set
/// the initial values). Pages set their own "<Page> · Spore" titles; the home page gets the brand one.
function useRouteMeta() {
  const loc = useLocation();
  useEffect(() => {
    const url = `${window.location.origin}${loc.pathname}`;
    document.querySelector('link[rel="canonical"]')?.setAttribute("href", url);
    document.querySelector('meta[property="og:url"]')?.setAttribute("content", url);
    if (loc.pathname === "/") document.title = BRAND.title;
  }, [loc.pathname]);
}

function MotionToggle() {
  const [paused, reduced, setPaused] = useMotionPref();
  return (
    <button type="button" className="motion-toggle" aria-pressed={paused} disabled={reduced} onClick={() => setPaused(!paused)}
      title={reduced ? "Your system asks for reduced motion, so animations are already off" : paused ? "Resume the background spores and other animations" : "Stop the background spores and other animations"}>
      <i aria-hidden="true" />{reduced ? "Animations off (system)" : paused ? "Animations paused" : "Pause animations"}
    </button>
  );
}

function Shell() {
  const loc = useLocation();
  const { stats, error } = useStats(30_000);
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLElement>(null);
  const burgerRef = useRef<HTMLButtonElement>(null);
  useScrollRestoration();
  useShortcuts();
  useRouteMeta();
  const closeMenu = useCallback(() => setMenu(false), []);
  useEffect(() => { setMenu(false); }, [loc.pathname]);
  // The phone menu closes on Escape (focus returns to its button) and on a tap outside it.
  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { setMenu(false); burgerRef.current?.focus(); } };
    const onDown = (e: PointerEvent) => { const t = e.target as Node; if (!menuRef.current?.contains(t) && !burgerRef.current?.contains(t)) setMenu(false); };
    window.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => { window.removeEventListener("keydown", onKey); document.removeEventListener("pointerdown", onDown); };
  }, [menu]);
  // The map fills the viewport and its canvas turns wheel events into zoom, so a footer under it
  // could never be scrolled to; the map route drops the page padding and the footer instead.
  const isMap = loc.pathname === "/map";
  const ours = stats?.mode === "ours";
  const launches = ours ? stats?.ourCoins ?? stats?.coins : stats?.coins;
  const pillTitle = error && !stats ? `API: ${error}` : stats ? (ours ? `${count(launches)} coins launched on Spore` : `${count(stats.coins)} coins indexed`) : "connecting to the API";
  const pillText = error && !stats ? "api down" : stats ? (stats.backfill.done ? (ours ? `${count(launches)} launches` : `${count(stats.coins)} coins`) : `indexing ${count(stats.backfill.resolved)}/${count(stats.backfill.total)}`) : "…";
  return (
    <div className="shell">
      <a className="skip" href="#main">Skip to content</a>
      <header className="nav">
        <div className="nav-inner">
          <NavLink to="/" className="wordmark" aria-label="Spore home"><Mark />spore</NavLink>
          <nav id="primary-nav" ref={menuRef} className={`nav-links ${menu ? "open" : ""}`} aria-label="Primary">
            {PRIMARY.map(([to, label]) => <NavLink key={to} to={to}>{label}</NavLink>)}
            {/* Fees sits in the footer on desktop; the phone sheet is the only nav there, so it joins. */}
            {menu && <NavLink to="/fees" onClick={closeMenu}>Fees &amp; rules</NavLink>}
          </nav>
          <div className="nav-right">
            <span className={`api-pill ${error && !stats ? "down" : stats ? "up" : ""}`} title={pillTitle} aria-label={pillTitle}><LiveDot short />{pillText}</span>
            <WalletMultiButton />
            <button ref={burgerRef} type="button" className="burger" aria-label={menu ? "Close menu" : "Open menu"} aria-expanded={menu} aria-controls="primary-nav" onClick={() => setMenu((m) => !m)}><i /><i /><i /></button>
          </div>
        </div>
      </header>
      {!isMap && <OfficialCoin />}
      <main id="main" tabIndex={-1} className={isMap ? "map-main" : undefined}>
        {/* Keyed by path so a page change fades in; search-param changes (the launch form's parent) keep the page mounted. */}
        <div className="route" key={loc.pathname}>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/explore" element={<Explore />} />
            <Route path="/map" element={<MapPage />} />
            <Route path="/c/:mint" element={<CoinPage />} />
            <Route path="/launch" element={<Launch />} />
            {/* Old links and share posts say /spawn; it renders the same page. */}
            <Route path="/spawn" element={<Launch />} />
            <Route path="/how" element={<How />} />
            <Route path="/fees" element={<Fees />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </div>
      </main>
      {!isMap && <footer className="footer">
        <div className="footer-grid">
          <div className="footer-col">
            <span className="footer-brand"><Mark size={20} /><b>{BRAND.name}</b> · {BRAND.tagline}</span>
            <p>A pump.fun launchpad for family trees. Launch a root with SOL, launch children under it, keep half of the creator fees. Spore's half buys <NavLink to={`/c/${SPORE_COIN}`}>$SPORE</NavLink> and locks it. Only coins launched here are listed.</p>
            <p>Nothing custodial: every transaction is built in your browser and signed by your wallet. Memecoins are risky; read <NavLink to="/fees">the fees and rules</NavLink> first.</p>
          </div>
          <div className="footer-col">
            <h4>Spore</h4>
            <nav className="footer-nav" aria-label="Footer">
              {PRIMARY.map(([to, label]) => <NavLink key={to} to={to}>{label}</NavLink>)}
              <NavLink to="/fees">Fees &amp; rules</NavLink>
            </nav>
          </div>
          <div className="footer-col">
            <h4>Elsewhere</h4>
            <nav className="footer-nav" aria-label="External links">
              <a href="https://x.com/Sporemap" target="_blank" rel="noreferrer">X · @Sporemap ↗</a>
              <a href="https://pump.fun" target="_blank" rel="noreferrer">pump.fun ↗</a>
              <a href="https://solscan.io" target="_blank" rel="noreferrer">Solscan ↗</a>
            </nav>
          </div>
          <div className="footer-col">
            <h4>Display</h4>
            <MotionToggle />
            <div className="kbd-row" aria-label="Keyboard shortcuts"><span><kbd>/</kbd> search</span><span><kbd>L</kbd> launch</span><span><kbd>Esc</kbd> close</span></div>
          </div>
        </div>
        <div className="footer-bottom">
          <span><LiveDot short />{pillText}{stats?.solUsd ? ` · SOL $${stats.solUsd.toFixed(2)}` : ""}</span>
          <span>half of creator fees is all Spore earns · no launch fee · no keys, no funds, no promises</span>
        </div>
      </footer>}
    </div>
  );
}

export default function App() {
  return <ToastProvider><Shell /></ToastProvider>;
}
