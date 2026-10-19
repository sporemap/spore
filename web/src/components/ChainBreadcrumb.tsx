import { Link } from "react-router-dom";
import type { Coin, CoinRef } from "../lib/api";
import { Logo, sym } from "./Bits";
import "./coin.css";

/// Root first, this coin last: SOL › $ROOT › $PARENT › $COIN, each coin with its image so the
/// chain reads like a route, not a path string. The quote of the root (SOL, USDC, a stock mint)
/// opens the trail so a non-SOL chain is obvious at a glance. `images` off gives the plain text
/// trail for tight spots.
export default function ChainBreadcrumb({ coin, rootQuote, images = true }: { coin: Coin; rootQuote?: string | null; images?: boolean }) {
  const trail: CoinRef[] = [...coin.ancestors].reverse();
  const quote = rootQuote ?? (coin.depth === 0 ? coin.quoteSymbol : null);
  return (
    <nav className="crumbs" aria-label="Parent chain">
      {quote && <span className="crumb quote mono">{quote === "SOL" && images ? <i className="crumb-sol" aria-hidden="true" /> : null}{quote}</span>}
      {trail.map((a) => (
        <span key={a.mint} className="crumb-seg"><i aria-hidden="true">›</i><Link to={`/c/${a.mint}`} className="crumb" title={`${a.name || a.mint} · depth ${a.depth}`}>{images && <Logo src={a.image} label={a.symbol} size={18} />}{sym(a)}</Link></span>
      ))}
      <span className="crumb-seg"><i aria-hidden="true">›</i><span className="crumb self" aria-current="page">{images && <Logo src={coin.image} label={coin.symbol} size={18} />}{sym(coin)}</span></span>
    </nav>
  );
}
