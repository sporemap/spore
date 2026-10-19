import { useEffect } from "react";
import { Link, useLocation } from "react-router-dom";
import Mark from "../components/Mark";
import Search from "../components/Search";
import SporeCanvas from "../components/SporeCanvas";

/// The SPA 404: the server answers every unknown path with the app, so this page is the only
/// "not found" a reader sees. It names the path, offers the main routes and a search, and tells
/// the one likely story (a coin link) where to go instead.
export default function NotFound() {
  const { pathname } = useLocation();
  useEffect(() => { document.title = "Page not found · Spore"; return () => { document.title = "Spore"; }; }, []);
  const looksLikeMint = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(pathname.replace(/^\/+/, ""));
  return (
    <>
      <SporeCanvas density={0.6} />
      <div className="container">
        <div className="nf">
          <div className="nf-mark" aria-hidden="true"><Mark size={96} /></div>
          <span className="eyebrow">404 · not found</span>
          <h1>Nothing <em>grows</em> here.</h1>
          <p className="lead">There is no page at <span className="mono">{pathname}</span>.{looksLikeMint ? <> That looks like a mint address: coin pages live at <span className="mono">/c/&lt;mint&gt;</span>, and only coins launched on Spore are listed.</> : " The link may be old, or the coin it pointed at was never launched here."}</p>
          <div className="nf-actions">
            {looksLikeMint && <Link to={`/c/${pathname.replace(/^\/+/, "")}`} className="btn accent">Open as a coin page</Link>}
            <Link to="/" className={`btn ${looksLikeMint ? "ghost" : "accent"}`}>Back to the tree</Link>
            <Link to="/explore" className="btn ghost">Explore launches</Link>
            <Link to="/launch" className="btn ghost">Launch a coin</Link>
          </div>
          <div className="nf-search"><Search size="lg" placeholder="Or find any pump.fun coin by name, ticker or mint…" /></div>
        </div>
      </div>
    </>
  );
}
