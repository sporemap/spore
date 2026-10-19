// Small helpers shared by the API docs components.

export const API_ORIGIN = "https://sporepad.com";
export const json = (v: unknown) => JSON.stringify(v, null, 2);

/// Long arrays are cut for display (a live /v1/heat carries ~1.6 k parallel entries, a tree can
/// hold hundreds of nodes); the marker says how many were left out so nobody mistakes it for data.
export function trimForDisplay(v: unknown, max = 6): unknown {
  if (Array.isArray(v)) {
    const head = v.slice(0, max).map((x) => trimForDisplay(x, max));
    return v.length > max ? [...head, `… ${(v.length - max).toLocaleString("en-US")} more`] : head;
  }
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, trimForDisplay(x, max)]));
  return v;
}

// A Solana address inside whatever was pasted: a bare mint, a pump.fun / Spore / Solscan URL, or a
// terminal link that carries the mint somewhere in its path.
const MINT_RE = /[1-9A-HJ-NP-Za-km-z]{32,44}/;
export const mintIn = (s: string): string | null => s.trim().match(MINT_RE)?.[0] ?? null;

/// Escapes text for an HTML attribute value in a generated snippet (coin names are user data).
export const attr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
