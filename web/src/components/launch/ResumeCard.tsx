// A launch this browser started earlier and did not finish: shown above the form after a reload
// or a closed tab, with the one action that completes it (finish the fee split) or the way to
// the coin. Never silently dropped: the user decides.
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { Connection } from "@solana/web3.js";
import { checkPending } from "../../lib/flow";
import { clearPending, type PendingLaunch } from "../../lib/launch-store";
import { solscanTx } from "../../lib/api";
import { Ext } from "../Bits";

type Props = { conn: Connection; pending: PendingLaunch; onResume: (p: PendingLaunch) => void; onDismiss: () => void };

export default function ResumeCard({ conn, pending, onResume, onDismiss }: Props) {
  // `signing` (the wallet never returned a signature) and `sent` both need the chain's answer.
  const unsettled = pending.step === "signing" || pending.step === "sent";
  const [state, setState] = useState<{ status: "checking" | "landed" | "expired" | "failed" | "unknown"; p: PendingLaunch }>({ status: unsettled ? "checking" : "landed", p: pending });
  useEffect(() => {
    if (!unsettled) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Polling stops at a terminal answer: `checkPending` reports a landed launch to the indexer,
    // and a timer that kept firing would repeat that report every few seconds.
    const tick = async () => {
      let r: { status: "landed" | "expired" | "failed" | "unknown"; p: PendingLaunch };
      try { r = await checkPending(conn, pending); } catch { r = { status: "unknown", p: pending }; }
      if (!alive) return;
      setState(r);
      if (r.status === "unknown") timer = setTimeout(tick, 4000);
    };
    void tick();
    return () => { alive = false; clearTimeout(timer); };
  }, [conn, pending, unsettled]);
  const p = state.p;
  const dismiss = () => { clearPending(); onDismiss(); };
  const tag = `$${p.symbol}`;
  const tx = p.sig ? solscanTx(p.sig) : null;
  return (
    <section className={`card raised resume ${state.status}`} aria-live="polite">
      <div className="resume-head">
        {p.image ? <img src={p.image} alt="" className="resume-img" /> : <span className="resume-img letter">{p.symbol.slice(0, 1)}</span>}
        <div>
          <span className="eyebrow">Unfinished launch</span>
          <b>{p.name} <span className="mono muted">{tag}</span>{p.parentSymbol ? <span className="muted"> · under ${p.parentSymbol}</span> : <span className="muted"> · root, quoted in SOL</span>}</b>
          <span className="hint">Mint <span className="mono">{p.mint.slice(0, 8)}…{p.mint.slice(-6)}</span> · started {new Date(p.createdAt).toLocaleString("en-US", { hour: "2-digit", minute: "2-digit", month: "short", day: "numeric" })}</span>
        </div>
      </div>
      {state.status === "checking" && <p className="muted">Checking whether the launch landed on-chain…</p>}
      {state.status === "unknown" && tx && <p className="muted">The launch transaction has not been seen yet. If your wallet shows it as sent, give it a minute; if it never lands, it should not have been charged. <Ext href={tx}>Check on Solscan ↗</Ext></p>}
      {state.status === "unknown" && !tx && <p className="muted">The wallet did not hand back a signature, so the chain is checked for {tag}'s curve every few seconds. If your wallet shows the launch as sent, give it a minute; if it never lands, it should not have been charged.</p>}
      {state.status === "expired" && <p className="muted">No launch transaction landed within its validity window, so it should not have been charged{tx ? <>; <Ext href={tx}>verify on Solscan ↗</Ext></> : " (check your wallet's activity if in doubt)"}. Fill the form again to launch.</p>}
      {state.status === "failed" && tx && <p className="muted">The launch transaction failed on-chain, so no coin was created and only the network fee was spent. <Ext href={tx}>See why ↗</Ext></p>}
      {state.status === "landed" && p.step === "split-pending" && <p className="muted"><b>{tag} exists on-chain</b> but its fee split was never locked, so Spore does not list it yet and every creator fee currently stays with you. Finishing takes one more signature; no new mint, no re-upload.</p>}
      {state.status === "landed" && p.step === "done" && <p className="muted">{tag} launched and its fee split is locked. You can open the coin page any time.</p>}
      <div className="resume-actions">
        {state.status === "landed" && p.step === "split-pending" && <button type="button" className="btn accent" onClick={() => onResume(p)}>Finish the fee split</button>}
        {state.status === "landed" && <Link to={`/c/${p.mint}`} className="btn ghost">View on Spore</Link>}
        {(state.status === "landed" || state.status === "unknown") && tx && <Ext href={tx} className="btn ghost">Transaction ↗</Ext>}
        <button type="button" className="btn ghost" onClick={dismiss}>{state.status === "expired" || state.status === "failed" ? "Dismiss" : "Forget this launch"}</button>
      </div>
    </section>
  );
}
