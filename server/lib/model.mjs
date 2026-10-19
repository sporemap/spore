// The in-memory working set: every coin and mint the indexer knows, the parent → children index and
// the derived numbers the API serves (prices up the quote chain, locked value, descendants).
//
// Everything mutating the tree goes through here so sqlite stays in sync and every reader sees one
// consistent snapshot. Derived numbers are recomputed at most once per `version` bump, so a burst
// of live trades costs one pass, not one per request.
import { USDC_MINT, NATIVE_MINT, TOKEN_2022_PROGRAM_ID } from "./sdk.mjs";
import { priceQuoteOf, chainPrices, progressOf, units } from "./pricing.mjs";
import { imageProxyUrl } from "./meta.mjs";
import { Activity } from "./activity.mjs";

const nowS = () => Math.floor(Date.now() / 1000);
const SOL_DECIMALS = 9;
// `PublicKey.toBase58()` encodes on every call (bn.js); `decimalsOf` runs millions of times per
// derived pass at 15k coins, so the SOL mint is compared as a string constant.
const SOL_MINT = NATIVE_MINT.toBase58();
const shortMint = (m) => `${m.slice(0, 4)}…${m.slice(-4)}`;
// A verified spawn (POST /api/spawned) stays "pending ours" this long while the indexer looks for
// the fee-sharing config that proves it (DESIGN §11.1); a genuine split lands within seconds of the
// create, so anything still unconfirmed after this is not ours and the flag drops.
export const PENDING_TTL_MS = 10 * 60_000;
// Pending entries are bounded: beyond this the oldest is dropped, so the map can never grow past
// what a few minutes of real launches need.
export const PENDING_MAX = 500;
// The whole-forest map (DESIGN §11.5) is rebuilt at most once per this window, and only when the
// model version moved; the delta variant (`since=`) shares the window.
export const MAP_CACHE_MS = 10_000;
// The map's heat sidecar (`/api/map/heat`, DESIGN §11.5) is rebuilt at most once per this window:
// it decays with the clock, not with model versions, so it has no version key.
export const HEAT_CACHE_MS = 15_000;
// Coin fields whose change alters a map node or the coin page; bookkeeping stamps are left out so
// a refresh tick that re-reads an unchanged curve does not mark the coin as updated.
// `creatorFee` (fees accrued on the curve, read by the treasury) lives in memory only and moves
// with every trade without touching a bubble.
const STAMP_SKIP = new Set(["refreshedAt", "sharesAt", "createdProbe", "updatedAt", "mint", "creatorFee"]);
// Fields of a child that move its parent's locked value / child count.
const PARENT_KEYS = ["realQuoteReserves", "migrated", "poolQuote", "tracked"];
const same = (a, b) => (a === b ? true : typeof a === "object" && typeof b === "object" && a !== null && b !== null ? JSON.stringify(a) === JSON.stringify(b) : false);

export class Model {
  constructor(db, { platformWallet, splitBps, platformMinBps = null, mode = "all", now = Date.now, log = console } = {}) {
    this.db = db; this.log = log; this.now = now;
    this.platformWallet = platformWallet; this.splitBps = splitBps;
    // The platform share a sharing config must carry to count as ours: the configured platform
    // slice (50% by default). Mere presence is not enough — anyone can write a config that names
    // the platform at 1 bps and would otherwise be listed as a Spore launch.
    this.platformMinBps = Math.max(1, Number(platformMinBps ?? splitBps?.[3] ?? 5000));
    this.mode = mode === "ours" ? "ours" : "all"; // "ours": the API shows only coins whose fee split includes the platform (DESIGN §11.1)
    this.pending = new Map();       // mint → { at (ms), sig }: spawns the UI reported, awaiting their sharing config
    this.scopeVersion = -1; this.scopeCache = null;
    this.coins = new Map(); this.mints = new Map(); this.meta = new Map();
    this.imageUrls = new Set();     // every image URL the API has handed out (the proxy serves only these)
    this.children = new Map();      // quoteMint → Set<child mint>
    this.curves = new Map();        // bonding curve address → mint (the curve itself does not store it)
    this.pools = new Map();         // pool address → mint (graduated coins; maps pump-amm events back)
    this.solUsd = null; this.solUsdAt = 0;
    this.quoteUsd = new Map();      // USD price of listed non-SOL quote mints we can price (PUMP, …)
    this.global = null;             // decoded pump Global (plain)
    this.backfill = { done: false, total: 0, resolved: 0 };
    this.version = 0; this.derivedVersion = -1; this.derived = new Map();
    // `computed()` runs after every version bump (each live trade is one), so its per-coin inputs are
    // memoized: a coin object is never mutated once indexed (upsertCoin builds a new one), so its
    // quote price and the value it locks in its parent are cached by object identity; descendant
    // counts change only when the parent → child structure does (`structVersion`).
    this.pqMemo = new WeakMap();    // coin → { pq, bd, qd, dv }: dv = `decVersion` the decimals were read at
    this.decVersion = 0;            // moves when any mint's decimals change
    this.lockMemo = new WeakMap();  // coin → bigint it locks in its parent
    this.structVersion = 0; this.descVersion = -1; this.descCache = new Map();
    // Exact 24 h / 1 h trade counters per mint, seeded from sqlite at load and fed by recordTrade.
    // They include trades the 2 000-rows-per-mint SQL trim later deletes (db.insertTrade), so a mint
    // with more than 2 000 trades in 24 h can exceed a SQL recount until the next restart re-seeds.
    this.activity = new Activity({ now: () => Math.floor(this.now() / 1000) });
    this.heatCache = null;
    this.touched = new Map();       // mint → last API access (ms); the refresh loop prioritises these
    this.updatedAt = nowS();
    // Map delta-sync (DESIGN §11.5): coins whose node changed since the last `mapdelta` flush, the
    // uri → mints index that turns a resolved metadata JSON into stamped coins, the cached forest
    // and the time of the last full build (stamps never fall behind it, see #stamp).
    this.dirty = new Set();
    this.byUri = new Map();         // metadata uri → Set<mint>
    this.mapCache = null; this.mapSinceCache = new Map(); this.totalCache = null;
    this.lastGeneratedAt = 0;
    this.mapStats = { builds: 0, lastBuildMs: null, maxBuildMs: 0 }; // full-forest builds (health)
  }

