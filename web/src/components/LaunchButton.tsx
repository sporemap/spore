import { Link } from "react-router-dom";
import type { Coin } from "../lib/api";
import { sym } from "./Bits";

/// Why a coin cannot take a child right now, or null when it can. Only what the card already
/// knows (depth, mayhem): the live checks (pending migration, delisted quote) run on the launch
/// page through /api/eligibility, so the button stays on for anything this cannot rule out.
export function launchBlock(coin: Pick<Coin, "depth" | "mayhem">, maxDepth: number | undefined): string | null {
  if (coin.mayhem) return "Mayhem-mode coins cannot be parents";
  if (maxDepth !== undefined && coin.depth >= maxDepth) return `At the depth cap (${maxDepth}): a child would be depth ${coin.depth + 1}`;
  return null;
}

type Props = { coin: Coin; maxDepth: number | undefined; size?: "sm" | "md" | "lg"; className?: string; label?: string; ghost?: boolean };

/// A small sprout mark so the launch action reads as "grow under this coin" and not as a generic button.
const Sprout = () => <svg className="launch-ico" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 22V10" /><path d="M12 14c0-3.5 2.5-6 6-6h2c0 3.5-2.5 6-6 6h-2Z" /><path d="M12 10C12 6.5 9.5 4 6 4H4c0 3.5 2.5 6 6 6h2Z" /></svg>;

/// The one way into the launch form from a listing: "Launch a coin" → /launch?parent=<mint>. The
/// same element everywhere (cards, coin page, CTA) so the action reads the same across the app;
/// a blocked parent keeps the button in place, disabled, with the reason in its tooltip.
export default function LaunchButton({ coin, maxDepth, size = "md", className = "", label, ghost = false }: Props) {
  const block = launchBlock(coin, maxDepth);
  const cls = `btn ${size === "md" ? "" : size} ${ghost ? "ghost" : "accent"} launch-cta ${className}`;
  const text = label ?? "Launch a coin";
  if (block) return <button type="button" className={cls} disabled title={block} aria-label={`${text} under ${sym(coin)}: ${block}`}><Sprout />{text}</button>;
  return <Link to={`/launch?parent=${coin.mint}`} className={cls} title={`Launch a coin under ${sym(coin)}`}><Sprout />{text}</Link>;
}
