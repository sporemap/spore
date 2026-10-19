import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Link, useNavigate } from "react-router-dom";
import { SPORE_COIN } from "../lib/policy";
import { api, type Coin } from "../lib/api";
import { useAsync, useStats } from "../lib/hooks";
import { count, usd } from "../lib/format";
import SporeCanvas from "../components/SporeCanvas";
import Search from "../components/Search";
import SpawnFeed, { LaunchTicker, LiveDot } from "../components/SpawnFeed";
import CoinCard from "../components/CoinCard";
import LaunchButton from "../components/LaunchButton";
import { Stat, StatStrip } from "../components/Stat";
import { Empty, ErrorBox, Logo, SkeletonCard, SkeletonRows, nameOf, sym } from "../components/Bits";
import "../components/discover.css";

/// A number that tweens to its next value and flashes once when it changes, so a stats strip fed
/// by SSE visibly reacts to a launch or a trade instead of silently swapping digits.
function AnimatedNumber({ value, format }: { value: number | null | undefined; format: (n: number | null | undefined) => string }) {
  const [shown, setShown] = useState(value);
  const [bump, setBump] = useState(false);
  const prev = useRef(value);
  const raf = useRef(0);
  useEffect(() => {
    const from = prev.current, to = value;
    prev.current = value;
    if (to == null || from == null || from === to) { setShown(to); return; }
    const reduced = typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) { setShown(to); return; }
    setBump(true);
    const t0 = performance.now(), ms = 700;
    const step = (t: number) => {
      const u = Math.min(1, (t - t0) / ms), e = 1 - (1 - u) ** 3;
      setShown(from + (to - from) * e);
      if (u < 1) raf.current = requestAnimationFrame(step); else setBump(false);
    };
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf.current);
  }, [value]);
  return <span className={`cnum ${bump ? "bump" : ""}`}>{format(shown)}</span>;
}

/// Illustrative tree for the empty launchpad: a root, three children, a few grandchildren, buys
/// flowing upward. Static shapes with placeholder tickers; nothing here is live data.
export function TreePreview() {
  const root = { x: 220, y: 56, r: 34 };
  const kids = [{ x: 100, y: 170, r: 24, s: "$CHILD" }, { x: 220, y: 182, r: 28, s: "$CHILD" }, { x: 342, y: 166, r: 20, s: "$CHILD" }];
  const grand = [{ x: 58, y: 262, r: 12, p: 0 }, { x: 128, y: 268, r: 10, p: 0 }, { x: 196, y: 272, r: 13, p: 1 }, { x: 262, y: 276, r: 9, p: 1 }, { x: 318, y: 256, r: 11, p: 2 }, { x: 380, y: 250, r: 8, p: 2 }];
  const link = (a: { x: number; y: number }, b: { x: number; y: number }, key: string, color: string) => (
    <g key={key}><line x1={b.x} y1={b.y} x2={a.x} y2={a.y} stroke={color} strokeOpacity=".28" strokeWidth="1.2" /><line className="tp-flow" x1={b.x} y1={b.y} x2={a.x} y2={a.y} stroke={color} strokeOpacity=".9" strokeWidth="1.6" strokeLinecap="round" /></g>
  );
  const bubble = (n: { x: number; y: number; r: number }, color: string, key: string, label?: string, strong = false) => (
    <g key={key}>
      <circle className="tp-pulse" cx={n.x} cy={n.y} r={n.r * 1.9} fill={color} fillOpacity={strong ? ".16" : ".1"} />
      <circle cx={n.x} cy={n.y} r={n.r} fill={color} fillOpacity=".2" stroke={color} strokeOpacity=".9" strokeWidth={strong ? 1.6 : 1.1} />
      {label && <text x={n.x} y={n.y + n.r + 14} textAnchor="middle" fill="#d8e8da" fontFamily="Geist Mono, ui-monospace, monospace" fontSize={strong ? 12 : 10.5} fontWeight={strong ? 600 : 500}>{label}</text>}
    </g>
  );
  return (
    <figure className="tree-preview" aria-label="Illustration of a coin family tree: a root coin, children quoted in it, grandchildren under those; buys flow upward">
      <svg viewBox="0 0 440 300" role="img">
        <defs><radialGradient id="tp-bg" cx="50%" cy="40%" r="60%"><stop offset="0" stopColor="#0d2316" /><stop offset="1" stopColor="#06100a" /></radialGradient></defs>
        <rect x="0" y="0" width="440" height="300" rx="18" fill="url(#tp-bg)" stroke="rgba(182,255,92,.14)" />
        {kids.map((k, i) => link(root, k, `l${i}`, "#5ce0c8"))}
        {grand.map((g, i) => link(kids[g.p], g, `g${i}`, "#b08cff"))}
        {grand.map((g, i) => bubble(g, "#b08cff", `gb${i}`))}
        {kids.map((k, i) => bubble(k, "#5ce0c8", `kb${i}`, k.s))}
        {bubble(root, "#b6ff5c", "root", "$ROOT", true)}
        <text x="14" y="288" fill="#5d7364" fontFamily="Geist Mono, ui-monospace, monospace" fontSize="9" letterSpacing="1">BUYS FLOW UP · PARENT TOKENS LOCK IN THE CHILD'S CURVE</text>
      </svg>
      <figcaption>Illustration — what a tree looks like</figcaption>
    </figure>
  );
}

