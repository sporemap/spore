// The official $SPORE strip, pinned under the nav on every page but the map (owner 2026-10-19:
// "pin the official CA"): the one contract address users should trust, a copy button, and the
// standing promise that half of the launchpad's fees are collected, swapped into $SPORE and locked.
import { Link } from "react-router-dom";
import { SPORE_COIN } from "../lib/policy";
import { useToast } from "./Toast";

export default function OfficialCoin() {
  const toast = useToast();
  const copy = async () => {
    try { await navigator.clipboard.writeText(SPORE_COIN); toast.success("Official $SPORE CA copied"); }
    catch { toast.error("Could not copy — select the address and copy it by hand"); }
  };
  return (
    <div className="official" role="region" aria-label="Official Spore coin">
      <div className="official-inner">
        <span className="official-badge"><i aria-hidden="true" />official $SPORE CA</span>
        <code className="official-ca" title={SPORE_COIN}>{SPORE_COIN}</code>
        <button type="button" className="official-copy" onClick={copy} aria-label="Copy the official $SPORE contract address">copy</button>
        <Link className="official-link" to={`/c/${SPORE_COIN}`}>coin page →</Link>
        <a className="official-link" href={`https://pump.fun/coin/${SPORE_COIN}`} target="_blank" rel="noreferrer">pump.fun ↗</a>
        <span className="official-note">50% of launchpad fees are collected, swapped into $SPORE and locked.</span>
      </div>
    </div>
  );
}
