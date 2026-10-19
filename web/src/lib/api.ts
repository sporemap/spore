// Typed client for the Spore API (DESIGN.md §7). Types are copied from the contract verbatim so a
// server change shows up as a type error here, not as "undefined" in a card. Every call goes to
// the same origin under /api, which Vite proxies to :8793 in development.

export type CoinRef = { mint: string; name: string | null; symbol: string | null; image: string | null; depth: number };
export type Shares = { address: string; bps: number }[];
export type Coin = {
  mint: string; name: string | null; symbol: string | null; image: string | null; description: string | null;
  twitter: string | null; telegram: string | null; website: string | null;
  creator: string; quoteMint: string | null /* null = SOL */; quoteSymbol: string /* "SOL" | "USDC" | parent symbol | short mint */;
  depth: number; parent: CoinRef | null; root: CoinRef | null; ancestors: CoinRef[] /* nearest first, excludes self */;
  complete: boolean; migrated: boolean; pool: string | null; createdAt: number | null; createdSlot: number | null;
  tokenProgram: string; decimals: number; totalSupply: string;
  priceQuote: number | null; priceSol: number | null; priceUsd: number | null; mcapSol: number | null; mcapUsd: number | null; progress: number;
  children: number; descendants: number; lockedQuote: string; lockedUsd: number | null; volume24hUsd: number; trades24h: number;
  holderReward: boolean; creatorFeeBps: number; shares: Shares | null; updatedAt: number;
  /// DESIGN §11.1: launched through Spore (platform wallet in the on-chain fee split), or reported by
  /// the UI right after a spawn and not yet verified. Optional: an older server leaves them out.
  ours?: boolean; oursPending?: boolean;
  /// pump's mayhem mode: such a coin can never be a parent, so the launch button on its card is off.
  mayhem?: boolean;
};
export type Stats = {
  coins: number; roots: number; byDepth: number[]; lockedUsd: number; volume24hUsd: number; solUsd: number | null; maxDepth: number;
  backfill: { done: boolean; total: number; resolved: number }; updatedAt: number;
  /// "ours" lists only coins launched here (§11.1); ourCoins/otherChildren let the UI say how many exist elsewhere.
  mode?: "ours" | "all"; ourCoins?: number; otherChildren?: number;
};
export type Trade = { sig: string; mint: string; slot: number; time: number; isBuy: boolean; user: string; baseAmount: string; quoteAmount: string; priceQuote: number; priceUsd: number | null };
export type TreeNode = { coin: Coin; children: TreeNode[] };
/// One bubble of the ecosystem map: a CoinRef plus the few numbers a bubble is sized and labelled by.
/// `parentMint` and `updatedAt` arrive on the flat delta variant (DESIGN §11.5); `ours` marks a Spore launch.
export type MapCoin = CoinRef & { mcapUsd: number | null; lockedUsd: number | null; children: number; descendants: number; migrated: boolean; createdAt: number | null; ours?: boolean; oursPending?: boolean; parentMint?: string | null; updatedAt?: number };
export type MapNode = { coin: MapCoin; children: MapNode[] };
/// `GET /api/map` (§11.5). Full form: a tree of every root. Delta form (`since=<ms>`): only the nodes whose
/// `updated_at` moved, flat, each with its `parentMint`; `removed` is reserved. An older server answers the
/// full tree to both, so the client treats whichever list is present as upserts.
export type MapResponse = { roots?: MapNode[]; nodes?: MapCoin[]; updated?: MapCoin[]; removed?: string[]; scope?: string; version?: number | string; generatedAt?: number; total?: number };
export type MapQuery = { limit?: number | "all"; depth?: number; scope?: "ours" | "all"; since?: number };
/// SSE `pair`: a child the live stream saw whose parent is tracked; `parent` lets the client add a root it has not drawn.
export type PairEvent = { coin: MapCoin; parent: MapCoin };
/// SSE `mapdelta`: numbers that moved since the last batch (≤ every 3 s, ≤ 500 entries).
export type MapDeltaEntry = { mint: string; mcapUsd: number | null; lockedUsd: number | null; children: number; descendants: number; migrated: boolean; name?: string | null; symbol?: string | null; image?: string | null };
export type MapDeltaEvent = { at: number; updated: MapDeltaEntry[] };
/// Lamports are a string on the wire so a big value survives JSON; `sol` is the same amount for display.
export type LaunchFeeInfo = { to: string; lamports: string; sol: number };
/// `pool` names what the new coin is quoted in: "sol" for a root coin (no parent), else the parent mint.
export type Eligibility = { ok: boolean; reason: string | null; depth: number | null; chain: CoinRef[]; parentCreator: string | null; grandparentCreator: string | null; shares: Shares; platform: string; launchFee?: LaunchFeeInfo | null; pool?: string };
export type Candle = { t: number; o: number; h: number; l: number; c: number; v: number };
export type Candles = { candles: Candle[]; priceKey: "usd" | "quote" };
/// `otherChildren`: children of this coin that exist on pump.fun but were not launched here (ours mode).
export type CoinPage = { coin: Coin; children: Coin[]; trades: Trade[]; otherChildren?: number };
/// `GET /api/fees/:mint` (DESIGN §11.6): the creator fees waiting for a coin, read live from the
/// curve's bucket, the sharing config's creator vault and (migrated) the pump-amm vault, all in raw
/// units of the coin's quote (lamports for SOL, parent-token units otherwise) as strings. `perShare`
/// is each shareholder's cut of `total`; `claimable` is false with a `reason` when there is no
/// sharing config, the coin pays holders instead, or nothing is distributable yet.
export type FeeShare = { address: string; bps: number; amount: string };
export type Fees = {
  mint: string; quoteMint: string | null /* null = SOL */; quoteSymbol: string; quoteDecimals: number; quoteUsd: number | null;
  shares: Shares | null; bucket: string; vault: string; amm: string; total: string; totalUsd: number | null; perShare: FeeShare[];
  migrated: boolean; claimable: boolean; reason: string | null; updatedAt: number;
};
export type RootSort = "locked" | "children" | "new" | "volume";
export type UploadBody = { name: string; symbol: string; description: string; image: string; twitter: string; telegram: string; website: string };

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.name = "ApiError"; this.status = status; }
}

