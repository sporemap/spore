import type { Shares } from "../lib/api";
import { bps, short } from "../lib/format";
import { Addr } from "./Bits";

type Props = { shares: Shares; you: string | null; creator?: string | null; parentCreator: string | null; grandparentCreator: string | null; platform: string; parentSymbol?: string | null; grandparentSymbol?: string | null; title?: string; quoteSymbol?: string | null };

/// Who earns what from the new coin's creator fees, forever. Two rows by default (creator and
/// Spore, DESIGN §4); the server merges duplicates (the platform spawning its own coin, a
/// platform-owned parent), so a single row can carry two roles and 100%. Upward shares, when the
/// server re-enables them, are labelled by the parent/grandparent tickers.
export default function SplitPreview({ shares, you, creator, parentCreator, grandparentCreator, platform, parentSymbol, grandparentSymbol, title = "Creator fee split", quoteSymbol }: Props) {
  const roleOf = (addr: string) => {
    const roles: string[] = [];
    if (you && addr === you) roles.push("you");
    else if (creator && addr === creator) roles.push("creator");
    if (parentCreator && addr === parentCreator) roles.push(parentSymbol ? `${parentSymbol} creator` : "parent creator");
    if (grandparentCreator && addr === grandparentCreator) roles.push(grandparentSymbol ? `${grandparentSymbol} creator` : "grandparent creator");
    if (platform && addr === platform) roles.push("Spore");
    // Unknown wallet: at spawn time it can only be the child creator; on a coin page we do not
    // know the platform wallet, so stay neutral.
    return roles.length ? roles.join(" + ") : you || !creator ? "child creator" : "shareholder";
  };
  const tone = (addr: string) => (you && addr === you ? "you" : creator && addr === creator ? "you" : platform && addr === platform ? "platform" : "up");
  const total = shares.reduce((s, x) => s + x.bps, 0);
  return (
    <div className="split">
      <div className="split-head"><b>{title}</b><span className="muted">{total === 10_000 ? "100% · set once at creation, immutable after" : `${bps(total)} allocated`}</span></div>
      <div className="split-bar" aria-hidden="true">{shares.map((s) => <i key={s.address} className={tone(s.address)} style={{ width: `${s.bps / 100}%` }} title={`${roleOf(s.address)} ${bps(s.bps)}`} />)}</div>
      <ul className="split-rows">
        {shares.map((s) => (
          <li key={s.address}>
            <i className={`dot ${tone(s.address)}`} aria-hidden="true" />
            <span className="split-role">{roleOf(s.address)}</span>
            <Addr a={s.address} n={4} />
            <b className="mono">{bps(s.bps)}</b>
          </li>
        ))}
        {!shares.length && <li className="muted">No split data yet{you ? "" : ` — connect a wallet to see your share (${short(platform)} is the platform)`}.</li>}
      </ul>
      <p className="hint">{quoteSymbol ? `Paid in ${quoteSymbol}` : "Paid in the coin's quote (SOL for a root, the parent coin for a child)"}: every trade of the coin sends its creator fee to these wallets in this proportion. Written at launch with the admin revoked, so it can never change.</p>
    </div>
  );
}
