// One number vocabulary for tiles, cards, charts and feeds, so the same value never reads two
// ways on one screen. Everything degrades to "—" for null/NaN so a missing API field never
// renders as "undefined" or "NaN".
const SUB = "₀₁₂₃₄₅₆₇₈₉";
const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const UNITS: [number, string][] = [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "K"]];

/// Three significant figures with a unit suffix: 1.23M · 45.6K · 789
const sig3 = (n: number): string => {
  const [k, u] = UNITS.find(([k]) => n >= k) ?? [1, ""];
  const m = n / k;
  const d = m < 10 ? 2 : m < 100 ? 1 : 0;
  return m.toFixed(d).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "") + u;
};

/// Compact number without a unit: 1.2M · 12.4K · 999
export const compact = (n: number | null | undefined) => (!finite(n) ? "—" : n < 0 ? `-${sig3(-n)}` : sig3(n));
/// Counts: separators under 100 000, compact above. 17 · 1,284 · 128K
export const count = (n: number | null | undefined) => (!finite(n) ? "—" : n < 100_000 ? Math.round(n).toLocaleString("en-US") : sig3(n));
/// Token amounts with an optional symbol. 3.24M PEPE
/// Sub-unit amounts keep three significant digits (0.0023 SOL), never a rounded "0".
export const amount = (n: number | null | undefined, symbol = ""): string => (!finite(n) ? "—" : `${n === 0 ? "0" : n < 0 ? `-${amount(-n)}` : n < 1 ? (n >= 0.001 ? n.toPrecision(3).replace(/\.?0+$/, "") : subscriptSmall(n)) : sig3(n)}${symbol ? ` ${symbol}` : ""}`);
/// 0.000000368 → 0.0₆368: the subscript carries the zero count so dust prices stay readable.
export const subscriptSmall = (n: number) => {
  const zeros = -Math.floor(Math.log10(n)) - 1;
  if (zeros < 3) return n.toPrecision(3);
  const digits = Math.round(n * 10 ** (zeros + 3)).toString().padStart(3, "0").slice(0, 3);
  return `0.0${[...String(zeros)].map((c) => SUB[Number(c)]).join("")}${digits}`;
};
/// Dollars at every magnitude: $3.68K · $11.91 · $0.4218 · $0.0₅368
export const usd = (n: number | null | undefined): string => {
  if (!finite(n)) return "—";
  if (n < 0) return `-${usd(-n)}`;
  if (n >= 1e3) return `$${sig3(n)}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toPrecision(4)}`;
  if (n === 0) return "$0";
  return `$${subscriptSmall(n)}`;
};
/// SOL amounts: 4 dp under 1, 2 dp under 100, 1 dp above.
export const sol = (n: number | null | undefined, unit = true) => {
  if (!finite(n)) return "—";
  const s = n >= 100 ? n.toFixed(1) : n >= 1 ? n.toFixed(2) : n >= 0.0001 ? n.toFixed(4) : n === 0 ? "0" : subscriptSmall(n);
  return unit ? `${s} SOL` : s;
};
/// A price in whatever the chain quotes in: dollars, SOL, or parent tokens.
export const price = (n: number | null | undefined, unit: string) => {
  if (!finite(n) || n <= 0) return "—";
  if (unit === "$" || unit === "USD") return usd(n);
  const s = n >= 1 ? n.toPrecision(4) : subscriptSmall(n);
  return `${s} ${unit}`;
};
/// Ratios 0..1 → 0.32% · 12.4% · 100%
export const pct = (x: number | null | undefined) => {
  if (!finite(x)) return "—";
  const p = x * 100;
  if (p >= 100) return "100%";
  if (p >= 10) return `${p.toFixed(1)}%`;
  if (p >= 1) return `${p.toFixed(2)}%`;
  return `${p.toPrecision(2)}%`;
};
/// Basis points → 25% · 12.5%
export const bps = (b: number) => `${(b / 100).toFixed(b % 100 === 0 ? 0 : 2)}%`;
export const short = (addr: string | null | undefined, n = 4) => (!addr ? "—" : addr.length > 2 * n + 2 ? `${addr.slice(0, n)}…${addr.slice(-n)}` : addr);
/// Raw on-chain integer (string/bigint) → display number. Precision loss above 2^53 is fine for display.
export const tokens = (raw: string | bigint | number | null | undefined, decimals: number) => {
  if (raw == null) return 0;
  try { return Number(BigInt(raw)) / 10 ** decimals; } catch { return 0; }
};
export const lamportsToSol = (v: bigint | number | string) => Number(BigInt(v)) / 1e9;
/// "0.25" → 250000000n; null for anything that is not a positive decimal. Splits on the decimal
/// point instead of multiplying a float, so 0.1 SOL is exactly 100 000 000 lamports.
export const parseAmount = (s: string, decimals: number): bigint | null => {
  const t = s.trim().replace(/,/g, "");
  if (!/^\d*\.?\d*$/.test(t) || t === "" || t === ".") return null;
  const [i = "0", f = ""] = t.split(".");
  const frac = (f + "0".repeat(decimals)).slice(0, decimals);
  const v = BigInt(i || "0") * 10n ** BigInt(decimals) + BigInt(frac || "0");
  return v > 0n ? v : null;
};
export const ago = (unix: number | null | undefined) => {
  if (!finite(unix)) return "—";
  const s = Math.max(0, Math.floor(Date.now() / 1000) - unix);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};
/// Age without "ago", for dense card footers: 12s · 3m · 5h · 2d
export const age = (unix: number | null | undefined) => (!finite(unix) ? "—" : ago(unix).replace(" ago", ""));
export const when = (unix: number | null | undefined) => (!finite(unix) ? "—" : new Date(unix * 1000).toLocaleString("en-US", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }));
export const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
/// Signed percentage for deltas: +12.4% · −3.2% · 0.0%. `ratio` is new/old − 1.
export const signedPct = (ratio: number | null | undefined) => {
  if (!finite(ratio)) return "—";
  const p = ratio * 100;
  const a = Math.abs(p);
  const s = a >= 100 ? a.toFixed(0) : a >= 10 ? a.toFixed(1) : a.toFixed(2);
  return `${p > 0 ? "+" : p < 0 ? "−" : ""}${s}%`;
};
/// Lamports as a short SOL figure for fee lines: 0.00003 SOL stays readable, 0 never shows as dust.
export const feeSol = (lamports: number | bigint) => { const n = Number(lamports) / 1e9; return n === 0 ? "0 SOL" : n < 0.001 ? `${n.toFixed(5).replace(/0+$/, "")} SOL` : sol(n); };
/// A wallet-ish "4bE1…KTGg" with the length tuned for dense rows.
export const shortSig = (s: string) => short(s, 4);
/// Clock time for tape rows and legends: 14:03:27
export const clock = (unix: number | null | undefined) => (!finite(unix) ? "—" : new Date(unix * 1000).toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" }));
/// Exact token amount as a plain decimal string for inputs ("MAX" fills the field with it, so the
/// user sells precisely what the wallet holds, not a rounded display figure).
export const exactAmount = (raw: bigint, decimals: number) => {
  const s = raw.toString().padStart(decimals + 1, "0");
  const i = s.slice(0, s.length - decimals), f = s.slice(s.length - decimals).replace(/0+$/, "");
  return f ? `${i}.${f}` : i;
};