const BASE = "/api";

async function request<T>(path: string, init: RequestInit = {}, timeoutMs = 15_000): Promise<T> {
  // The caller's signal (search typeahead cancels stale queries) wins; otherwise a timeout
  // keeps a dead API from leaving skeletons on screen forever.
  const signal = init.signal ?? AbortSignal.timeout(timeoutMs);
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, { ...init, signal, headers: { accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers } });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new ApiError("The API is unreachable", 0);
  }
  const text = await res.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON body: handled below */ }
  if (!res.ok) {
    const msg = (json as { error?: string } | null)?.error || (res.status === 502 || res.status === 504 ? "The API is down" : `Request failed (${res.status})`);
    throw new ApiError(msg, res.status);
  }
  if (json === null) throw new ApiError("Empty response", res.status);
  return json as T;
}

const qs = (o: Record<string, string | number | undefined | null>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
};

export const api = {
  stats: () => request<Stats>("/stats"),
  feed: (limit = 50, before?: number) => request<{ coins: Coin[] }>(`/feed${qs({ limit, before })}`),
  roots: (sort: RootSort = "locked", limit = 50, offset = 0) => request<{ roots: Coin[] }>(`/roots${qs({ sort, limit, offset })}`),
  coin: (mint: string) => request<CoinPage>(`/coin/${encodeURIComponent(mint)}`),
  tree: (mint: string, depth = 2) => request<TreeNode>(`/tree/${encodeURIComponent(mint)}${qs({ depth })}`),
  /// `scope: "all"` = every pump.fun pair the indexer knows (the map), not only Spore launches;
  /// `limit: "all"` = no root cap; `since` = only what changed after that `generatedAt` (§11.5).
  /// The full tree can be a few MB, so it gets a longer timeout than a card fetch.
  /// With `limit: "all"` the depth is left to the server (its program depth cap), so every client shares one cached build.
  map: ({ limit = 60, depth, scope = "ours", since }: MapQuery = {}) => request<MapResponse>(`/map${qs({ limit, depth: depth ?? (limit === "all" ? undefined : 2), scope: scope === "all" ? "all" : undefined, since })}`, {}, 60_000),
  candles: (mint: string, res = 60) => request<Candles>(`/candles/${encodeURIComponent(mint)}${qs({ res })}`),
  /// Pending creator fees of one coin (§11.6); the server reads the chain and caches 15 s per mint.
  fees: (mint: string) => request<Fees>(`/fees/${encodeURIComponent(mint)}`),
  search: (q: string, signal?: AbortSignal) => request<{ coins: Coin[] }>(`/search${qs({ q })}`, { signal }),
  eligibility: (mint: string, creator?: string | null) => request<Eligibility>(`/eligibility/${encodeURIComponent(mint)}${qs({ creator })}`),
  /// The SOL pool: a root coin needs no parent, but the split and launch fee are still the server's.
  eligibilitySol: (creator?: string | null) => request<Eligibility>(`/eligibility/sol${qs({ creator })}`),
  upload: (body: UploadBody) => request<{ metadataUri: string }>("/upload", { method: "POST", body: JSON.stringify(body) }, 45_000),
  /// Tells the indexer a spawn just landed so the coin is listed as ours before its sharing config
  /// is verified on-chain (§11.1). The server may answer with any small JSON object. The signature
  /// is optional: a launch recovered from the chain (the wallet never returned one) is reported too.
  spawned: (mint: string, sig: string | null = null) => request<unknown>("/spawned", { method: "POST", body: JSON.stringify(sig ? { mint, sig } : { mint }) }, 10_000),
  eventsUrl: `${BASE}/events`,
};

export const pumpUrl = (mint: string) => `https://pump.fun/coin/${mint}`;
export const solscanAccount = (addr: string) => `https://solscan.io/account/${addr}`;
export const solscanTx = (sig: string) => `https://solscan.io/tx/${sig}`;
/// Share intent for a freshly spawned coin (the text is what the user posts; nothing is auto-posted).
export const xShareUrl = (text: string, url: string) => `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`;
export const isApiDown = (e: unknown) => e instanceof ApiError && (e.status === 0 || e.status === 502 || e.status === 503 || e.status === 504);
export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));
