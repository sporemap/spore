// Share links for the map (DESIGN §11.5 "Map v2"). Force layouts differ per browser, so a shared view is
// anchored by mint: `/map?focus=<mint>` selects the coin and frames it with its parent and children.
import { count, usd } from "../format";
import type { BubbleNode } from "./types";

const SITE = "https://sporepad.com";

export function mapLink(mint: string, origin?: string): string {
  const o = origin ?? (typeof location !== "undefined" && /^https?:$/.test(location.protocol) ? location.origin : SITE);
  return `${o.replace(/\/$/, "")}/map?focus=${encodeURIComponent(mint)}`;
}

const tick = (n: BubbleNode) => (n.symbol ? `$${n.symbol.replace(/^\$/, "")}` : n.name ? n.name : `${n.mint.slice(0, 4)}…${n.mint.slice(-4)}`);

/// The post text (the link goes separately in the intent URL). A root says how big its tree is; a child
/// says which coin it trades against (its parent is its quote on pump.fun).
export function shareText(n: BubbleNode, parent: BubbleNode | null): string {
  const t = tick(n);
  if (!parent || n.depth === 0) {
    const kids = n.descendants ?? n.children;
    const tree = kids > 0 ? `${count(kids)} coin${kids === 1 ? "" : "s"} trade under it` : "a root of the pump.fun pair tree";
    const locked = n.lockedUsd != null && n.lockedUsd > 0 ? `, ${usd(n.lockedUsd)} locked` : "";
    return `${t} on the Spore map: ${tree}${locked}.`;
  }
  const mcap = n.mcapUsd != null && n.mcapUsd > 0 ? ` (${usd(n.mcapUsd)} mcap)` : "";
  return `${t}${mcap} is paired with ${tick(parent)} on pump.fun. Its family tree on the Spore map:`;
}
