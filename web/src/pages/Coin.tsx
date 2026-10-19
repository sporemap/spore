import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, pumpUrl, solscanAccount, solscanTx, type Coin as CoinT, type Trade } from "../lib/api";
import { useEvents } from "../lib/events";
import { copyText, useAsync, useMediaQuery, useNow, useScrollLock, useStats } from "../lib/hooks";
import { age, amount, clock, count, pct, price, short, sol, tokens, usd, when } from "../lib/format";
import type { Side } from "../lib/pump";
import ChainBreadcrumb from "../components/ChainBreadcrumb";
import { CoinBubbleMap } from "../components/BubbleMap";
import PriceChart from "../components/PriceChart";
import TradeWidget from "../components/TradeWidget";
import CoinCard from "../components/CoinCard";
import SplitPreview from "../components/SplitPreview";
import FeeSplitAction from "../components/FeeSplitAction";
import ClaimFees from "../components/ClaimFees";
import LaunchButton, { launchBlock } from "../components/LaunchButton";
import { Delta, Stat, StatStrip } from "../components/Stat";
import { Addr, Chip, DepthBadge, Empty, ErrorBox, Ext, Logo, ProgressBar, Skeleton, SkeletonCard, nameOf, sym } from "../components/Bits";
import { useToast } from "../components/Toast";
import "../components/coin.css";

/// The API hands over the last 50 trades and keeps 2 000 per mint; the tape stops at 50 and says
/// so, with the explorer for the rest.
const MAX_TRADES = 50;
type TapeFilter = "all" | "buy" | "sell";

/// 24 h move from hourly candles: the close of the last candle that ended at least 24 h ago,
/// else the first open when the series is younger (then the pill says "since first trade").
function change24h(rows: { t: number; o: number; c: number }[], priceNow: number | null, priceKey: "usd" | "quote", coin: CoinT): { ratio: number; label: string } | null {
  if (!rows.length) return null;
  const now = Math.floor(Date.now() / 1000);
  const cutoff = now - 86_400;
  const sorted = [...rows].sort((a, b) => a.t - b.t);
  const ref = [...sorted].reverse().find((r) => r.t + 3600 <= cutoff);
  const current = priceKey === "usd" ? (priceNow ?? sorted[sorted.length - 1].c) : (coin.priceQuote ?? sorted[sorted.length - 1].c);
  if (ref && ref.c > 0) return { ratio: current / ref.c - 1, label: "24h" };
  const first = sorted[0];
  if (first.o > 0 && sorted.length > 1) return { ratio: current / first.o - 1, label: `${age(first.t)}` };
  return null;
}