/// The empty launchpad (DESIGN §11.1): the three steps, one big CTA and the preview tree. It must
/// read as "nothing yet, be first", never as a page that failed to load.
function EmptyLaunchpad() {
  return (
    <section className="empty-hero card">
      <div className="empty-hero-text">
        <span className="eyebrow">nothing launched yet</span>
        <h2>Be the first tree on Spore.</h2>
        <p>Spore lists only coins launched here, so the first launch is the whole front page. Three steps from an idea to a family tree:</p>
        <ol className="empty-steps">
          <li><div><b>Launch a root with SOL.</b><span>A plain pump.fun coin, one signature, no launch fee — only network rent. Its fee split is written on-chain at creation.</span></div></li>
          <li><div><b>Launch the next coin under it.</b><span>The child is quoted in the parent, so every buy of the child buys the parent and locks it in the child's curve.</span></div></li>
          <li><div><b>Keep half the fees, forever.</b><span>Creator 50% / Spore 50%, paid in the coin's quote on every trade. Set once with the admin revoked. Spore's half buys $SPORE and locks it.</span></div></li>
        </ol>
        <div className="empty-hero-cta"><Link className="btn lg accent" to="/launch">Launch the first coin</Link><Link className="btn lg ghost" to="/how">How it works</Link></div>
      </div>
      <TreePreview />
    </section>
  );
}

