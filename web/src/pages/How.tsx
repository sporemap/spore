import { useEffect } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { useAsync, useStats } from "../lib/hooks";
import { count, usd } from "../lib/format";

const solText = (s: number) => `${Number(s.toFixed(4))} SOL`;
import SporeCanvas from "../components/SporeCanvas";
import { Glyph, type GlyphName } from "../components/Stat";

// Two shareholders (DESIGN §4): the creator and the launchpad.
const SPLIT = [["Creator", "50%", "you — the wallet that signs the launch"], ["Spore", "50%", "the launchpad wallet"]];
const MONO = "Geist Mono, monospace";

/// SOL → $ROOT → $CHILD, the product in one picture: lime arrows are the buy route, the teal
/// bracket is the root tokens parked in the child's curve, violet arcs are each coin's creator
/// fee leaving for its two shareholders (in SOL for the root, in $ROOT for the child). A dashed
/// third node hints that the chain can go one deeper.
function FlowDiagram({ maxDepth }: { maxDepth: number }) {
  const y = 160, r = 38;
  const sol = { x: 86 }, root = { x: 300 }, child = { x: 514 }, next = { x: 690 };
  const arrow = (a: number, b: number, key: string) => (
    <g key={key}>
      <path d={`M${a + r + 6} ${y}H${b - r - 8}`} stroke="rgba(182,255,92,.35)" strokeWidth="2" />
      <path className="flow-pulse" d={`M${a + r + 6} ${y}H${b - r - 8}`} stroke="#b6ff5c" strokeWidth="2" markerEnd="url(#fd-buy)" />
      <text x={(a + b) / 2} y={y - 12} textAnchor="middle" fill="#b6ff5c" fontFamily={MONO} fontSize="11">buys</text>
    </g>
  );
  return (
    <figure className="card flow-diagram">
      <div className="flow-scroll">
        <svg viewBox="0 0 760 276" role="img" aria-label="Diagram: SOL buys the root coin, the root buys the child; the root tokens stay locked in the child's curve; each coin's creator fee is split 50/50 between its creator and Spore, paid in SOL for the root and in the root coin for the child; a further coin can grow under the child up to the depth cap.">
          <defs>
            <marker id="fd-buy" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5 0 10z" fill="#b6ff5c" /></marker>
            <marker id="fd-fee" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5 0 10z" fill="#b08cff" /></marker>
            <radialGradient id="fd-glow-l"><stop offset="0" stopColor="#b6ff5c" stopOpacity=".22" /><stop offset="1" stopColor="#b6ff5c" stopOpacity="0" /></radialGradient>
            <radialGradient id="fd-glow-t"><stop offset="0" stopColor="#5ce0c8" stopOpacity=".22" /><stop offset="1" stopColor="#5ce0c8" stopOpacity="0" /></radialGradient>
          </defs>
          <circle cx={root.x} cy={y} r={74} fill="url(#fd-glow-l)" />
          <circle cx={child.x} cy={y} r={74} fill="url(#fd-glow-t)" />
          {arrow(sol.x, root.x, "a")}
          {arrow(root.x, child.x, "b")}
          {/* a possible next coin under the child */}
          <path d={`M${child.x + r + 6} ${y}H${next.x - 26}`} stroke="rgba(92,224,200,.3)" strokeWidth="1.5" strokeDasharray="4 6" />
          <circle cx={next.x} cy={y} r={22} fill="none" stroke="rgba(176,140,255,.5)" strokeWidth="1.4" strokeDasharray="4 5" />
          <text x={next.x} y={y + 4} textAnchor="middle" fill="#c7adff" fontFamily={MONO} fontSize="11">d{Math.min(2, maxDepth)}</text>
          <text x={next.x} y={y + 40} textAnchor="middle" fill="#8ea596" fontFamily={MONO} fontSize="10">and so on,</text>
          <text x={next.x} y={y + 53} textAnchor="middle" fill="#8ea596" fontFamily={MONO} fontSize="10">up to depth {maxDepth}</text>
          {/* creator fees: one callout, two arcs */}
          <rect x={(root.x + child.x) / 2 - 150} y={28} width={300} height={34} rx={17} fill="rgba(176,140,255,.12)" stroke="rgba(176,140,255,.45)" />
          <text x={(root.x + child.x) / 2} y={44} textAnchor="middle" fill="#c7adff" fontFamily={MONO} fontSize="11">creator fee · 50% you · 50% Spore</text>
          <text x={(root.x + child.x) / 2} y={56} textAnchor="middle" fill="#8ea596" fontFamily={MONO} fontSize="9.5">set at launch, never changes</text>
          <path className="flow-pulse rev" d={`M${root.x + 8} ${y - r - 4} Q${root.x + 40} 86 ${root.x + 80} 66`} fill="none" stroke="#b08cff" strokeWidth="1.6" markerEnd="url(#fd-fee)" />
          <text x={root.x - 4} y={96} textAnchor="end" fill="#c7adff" fontFamily={MONO} fontSize="9.5">in SOL</text>
          <path className="flow-pulse rev" d={`M${child.x - 8} ${y - r - 4} Q${child.x - 40} 86 ${child.x - 80} 66`} fill="none" stroke="#b08cff" strokeWidth="1.6" markerEnd="url(#fd-fee)" />
          <text x={child.x + 4} y={96} textAnchor="start" fill="#c7adff" fontFamily={MONO} fontSize="9.5">in $ROOT</text>
          {/* root tokens parked under the child */}
          <path d={`M${child.x - 34} ${y + r + 30} v8 h68 v-8`} fill="none" stroke="#5ce0c8" strokeWidth="1.4" strokeOpacity=".8" />
          <text x={child.x} y={y + r + 56} textAnchor="middle" fill="#8df0de" fontFamily={MONO} fontSize="10.5">$ROOT locked in the curve</text>
          {/* nodes */}
          {[{ x: sol.x, label: "SOL", sub: "your wallet", color: "#c6d9c9", ring: "rgba(232,243,232,.35)", fill: "#0f2217" },
            { x: root.x, label: "$ROOT", sub: "depth 0 · launched with SOL", color: "#b6ff5c", ring: "rgba(182,255,92,.8)", fill: "#14301f" },
            { x: child.x, label: "$CHILD", sub: "depth 1 · launched under $ROOT", color: "#8df0de", ring: "rgba(92,224,200,.85)", fill: "#0f2a24" }].map((n) => (
            <g key={n.label}>
              <circle cx={n.x} cy={y} r={r} fill={n.fill} stroke={n.ring} strokeWidth="1.6" />
              <text x={n.x} y={y + 4} textAnchor="middle" fill={n.color} fontFamily={MONO} fontSize="12.5" fontWeight="600">{n.label}</text>
              <text x={n.x} y={y + r + 16} textAnchor="middle" fill="#8ea596" fontFamily={MONO} fontSize="10.5">{n.sub}</text>
            </g>
          ))}
        </svg>
      </div>
      <figcaption className="flow-legend"><span><i />buy route (SOL in)</span><span><i className="lock" />parent tokens locked</span><span><i className="fee" />creator fee, split 50/50</span></figcaption>
    </figure>
  );
}

