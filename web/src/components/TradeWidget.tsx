import { useCallback, useEffect, useMemo, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { api, pumpUrl, solscanTx, type Coin } from "../lib/api";
import { routeLabels } from "../lib/chain";
import { QUOTE_PROBE, runSwap, withSlippage } from "../lib/flow";
import { isSolRooted, quoteSwap, type Chain, type Side } from "../lib/pump";
import { CU_PRICE_MICRO } from "../lib/pump/trade";
import { useAsync, useDebounced, useLocalPref, useNow } from "../lib/hooks";
import { friendlyError, type Step } from "../lib/steps";
import { amount, exactAmount, feeSol, lamportsToSol, parseAmount, pct, signedPct, sol, tokens, usd } from "../lib/format";
import { ErrorBox, Ext, Logo, Skeleton, sym } from "./Bits";
import Steps from "./Steps";
import { useToast } from "./Toast";
import "./coin.css";

const SLIPPAGES = [50, 100, 300, 500];
const QUICK_SOL = ["0.1", "0.25", "0.5", "1"];
const QUICK_PCT = [25, 50, 75, 100];
/// A quote is re-simulated after this many seconds: pump curves move on every trade and a stale
/// preview is the usual cause of a slippage failure.
const REQUOTE_S = 20;
const STALE_S = 10;
/// Solana's base signature fee and the rent of an associated token account (165 bytes) in
/// lamports; both are protocol constants, shown so the fee line adds up.
const BASE_FEE = 5_000n;
const ATA_RENT = 2_039_280n;
/// Lamports kept back on a buy: the WSOL scratch account's rent is refunded in the same
/// transaction but has to be there at the start.
const HEADROOM = 2_100_000n;

type Route = { chain: Chain; coins: Coin[]; pending: Coin | null };

/// The chain of this coin plus the full record of every ancestor in one pass, so the widget can
/// say *which* coin is awaiting migration instead of waiting for the program's 6107. Same link
/// shape as lib/chain's chainFor (self first, SOL root last); done here to avoid fetching every
/// ancestor twice.
async function loadRoute(coin: Coin): Promise<Route> {
  const ancestors = await Promise.all(coin.ancestors.map((a) => api.coin(a.mint).then((r) => r.coin)));
  const coins = [coin, ...ancestors];
  const chain: Chain = coins.map((c, i) => ({ mint: c.mint, quoteMint: c.quoteMint, tokenProgram: c.tokenProgram, quoteTokenProgram: coins[i + 1]?.tokenProgram ?? TOKEN_PROGRAM_ID.toBase58(), migrated: c.migrated, depth: c.depth }));
  return { chain, coins, pending: coins.find((c) => c.complete && !c.migrated) ?? null };
}

type QuoteState = { amountOut: bigint; units: number; at: number; amountIn: bigint; side: Side };

export type TradeWidgetProps = { coin: Coin; solUsd: number | null; initialSide?: Side; sheet?: boolean; onClose?: () => void };

/// Buy from SOL / sell to SOL through every hop of the chain in one multi_hop_swap. Quotes come
/// from a simulation (no local curve math), so the preview is what the program does; the widget
/// adds what a terminal needs around it: balances, impact against spot, slippage, fees, the
/// reason a trade is blocked, and a confirm step before the wallet opens.
export default function TradeWidget({ coin, solUsd, initialSide = "buy", sheet = false, onClose }: TradeWidgetProps) {
  const { connection } = useConnection();
  const wallet = useWallet();
  const toast = useToast();
  const user = wallet.publicKey;
  const userKey = user?.toBase58() ?? null;
  const route = useAsync(() => loadRoute(coin), [coin.mint]);
  const chain = route.data?.chain ?? null;
  const tradable = chain ? isSolRooted(chain) : null;
  const pending = route.data?.pending ?? null;
  const [side, setSide] = useState<Side>(initialSide);
  const [input, setInput] = useState("");
  const [slippage, setSlippage] = useLocalPref<number>("slippage", 100);
  const [customOpen, setCustomOpen] = useState(() => !SLIPPAGES.includes(slippage));
  const [steps, setSteps] = useState<Step[]>([]);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [bal, setBal] = useState<{ sol: bigint | null; token: bigint | null; hasAta: boolean }>({ sol: null, token: null, hasAta: false });
  const [nonce, setNonce] = useState(0);
  const now = useNow(1_000);
  const dInput = useDebounced(input.trim(), 350);
  const decimalsIn = side === "buy" ? 9 : coin.decimals;
  const amountIn = useMemo(() => parseAmount(dInput, decimalsIn), [dInput, decimalsIn]);
  const refs = useMemo(() => new Map<string, Coin | Coin["ancestors"][number]>([[coin.mint, coin], ...coin.ancestors.map((a) => [a.mint, a] as const)]), [coin]);

  const refreshBalances = useCallback(async () => {
    if (!user) { setBal({ sol: null, token: null, hasAta: false }); return; }
    const ata = getAssociatedTokenAddressSync(new PublicKey(coin.mint), user, false, new PublicKey(coin.tokenProgram));
    const [s, t] = await Promise.all([
      connection.getBalance(user, "confirmed").then((n) => BigInt(n)).catch(() => null),
      // A missing account is the normal "never held it" case, not an error.
      connection.getTokenAccountBalance(ata, "confirmed").then((r) => ({ amount: BigInt(r.value.amount), has: true })).catch(() => ({ amount: 0n, has: false })),
    ]);
    setBal({ sol: s, token: t.amount, hasAta: t.has });
  }, [connection, user, coin.mint, coin.tokenProgram]);
  useEffect(() => { refreshBalances(); const t = setInterval(refreshBalances, 20_000); return () => clearInterval(t); }, [refreshBalances]);

  const [quote, setQuote] = useState<QuoteState | null>(null);
  const [quoteErr, setQuoteErr] = useState<string | null>(null);
  const [quoting, setQuoting] = useState(false);
  useEffect(() => {
    setQuoteErr(null);
    if (!chain || !tradable || !amountIn || pending) { setQuote(null); return; }
    if (side === "sell" && !user) { setQuote(null); setQuoteErr("Connect a wallet to quote a sell"); return; }
    let alive = true;
    setQuoting(true);
    // Before a wallet connects, buys are simulated from a public probe key so the preview works.
    quoteSwap(connection, user ?? QUOTE_PROBE, chain, side, amountIn)
      .then((q) => { if (alive) { setQuote({ amountOut: q.amountOut, units: q.unitsConsumed, at: Date.now(), amountIn, side }); setQuoteErr(null); } })
      .catch((e) => { if (alive) { setQuote(null); setQuoteErr(friendlyError(e)); } })
      .finally(() => { if (alive) setQuoting(false); });
    return () => { alive = false; };
  }, [chain, tradable, pending, amountIn, side, userKey, connection, user, nonce]);

  // Re-simulate a standing quote on a timer, but never under the user's hands (a confirm sheet
  // open, a transaction in flight) and never in a background tab.
  const quoteAge = quote ? Math.max(0, Math.floor((now * 1000 - quote.at) / 1000)) : 0;
  const requote = useCallback(() => setNonce((n) => n + 1), []);
  useEffect(() => {
    if (!quote || quoting || busy || confirm || document.hidden) return;
    if (quoteAge >= REQUOTE_S) requote();
  }, [quote, quoteAge, quoting, busy, confirm, requote]);

  async function go() {
    if (!chain || !amountIn || !quote) return;
    setConfirm(false); setBusy(true); setSteps([]);
    try {
      const { sig } = await runSwap(connection, wallet, chain, side, amountIn, quote.amountOut, slippage, setSteps);
      toast.success(side === "buy" ? `Bought ${sym(coin)}` : `Sold ${sym(coin)}`, { href: solscanTx(sig), label: "view transaction" });
      setInput(""); setQuote(null); setSteps([]);
      refreshBalances();
      onClose?.();
    } catch (e) { toast.error(friendlyError(e)); }
    finally { setBusy(false); }
  }

  const switchSide = (s: Side) => { if (s === side) return; setSide(s); setInput(""); setQuote(null); setQuoteErr(null); setSteps([]); };
  const setPct = (p: number) => { if (bal.token == null) return; setInput(p === 100 ? exactAmount(bal.token, coin.decimals) : exactAmount((bal.token * BigInt(p)) / 100n, coin.decimals)); };
  const setSlip = (bps: number) => setSlippage(Math.min(5_000, Math.max(1, Math.round(bps))));

  // --- derived figures for the preview ---
  const hops = chain?.length ?? 0;
  // Same CU sizing as buildSwapTx; the unused part of the limit is never charged, but the
  // priority fee is paid on the limit, so this is the real worst case.
  const units = Math.min(1_400_000, 150_000 + 80_000 * hops);
  const networkFee = BASE_FEE + BigInt(Math.ceil((units * CU_PRICE_MICRO) / 1_000_000));
  const ataRent = side === "buy" && user && !bal.hasAta ? ATA_RENT : 0n;
  // What a buy must leave in the wallet besides the amount itself.
  const reserve = networkFee + ataRent + HEADROOM;
  const need = side === "buy" && amountIn ? amountIn + reserve : null;
  const insufficient = amountIn != null && user != null && (side === "buy" ? bal.sol != null && need != null && need > bal.sol : bal.token != null && amountIn > bal.token);
  const outTokens = quote ? tokens(quote.amountOut, coin.decimals) : null;
  const outSol = quote ? lamportsToSol(quote.amountOut) : null;
  const outLabel = quote ? (side === "buy" ? amount(outTokens, sym(coin)) : sol(outSol)) : null;
  const outUsd = quote ? (side === "buy" ? (coin.priceUsd != null ? usd(outTokens! * coin.priceUsd) : null) : (solUsd ? usd(outSol! * solUsd) : null)) : null;
  const minOut = quote ? withSlippage(quote.amountOut, slippage) : null;
  const minLabel = minOut != null ? (side === "buy" ? amount(tokens(minOut, coin.decimals), sym(coin)) : sol(lamportsToSol(minOut))) : null;
  const inSol = amountIn && side === "buy" ? Number(amountIn) / 1e9 : null;
  const inTok = amountIn && side === "sell" ? tokens(amountIn, coin.decimals) : null;
  const inUsd = inSol != null && solUsd ? usd(inSol * solUsd) : inTok != null && coin.priceUsd != null ? usd(inTok * coin.priceUsd) : null;
  // Impact = how far the simulated fill lands from the spot price the page shows. It includes
  // pump's protocol and creator fees (they come out of the same route), which is what the user
  // actually loses versus spot.
  const spot = coin.priceSol;
  const impact = quote && spot && spot > 0 && (inSol != null || inTok != null)
    ? (side === "buy" ? 1 - outTokens! / (inSol! / spot) : 1 - outSol! / (inTok! * spot))
    : null;
  const impactTone = impact == null ? "" : impact > 0.15 ? "bad" : impact > 0.05 ? "warn" : "";
  const effPrice = quote && inSol != null && outTokens ? inSol / outTokens : quote && inTok && outSol != null ? outSol / inTok : null;
  const stale = quote && quoteAge >= STALE_S;
  const tokenBal = bal.token != null ? tokens(bal.token, coin.decimals) : null;
  const solBal = bal.sol != null ? lamportsToSol(bal.sol) : null;

  // The one reason the primary button is off, in the user's words.
  const blocker: string | null = !chain ? null
    : tradable === false ? "Not tradable from SOL here"
    : pending ? `Awaiting ${sym(pending)} migration`
    : !wallet.connected ? null
    : insufficient ? (side === "buy" ? "Not enough SOL" : `Not enough ${sym(coin)}`)
    : side === "sell" && bal.token === 0n ? `No ${sym(coin)} in this wallet`
    : null;
  const canTrade = !!quote && !!amountIn && !blocker && !quoting && !busy && quote.amountIn === amountIn && quote.side === side;

  return (
    <section className={`card trade ${sheet ? "in-sheet" : ""} ${side}`} aria-label={`Trade ${sym(coin)}`}>
      {sheet && (
        <div className="trade-sheet-head">
          <Logo src={coin.image} label={coin.symbol} size={28} />
          <div><b>{side === "buy" ? "Buy" : "Sell"} {sym(coin)}</b><span className="muted mono">{coin.priceUsd != null ? usd(coin.priceUsd) : sol(coin.priceSol)}</span></div>
          <button type="button" className="sheet-close" aria-label="Close" onClick={onClose}>×</button>
        </div>
      )}
      <div className="trade-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={side === "buy"} className={side === "buy" ? "on buy" : ""} onClick={() => switchSide("buy")}>Buy</button>
        <button type="button" role="tab" aria-selected={side === "sell"} className={side === "sell" ? "on sell" : ""} onClick={() => switchSide("sell")}>Sell</button>
      </div>

      {route.loading && <div className="stack-2"><Skeleton h={52} r={12} /><Skeleton h={28} r={999} /><Skeleton h={120} r={12} /><Skeleton h={48} r={999} /></div>}
      {route.error && !route.data && <ErrorBox error={route.error} retry={route.reload} compact />}
      {route.data && tradable === false && (
        <div className="notice warn trade-block">
          <span><b>Not tradable from SOL here.</b> This chain bottoms out in a listed mint other than SOL (USDC or a tokenized stock), so <code>multi_hop_swap</code> cannot start from a SOL wallet. <Ext href={pumpUrl(coin.mint)}>Trade on pump.fun ↗</Ext></span>
        </div>
      )}
      {route.data && tradable && pending && (
        <div className="notice warn trade-block">
          <span><b>{sym(pending)} is awaiting migration.</b> {pending.mint === coin.mint ? "This coin" : "A coin on this chain"} filled its curve and is moving to a PumpSwap pool; pump blocks trades through it until the migration lands (usually minutes). The quote resumes by itself.</span>
          <button type="button" className="btn sm ghost" onClick={route.reload}>Check again</button>
        </div>
      )}

      {route.data && tradable && (
        <>
          <label className="field trade-field">
            <span className="field-row">
              <span>{side === "buy" ? "You pay" : "You sell"}</span>
              {user && (
                <button type="button" className="bal" title="Use the whole balance" onClick={() => side === "buy" ? (bal.sol != null && setInput(exactAmount(bal.sol > reserve ? bal.sol - reserve : 0n, 9))) : setPct(100)}>
                  <i aria-hidden="true" /> {side === "buy" ? (solBal != null ? sol(solBal) : "…") : (tokenBal != null ? amount(tokenBal, sym(coin)) : "…")}
                  {side === "sell" && tokenBal != null && coin.priceUsd != null && tokenBal > 0 && <em>≈ {usd(tokenBal * coin.priceUsd)}</em>}
                </button>
              )}
            </span>
            <div className="amount">
              <input className="input mono" inputMode="decimal" autoComplete="off" placeholder="0.0" value={input} disabled={busy || !!pending} onChange={(e) => setInput(e.target.value.replace(/[^\d.,]/g, ""))} />
              <em>{side === "buy" ? "SOL" : sym(coin)}</em>
              {inUsd && <small className="amount-usd mono">{inUsd}</small>}
            </div>
          </label>
          <div className="quick">
            {side === "buy"
              ? QUICK_SOL.map((q) => <button key={q} type="button" aria-pressed={input === q} onClick={() => setInput(q)}>{q} SOL</button>)
              : QUICK_PCT.map((p) => <button key={p} type="button" disabled={!user || bal.token == null || bal.token === 0n} onClick={() => setPct(p)}>{p === 100 ? "MAX" : `${p}%`}</button>)}
          </div>

          <div className="slip">
            <span className="muted">Slippage</span>
            <span className="seg">
              {SLIPPAGES.map((s) => <button key={s} type="button" aria-pressed={!customOpen && slippage === s} onClick={() => { setCustomOpen(false); setSlip(s); }}>{s / 100}%</button>)}
              <button type="button" aria-pressed={customOpen} onClick={() => setCustomOpen(true)}>custom</button>
            </span>
            {customOpen && <span className="slip-custom"><input className="input mono" inputMode="decimal" aria-label="Custom slippage percent" value={(slippage / 100).toString()} onChange={(e) => { const v = Number(e.target.value.replace(/[^\d.]/g, "")); if (Number.isFinite(v) && v > 0) setSlip(v * 100); }} /><em>%</em></span>}
          </div>
          {slippage >= 1000 && <div className="notice warn compact">High slippage: a fill up to {slippage / 100}% below the quote is accepted.</div>}

          <div className={`quote ${stale ? "stale" : ""}`} aria-live="polite">
            {!amountIn ? <div className="quote-empty muted">Enter an amount: the route is simulated on-chain and the preview is exactly what the program would do.</div>
              : quoting && !quote ? <div className="quote-empty muted"><i className="spin" aria-hidden="true" /> Simulating {hops} hop{hops === 1 ? "" : "s"}…</div>
              : quoteErr ? <div className={`quote-err ${/^Connect a wallet/.test(quoteErr) ? "muted" : "bad"}`}>{quoteErr}</div>
              : quote ? (
                <>
                  <div className="quote-main">
                    <span>You receive <small className="muted">(estimated)</small></span>
                    <b className={side === "buy" ? "accent" : "violet"}>{outLabel}</b>
                    {outUsd && <small className="quote-usd mono muted">≈ {outUsd}</small>}
                  </div>
                  <div><span>Min. received <small className="muted">after {slippage / 100}%</small></span><b>{minLabel}</b></div>
                  {impact != null && <div><span>Price impact <small className="muted">vs spot, fees included</small></span><b className={impactTone} title={`Spot ${sol(spot)} per ${sym(coin)}; simulated fill ${effPrice != null ? sol(effPrice) : "—"}`}>{impact <= 0 ? signedPct(-impact) : `−${pct(impact)}`}</b></div>}
                  <div><span>Route</span><b className="route" title={`${hops} hop${hops === 1 ? "" : "s"}: ${chain!.map((l) => (l.migrated ? "pool" : "curve")).join(", ")}`}>{routeLabels(chain!, refs, side).map((s, i) => <span key={i}>{i > 0 && <i aria-hidden="true">→</i>}{s}</span>)}</b></div>
                  <div><span>Network fee</span><b title={`${units.toLocaleString("en-US")} CU limit × ${CU_PRICE_MICRO / 1e6} lamports + 5 000 base`}>{feeSol(networkFee)}{ataRent > 0n && <small className="muted"> + {feeSol(ataRent)} account rent</small>}</b></div>
                  <div><span>pump fees</span><b className="muted" title={`Charged inside the route (protocol fee on the SOL hop, creator fee on ${sym(coin)}), so they are already inside the figures above`}>inside the quote</b></div>
                  <div className="quote-age">
                    <span className={stale ? "warn" : "muted"}>{quoting ? "refreshing…" : stale ? `quoted ${quoteAge}s ago` : `quoted ${quoteAge}s ago`}</span>
                    <button type="button" className="linkish" disabled={quoting} onClick={requote}>↻ refresh</button>
                  </div>
                </>
              ) : null}
          </div>

          {steps.length > 0 && <Steps steps={steps} />}
          {!wallet.connected
            ? <WalletMultiButton>{side === "buy" ? `Connect wallet to buy ${sym(coin)}` : `Connect wallet to sell ${sym(coin)}`}</WalletMultiButton>
            : <button type="button" className={`btn lg block ${side === "buy" ? "accent" : "violet"}`} disabled={!canTrade} onClick={() => setConfirm(true)}>
                {busy ? "Working…" : blocker ?? (!amountIn ? (side === "buy" ? "Enter an amount of SOL" : `Enter an amount of ${sym(coin)}`) : quoting ? "Quoting…" : side === "buy" ? `Buy ${sym(coin)}` : `Sell ${sym(coin)}`)}
              </button>}
          {insufficient && side === "buy" && need != null && <p className="hint">You need about {sol(lamportsToSol(need))} for this buy: the amount plus the network fee{ataRent > 0n ? ", the token account rent" : ""} and a {sol(lamportsToSol(HEADROOM))} buffer for the wrapped-SOL scratch account (refunded).</p>}
          {!sheet && <p className="hint">Built in your browser, signed by your wallet, nothing custodial. {coin.priceSol == null && "Spot price unavailable, so no impact figure."}</p>}
        </>
      )}

      {confirm && quote && amountIn && chain && (
        <div className="confirm-backdrop" onClick={() => setConfirm(false)}>
          <div className="confirm" role="dialog" aria-modal="true" aria-label={`Confirm ${side}`} onClick={(e) => e.stopPropagation()}>
            <div className="confirm-head"><Logo src={coin.image} label={coin.symbol} size={32} /><b>Confirm {side} · {sym(coin)}</b><button type="button" className="sheet-close" aria-label="Cancel" onClick={() => setConfirm(false)}>×</button></div>
            <div className="confirm-rows">
              <div><span>{side === "buy" ? "You pay" : "You sell"}</span><b>{side === "buy" ? sol(inSol) : amount(inTok, sym(coin))}{inUsd && <small> ≈ {inUsd}</small>}</b></div>
              <div><span>You receive ≈</span><b className={side === "buy" ? "accent" : "violet"}>{outLabel}{outUsd && <small> ≈ {outUsd}</small>}</b></div>
              <div><span>Minimum ({slippage / 100}% slippage)</span><b>{minLabel}</b></div>
              {impact != null && <div><span>Price impact</span><b className={impactTone}>{impact <= 0 ? signedPct(-impact) : `−${pct(impact)}`}</b></div>}
              <div><span>Route</span><b className="route">{routeLabels(chain, refs, side).join(" → ")}</b></div>
              <div><span>Network fee</span><b>{feeSol(networkFee + ataRent)}</b></div>
              <div><span>Quote age</span><b className={stale ? "warn" : ""}>{quoteAge}s{stale ? " · consider refreshing" : ""}</b></div>
            </div>
            <p className="hint">The transaction fails on-chain (nothing charged beyond the network fee) if the fill falls below the minimum. Your wallet shows the final simulation before you sign.</p>
            <div className="confirm-actions">
              <button type="button" className="btn ghost" onClick={() => { setConfirm(false); requote(); }}>Refresh quote</button>
              <button type="button" className={`btn ${side === "buy" ? "accent" : "violet"}`} onClick={go}>{side === "buy" ? `Buy ${sym(coin)}` : `Sell ${sym(coin)}`}</button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

