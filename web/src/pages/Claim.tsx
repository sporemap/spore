// The Claim page (DESIGN §11.7): connect a wallet, see every coin whose fee-sharing config names it
// with what is waiting and its part, and pay out one coin or all of them. Below, the Spore launches
// with the most fees waiting: a payout is permissionless, so anyone may trigger one (the signer pays
// the network fee, the program pays the shareholders). Numbers come from /api/claims; transactions
// are built and simulated in the browser and signed by the wallet.
import { useCallback, useEffect, useMemo, useRef } from "react";
import { Link } from "react-router-dom";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { api, type ClaimCoin } from "../lib/api";
import { useAsync } from "../lib/hooks";
import { amount, bps, tokens, usd } from "../lib/format";
import { DepthBadge, ErrorBox, Logo, SkeletonRows, nameOf, sym } from "../components/Bits";
import SporeCanvas from "../components/SporeCanvas";
import { useClaimFlow, type ClaimTarget } from "../components/claim/useClaimFlow";

const POLL_MS = 30_000;
const CACHE_MS = 16_000; // the API caches each coin for 15 s; refetch after a claim once it has turned over
const target = (c: ClaimCoin): ClaimTarget => ({ mint: c.mint, symbol: c.symbol, image: c.image, quoteSymbol: c.quoteSymbol, quoteDecimals: c.quoteDecimals, total: c.total, perShare: c.perShare });
const fmt = (c: { quoteDecimals: number; quoteSymbol: string }, raw: string) => amount(tokens(raw, c.quoteDecimals), c.quoteSymbol);

export default function Claim() {
  useEffect(() => { document.title = "Claim fees · Spore"; return () => { document.title = "Spore"; }; }, []);
  const pub = useAsync(() => api.claims(50), []);
  // Latest reloaders, read when a claim lands (the flow hook is created before the wallet-keyed fetch).
  const reloadRef = useRef<{ mine: () => void; pub: () => void }>({ mine: () => {}, pub: () => {} });
  reloadRef.current.pub = pub.reload;
  const onClaimed = useCallback(() => { const r = () => { reloadRef.current.mine(); reloadRef.current.pub(); }; r(); setTimeout(r, CACHE_MS); }, []);
  const flow = useClaimFlow(onClaimed);
  const mine = useAsync(() => (flow.me ? api.claimsFor(flow.me) : Promise.resolve(null)), [flow.me]);
  reloadRef.current.mine = mine.reload;
  useEffect(() => {
    const t = setInterval(() => { if (!document.hidden && !flow.busy) { mine.reload(); pub.reload(); } }, POLL_MS);
    return () => clearInterval(t);
  }, [mine.reload, pub.reload, flow.busy]);

  const rows = mine.data?.coins ?? [];
  const claimable = useMemo(() => rows.filter((c) => c.claimable), [rows]);
  const totals = mine.data?.totals;

  return (
    <>
      <SporeCanvas density={0.4} />
      <div className="container claim-page">
        <div className="page-head">
          <span className="eyebrow">Claim</span>
          <h1>Claim your <em>creator fees</em>.</h1>
          <p className="lead">Every coin launched on Spore splits its creator fee on-chain: <b>you 50%, Spore 50%</b>, paid in the coin's quote on every trade. Connect the wallet that launched a coin to see what is waiting and pay it out in one signature. Spore's half buys $SPORE and locks it.</p>
        </div>

        <section className="card pad claim-card" aria-busy={mine.loading}>
          <div className="claim-head">
            <div>
              <span className="eyebrow">Your coins</span>
              {flow.me && <p className="muted claim-sub">{flow.dry ? "dry run as " : ""}{flow.me.slice(0, 4)}…{flow.me.slice(-4)}</p>}
            </div>
            {totals && rows.length > 0 && (
              <div className="claim-totals">
                <div><em>your part</em><b className="accent">{usd(totals.usd)}</b></div>
                <div className="claim-quotes">{totals.byQuote.filter((q) => BigInt(q.amount) > 0n).map((q) => <span key={q.quoteMint ?? "SOL"} className="mono">{amount(tokens(q.amount, q.quoteDecimals), q.quoteSymbol)}</span>)}</div>
                <button type="button" className="btn accent" disabled={flow.busy || claimable.length === 0} onClick={() => flow.claimAll(claimable.map(target))}>
                  {flow.bulk ? `Claiming ${flow.bulk.i + 1} of ${flow.bulk.n}…` : `Claim all (${claimable.length})`}
                </button>
              </div>
            )}
          </div>

          {!flow.me ? (
            <div className="claim-connect">
              <p className="muted">Connect the wallet you launched with. Every coin whose fee split names it shows up here, across Spore.</p>
              <WalletMultiButton>Connect wallet</WalletMultiButton>
            </div>
          ) : mine.loading && !mine.data ? <SkeletonRows n={4} h={56} />
            : mine.error && !mine.data ? <ErrorBox error={mine.error} retry={mine.reload} />
            : rows.length === 0 ? (
              <div className="claim-empty">
                <b>No fees waiting for this wallet yet.</b>
                <p className="muted">Launch a coin on Spore and every trade of it pays this wallet half of its creator fee. <Link to="/launch">Launch a coin →</Link></p>
              </div>
            ) : (
              <ClaimTable rows={rows} mine flow={flow} />
            )}
        </section>

        <section className="card pad claim-card">
          <div className="claim-head">
            <div>
              <span className="eyebrow">Fees waiting across Spore</span>
              <p className="muted claim-sub">Anyone may trigger a payout: you pay the network fee, the program pays the shareholders.</p>
            </div>
            {pub.data && pub.data.coins.length > 0 && <div className="claim-totals"><div><em>waiting</em><b>{usd(pub.data.totals.usd)}</b></div></div>}
          </div>
          {pub.loading && !pub.data ? <SkeletonRows n={4} h={56} />
            : pub.error && !pub.data ? <ErrorBox error={pub.error} retry={pub.reload} />
            : !pub.data?.coins.length ? <p className="muted">Nothing waiting right now.</p>
            : <ClaimTable rows={pub.data.coins} flow={flow} />}
        </section>
      </div>
      {flow.dialog}
    </>
  );
}