const Card = ({ icon, tone = "", children }: { icon: GlyphName; tone?: "" | "violet" | "teal" | "warn"; children: React.ReactNode }) => (
  <section className={`card how-card ${tone}`}><i aria-hidden="true"><Glyph name={icon} /></i><div className="prose">{children}</div></section>
);

export default function How() {
  const { stats } = useStats();
  const elig = useAsync(() => api.eligibilitySol(null), []);
  useEffect(() => { document.title = "How it works · Spore"; return () => { document.title = "Spore"; }; }, []);
  const maxDepth = stats?.maxDepth ?? 2;
  const fee = elig.data ? (elig.data.launchFee?.sol ?? 0) : null;
  const launches = stats ? (stats.mode === "ours" ? stats.ourCoins ?? stats.coins : stats.coins) : null;
  return (
    <>
      <SporeCanvas density={0.5} />
      <div className="container how">
        <div className="page-head">
          <span className="eyebrow">How it works</span>
          <h1>A coin that <em>grows</em> coins.</h1>
          <p className="lead">pump.fun's <span className="mono">create_v2</span> lets a coin be quoted in another pump.fun coin instead of SOL. Spore is a launchpad for that: launch a root with SOL, launch the next coin under it, keep half of your creator fees. Only coins launched here are listed.</p>
        </div>

        <FlowDiagram maxDepth={maxDepth} />

        <div className="how-facts" aria-label="Key numbers">
          <div className="how-fact"><span>launch fee</span><b className="accent">{fee === null ? "…" : fee > 0 ? solText(fee) : "none"}</b><small>to Spore, inside the launch</small></div>
          <div className="how-fact"><span>creator fees</span><b>50 / 50</b><small>you / Spore · Spore's half buys &amp; locks $SPORE</small></div>
          <div className="how-fact"><span>depth cap</span><b>{stats ? stats.maxDepth : "2"}</b><small>root → child → grandchild</small></div>
          <div className="how-fact"><span>listed here</span><b>{launches === null ? "…" : count(launches)}</b><small>{stats && launches ? `${usd(stats.lockedUsd)} locked by children` : "Spore launches only"}</small></div>
        </div>

        <div className="how-cards">
          <Card icon="spore" tone="teal">
            <h2>Launching</h2>
            <ol className="how-list">
              <li><b>Launch a root with SOL.</b> The first coin of a tree is a plain pump.fun coin: quoted in SOL, no parent needed. Name, ticker, image, description and socials become a content-addressed metadata file on Spore's own host.</li>
              <li><b>Or launch under a coin.</b> Press “Launch a coin” on any coin below the depth cap, here or by searching all of pump.fun. The new coin is quoted in that parent: its curve collects parent tokens instead of SOL. The eligibility check runs against the live chain before you sign.</li>
              <li><b>Check the cost, sign once.</b> The cost box shows the launch fee{fee !== null && fee > 0 ? ` (${solText(fee)})` : ""}, the network rent (about 0.025 SOL for the mint, curve, fee config and vault) and your optional first buy, against your wallet balance. One transaction creates the coin, pays the fee and writes the fee split. Full list on <Link to="/fees">Fees &amp; rules</Link>.</li>
            </ol>
          </Card>

          <Card icon="tree">
            <h2>Why a child helps its parent</h2>
            <p>Buying a child from SOL is a multi-hop swap: SOL buys the root, the root buys the child. The root tokens stay parked in the child's curve and, once the child graduates, locked in the child/root PumpSwap pool. Selling runs the hops in reverse.</p>
            <p>So every child is permanent buy pressure and locked liquidity for its parent. That is the <b>locked</b> number on every card: the parent tokens its children hold.</p>
          </Card>

          <Card icon="lock" tone="violet">
            <h2>Fees</h2>
            <p>A coin's creator fee is paid on every trade of it. Spore writes a fee-sharing config in the launch transaction with exactly two shareholders:</p>
            <table className="table">
              <thead><tr><th>Shareholder</th><th>Share</th><th>Who</th></tr></thead>
              <tbody>{SPLIT.map(([a, b, c]) => <tr key={a}><td>{a}</td><td className="mono accent">{b}</td><td className="muted">{c}</td></tr>)}</tbody>
            </table>
            <p>Payouts arrive in the coin's quote: SOL for a root, the parent coin for a child. The split is shown before you sign and is <b>immutable afterwards</b>: pump's <span className="mono">update_fee_shares_v2</span> revokes the admin on first use, so neither Spore nor you can change it. Parent creators earn through locked liquidity, not a fee share.</p>
          </Card>

          <Card icon="depth">
            <h2>Depth, and what is listed</h2>
            <p>A coin quoted in SOL is depth 0, its child depth 1, and so on. pump.fun's <span className="mono">Global.maxCurveDepth</span> is <b>{stats ? stats.maxDepth : "2"}</b> today, so the chain is root → child → grandchild; the launch button greys out at the cap. Mayhem-mode coins cannot be parents, and a chain waits while any coin on it is graduated but not yet migrated.</p>
            <p>Spore lists only coins launched through it{stats && launches !== null ? <>: <b>{count(launches)}</b> so far{launches > 0 ? <>, with <b>{usd(stats.lockedUsd)}</b> of parent tokens locked by children</> : null}</> : null}. Any pump.fun coin can still be a parent; search covers all of pump.fun.</p>
          </Card>

          <Card icon="price" tone="teal">
            <h2>Trading here</h2>
            <p>The trade widget quotes by simulating the real <span className="mono">multi_hop_swap</span> and reading the resulting event, so the preview is what the program will do. Slippage is enforced on-chain through <span className="mono">minAmountOut</span>. Chains not rooted in SOL link out to pump.fun.</p>
          </Card>

          <Card icon="volume" tone="warn">
            <h2>Risks, plainly</h2>
            <ul className="how-list">
              <li>These are pump.fun memecoins. A child's price is the product of every price on its chain: when the parent drops, every child drops with it.</li>
              <li>Multi-hop swaps pay more compute and can fail on slippage when any hop moves; a failed transaction costs only the network fee.</li>
              <li>The fee split cannot be changed after launch. Check it in the preview.</li>
              <li>Spore holds no keys and no funds. Transactions are built client-side, simulated, then signed by your wallet. The API only indexes public chain data and proxies an allow-listed RPC.</li>
            </ul>
          </Card>
        </div>

        <div className="how-foot"><Link to="/launch" className="btn lg accent">Launch a coin</Link><Link to="/explore" className="btn lg ghost">Explore launches</Link><p className="hint">Every fee and rule, in full: <Link to="/fees">Fees &amp; rules</Link>.</p></div>
      </div>
    </>
  );
}
