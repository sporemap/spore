// Highlight filters for the map (DESIGN §11.5 "Map v2"): a set of keys from `?hl=` that dim every coin
// not matching ALL of them, without removing anything, so the layout never moves. Pure: the page builds
// one predicate from the keys and a context, BubbleMap writes the match bit per node (O(n), no worker
// message), and the chip counts come from the same context so a number always matches what lights up.
import type { HeatIndex } from "./heat";
import type { BubbleNode } from "./types";

export type HlKey = "ours" | "new1h" | "new24h" | "grad" | "min1k" | "active" | "since";
/// Canonical order: chips render in it and `?hl=` is always written in it, so one filter has one URL.
export const HL_KEYS: readonly HlKey[] = ["ours", "new1h", "new24h", "grad", "min1k", "active", "since"];
export const HL_LABEL: Record<HlKey, string> = {
  ours: "Spore launches",
  new1h: "New 1h",
  new24h: "New 24h",
  grad: "Graduated",
  min1k: "≥ $1K mcap",
  active: "Traded 1h",
  since: "Since your last visit",
};
/// `nowS` and `seenAtS` are unix seconds; `seenAtS` is the previous visit (null on a first visit).
export type HlCtx = { nowS: number; seenAtS: number | null; heat: HeatIndex | null };

const KNOWN = new Set<string>(HL_KEYS);
const isKey = (s: string): s is HlKey => KNOWN.has(s);

/// `?hl=ours,grad` → ["ours", "grad"]; unknown keys and duplicates are dropped, the order is canonical.
export function parseHl(param: string | null): HlKey[] {
  if (!param) return [];
  const want = new Set<HlKey>();
  for (const part of param.split(",")) { const k = part.trim().toLowerCase(); if (isKey(k)) want.add(k); }
  return HL_KEYS.filter((k) => want.has(k));
}
/// The inverse: null when empty (the param is then removed from the URL).
export function formatHl(keys: HlKey[]): string | null {
  const want = new Set(keys);
  const out = HL_KEYS.filter((k) => want.has(k));
  return out.length ? out.join(",") : null;
}

const created = (n: BubbleNode) => (typeof n.createdAt === "number" && Number.isFinite(n.createdAt) ? n.createdAt : null);

/// One key against one node. A node without `createdAt` is never "new"; `active` needs the heat sidecar.
export function hlTest(key: HlKey, n: BubbleNode, ctx: HlCtx): boolean {
  switch (key) {
    case "ours": return !!n.ours;
    case "new1h": { const c = created(n); return c != null && c >= ctx.nowS - 3_600; }
    case "new24h": { const c = created(n); return c != null && c >= ctx.nowS - 86_400; }
    case "grad": return !!n.migrated;
    case "min1k": return (n.mcapUsd ?? 0) >= 1_000;
    case "active": { const r = ctx.heat?.rows.get(n.mint); return !!r && (r.t1h > 0 || r.last >= ctx.nowS - 3_600); }
    case "since": { const c = created(n); return ctx.seenAtS != null && c != null && c > ctx.seenAtS; }
  }
}

/// All keys at once (AND), or null when there are none (no highlight at all).
export function hlPredicate(keys: HlKey[], ctx: HlCtx): ((n: BubbleNode) => boolean) | null {
  const ks = parseHl(keys.join(","));
  if (!ks.length) return null;
  if (ks.length === 1) { const k = ks[0]; return (n) => hlTest(k, n, ctx); }
  return (n) => { for (const k of ks) if (!hlTest(k, n, ctx)) return false; return true; };
}

/// How many nodes each key matches on its own (the chip counts).
export function hlCounts(nodes: BubbleNode[], ctx: HlCtx): Record<HlKey, number> {
  const out = { ours: 0, new1h: 0, new24h: 0, grad: 0, min1k: 0, active: 0, since: 0 } as Record<HlKey, number>;
  for (const n of nodes) for (const k of HL_KEYS) if (hlTest(k, n, ctx)) out[k]++;
  return out;
}
