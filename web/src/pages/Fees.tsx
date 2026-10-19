import { useEffect, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { useAsync, useStats } from "../lib/hooks";
import { usd } from "../lib/format";

// "0.02 SOL", "0.025 SOL": the page quotes fees, where lib/format's fixed four decimals read as noise.
const solText = (s: number) => `${Number(s.toFixed(4))} SOL`;
import SporeCanvas from "../components/SporeCanvas";
import { Glyph, type GlyphName } from "../components/Stat";
import { DepthBadge, Skeleton } from "../components/Bits";

// The network rent a launch pays for its own accounts (mint, curve, fee-sharing config, vault
// ATA): an estimate, the same figure the launch page's cost box uses (DESIGN §11.2).
const RENT_SOL = 0.025;
const MAX_CREATOR_FEE_BPS = 300;

const Card = ({ icon, tone = "", title, children }: { icon: GlyphName; tone?: "" | "violet" | "teal" | "warn"; title: string; children: ReactNode }) => (
  <section className={`card fees-card ${tone}`}><h2><i aria-hidden="true"><Glyph name={icon} /></i>{title}</h2>{children}</section>
);
const No = ({ children }: { children: ReactNode }) => (
  <li><i aria-hidden="true"><svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M3 3l6 6M9 3l-6 6" /></svg></i><span>{children}</span></li>
);

/// Everything Spore charges and everything it refuses to do, on one page: the launch fee (live
/// from the API, so an env change shows up here), the 50/50 creator-fee split, the depth cap, the
/// rules pump.fun enforces, and the risks. Linked from the footer and the launch page.
export default function Fees() {
  const { stats } = useStats();
  // The SOL pool's eligibility carries the launch fee and the default split without a wallet.
  const elig = useAsync(() => api.eligibilitySol(null), []);
  useEffect(() => { document.title = "Fees & rules · Spore"; return () => { document.title = "Spore"; }; }, []);
  const fee = elig.data ? (elig.data.launchFee?.sol ?? 0) : null;
  const solUsd = stats?.solUsd ?? null;
  const inUsd = (s: number) => (solUsd ? usd(s * solUsd) : null);
  const platformShare = elig.data?.shares.find((s) => s.address === elig.data?.platform)?.bps ?? 5000;
  const creatorShare = 10_000 - platformShare;
  const maxDepth = stats?.maxDepth ?? 2;
  const Amount = ({ s }: { s: number | null }) => (s === null ? <Skeleton w={70} h={16} /> : <>{solText(s)}{inUsd(s) && <small>{inUsd(s)}</small>}</>);
  return (
    <>
      <SporeCanvas density={0.5} />
      <div className="container fees">
        <div className="page-head">
          <span className="eyebrow">Fees &amp; rules</span>
          <h1>What it costs. What it <em>never</em> does.</h1>
          <p className="lead">Spore earns two things: a small fee when a coin is launched, and half of that coin's creator fees afterwards. Both are shown before you sign, both are written on-chain, and nothing else ever leaves your wallet.</p>
        </div>

        <div className="fees-grid">
          <Card icon="spore" title="One launch, line by line">
            <dl className="ledger">
              <div><dt>Launch fee<small>Transferred to Spore inside the launch transaction. Zero hides this line on the launch page.</small><span className="who spore">to Spore</span></dt><dd className="accent"><Amount s={fee} /></dd></div>
              <div><dt>Network rent<small>Held by the coin's own accounts on Solana: mint, bonding curve, fee-sharing config and the curve's vault. An estimate, hence the “~”.</small><span className="who">to the network</span></dt><dd>~<Amount s={RENT_SOL} /></dd></div>
              <div><dt>Network fees<small>Solana's transaction fee plus the priority fee your wallet adds. Fractions of a cent.</small><span className="who">to validators</span></dt><dd>≈ 0.0001 SOL</dd></div>
              <div><dt>First buy<small>Optional. A second signature buys your coin with SOL right after it exists, through every hop of the chain.</small><span className="who">your choice</span></dt><dd>0 – any</dd></div>
            </dl>
            <p className="hint">{fee === null ? "Reading the current fee…" : fee > 0 ? `A launch therefore costs about ${solText(fee + RENT_SOL)} before any first buy, and the launch page checks your balance against that total, with a small margin for network fees.` : "No launch fee is charged right now: a launch costs the network rent and fees only."}</p>
          </Card>

          <Card icon="lock" tone="violet" title="Creator fees, split 50 / 50">
            <div className="fees-split">
              <div className="fees-split-bar" aria-hidden="true"><i className="you" style={{ flexGrow: creatorShare }} /><i className="spore" style={{ flexGrow: platformShare }} /></div>
              <div className="fees-split-rows">
                <div><b>{creatorShare / 100}%</b><span>you, the creator</span><small>the wallet that signs the launch</small></div>
                <div><b>{platformShare / 100}%</b><span>Spore</span><small>the launchpad wallet — buys $SPORE and locks it</small></div>
              </div>
            </div>
            <div className="prose">
              <p>Every trade of a pump.fun coin pays a <b>creator fee</b> to the coin's creator: pump's default schedule, or a custom rate you pick at launch, up to {MAX_CREATOR_FEE_BPS / 100}%. Spore writes a fee-sharing config in the launch transaction with exactly two shareholders, you and Spore, and pump revokes the admin on first use, so <b>the split can never be changed</b> by anyone, Spore included.</p>
              <p>Payouts arrive in the coin's quote: <b>SOL</b> for a root coin, <b>the parent coin</b> for a child. Anyone can trigger <span className="mono">distribute_creator_fees_v2</span>; Spore's keeper does it on a schedule. Parent creators get no share of a child's fees: they earn through the parent tokens the child buys and locks.</p>
              <p>pump.fun's own protocol fee on every trade goes to pump.fun, as on any pump coin. Spore takes nothing from trades beyond its half of the creator fee.</p>
            </div>
          </Card>

          <Card icon="depth" tone="teal" title="Depth cap">
            <div className="depth-row"><DepthBadge depth={0} title="root: quoted in SOL" /><span>→</span><DepthBadge depth={1} title="child: quoted in the root" />{maxDepth >= 2 && <><span>→</span><DepthBadge depth={2} title="grandchild: quoted in the child" /></>}{maxDepth >= 3 && <><span>→</span><DepthBadge depth={3} /></>}<span>→</span><span className="ghost">depth {maxDepth + 1} not allowed</span></div>
            <div className="prose">
              <p>A root is quoted in SOL (depth 0). A child is quoted in its parent, one deeper. pump.fun's <span className="mono">Global.maxCurveDepth</span> is <b>{stats ? stats.maxDepth : "2"}</b> right now, so the deepest coin possible is depth {maxDepth}; the launch button is greyed out on any coin at the cap, with the reason in its tooltip. The program's hard limit is 5; if pump.fun raises its setting, Spore follows automatically.</p>
            </div>
          </Card>

          <Card icon="tree" title="Rules pump.fun enforces">
            <div className="prose">
              <ul className="how-list">
                <li>A <b>mayhem-mode</b> coin cannot be a parent.</li>
                <li>A coin cannot be launched under a chain where any coin has <b>graduated but not migrated</b> yet: wait for the migration.</li>
                <li>Only coins quoted in a listed mint (SOL, USDC, tokenized stocks) can be roots; a chain not rooted in SOL cannot be bought from SOL in-app.</li>
                <li><b>Holder rewards are off</b> on Spore launches: a holder-reward coin routes fees to holders through a PDA, which would defeat the split.</li>
                <li>Names are at most 32 characters, tickers 1–13 letters or digits, images under 2 MB. Metadata is content-addressed on Spore's own host.</li>
              </ul>
            </div>
          </Card>

          <Card icon="price" tone="warn" title="What Spore never does">
            <ul className="never">
              <No><b>Never holds keys or funds.</b> Every transaction is built in your browser, simulated, then signed by your wallet. No private key exists anywhere in Spore.</No>
              <No><b>Never launches coins itself.</b> Spore is a launchpad, not a coin project: its only revenue is its half of creator fees on other people's launches; there is no launch fee.</No>
              <No><b>Never changes a split after launch.</b> It cannot: pump revokes the config's admin the moment the shares are written.</No>
              <No><b>Never lists a coin it did not launch.</b> Feeds, the map and the leaderboard show Spore launches only; ancestors appear as context, never as listings.</No>
              <No><b>Never trades on your behalf</b> and never takes a cut of a trade beyond the creator-fee share above. Slippage is enforced on-chain through <span className="mono">minAmountOut</span>.</No>
              <No><b>Never promises a price.</b> These are pump.fun memecoins; most go to zero.</No>
            </ul>
          </Card>

          <Card icon="volume" tone="warn" title="Risks, plainly">
            <div className="prose">
              <ul className="how-list">
                <li>A child's price is the product of every price on its chain: when the parent drops, every child drops with it.</li>
                <li>Multi-hop swaps cost more compute and can fail on slippage when any hop moves. A failed transaction costs only the network fee.</li>
                <li>There is no launch fee: a launch costs only Solana's network rent and fees, and if the transaction fails, only the network fee is spent.</li>
                <li>Creator fees are paid in parent tokens for a child coin, so their value follows the parent, not SOL.</li>
              </ul>
            </div>
          </Card>
        </div>

        <div className="fees-cta">
          <Link to="/launch" className="btn lg accent">Launch a coin</Link>
          <Link to="/how" className="btn lg ghost">How it works</Link>
          <p className="hint">Figures on this page are read live from the API (fee, split, depth cap); the network rent is an estimate.</p>
        </div>
      </div>
    </>
  );
}