  load() {
    for (const m of this.db.allMints()) { this.mints.set(m.mint, m); this.#indexUri(m.mint, null, m.uri); }
    this.decVersion++;
    for (const m of this.db.allMeta()) { this.meta.set(m.uri, m); if (m.image) this.imageUrls.add(m.image); }
    for (const c of this.db.allCoins()) this.#index(c);
    this.solUsd = this.db.kvGet("solUsd"); this.solUsdAt = this.db.kvGet("solUsdAt", 0);
    this.quoteUsd = new Map(Object.entries(this.db.kvGet("quoteUsd", {})));
    this.global = this.db.kvGet("global");
    this.pending = new Map(Object.entries(this.db.kvGet("oursPending", {})));
    const t0 = performance.now();
    const seeded = this.activity.seed(this.db.tradesWindow(Math.floor(this.now() / 1000) - this.activity.dayS));
    this.activity.seededMs = Math.round(performance.now() - t0);
    this.#bump();
    this.log.info?.(`model: ${this.coins.size} coins, ${this.mints.size} mints, ${this.meta.size} metadata entries loaded`);
    this.log.info?.(`activity seeded ${seeded} trades in ${this.activity.seededMs} ms`);
  }

  #bump() { this.version++; this.updatedAt = nowS(); }
  /**
   * Marks a coin's map node as changed: `updatedAt` (ms) moves forward and the mint joins the
   * `mapdelta` batch. Stamps are kept strictly after the last full map build, so a change that lands
   * in the same millisecond as a `generatedAt` is still caught by `since=<generatedAt>`.
   */
  #stamp(mint, { persist = true } = {}) {
    const c = this.coins.get(mint);
    if (!c) return;
    const at = Math.max(this.now(), this.lastGeneratedAt + 1, (c.updatedAt ?? 0) + 1);
    c.updatedAt = at;
    this.dirty.add(mint);
    if (persist && c.tracked) this.db.touchCoin(mint, at);
  }
  #indexUri(mint, oldUri, newUri) {
    if (oldUri === newUri) return;
    if (oldUri) { const s = this.byUri.get(oldUri); if (s) { s.delete(mint); if (!s.size) this.byUri.delete(oldUri); } }
    if (newUri) { if (!this.byUri.has(newUri)) this.byUri.set(newUri, new Set()); this.byUri.get(newUri).add(mint); }
  }
  /** Mints (coins or not) whose on-chain uri is this one. */
  mintsOfUri(uri) { return [...(this.byUri.get(uri) ?? [])]; }
  /** Drains the set of coins whose map node changed since the last call (the `mapdelta` batch). */
  takeDirty() { const out = [...this.dirty]; this.dirty.clear(); return out; }
  /** Puts mints back for the next batch (a capped `mapdelta` carries the rest over). */
  requeueDirty(mints) { for (const m of mints) this.dirty.add(m); }
  #index(c) {
    const prev = this.coins.get(c.mint);
    if (prev && prev.quoteMint !== c.quoteMint) this.children.get(prev.quoteMint)?.delete(c.mint);
    if (!prev || prev.quoteMint !== c.quoteMint || prev.tracked !== c.tracked) this.structVersion++;
    this.coins.set(c.mint, c);
    if (c.quoteMint) { if (!this.children.has(c.quoteMint)) this.children.set(c.quoteMint, new Set()); this.children.get(c.quoteMint).add(c.mint); }
    if (c.curve) this.curves.set(c.curve, c.mint);
    if (c.pool) this.pools.set(c.pool, c.mint);
  }
  byCurve(curve) { const m = this.curves.get(curve); return m ? this.coins.get(m) ?? null : null; }

  // ---------------------------------------------------------------- mutations
  /**
   * Inserts or merges a coin. Unknown fields keep their previous value; `tracked` only ever turns
   * on. Untracked coins (an on-demand lookup of a foreign coin nobody spawned under) live in memory
   * only and are evicted when nobody looks at them (`evictUntracked`), so browsing pump.fun through
   * /api/coin cannot grow the database.
   */
  upsertCoin(partial) {
    const prev = this.coins.get(partial.mint);
    const patch = stripUndefined(partial);
    const c = {
      tracked: true, complete: false, migrated: false, mayhem: false, holderReward: false, creatorFeeBps: 0,
      virtualTokenReserves: "0", virtualQuoteReserves: "0", realTokenReserves: "0", realQuoteReserves: "0", tokenTotalSupply: "0", initialVirtualQuoteReserves: "0",
      pool: null, poolBaseVault: null, poolQuoteVault: null, poolBase: null, poolQuote: null,
      createdAt: null, createdSlot: null, createdProbe: false, shares: null, sharesAt: 0, refreshedAt: 0, feePaid: null,
      ...prev, ...patch, updatedAt: prev?.updatedAt ?? 0,
    };
    // Tracked only ever turns on: an explicit `tracked: true` (or a brand-new coin without the flag)
    // joins the tree; a later reserve update of an untracked coin leaves it untracked.
    c.tracked = prev ? !!(prev.tracked || partial.tracked === true) : partial.tracked !== false;
    // `updatedAt` (ms) moves only when something a map node or coin page shows actually changed:
    // the rolling refresh re-reads every curve and most of them come back identical.
    const changed = !prev || Object.keys(patch).some((k) => !STAMP_SKIP.has(k) && !same(prev[k], c[k])) || prev.tracked !== c.tracked;
    this.#index(c);
    if (changed) {
      c.updatedAt = Math.max(this.now(), this.lastGeneratedAt + 1, (prev?.updatedAt ?? 0) + 1);
      this.dirty.add(c.mint);
    }
    if (c.tracked) this.db.upsertCoin(c);
    if (changed) {
      // The parent's locked value and child count follow from the child's state.
      const parentMoved = !prev || PARENT_KEYS.some((k) => !same(prev[k], c[k]));
      if (prev && prev.quoteMint && prev.quoteMint !== c.quoteMint) this.#stamp(prev.quoteMint);
      if (c.quoteMint && c.tracked && (parentMoved || prev?.quoteMint !== c.quoteMint)) this.#stamp(c.quoteMint);
      this.#bump();
    }
    return c;
  }
  /**
   * Drops untracked coins nobody asked for in `idleMs` (no children, not pending, not viewed):
   * they were fetched for a coin page or an eligibility check and would otherwise accumulate for
   * every pump.fun coin ever viewed. Returns how many were removed.
   */
  evictUntracked({ idleMs = 10 * 60_000 } = {}) {
    const cutoff = Date.now() - idleMs;
    let n = 0;
    for (const c of this.coins.values()) {
      if (c.tracked || this.pending.has(c.mint) || (this.children.get(c.mint)?.size ?? 0) > 0) continue;
      if ((this.touched.get(c.mint) ?? 0) > cutoff || (c.updatedAt ?? 0) > cutoff) continue;
      this.coins.delete(c.mint);
      if (c.curve) this.curves.delete(c.curve);
      if (c.pool) this.pools.delete(c.pool);
      if (c.quoteMint) this.children.get(c.quoteMint)?.delete(c.mint);
      this.touched.delete(c.mint);
      n++;
    }
    if (n) { this.structVersion++; this.#bump(); }
    return n;
  }
  /** Forgets API views older than `maxAgeMs`: the refresh loop only reads newer ones, so older entries are dead weight. */
  pruneTouched(maxAgeMs = 120_000) {
    const cutoff = Date.now() - maxAgeMs;
    for (const [m, t] of this.touched) if (t <= cutoff) this.touched.delete(m);
  }
  setMint(info) {
    const prev = this.mints.get(info.mint) ?? { mint: info.mint, decimals: null, tokenProgram: null, supply: null, name: null, symbol: null, uri: null, onchainAt: 0 };
    const m = { ...prev, ...stripUndefined(info) };
    this.mints.set(m.mint, m);
    if (prev.decimals !== m.decimals) this.decVersion++;
    this.#indexUri(m.mint, prev.uri, m.uri);
    this.db.upsertMint(m);
    // A name, ticker or metadata pointer that just resolved changes the coin's label on the map.
    if (prev.name !== m.name || prev.symbol !== m.symbol || prev.uri !== m.uri) this.#stamp(m.mint);
    this.#bump();
    return m;
  }
  setMeta(uri, meta) {
    const prev = this.meta.get(uri);
    const m = { uri, ...meta };
    this.meta.set(uri, m);
    if (m.image) this.imageUrls.add(m.image);
    this.db.metaSet(m);
    // A logo that just arrived (or changed) reaches every coin behind this uri: `since=` and `mapdelta`.
    if ((prev?.image ?? null) !== (m.image ?? null)) for (const mint of this.mintsOfUri(uri)) this.#stamp(mint);
    this.#bump();
  }
  /** Has the API handed out this image URL (so the proxy may fetch it)? */
  knownImage(url) { return this.imageUrls.has(url); }
  /** Is a file of our metadata host (`<sha256>.<ext>`) the uri or image of any coin we know? */
  referencesMetaFile(name) {
    const tail = `/m/${name}`;
    for (const m of this.mints.values()) if (m.uri && m.uri.endsWith(tail)) return true;
    for (const m of this.meta.values()) if (m.image && m.image.endsWith(tail)) return true;
    return false;
  }
  setSolUsd(v) { if (v > 0) { this.solUsd = v; this.solUsdAt = nowS(); this.db.kvSet("solUsd", v); this.db.kvSet("solUsdAt", this.solUsdAt); this.#bump(); } }
  setQuoteUsd(mint, v) { if (v > 0) { this.quoteUsd.set(mint, v); this.db.kvSet("quoteUsd", Object.fromEntries(this.quoteUsd)); this.#bump(); } }
  /** USD per 1 unit of a quote mint: SOL price, 1 for USDC, a tracked pump coin's own price, a known listed quote, else null. */
  quoteUsdOf(mint) {
    if (mint == null || mint === SOL_MINT) return this.solUsd;
    if (mint === USDC_MINT) return 1;
    if (this.coins.has(mint)) return this.priceOf(mint)?.priceUsd ?? null;
    return this.quoteUsd.get(mint) ?? null;
  }
  /**
   * Prices of one coin from its own quote chain (≤ depth + 1 coins), without recomputing the whole
   * forest: the live trade path calls this right after it changed the coin, when `computed()` would
   * start a full pass for every trade. Same math as `computed()`.
   */
  priceOf(mint) {
    const c = this.coins.get(mint);
    if (!c) return null;
    const chain = [c, ...this.ancestors(mint)];
    const root = chain[chain.length - 1];
    const quoteOf = (x) => priceQuoteOf(x, this.decimalsOf(x.mint), this.quoteDecimals(x));
    const priceQuote = quoteOf(c);
    if (root.depth !== 0) return { priceQuote, priceSol: null, priceUsd: null };
    const kind = this.rootQuoteKind(root);
    return { priceQuote, ...chainPrices(chain.map(quoteOf), kind, this.solUsd, kind === "other" ? this.quoteUsd.get(root.quoteMint) ?? null : null) };
  }
  setGlobal(g) { this.global = g; this.db.kvSet("global", g); this.#bump(); }
  setBackfill(b) { this.backfill = { ...this.backfill, ...b }; }
  /** Stores a trade; only a row sqlite did not have yet is counted (a replayed event never counts twice). */
  recordTrade(t) { if (this.db.insertTrade(t)) this.activity.record(t); this.#bump(); }
  touch(mint) { this.touched.set(mint, Date.now()); }

  // ---------------------------------------------------------------- "ours" (DESIGN §11.1)
  /** Proven ours: the on-chain fee-sharing config pays the platform wallet at least its configured share. */
  isOurs(c) { return !!c?.shares?.some((s) => s.address === this.platformWallet && s.bps >= this.platformMinBps); }
  /** The launch fee a verified spawn paid (lamports as a string), from the coin or its pending record. */
  feePaidOf(c) { return c?.feePaid ?? this.pending.get(c?.mint)?.feePaid ?? null; }
  oursOf(c) {
    const ours = this.isOurs(c);
    const p = !ours && this.pending.get(c?.mint);
    return { ours, oursPending: !!p && this.now() - p.at < PENDING_TTL_MS };
  }
  /** Ours or still pending: what the feed, the roots and the counts are built from in ours mode. */
  isOurCoin(c) { const o = this.oursOf(c); return o.ours || o.oursPending; }
  /** `at` (ms) anchors the pending window to the launch transaction's block time, so re-posting an old signature cannot restart it. */
  markPending(mint, sig, { feePaid = null, at = null } = {}) {
    this.pending.delete(mint);
    while (this.pending.size >= PENDING_MAX) this.pending.delete(this.pending.keys().next().value); // insertion order: the oldest goes
    this.pending.set(mint, { at: Math.min(at ?? this.now(), this.now()), sig: sig ?? null, feePaid: feePaid != null ? String(feePaid) : null });
    this.#stamp(mint); // the node's `oursPending` flag changed
    this.#persistPending(); this.#bump();
  }
  /** Drops pending entries that expired or that the sharing config confirmed; bumps only when something changed. */
  sweepPending() {
    let changed = false;
    for (const [mint, p] of this.pending) {
      if (this.now() - p.at >= PENDING_TTL_MS || this.isOurs(this.coins.get(mint))) { this.pending.delete(mint); this.#stamp(mint); changed = true; }
    }
    if (changed) { this.#persistPending(); this.#bump(); }
    return changed;
  }
  pendingMints() { this.sweepPending(); return [...this.pending.keys()]; }
  #persistPending() { this.db.kvSet("oursPending", Object.fromEntries(this.pending)); }

  /**
   * The visible set and its own counts, recomputed per version. `ours` = tracked coins that are ours
   * or pending; `inScope` = those plus every ancestor (served as context); `derived` = per in-scope
   * mint: children shown, our descendants, locked value over our direct children, and how many
   * direct children on pump.fun the scope leaves out (`otherChildren`). In "all" mode the scope is
   * the whole tree and the global numbers apply.
   */
  scope() {
    this.sweepPending();
    if (this.scopeVersion === this.version) return this.scopeCache;
    const ours = new Set(); const inScope = new Set(); const derived = new Map();
    const d = this.computed();
    for (const c of this.coins.values()) if (c.tracked && this.isOurCoin(c)) ours.add(c.mint);
    if (this.mode === "all") {
      for (const c of this.coins.values()) if (c.tracked) inScope.add(c.mint);
    } else {
      for (const m of ours) { inScope.add(m); for (const a of this.ancestors(m)) inScope.add(a.mint); }
      const memo = new Map();
      const desc = (mint) => {
        if (memo.has(mint)) return memo.get(mint);
        memo.set(mint, 0); // cycle guard; depth strictly grows on chain
        let n = 0;
        for (const m of this.children.get(mint) ?? []) if (inScope.has(m)) n += (ours.has(m) ? 1 : 0) + desc(m);
        memo.set(mint, n); return n;
      };
      for (const mint of inScope) {
        let shown = 0, locked = 0n;
        for (const m of this.children.get(mint) ?? []) {
          if (!inScope.has(m)) continue;
          shown++;
          const ch = this.coins.get(m);
          if (ours.has(m) && ch) locked += BigInt((ch.migrated ? ch.poolQuote : ch.realQuoteReserves) ?? 0);
        }
        const e = d.get(mint);
        const lockedUsd = e?.priceUsd != null ? units(locked, this.decimalsOf(mint)) * e.priceUsd : null;
        derived.set(mint, { children: shown, descendants: desc(mint), lockedQuote: locked, lockedUsd, otherChildren: (e?.children ?? 0) - shown });
      }
    }
    this.scopeCache = { ours, inScope, derived }; this.scopeVersion = this.version;
    return this.scopeCache;
  }
  /** Scoped counts for a coin, or the "nothing of ours below it" row for a foreign coin viewed directly. */
  scoped(c) {
    const d = this.computed().get(c.mint) ?? {};
    if (this.mode === "all") return { children: d.children ?? 0, descendants: d.descendants ?? 0, lockedQuote: d.lockedQuote ?? 0n, lockedUsd: d.lockedUsd ?? null, otherChildren: 0 };
    return this.scope().derived.get(c.mint) ?? { children: 0, descendants: 0, lockedQuote: 0n, lockedUsd: d.priceUsd != null ? 0 : null, otherChildren: d.children ?? 0 };
  }
  /** Whole-ecosystem counts for a coin regardless of the mode: what the map draws when it shows every pump.fun pair. */
  scopedAll(c) {
    const d = this.computed().get(c.mint) ?? {};
    return { children: d.children ?? 0, descendants: d.descendants ?? 0, lockedQuote: d.lockedQuote ?? 0n, lockedUsd: d.lockedUsd ?? null, otherChildren: 0 };
  }
  /** Every depth-0 coin with at least one child on pump.fun, regardless of the mode. */
  allRoots() { const d = this.computed(); return this.tracked().filter((c) => c.depth === 0 && (d.get(c.mint)?.children ?? 0) > 0); }
  inScope(mint) { return this.scope().inScope.has(mint); }
  /** Direct children the API may show: every tracked child in "all" mode, in-scope ones in "ours" mode. */
  visibleChildren(mint) { const kids = this.childrenOf(mint); return this.mode === "all" ? kids : kids.filter((c) => this.scope().inScope.has(c.mint)); }
  /** Feed rows: every spawn (depth ≥ 1) in "all" mode; in "ours" mode every coin launched here, roots included. */
  visibleSpawns() { const sc = this.scope(); return this.tracked().filter((c) => (this.mode === "all" ? c.depth >= 1 : sc.ours.has(c.mint))); }
  /** Leaderboard rows: depth-0 coins with children, or in "ours" mode with at least one of our coins below them. */
  visibleRoots() {
    if (this.mode === "all") { const d = this.computed(); return this.tracked().filter((c) => c.depth === 0 && (d.get(c.mint)?.children ?? 0) > 0); }
    const sc = this.scope();
    return this.tracked().filter((c) => c.depth === 0 && sc.inScope.has(c.mint) && (sc.derived.get(c.mint)?.descendants ?? 0) > 0);
  }

  // ---------------------------------------------------------------- lookups
  get(mint) { return this.coins.get(mint) ?? null; }
  mint(mint) { return this.mints.get(mint) ?? null; }
  decimalsOf(mint) { if (mint == null || mint === SOL_MINT) return SOL_DECIMALS; return this.mints.get(mint)?.decimals ?? 6; }
  quoteDecimals(c) { return this.decimalsOf(c.quoteMint); }
  nameOf(mint) { const m = this.mints.get(mint); return { name: m?.name ?? null, symbol: m?.symbol ?? null }; }
  quoteSymbol(c) {
    if (c.quoteMint == null) return "SOL";
    if (c.quoteMint === USDC_MINT) return "USDC";
    return this.mints.get(c.quoteMint)?.symbol || shortMint(c.quoteMint);
  }
  /** "sol" | "usdc" | "other" for a depth-0 coin's own quote (what chain pricing roots in). */
  rootQuoteKind(root) { return root.quoteMint == null ? "sol" : root.quoteMint === USDC_MINT ? "usdc" : "other"; }
  /** Ancestors nearest first (parent, grandparent, …) as far as the model knows them; cycle-safe. */
  ancestors(mint) {
    const out = []; const seen = new Set([mint]);
    let c = this.coins.get(mint);
    while (c && c.quoteMint && !seen.has(c.quoteMint)) {
      const p = this.coins.get(c.quoteMint);
      if (!p) break;
      out.push(p); seen.add(p.mint); c = p;
    }
    return out;
  }
  childrenOf(mint) { return [...(this.children.get(mint) ?? [])].map((m) => this.coins.get(m)).filter((c) => c && c.tracked); }
  tracked() { return [...this.coins.values()].filter((c) => c.tracked); }
  metaFor(c) { const uri = this.mints.get(c.mint)?.uri; return uri ? this.meta.get(uri) ?? null : null; }

  // ---------------------------------------------------------------- derived numbers
  /** Prices, locked value and descendant counts for every coin, recomputed when the version moved. */
  computed() {
    if (this.derivedVersion === this.version) return this.derived;
    const d = new Map();
    for (const c of this.coins.values()) {
      let m = this.pqMemo.get(c);
      if (!m || m.dv !== this.decVersion) {
        const bd = this.decimalsOf(c.mint), qd = this.quoteDecimals(c);
        if (!m || m.bd !== bd || m.qd !== qd) { m = { pq: priceQuoteOf(c, bd, qd), bd, qd, dv: 0 }; this.pqMemo.set(c, m); }
        m.dv = this.decVersion;
      }
      d.set(c.mint, { priceQuote: m.pq, priceSol: null, priceUsd: null, lockedQuote: 0n, lockedUsd: null, descendants: 0, children: 0 });
    }
    // Self first, then the ancestors as far as the model knows them (the walk `ancestors()` does,
    // cycle-safe), into two scratch arrays reused for every coin.
    const chain = [], steps = [];
    for (const c of this.coins.values()) {
      chain.length = 0; chain.push(c);
      for (let x = c; x.quoteMint && !inChain(chain, x.quoteMint);) { const p = this.coins.get(x.quoteMint); if (!p) break; chain.push(p); x = p; }
      const root = chain[chain.length - 1];
      // A chain that does not reach a depth-0 coin cannot be priced in SOL or USD yet (ancestor missing).
      if (root.depth !== 0) continue;
      steps.length = chain.length;
      for (let k = 0; k < chain.length; k++) steps[k] = d.get(chain[k].mint).priceQuote;
      const kind = this.rootQuoteKind(root);
      Object.assign(d.get(c.mint), chainPrices(steps, kind, this.solUsd, kind === "other" ? this.quoteUsd.get(root.quoteMint) ?? null : null));
    }
    // Locked quote = Σ children (raw units of the parent's token: realQuoteReserves on the curve, the
    // pool's quote vault after migration). Descendants = recursive child count, children = direct.
    for (const [parent, set] of this.children) {
      const e = d.get(parent); if (!e) continue;
      let locked = 0n, n = 0;
      for (const m of set) {
        const ch = this.coins.get(m); if (!ch || !ch.tracked) continue;
        n++;
        let v = this.lockMemo.get(ch);
        if (v === undefined) { v = BigInt((ch.migrated ? ch.poolQuote : ch.realQuoteReserves) ?? 0); this.lockMemo.set(ch, v); }
        locked += v;
      }
      e.children = n; e.lockedQuote = locked;
      const parentCoin = this.coins.get(parent);
      e.lockedUsd = e.priceUsd != null && parentCoin ? units(locked, this.decimalsOf(parent)) * e.priceUsd : null;
    }
    if (this.descVersion !== this.structVersion) {
      const memo = new Map(); const visiting = new Set();
      const desc = (mint) => {
        if (memo.has(mint)) return memo.get(mint);
        if (visiting.has(mint)) return 0; // malformed data guard; depth strictly grows on chain
        visiting.add(mint);
        let n = 0;
        for (const m of this.children.get(mint) ?? []) { const ch = this.coins.get(m); if (ch && ch.tracked) n += 1 + desc(m); }
        visiting.delete(mint); memo.set(mint, n); return n;
      };
      for (const c of this.coins.values()) desc(c.mint);
      this.descCache = memo; this.descVersion = this.structVersion;
    }
    for (const [mint, e] of d) e.descendants = this.descCache.get(mint) ?? 0;
    this.derived = d; this.derivedVersion = this.version;
    return d;
  }
  /** 24 h volume/trade counts per mint (Map<mint, { trades, usd }>), live from the in-memory activity counters. */
  volumes() { return this.activity.volumes(); }
  /**
   * The map's heat sidecar (DESIGN §11.5): per-mint activity of every tracked coin with a trade in the
   * last 24 h, whatever the listing mode. Rebuilt at most once per `HEAT_CACHE_MS`; the entry carries
   * a `prepared` slot the HTTP layer fills with the encoded bytes, like `mapAll`.
   */
  heatEntry() {
    const hit = this.heatCache;
    if (hit && this.now() - hit.at < HEAT_CACHE_MS) return hit;
    const t0 = performance.now();
    const body = this.activity.heat({ keep: (mint) => !!this.coins.get(mint)?.tracked });
    this.heatCache = { at: this.now(), body, prepared: null, buildMs: Math.round(performance.now() - t0) };
    return this.heatCache;
  }

  // ---------------------------------------------------------------- API views (DESIGN §7)
  ref(c) { const { name, symbol } = this.nameOf(c.mint); return { mint: c.mint, name, symbol, image: imageProxyUrl(this.metaFor(c)?.image), depth: c.depth, ...this.oursOf(c) }; }
  /** CoinRef plus the few numbers a bubble needs. Skips the ancestor walk and the volume join that
   *  make `view()` cost more, because the map asks for hundreds of coins per request. */
  mapRef(c, all = false) {
    const d = this.computed().get(c.mint) ?? {};
    const s = all ? this.scopedAll(c) : this.scoped(c);
    const supply = units(c.tokenTotalSupply, this.decimalsOf(c.mint));
    return { ...this.ref(c), mcapUsd: d.priceUsd != null ? d.priceUsd * supply : null, lockedUsd: s.lockedUsd, children: s.children, descendants: s.descendants, otherChildren: s.otherChildren, migrated: c.migrated, createdAt: c.createdAt };
  }

  // ---------------------------------------------------------------- the whole-forest map (DESIGN §11.5)
  /** Deepest level the full map descends to: the program's current depth cap (every descendant), never less than 2. */
  mapDepth() { return Math.max(2, this.global?.maxCurveDepth ?? 2); }
  /** Roots the map draws: every depth-0 coin with a child (`all`), or the roots of the listing scope. */
  mapRoots(all) { return all ? this.allRoots() : this.visibleRoots(); }
  mapChildren(mint, all) { return all ? this.childrenOf(mint) : this.visibleChildren(mint); }
  /**
   * Every root and every descendant as `{ coin: mapRef, children }` nodes, no fan-out cap. Built
   * from `mapRef` only (no `view()`: no ancestor walk, no volume join), cached per model version
   * and at most once per `MAP_CACHE_MS` so a burst of opens shares one build (≈ 50 ms for 15k
   * coins). The cache entry carries `body`, `total` and a `prepared` slot the HTTP layer fills with
   * the encoded bytes. Roots and children are ordered by locked value, biggest first.
   */
  mapAll({ all = true, depth = this.mapDepth() } = {}) {
    const key = `${all ? "all" : this.mode}:${depth}`;
    const hit = this.mapCache;
    if (hit && hit.key === key && (hit.version === this.version || this.now() - hit.at < MAP_CACHE_MS)) return hit;
    const t0 = performance.now();
    const generatedAt = this.now();
    const d = this.computed();
    const stat = (c) => (all ? this.scopedAll(c) : this.scoped(c));
    const cmp = (a, b) => (stat(b).lockedUsd ?? -1) - (stat(a).lockedUsd ?? -1) || (d.get(b.mint)?.priceUsd ?? -1) - (d.get(a.mint)?.priceUsd ?? -1);
    let total = 0;
    const node = (c, left) => { total++; return { coin: this.mapRef(c, all), children: left > 0 ? this.mapChildren(c.mint, all).sort(cmp).map((k) => node(k, left - 1)) : [] }; };
    const roots = this.mapRoots(all).sort(cmp).map((r) => node(r, depth));
    const body = { roots, scope: all ? "all" : this.mode, version: this.version, generatedAt, total };
    this.lastGeneratedAt = Math.max(this.lastGeneratedAt, generatedAt);
    this.mapCache = { key, all, version: this.version, at: generatedAt, body, total, prepared: null, buildMs: Math.round(performance.now() - t0) };
    this.totalCache = { all, version: this.version, total };
    this.mapStats.builds++; this.mapStats.lastBuildMs = this.mapCache.buildMs; this.mapStats.maxBuildMs = Math.max(this.mapStats.maxBuildMs, this.mapCache.buildMs);
    return this.mapCache;
  }
  /** Number of nodes the full map holds right now (a cheap walk when no build is cached for this version). */
  mapTotal(all = true) {
    if (this.totalCache?.version === this.version && this.totalCache.all === all) return this.totalCache.total;
    const depth = this.mapDepth();
    let total = 0;
    const walk = (c, left) => { total++; if (left > 0) for (const k of this.mapChildren(c.mint, all)) walk(k, left - 1); };
    for (const r of this.mapRoots(all)) walk(r, depth);
    this.totalCache = { all, version: this.version, total };
    return total;
  }
  /** Is this coin drawn by the full map: a root with children, or a child whose parent chain reaches a tracked root? */
  #onMap(c, all) {
    if (!c.tracked) return false;
    if (!all && !this.scope().inScope.has(c.mint)) return false;
    if (c.depth === 0) return this.mapChildren(c.mint, all).length > 0;
    if (c.depth > this.mapDepth()) return false;
    const anc = this.ancestors(c.mint);
    return anc.length > 0 && anc[anc.length - 1].depth === 0 && anc.every((a) => a.tracked && (all || this.scope().inScope.has(a.mint)));
  }
  /**
   * Delta sync: the nodes whose `updatedAt` (ms) is after `since`, flat, each with its `parentMint`
   * (null for a root). `removed` is reserved (coins are never deleted from the tree). `total` says
   * how many nodes the full map holds, so a client can tell a stale cache from a complete one.
   */
  mapSince({ all = true, since = 0 } = {}) {
    const key = `${all ? "all" : this.mode}:${since}`;
    const hit = this.mapSinceCache.get(key);
    if (hit && (hit.version === this.version || this.now() - hit.at < MAP_CACHE_MS)) return hit;
    const generatedAt = this.now();
    const nodes = [];
    for (const c of this.coins.values()) {
      if (!((c.updatedAt ?? 0) > since) || !this.#onMap(c, all)) continue;
      nodes.push({ ...this.mapRef(c, all), parentMint: c.depth > 0 ? c.quoteMint : null });
    }
    nodes.sort((a, b) => (b.lockedUsd ?? -1) - (a.lockedUsd ?? -1));
    const body = { nodes, removed: [], generatedAt, total: this.mapTotal(all), version: this.version };
    this.lastGeneratedAt = Math.max(this.lastGeneratedAt, generatedAt);
    const entry = { key, version: this.version, at: generatedAt, body, prepared: null };
    this.mapSinceCache.set(key, entry);
    if (this.mapSinceCache.size > 64) this.mapSinceCache.delete(this.mapSinceCache.keys().next().value);
    return entry;
  }

  view(c) {
    const d = this.computed().get(c.mint) ?? {};
    const { name, symbol } = this.nameOf(c.mint);
    const meta = this.metaFor(c);
    const anc = this.ancestors(c.mint);
    const vol = this.volumes().get(c.mint);
    const decimals = this.decimalsOf(c.mint);
    const supply = units(c.tokenTotalSupply, decimals);
    const mintInfo = this.mints.get(c.mint);
    const s = this.scoped(c);
    return {
      mint: c.mint, name, symbol, image: imageProxyUrl(meta?.image), description: meta?.description ?? null,
      twitter: meta?.twitter ?? null, telegram: meta?.telegram ?? null, website: meta?.website ?? null,
      creator: c.creator, quoteMint: c.quoteMint, quoteSymbol: this.quoteSymbol(c), quoteDecimals: this.quoteDecimals(c),
      depth: c.depth, parent: anc[0] ? this.ref(anc[0]) : null, root: anc.length ? this.ref(anc[anc.length - 1]) : null, ancestors: anc.map((a) => this.ref(a)),
      complete: c.complete, migrated: c.migrated, pool: c.pool, createdAt: c.createdAt, createdSlot: c.createdSlot,
      tokenProgram: mintInfo?.tokenProgram ?? TOKEN_2022_PROGRAM_ID.toBase58(), decimals, totalSupply: c.tokenTotalSupply,
      priceQuote: d.priceQuote ?? null, priceSol: d.priceSol ?? null, priceUsd: d.priceUsd ?? null,
      mcapSol: d.priceSol != null ? d.priceSol * supply : null, mcapUsd: d.priceUsd != null ? d.priceUsd * supply : null,
      progress: progressOf(c, this.global?.initialRealTokenReserves),
      children: s.children, descendants: s.descendants, lockedQuote: s.lockedQuote.toString(), lockedUsd: s.lockedUsd, otherChildren: s.otherChildren,
      volume24hUsd: vol?.usd ?? 0, trades24h: vol?.trades ?? 0,
      holderReward: c.holderReward, creatorFeeBps: c.creatorFeeBps, shares: c.shares, updatedAt: Math.floor((c.updatedAt ?? 0) / 1000), // seconds on the coin page; the row holds ms
      curve: c.curve, mayhem: c.mayhem, tracked: c.tracked, ...this.oursOf(c), feePaid: this.feePaidOf(c),
    };
  }

  /**
   * In "ours" mode the counts cover our coins (locked value and volume also include the context
   * ancestors) and `otherChildren` is how many direct children on pump.fun the scope leaves out,
   * so the UI can say "and N other children on pump.fun".
   */
  stats() {
    const sc = this.scope();
    const maxDepth = this.global?.maxCurveDepth ?? 0;
    const byDepth = new Array(Math.max(maxDepth + 1, 1)).fill(0);
    let coins = 0, lockedUsd = 0, otherChildren = 0;
    for (const mint of this.mode === "all" ? sc.inScope : sc.ours) {
      const c = this.coins.get(mint); if (!c) continue;
      coins++;
      if (c.depth < byDepth.length) byDepth[c.depth]++; else byDepth[c.depth] = (byDepth[c.depth] ?? 0) + 1;
    }
    for (const mint of sc.inScope) { const c = this.coins.get(mint); if (!c) continue; const s = this.scoped(c); lockedUsd += s.lockedUsd ?? 0; otherChildren += s.otherChildren; }
    const roots = this.visibleRoots().length;
    let volume24hUsd = 0; for (const [mint, v] of this.volumes()) if (sc.inScope.has(mint)) volume24hUsd += v.usd;
    return { coins, roots, byDepth, lockedUsd, volume24hUsd, solUsd: this.solUsd, maxDepth, backfill: { ...this.backfill }, updatedAt: this.updatedAt, mode: this.mode, ourCoins: sc.ours.size, otherChildren };
  }
}

function inChain(chain, mint) { for (let i = 0; i < chain.length; i++) if (chain[i].mint === mint) return true; return false; }
function stripUndefined(o) { return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)); }