/// Roots ranked by what their children have locked: the trees worth launching under. Each row
/// links to the coin, to its cluster on the map, and straight into the launch form.
function BiggestTrees({ maxDepth }: { maxDepth: number | undefined }) {
  const nav = useNavigate();
  const roots = useAsync(() => api.roots("locked", 6, 0), []);
  if (roots.loading) return <SkeletonRows n={6} h={62} />;
  if (roots.error && !roots.data) return <ErrorBox error={roots.error} retry={roots.reload} />;
  const rows = roots.data?.roots ?? [];
  if (!rows.length) return <Empty title="No trees yet" hint="A tree appears with the first coin launched under a root." action={<Link to="/launch" className="btn sm accent">Launch a root</Link>} />;
  const top = Math.max(1, ...rows.map((r) => r.lockedUsd ?? 0));
  return (
    <div className="trees card">
      {rows.map((c: Coin, i) => {
        const d1 = Math.min(c.children, 12), d2 = Math.min(Math.max(0, c.descendants - c.children), 12 - d1);
        return (
          <div key={c.mint} className="tree-row" role="link" tabIndex={0} onClick={() => nav(`/c/${c.mint}`)} onKeyDown={(e) => { if (e.key === "Enter") nav(`/c/${c.mint}`); }}>
            <span className="tree-rank">{i + 1}</span>
            <Logo src={c.image} label={c.symbol} size={40} />
            <div className="tree-body">
              <div className="tree-name"><b>{nameOf(c)}</b><span>{sym(c)}</span></div>
              <div className="tree-meta"><span className="tree-dots" aria-hidden="true">{Array.from({ length: d1 }, (_, k) => <i key={`a${k}`} />)}{Array.from({ length: d2 }, (_, k) => <i key={`b${k}`} className="d2" />)}{c.descendants > 12 && <small>+{count(c.descendants - 12)}</small>}</span><span>{count(c.descendants)} coin{c.descendants === 1 ? "" : "s"} below</span>·<span><b>{usd(c.lockedUsd)}</b> locked</span>·<span>{usd(c.mcapUsd)} mcap</span></div>
              <div className="tree-bar" aria-hidden="true"><i style={{ "--w": `${Math.max(2, ((c.lockedUsd ?? 0) / top) * 100)}%` } as CSSProperties} /></div>
            </div>
            <div className="tree-actions" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
              <Link to={`/map?focus=${c.mint}`} className="btn sm ghost" title="See this tree on the map">Map</Link>
              <LaunchButton coin={c} maxDepth={maxDepth} size="sm" label="Launch under" />
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default function Home() {
  const { stats, error } = useStats();
  // "Launched on Spore": our coins, the strongest six by locked value, then 24 h volume, then mcap.
  const feed = useAsync(() => api.feed(60), []);
  const top = [...(feed.data?.coins ?? [])].sort((a: Coin, b: Coin) => (b.lockedUsd ?? 0) - (a.lockedUsd ?? 0) || b.volume24hUsd - a.volume24hUsd || (b.mcapUsd ?? 0) - (a.mcapUsd ?? 0)).slice(0, 6);
  const depthLabel = stats ? stats.byDepth.map((n, d) => `${count(n)} at d${d}`).filter((_, d) => d > 0).join(" · ") : undefined;
  // "ours" mode (DESIGN §11.1): the listing is Spore's launches, so the strip counts those; an older
  // server without `mode` keeps the whole-tree wording.
  const ours = stats?.mode === "ours";
  const launches = ours ? stats?.ourCoins ?? stats?.coins : stats?.coins;
  const noSpawns = !!stats && (launches ?? 0) === 0;
  const loading = !stats && !error;
  return (
    <>
      <SporeCanvas />
      <div className="container home">
        <section className="hero">
          <span className="eyebrow">a pump.fun family-tree launchpad</span>
          <h1>Coins that <em>grow</em> coins.</h1>
          <p className="hero-tagline">Launch a coin with SOL. Launch the next one under it. Every buy of a child buys and locks its parent; half the fees stay yours.</p>
          <p className="lead">The first coin of a tree is a plain pump.fun coin. A child coin is quoted in its parent instead of SOL, so its curve parks parent tokens forever. Creator fees are split 50/50 between you and Spore, paid in the coin's quote. <b>Nothing custodial</b> — every transaction is built in your browser and signed by your wallet.</p>
          <div className="hero-actions">
            <Link className="btn lg accent" to="/launch">Launch a coin</Link>
            <Link className="btn lg ghost" to="/explore">Explore launches</Link>
          </div>
          <div className="hero-search"><Search size="lg" placeholder="Find any pump.fun coin by name, ticker or mint…" /></div>
          <p className="hint">Any pump.fun coin can be a parent. Listings show only coins launched on Spore.</p>
        </section>

        {noSpawns ? (
          <>
            <EmptyLaunchpad />
            <StatStrip>
              <Stat icon="tree" label={ours ? "Spore launches" : "coins in the tree"} value="0" sub="be the first" />
              <Stat icon="depth" label="depth cap" value={`${stats!.maxDepth}`} sub="pump.fun Global.maxCurveDepth" />
              <Stat icon="price" label="SOL" value={usd(stats!.solUsd)} sub="no launch fee" />
              <Stat icon="lock" label="your share of fees" value="50%" hero sub="Spore's half buys & locks $SPORE" />
            </StatStrip>
          </>
        ) : (
          <>
            <StatStrip>
              <Stat icon="tree" label={ours ? "Spore launches" : "coins in the tree"} value={<AnimatedNumber value={launches} format={count} />} loading={loading} sub={ours && stats?.otherChildren ? `${depthLabel && launches ? depthLabel + " · " : ""}${count(stats.otherChildren)} other children on pump.fun` : depthLabel} />
              <Stat icon="depth" label="trees" value={<AnimatedNumber value={stats?.roots} format={count} />} loading={loading} sub={stats ? `roots with children · depth cap ${stats.maxDepth}` : undefined} />
              <Stat icon="lock" label="locked in curves" value={<AnimatedNumber value={stats?.lockedUsd} format={usd} />} loading={loading} hero sub="parent tokens parked by children" />
              <Stat icon="volume" label="24h volume" value={<AnimatedNumber value={stats?.volume24hUsd} format={usd} />} loading={loading} sub={stats?.solUsd ? `SOL ${usd(stats.solUsd)}` : undefined} />
            </StatStrip>
            {error && !stats && <ErrorBox error={error} />}
            {stats && !stats.backfill.done && <div className="notice info">Indexing the tree: {count(stats.backfill.resolved)} of {count(stats.backfill.total)} curves resolved. Lists fill in as it goes.</div>}

            <section className="home-top">
              <div className="section-head"><h2>Live launches</h2><LiveDot /></div>
              <LaunchTicker limit={14} />
            </section>

            <section>
              <div className="section-head"><h2>Launched on Spore</h2><Link to="/explore" className="more">All launches →</Link></div>
              {feed.loading ? <div className="home-cards">{[0, 1, 2, 3, 4, 5].map((i) => <SkeletonCard key={i} />)}</div>
                : feed.error && !feed.data ? <ErrorBox error={feed.error} retry={feed.reload} />
                : !top.length ? <Empty title="Nothing launched yet — launch the first coin" hint="Coins launched on Spore appear here, strongest first." action={<Link to="/launch" className="btn sm accent">Launch a coin</Link>} />
                : <div className="home-cards">{top.map((c, i) => <CoinCard key={c.mint} coin={c} rank={i + 1} action={<LaunchButton coin={c} maxDepth={stats?.maxDepth} className="block" />} />)}</div>}
            </section>

            <div className="home-split">
              <section>
                <div className="section-head"><h2>Biggest trees</h2><Link to="/map" className="more">Open the map →</Link></div>
                <BiggestTrees maxDepth={stats?.maxDepth} />
              </section>
              <section>
                <div className="section-head"><h2>Latest launches</h2><Link to="/explore?sort=new" className="more">All →</Link></div>
                <SpawnFeed limit={8} />
              </section>
            </div>
          </>
        )}

        {!noSpawns && (
          <section>
            <div className="section-head"><h2>Three steps</h2><Link to="/how" className="more">How it works →</Link></div>
            <div className="how-strip threaded">
              <div className="how-step"><i>1</i><h3>Launch a root</h3><p>The first coin of a tree is quoted in SOL, like any pump.fun coin. One signature: <span className="mono">create_v2</span> plus a fee-sharing config that is set once and never changes.</p></div>
              <div className="how-step"><i>2</i><h3>Launch under it</h3><p>Press “Launch a coin” on any coin below the depth cap: the child is quoted in the parent, so its curve buys and locks parent tokens on every trade.</p></div>
              <div className="how-step"><i>3</i><h3>Fees split 50/50</h3><p>Creator 50%, Spore 50% — paid in the parent coin on every trade of the child. Set at launch with the admin revoked, so it can never change. Spore's half buys <Link to={`/c/${SPORE_COIN}`}>$SPORE</Link> and locks it.</p></div>
            </div>
          </section>
        )}
      </div>
    </>
  );
}