function ClaimTable({ rows, mine = false, flow }: { rows: ClaimCoin[]; mine?: boolean; flow: ReturnType<typeof useClaimFlow> }) {
  return (
    <div className="claim-table" role="table" aria-label={mine ? "Your coins with creator fees" : "Coins with fees waiting"}>
      <div className="claim-row claim-th" role="row">
        <span role="columnheader">Coin</span>
        {mine && <span role="columnheader">Your share</span>}
        <span role="columnheader">Pending</span>
        {mine && <span role="columnheader">Your part</span>}
        <span role="columnheader" aria-label="Action" />
      </div>
      {rows.map((c) => {
        const busyLabel = flow.labelFor(c.mint);
        const zero = BigInt(c.total) === 0n;
        return (
          <div key={c.mint} className={`claim-row ${zero ? "dim" : ""}`} role="row">
            <Link to={`/c/${c.mint}`} className="claim-coin" role="cell">
              <Logo src={c.image} label={c.symbol} size={34} />
              <span><b>{nameOf(c)}</b><small>{sym(c)}</small></span>
              <DepthBadge depth={c.depth} />
            </Link>
            {mine && <span role="cell" className="mono" data-label="Your share">{bps(c.yourBps ?? 0)}</span>}
            <span role="cell" data-label="Pending"><b className="mono">{fmt(c, c.total)}</b>{c.totalUsd != null && !zero && <small>{usd(c.totalUsd)}</small>}</span>
            {mine && <span role="cell" data-label="Your part"><b className={`mono ${zero ? "" : "accent"}`}>{fmt(c, c.yourAmount ?? "0")}</b>{c.yourUsd != null && !zero && <small>{usd(c.yourUsd)}</small>}</span>}
            <span role="cell" className="claim-act">
              {!flow.me ? <span className="muted claim-why">connect a wallet</span>
                : !c.claimable ? <span className="muted claim-why" title={c.reason ?? undefined}>{zero ? "nothing yet" : "below minimum"}</span>
                : <button type="button" className="btn accent sm" disabled={flow.busy} onClick={() => flow.start({ mint: c.mint, symbol: c.symbol, image: c.image, quoteSymbol: c.quoteSymbol, quoteDecimals: c.quoteDecimals, total: c.total, perShare: c.perShare })}>{busyLabel ?? "Claim"}</button>}
            </span>
          </div>
        );
      })}
    </div>
  );
}
