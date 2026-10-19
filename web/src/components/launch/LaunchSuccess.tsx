// After the launch: a share card that is the coin's identity (image, name, ticker, pool, Spore
// link), the one action the owner wants next (grow the tree under it), the explorer/pump links,
// a live "indexer" line that polls the coin until Spore lists it, and, when the fee split did not
// land, the single button that finishes it without a new mint or a re-upload.
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, pumpUrl, solscanTx, xShareUrl, type Coin } from "../../lib/api";
import type { SpawnResult } from "../../lib/flow";
import { friendlyError, type Step } from "../../lib/steps";
import { amount, tokens } from "../../lib/format";
import Steps from "../Steps";
import { Ext } from "../Bits";

type Props = { r: SpawnResult; maxDepth?: number; onFinishSplit: () => void; splitBusy: boolean; splitSteps: Step[]; splitError: string | null };

/// Polls /api/coin/:mint until the indexer lists it (the CreateEvent arrives over the live
/// subscription within seconds; the fee split verification follows). Stops after ~3 minutes.
function useIndexed(mint: string, enabled: boolean) {
  const [coin, setCoin] = useState<Coin | null>(null);
  const [tries, setTries] = useState(0);
  useEffect(() => {
    if (!enabled || coin) return;
    let alive = true;
    let n = 0;
    const tick = () => api.coin(mint).then((r) => { if (alive) setCoin(r.coin); }).catch(() => { if (alive) setTries(++n); });
    tick();
    const t = setInterval(() => { if (n >= 60) clearInterval(t); else tick(); }, 3000);
    return () => { alive = false; clearInterval(t); };
  }, [mint, enabled, coin]);
  return { coin, gaveUp: tries >= 60 };
}

export default function LaunchSuccess({ r, maxDepth, onFinishSplit, splitBusy, splitSteps, splitError }: Props) {
  const url = `${window.location.origin}/c/${r.mint}`;
  const tag = `$${r.symbol}`;
  const pool = r.parent ? `$${r.parent.symbol ?? r.parent.mint.slice(0, 4)}` : "SOL";
  const text = r.parent
    ? `${tag} just launched under ${pool} on Spore — a pump.fun coin whose curve buys and locks ${pool} on every trade.`
    : `${tag} just launched on Spore — a pump.fun coin that other coins can grow under.`;
  const { coin, gaveUp } = useIndexed(r.mint, !r.dry);
  const [copied, setCopied] = useState<"mint" | "link" | null>(null);
  const copy = (what: "mint" | "link", value: string) => { navigator.clipboard?.writeText(value).then(() => { setCopied(what); setTimeout(() => setCopied(null), 1600); }).catch(() => { /* clipboard blocked: the mint is on screen */ }); };
  const canGrow = r.depth < (maxDepth ?? 2);
  const listed = !!coin?.ours;
  return (
    <div className={`success v2 ${r.split.done ? "" : "split-pending"}`} data-mint={r.mint} data-dry={r.dry ? "1" : "0"}>
      <div className="success-head">
        <i aria-hidden="true">✓</i>
        <div>
          <b>{tag} is live{r.parent ? ` at depth ${r.depth}` : ", quoted in SOL"}{r.dry ? " · dry run" : ""}.</b>
          <span className="muted">{r.dry ? "Every transaction was simulated on mainnet state; nothing was sent or charged." : `One transaction, ${r.spent !== null ? `${(Number(r.spent) / 1e9).toFixed(4)} SOL` : "rent and fees"} spent, creator fees split 50/50 with Spore forever.`}</span>
        </div>
      </div>

      {/* The share card: what the coin looks like everywhere on Spore, with its link. */}
      <div className="share-card">
        {r.image ? <img src={r.image} alt="" /> : <span className="share-img letter">{r.symbol.slice(0, 1)}</span>}
        <div className="share-body">
          <b>{r.name}</b>
          <span className="mono">{tag} <span className="muted">· {r.parent ? `under ${pool}` : "root · quoted in SOL"} · depth {r.depth}</span></span>
          <span className="share-link mono">{url.replace(/^https?:\/\//, "")}</span>
        </div>
        <div className="share-side">
          <button type="button" className="btn sm ghost" onClick={() => copy("mint", r.mint)}>{copied === "mint" ? "Copied" : "Copy mint"}</button>
          <button type="button" className="btn sm ghost" onClick={() => copy("link", url)}>{copied === "link" ? "Copied" : "Copy link"}</button>
        </div>
      </div>

      {!r.split.done && (
        <div className="notice warn split-notice" role="alert">
          <div>
            <b>The fee split did not land.</b> {tag} exists on-chain, but its creator/Spore split is not locked yet, so it is not listed on Spore and all creator fees currently stay with you. One more signature fixes it; no new mint, no re-upload.
            {r.split.error && <span className="hint"> Reason: {friendlyError(new Error(r.split.error))}</span>}
            {splitSteps.length > 0 && <Steps steps={splitSteps} />}
            {splitError && <span className="field-error">{splitError}</span>}
          </div>
          <button type="button" className="btn accent" disabled={splitBusy} onClick={onFinishSplit}>{splitBusy ? "Working…" : "Finish the fee split"}</button>
        </div>
      )}

      {r.buy && <div className="notice good">First buy landed: {amount(tokens(r.buy.amountOut, 6), tag)} · <Ext href={solscanTx(r.buy.sig)}>transaction ↗</Ext></div>}
      {r.buyError && <div className="notice warn">The launch landed but the first buy did not: {friendlyError(new Error(r.buyError))} You can buy from the coin page.</div>}

      <div className="success-actions">
        {canGrow && <Link to={`/launch?parent=${r.mint}`} className="btn accent">Launch a coin under {tag}</Link>}
        <Link to={`/c/${r.mint}`} className={`btn ${canGrow ? "ghost" : "accent"}`}>View on Spore</Link>
        <Ext href={xShareUrl(text, url)} className="btn ghost">Share on X ↗</Ext>
        <Ext href={pumpUrl(r.mint)} className="btn ghost">pump.fun ↗</Ext>
        {!r.dry && r.sig && <Ext href={solscanTx(r.sig)} className="btn ghost">Transaction ↗</Ext>}
      </div>

      <p className={`indexer ${listed ? "ok" : coin ? "seen" : ""}`} aria-live="polite">
        {r.dry ? <>Dry run: the indexer is not polled because nothing was created.</>
          : listed ? <><i /> Listed on Spore{coin?.oursPending ? " · verifying the fee split" : ""}. The coin page is ready.</>
          : coin ? <><i /> The indexer sees {tag}{r.split.done ? " and is verifying the fee split…" : "; it will be listed once the fee split is locked."}</>
          : gaveUp ? <><i /> Still waiting for the indexer. The coin exists on-chain; open the coin page and it will fill in.</>
          : <><i className="spin" /> Waiting for the indexer to pick {tag} up…</>}
      </p>
    </div>
  );
}