export default function CoinPage() {
  const { mint = "" } = useParams();
  const page = useAsync(() => api.coin(mint), [mint]);
  // Hourly candles just for the 24 h delta; the chart has its own series at the chosen resolution.
  const daily = useAsync(() => api.candles(mint, 3600).catch(() => null), [mint]);
  const { stats } = useStats();
  const toast = useToast();
  const now = useNow(5_000);
  const narrow = useMediaQuery("(max-width: 980px)");
  const [sheet, setSheet] = useState<Side | null>(null);
  const [tapeFilter, setTapeFilter] = useState<TapeFilter>("all");
  // Signatures that arrived over SSE since the page loaded, so the tape can highlight them.
  const fresh = useRef(new Set<string>());
  useScrollLock(sheet !== null);
  useEffect(() => { if (!narrow) setSheet(null); }, [narrow]);
  useEffect(() => { document.title = page.data ? `${nameOf(page.data.coin)} ${sym(page.data.coin)} · Spore` : "Spore"; return () => { document.title = "Spore"; }; }, [page.data]);
  // Live: a trade on this coin prepends to the tape and moves the header price; a new child
  // appears in the grid at once.
  useEvents({
    trade: (t: Trade) => {
      if (t.mint !== mint) return;
      // Highlight once: the row keeps its key, and a later filter change must not replay the flash.
      fresh.current.add(t.sig);
      setTimeout(() => fresh.current.delete(t.sig), 4_000);
      page.setData((d) => {
        if (!d || d.trades.some((x) => x.sig === t.sig)) return d;
        const solUsd = stats?.solUsd ?? null;
        const supply = tokens(d.coin.totalSupply, d.coin.decimals);
        const priceUsd = t.priceUsd ?? d.coin.priceUsd;
        const priceSol = priceUsd != null && solUsd ? priceUsd / solUsd : d.coin.priceSol;
        const coin = { ...d.coin, priceQuote: t.priceQuote, priceUsd, priceSol, mcapUsd: priceUsd != null ? priceUsd * supply : d.coin.mcapUsd, mcapSol: priceSol != null ? priceSol * supply : d.coin.mcapSol, trades24h: d.coin.trades24h + 1, volume24hUsd: d.coin.volume24hUsd + ((t as Trade & { valueUsd?: number }).valueUsd ?? 0) };
        return { ...d, coin, trades: [t, ...d.trades].slice(0, MAX_TRADES) };
      });
    },
    coin: (c: CoinT) => { if (c.parent?.mint !== mint) return; page.setData((d) => d && !d.children.some((x) => x.mint === c.mint) ? { ...d, children: [c, ...d.children], coin: { ...d.coin, children: d.coin.children + 1, descendants: d.coin.descendants + 1 } } : d); },
  });

  const coin = page.data?.coin ?? null;
  const delta = useMemo(() => (coin && daily.data ? change24h(daily.data.candles, coin.priceUsd, daily.data.priceKey, coin) : null), [coin, daily.data]);

  if (page.loading) return <div className="container"><CoinSkeleton /></div>;
  if (page.error && !page.data) return <div className="container"><div className="page-head"><h1>{page.error.includes("404") || /not found/i.test(page.error) ? "Unknown coin" : "Could not load"}</h1></div><ErrorBox error={page.error} retry={page.reload} /><p className="hint">Mint <span className="mono">{mint}</span> is not indexed here: Spore serves the coins launched on it and their ancestors. <Ext href={pumpUrl(mint)}>Open on pump.fun ↗</Ext> or <Link to={`/launch?parent=${mint}`}>launch a coin under it</Link>.</p></div>;
  if (!page.data || !coin) return null;
  const { children, trades } = page.data;
  // Children of this coin that live on pump.fun but were not launched here (ours mode, §11.1).
  const otherChildren = page.data.otherChildren ?? 0;
  // Server extras outside the §7 contract: holders arrives if the indexer ever counts them;
  // quoteDecimals formats lockedQuote and the tape's "for" column exactly.
  const extras = coin as CoinT & { holders?: number | null; quoteDecimals?: number };
  const quoteDecimals = extras.quoteDecimals ?? (coin.quoteMint === null ? 9 : 6);
  const lockedQuote = tokens(coin.lockedQuote, coin.decimals);
  const priceMain = coin.priceUsd != null ? usd(coin.priceUsd) : price(coin.priceQuote, coin.quoteSymbol);
  const copy = async (text: string, what: string) => { if (await copyText(text)) toast.success(`${what} copied`); else toast.error(`Could not copy the ${what.toLowerCase()}`); };
  const shownTrades = tapeFilter === "all" ? trades : trades.filter((t) => (tapeFilter === "buy") === t.isBuy);
  const buys = trades.filter((t) => t.isBuy).length;
  const solUsd = stats?.solUsd ?? null;

  return (
    <div className={`container coin-page ${narrow ? "has-bar" : ""}`}>
      <header className="coin-head">
        <Logo src={coin.image} label={coin.symbol} size={72} className="big" />
        <div className="coin-head-text">
          <div className="coin-title">
            <h1>{nameOf(coin)}</h1>
            <span className="ticker mono">{sym(coin)}</span>
            <DepthBadge depth={coin.depth} />
            {coin.migrated ? <Chip tone="good">graduated · PumpSwap</Chip> : coin.complete ? <Chip tone="warn">complete, awaiting migration</Chip> : null}
            {coin.holderReward && <Chip tone="violet" title="Creator fees go to holders; the fee split does not apply">holder rewards</Chip>}
            {coin.ours ? <Chip tone="accent" title="Its on-chain fee split names the Spore wallet: launched here">launched on Spore</Chip> : coin.oursPending ? <Chip tone="warn" title="Reported as a Spore launch; the indexer is verifying the fee split on-chain">verifying launch</Chip> : null}
          </div>
          <ChainBreadcrumb coin={coin} rootQuote={coin.depth === 0 ? coin.quoteSymbol : coin.root ? null : coin.quoteSymbol} />
          <div className="coin-meta">
            <span className="addr-row">creator <Addr a={coin.creator} /><CopyBtn onClick={() => copy(coin.creator, "Creator address")} label="Copy creator address" /></span>
            <span className="addr-row">mint <Addr a={coin.mint} n={5} /><CopyBtn onClick={() => copy(coin.mint, "Mint address")} label="Copy mint address" /></span>
            {coin.createdAt && <span title={when(coin.createdAt)}>{coin.ours || coin.oursPending ? "launched" : "created"} {age(coin.createdAt)} ago</span>}
            <span className="links">
              <Ext href={pumpUrl(coin.mint)}>pump.fun ↗</Ext>
              <Ext href={solscanAccount(coin.mint)}>solscan ↗</Ext>
              {coin.twitter && <Ext href={coin.twitter}>X ↗</Ext>}
              {coin.telegram && <Ext href={coin.telegram}>Telegram ↗</Ext>}
              {coin.website && <Ext href={coin.website}>Website ↗</Ext>}
            </span>
          </div>
          {coin.description && <p className="coin-desc">{coin.description}</p>}
        </div>
        <LaunchButton coin={coin} maxDepth={stats?.maxDepth} size="lg" className="coin-cta" label={`Launch a coin under ${sym(coin)}`} />
      </header>

      <StatStrip className="coin-stats">
        <Stat label="price" value={priceMain} delta={delta?.ratio} deltaLabel={delta?.label} deltaTitle={delta?.label === "24h" ? "Change over the last 24 hours (hourly candles)" : `Change since the first trade the indexer saw, ${delta?.label} ago`}
          sub={coin.priceSol != null && coin.priceUsd != null ? `${sol(coin.priceSol)}${coin.quoteMint ? ` · ${price(coin.priceQuote, coin.quoteSymbol)}` : ""}` : coin.priceSol != null ? sol(coin.priceSol) : `quoted in ${coin.quoteSymbol}`} />
        <Stat label="market cap" value={coin.mcapUsd != null ? usd(coin.mcapUsd) : sol(coin.mcapSol)} sub={coin.mcapUsd != null && coin.mcapSol != null ? sol(coin.mcapSol) : undefined} />
        <Stat label="locked by children" value={coin.lockedUsd != null ? usd(coin.lockedUsd) : amount(lockedQuote, sym(coin))} hero sub={`${amount(lockedQuote, sym(coin))} across ${count(coin.children)} child${coin.children === 1 ? "" : "ren"}`} />
        <Stat label="24h volume" value={usd(coin.volume24hUsd)} sub={`${count(coin.trades24h)} trades${extras.holders != null ? ` · ${count(extras.holders)} holders` : ""}`} />
        <Stat label={coin.migrated ? "curve" : "curve progress"} value={coin.migrated ? "migrated" : pct(coin.progress)} sub={<ProgressBar value={coin.progress} />} />
      </StatStrip>

      <div className="coin-grid">
        <div className="coin-main">
          <PriceChart coin={coin} />
          <section className="card tree-card">
            <div className="section-head"><h2>Family tree</h2><span className="muted">{count(coin.descendants)} descendant{coin.descendants === 1 ? "" : "s"} · {coin.ancestors.length} ancestor{coin.ancestors.length === 1 ? "" : "s"} · <Link to={`/map?focus=${coin.mint}`} className="more">whole ecosystem →</Link></span></div>
            <CoinBubbleMap mint={coin.mint} height={520} />
          </section>
          <section>
            <div className="section-head"><h2>Children</h2><span className="muted">{count(coin.children)} direct · sorted by locked value{otherChildren > 0 && <> · <Ext href={pumpUrl(coin.mint)} className="muted" title="Children on pump.fun that were not launched on Spore">{count(otherChildren)} other {otherChildren === 1 ? "child" : "children"} on pump.fun ↗</Ext></>}</span></div>
            {children.length === 0
              ? <Empty title={otherChildren > 0 ? `No Spore launches under ${sym(coin)} yet` : `Nothing grows under ${sym(coin)} yet`} hint={otherChildren > 0 ? `${count(otherChildren)} other ${otherChildren === 1 ? "child exists" : "children exist"} on pump.fun, launched elsewhere. Launch the first one here: its curve will buy and lock this coin on every trade.` : launchBlock(coin, stats?.maxDepth) ?? "Launch the first child: its curve will buy and lock this coin on every trade."} action={<LaunchButton coin={coin} maxDepth={stats?.maxDepth} size="sm" label={`Launch a coin under ${sym(coin)}`} />} />
              : <div className="grid-cards">{children.map((c) => <CoinCard key={c.mint} coin={c} action={<LaunchButton coin={c} maxDepth={stats?.maxDepth} className="block" />} />)}</div>}
          </section>

          <section className="card tape">
            <div className="section-head">
              <h2>Trades</h2>
              <div className="tape-ctl">
                <span className="seg" role="tablist" aria-label="Filter trades">
                  {(["all", "buy", "sell"] as TapeFilter[]).map((f) => <button key={f} type="button" role="tab" aria-selected={tapeFilter === f} aria-pressed={tapeFilter === f} onClick={() => setTapeFilter(f)}>{f === "all" ? `all ${trades.length}` : f === "buy" ? `buys ${buys}` : `sells ${trades.length - buys}`}</button>)}
                </span>
                <span className="live live"><i />live</span>
              </div>
            </div>
            {trades.length === 0 ? <Empty title="No trades seen yet" hint="Trades stream in as they happen; the indexer only keeps what it has watched." />
              : shownTrades.length === 0 ? <Empty title={`No ${tapeFilter}s in the last ${trades.length} trades`} />
              : (
              <div className="tape-table" role="table">
                <div className="tape-row head" role="row"><span>time</span><span>side</span><span>{sym(coin)}</span><span>for</span><span>price</span><span>value</span><span className="who">trader</span></div>
                {shownTrades.map((t) => {
                  const value = (t as Trade & { valueUsd?: number }).valueUsd ?? (t.priceUsd != null ? t.priceUsd * tokens(t.baseAmount, coin.decimals) : null);
                  const isFresh = fresh.current.has(t.sig);
                  return (
                    <div key={t.sig} className={`tape-row ${t.isBuy ? "buy" : "sell"} ${isFresh ? "fresh" : ""}`} role="row">
                      <a className="mono muted t" href={solscanTx(t.sig)} target="_blank" rel="noreferrer" title={`${when(t.time)} · ${clock(t.time)} · open transaction`}>{age(t.time)}<small>{now - t.time < 60 ? "" : clock(t.time).slice(0, 5)}</small></a>
                      <span className={`chip ${t.isBuy ? "good" : "bad"}`}>{t.isBuy ? "buy" : "sell"}</span>
                      <span className="mono amt">{amount(tokens(t.baseAmount, coin.decimals))}</span>
                      <span className="mono muted">{amount(tokens(t.quoteAmount, quoteDecimals), coin.quoteSymbol)}</span>
                      <span className="mono">{t.priceUsd != null ? usd(t.priceUsd) : price(t.priceQuote, coin.quoteSymbol)}</span>
                      <span className="mono val">{value != null ? usd(value) : "—"}</span>
                      <a className="mono muted who" href={solscanAccount(t.user)} target="_blank" rel="noreferrer" title={`${t.user} · open wallet`}>{short(t.user, 4)}</a>
                    </div>
                  );
                })}
              </div>
            )}
            {trades.length >= MAX_TRADES && <p className="tape-foot muted">Showing the last {MAX_TRADES} trades the indexer kept. Older ones: <Ext href={solscanAccount(coin.mint)}>full history on solscan ↗</Ext></p>}
          </section>
        </div>

        <aside className="coin-side">
          {!narrow && <TradeWidget coin={coin} solUsd={solUsd} />}
          <section className="card pad spawn-cta">
            <span className="eyebrow">Grow the tree</span>
            <h3>Launch a coin under {sym(coin)}</h3>
            <p className="muted">Your coin's curve collects {sym(coin)} instead of SOL. Every buy routes SOL → {coin.ancestors.length ? `${[...coin.ancestors].reverse().map((a) => sym(a)).join(" → ")} → ` : ""}{sym(coin)} → your coin, and {launchBlock(coin, stats?.maxDepth) ? `${launchBlock(coin, stats?.maxDepth)}.` : `your creator fees are split 50/50 with Spore, paid in ${sym(coin)}.`}</p>
            <LaunchButton coin={coin} maxDepth={stats?.maxDepth} label={`Launch a coin under ${sym(coin)}`} />
          </section>
          {/* Pending creator fees + permissionless claim (§11.6); the card explains itself when there is no split to claim through. */}
          <ClaimFees coin={coin} />
          {coin.shares && coin.shares.length > 0 ? (
            <section className="card pad">
              <SplitPreview title="Fee shares" shares={coin.shares} you={null} creator={coin.creator} parentCreator={null} grandparentCreator={null} platform="" />
            </section>
          ) : coin.depth > 0 ? <FeeSplitAction coin={coin} onDone={page.reload} /> : null}
          <section className="card pad details">
            <span className="eyebrow">Details</span>
            <dl className="kv">
              <dt>Quote</dt><dd>{coin.parent ? <Link to={`/c/${coin.parent.mint}`}>{sym(coin.parent)}</Link> : coin.quoteSymbol}{coin.quoteMint && <> · <Addr a={coin.quoteMint} /></>}</dd>
              <dt>Root</dt><dd>{coin.root ? <Link to={`/c/${coin.root.mint}`}>{sym(coin.root)}</Link> : coin.depth === 0 ? "this coin" : "—"}</dd>
              <dt>Creator</dt><dd className="addr-row"><Addr a={coin.creator} n={6} /><CopyBtn onClick={() => copy(coin.creator, "Creator address")} label="Copy creator address" /></dd>
              <dt>Mint</dt><dd className="addr-row"><Addr a={coin.mint} n={6} /><CopyBtn onClick={() => copy(coin.mint, "Mint address")} label="Copy mint address" /></dd>
              <dt>Token program</dt><dd className="mono">{coin.tokenProgram.startsWith("Tokenz") ? "Token-2022" : "SPL Token"}</dd>
              <dt>Supply</dt><dd className="mono">{amount(tokens(coin.totalSupply, coin.decimals))}</dd>
              {extras.holders != null && <><dt>Holders</dt><dd className="mono">{count(extras.holders)}</dd></>}
              <dt>Creator fee</dt><dd className="mono">{coin.creatorFeeBps ? `${coin.creatorFeeBps} bps` : "pump schedule"}</dd>
              {coin.pool && <><dt>Pool</dt><dd><a className="mono" href={solscanAccount(coin.pool)} target="_blank" rel="noreferrer">{short(coin.pool, 6)}</a></dd></>}
              <dt>Created</dt><dd>{when(coin.createdAt)}{coin.createdSlot ? <span className="muted"> · slot {coin.createdSlot.toLocaleString("en-US")}</span> : null}</dd>
              <dt>Updated</dt><dd>{age(coin.updatedAt)} ago</dd>
            </dl>
          </section>
        </aside>
      </div>

      {narrow && (
        <>
          <div className="trade-bar" role="region" aria-label="Trade">
            <div className="trade-bar-price">
              <b className="mono">{priceMain}</b>
              <span className="muted">{delta ? <Delta ratio={delta.ratio} label={delta.label} /> : sym(coin)}</span>
            </div>
            <button type="button" className="btn accent" onClick={() => setSheet("buy")}>Buy</button>
            <button type="button" className="btn violet" onClick={() => setSheet("sell")}>Sell</button>
          </div>
          {sheet && (
            <div className="trade-sheet-backdrop" onClick={() => setSheet(null)}>
              <div className="trade-sheet" onClick={(e) => e.stopPropagation()}>
                <TradeWidget coin={coin} solUsd={solUsd} initialSide={sheet} sheet onClose={() => setSheet(null)} />
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

const CopyBtn = ({ onClick, label }: { onClick: () => void; label: string }) => (
  <button type="button" className="copy" onClick={onClick} aria-label={label} title={label}>
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2.5" /><path d="M5 15V6.5A1.5 1.5 0 0 1 6.5 5H15" /></svg>
  </button>
);

function CoinSkeleton() {
  return (
    <div className="coin-page" aria-busy="true">
      <header className="coin-head"><Skeleton w={72} h={72} r={20} /><div className="coin-head-text stack-2"><Skeleton w="40%" h={30} /><Skeleton w="60%" h={14} /><Skeleton w="50%" h={12} /></div></header>
      <div className="stats">{[0, 1, 2, 3, 4].map((i) => <div className="stat" key={i}><Skeleton w="50%" h={11} /><Skeleton w="70%" h={24} /></div>)}</div>
      <div className="coin-grid"><div className="coin-main"><Skeleton h={340} r={14} /><Skeleton h={420} r={14} /><div className="grid-cards">{[0, 1, 2].map((i) => <SkeletonCard key={i} />)}</div></div><aside className="coin-side"><Skeleton h={360} r={14} /><Skeleton h={160} r={14} /></aside></div>
    </div>
  );
}
