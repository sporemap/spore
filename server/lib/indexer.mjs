// The indexer: backfill (once, resumable), live log subscription, refresh loop (DESIGN §6).
//
// Shape of the work:
//   backfill  getProgramAccounts per depth → resolve each curve's mint → walk ancestors → mint data
//   live      CreateEvent / TradeEvent / CompleteEvent (+ pump-amm Buy/SellEvent for graduated coins)
//   refresh   hot coins every tick, the whole set on a rolling schedule, SOL price every minute
// All RPC traffic shares one budget (rpc.mjs), so the backfill never starves the live path.
import { PUMP_SDK, PUMP_PROGRAM_ID, PUMP_AMM_PROGRAM_ID, GLOBAL_PDA, QUOTE_CONTROL_PDA, PublicKey, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, NATIVE_MINT,
  bondingCurvePda, canonicalPumpPoolPdaWithQuote, normalizeQuoteMint, feeSharingConfigPda, metaplexPda, pk, b58 } from "./sdk.mjs";
import { BONDING_CURVE_DISCRIMINATOR, decodeCurve, decodeEvent, decodeMint, decodeMetaplex, decodePool, decodeShares, decodeTokenAccount, eventsInLogs, plain } from "./decode.mjs";
import { LogsSubscriber } from "./live.mjs";
import { curvePriceQuote, poolPriceQuote, units } from "./pricing.mjs";

const nowS = () => Math.floor(Date.now() / 1000);
const SOL_MINT = NATIVE_MINT.toBase58(); // encoded once: toBase58() is a base58 encode per call
/** Programs whose events the live subscription acts on; a CPI into another program cannot inject events. */
const LIVE_EVENT_PROGRAMS = new Set([PUMP_PROGRAM_ID.toBase58(), PUMP_AMM_PROGRAM_ID.toBase58()]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chunks = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };
const DEPTH_OFFSET = 141; // BondingCurve.depth (DESIGN §2)
/** Full re-scan of a depth (getProgramAccountsV2 on Helius walks the whole pump key space, ~8 min per depth); the live stream covers the rest. */
const BACKFILL_RESCAN_S = 7 * 24 * 3600;
const SHARES_TTL_S = 6 * 3600;
// On-demand lookups (/api/coin, eligibility) remember whether a mint is a pump coin for this long,
// so a stream of requests for the same mint costs one RPC round, not one per request.
const FETCH_CACHE_MS = 60_000;
const FETCH_CACHE_MAX = 2_000;
// A coin younger than this gets its fee-sharing config re-read on every refresh: a spawn through
// Spore writes the config in (or right after) the create transaction, and the "ours" flag depends on it.
const YOUNG_S = 30 * 60;
// Map stream (DESIGN §11.5): a `pair` is announced at most once per mint within this window (the
// create path and the enrich path both try), and `mapdelta` batches are flushed on this timer with
// at most this many entries each (largest locked value first; the rest carry over).
export const PAIR_DEDUPE_MS = 60_000;
export const MAPDELTA_MS = 3_000;
export const MAPDELTA_MAX = 500;
// Listed quote mints with a CoinGecko id: trees rooted in a coin quoted in one of these get USD
// (and SOL) prices. PUMP is the common case; tokenized stocks have no public price feed here.
const QUOTE_PRICE_IDS = { pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn: "pump-fun" };
const COINGECKO = `https://api.coingecko.com/api/v3/simple/price?ids=${["solana", ...Object.values(QUOTE_PRICE_IDS)].join(",")}&vs_currencies=usd`;

export class Indexer {
  constructor({ rpc, model, meta, hub, log = console, opts = {} }) {
    this.rpc = rpc; this.model = model; this.meta = meta; this.hub = hub; this.log = log;
    this.opts = { backfill: true, backfillLimit: Infinity, refreshMs: 30_000, fullRefreshMs: 20 * 60_000, wsUrl: null, createdAtProbe: true, ...opts };
    this.live = null; this.timers = []; this.stopped = false;
    this.globalRaw = null; this.quoteControlRaw = null; this.globalAt = 0;
    this.hot = new Set(); this.cursor = 0; this.refreshing = false;
    this.fetchCache = new Map(); // mint → { at, found } for fetchCoin
    this.pairSent = new Map();   // mint → when its `pair` event went out (dedupe)
    this.state = { phase: "idle", backfillStartedAt: null, backfillDoneAt: null, lastRefreshAt: null, lastError: null, created: { probed: 0, found: 0 }, map: { pairs: 0, deltas: 0, deltaEntries: 0 } };
  }

  // ---------------------------------------------------------------- lifecycle
  async start() {
    await this.loadGlobal();
    this.live = new LogsSubscriber({ wsUrl: this.opts.wsUrl, programId: PUMP_PROGRAM_ID.toBase58(), log: this.log, onLogs: (n) => this.onLogs(n), onConnect: () => { this.refresh({ reason: "reconnect" }).catch(() => {}); } }).start();
    this.refreshSolUsd().catch(() => {});
    this.timers.push(setInterval(() => this.refreshSolUsd().catch(() => {}), 60_000));
    this.timers.push(setInterval(() => this.refresh({ reason: "tick" }).catch((e) => this.log.warn(`refresh: ${e.message}`)), this.opts.refreshMs));
    this.timers.push(setInterval(() => this.loadGlobal().catch(() => {}), 10 * 60_000));
    this.timers.push(setInterval(() => { try { this.flushMapDelta(); } catch (e) { this.log.warn(`mapdelta: ${e.message}`); } }, MAPDELTA_MS));
    if (this.opts.backfill) this.runBackfill().catch((e) => { this.state.lastError = e.message; this.log.error(`backfill failed: ${e.stack ?? e}`); });
    else { this.model.setBackfill({ done: true, ...this.model.db.backfillStats() }); this.state.phase = "live"; }
  }
  stop() { this.stopped = true; this.live?.stop(); for (const t of this.timers) clearInterval(t); }

  snapshot() { return { ...this.state, backfill: this.model.backfill, rpc: this.rpc.snapshot(), live: this.live?.snapshot() ?? null, meta: this.meta?.snapshot?.() ?? this.meta?.stats ?? null }; }

  // ---------------------------------------------------------------- map stream (DESIGN §11.5)
  /**
   * `pair`: a coin with a tracked parent, both as map nodes, so an open map can add the child (and
   * the root when it is not drawn yet). Sent in both listing modes; at most once per mint per
   * `PAIR_DEDUPE_MS`, since the create path tries before and after the parent chain is pulled.
   * Returns true when an event went out.
   */
  announcePair(mint) {
    const c = this.model.get(mint);
    if (!c || !c.tracked || c.depth < 1 || !c.quoteMint) return false;
    const p = this.model.get(c.quoteMint);
    if (!p || !p.tracked) return false;
    const at = this.pairSent.get(mint);
    if (at != null && Date.now() - at < PAIR_DEDUPE_MS) return false;
    this.pairSent.set(mint, Date.now());
    if (this.pairSent.size > 5_000) for (const [m, t] of this.pairSent) { if (Date.now() - t >= PAIR_DEDUPE_MS) this.pairSent.delete(m); if (this.pairSent.size <= 2_500) break; }
    this.state.map.pairs++;
    // `parentMint` on both halves, as on a `since=` node, so a client that does not hold the parent yet can hang it under its own parent instead of drawing it as a root.
    this.hub?.emit("pair", { coin: { ...this.model.mapRef(c, true), parentMint: p.mint }, parent: { ...this.model.mapRef(p, true), parentMint: p.depth > 0 ? p.quoteMint ?? null : null } });
    return true;
  }
  /**
   * `mapdelta`: the coins whose map node changed since the last flush (trades, refresh ticks,
   * completes, a resolved name or logo), with the numbers and labels a bubble shows. Only sent when
   * something changed; capped at `MAPDELTA_MAX` entries, largest locked value first, the rest wait
   * for the next flush. Returns the payload (null when nothing changed).
   */
  flushMapDelta() {
    const mints = this.model.takeDirty();
    if (!mints.length) return null;
    const entries = [];
    for (const mint of mints) {
      const c = this.model.get(mint);
      if (!c || !c.tracked) continue;
      const r = this.model.mapRef(c, true);
      entries.push({ mint, mcapUsd: r.mcapUsd, lockedUsd: r.lockedUsd, children: r.children, descendants: r.descendants, migrated: r.migrated, name: r.name, symbol: r.symbol, image: r.image });
    }
    if (!entries.length) return null;
    entries.sort((a, b) => (b.lockedUsd ?? -1) - (a.lockedUsd ?? -1));
    if (entries.length > MAPDELTA_MAX) this.model.requeueDirty(entries.splice(MAPDELTA_MAX).map((e) => e.mint));
    const payload = { at: Date.now(), updated: entries };
    this.state.map.deltas++; this.state.map.deltaEntries += entries.length;
    this.hub?.emit("mapdelta", payload);
    return payload;
  }

  /** pump `Global` + `QuoteControl`, kept raw (BN) for the SDK's admission math and plain for the API. */
  async loadGlobal() {
    const [g, qc] = await this.rpc.getMultipleAccounts([GLOBAL_PDA.toBase58(), QUOTE_CONTROL_PDA.toBase58()]);
    if (!g) throw new Error("pump Global account not found");
    this.globalRaw = PUMP_SDK.decodeGlobal({ ...g, owner: pk(g.owner) });
    this.quoteControlRaw = qc ? PUMP_SDK.decodeQuoteControl({ ...qc, owner: pk(qc.owner) }) : null;
    this.globalAt = Date.now();
    const p = plain(this.globalRaw);
    this.model.setGlobal({ maxCurveDepth: p.maxCurveDepth, createV2Enabled: p.createV2Enabled, initialRealTokenReserves: p.initialRealTokenReserves, initialVirtualTokenReserves: p.initialVirtualTokenReserves, initialVirtualSolReserves: p.initialVirtualSolReserves, tokenTotalSupply: p.tokenTotalSupply, whitelistedQuoteMints: p.whitelistedQuoteMints, creatorFeeConfigurable: p.creatorFeeConfigurable, maxConfigurableCreatorFeeBps: p.maxConfigurableCreatorFeeBps, isHolderRewardEnabled: p.isHolderRewardEnabled, quoteControlMints: this.quoteControlRaw ? this.quoteControlRaw.mints.length : 0 });
  }

  async refreshSolUsd() {
    try {
      const r = await fetch(COINGECKO, { signal: AbortSignal.timeout(6_000) });
      if (r.ok) {
        const j = await r.json();
        if (j?.solana?.usd > 0) this.model.setSolUsd(Number(j.solana.usd));
        for (const [mint, id] of Object.entries(QUOTE_PRICE_IDS)) if (j?.[id]?.usd > 0) this.model.setQuoteUsd(mint, Number(j[id].usd));
      }
    } catch { /* keep the last prices (DESIGN §6.3) */ }
  }

  // ---------------------------------------------------------------- backfill
  async runBackfill() {
    const db = this.model.db;
    this.state.phase = "backfill:scan"; this.state.backfillStartedAt = nowS();
    const maxDepth = this.model.global?.maxCurveDepth ?? 0;
    for (let d = 1; d <= maxDepth; d++) {
      const scannedAt = db.backfillGet(`scanned:${d}`, 0);
      if (nowS() - scannedAt < BACKFILL_RESCAN_S) continue;
      const t0 = Date.now();
      const rows = await this.rpc.getProgramAccounts(PUMP_PROGRAM_ID.toBase58(), [
        { memcmp: { offset: 0, bytes: bs58(BONDING_CURVE_DISCRIMINATOR) } },
        { memcmp: { offset: DEPTH_OFFSET, bytes: bs58(Buffer.from([d])) } },
      ]);
      db.transaction(() => {
        for (const { pubkey, account } of rows) {
          let c; try { c = decodeCurve(account.data, pubkey); } catch { continue; }
          db.backfillCurveUpsert({ curve: pubkey, depth: c.depth, quoteMint: c.quoteMint, data: account.data.toString("base64"), graduated: c.complete || c.migrated, rq: Number(BigInt(c.realQuoteReserves)) });
        }
      });
      db.backfillSet(`scanned:${d}`, nowS());
      this.log.info(`backfill: depth ${d}: ${rows.length} curves in ${Date.now() - t0} ms`);
    }
    this.model.setBackfill({ ...db.backfillStats() });

    this.state.phase = "backfill:resolve";
    await this.resolveCurves();
    this.state.phase = "backfill:ancestors";
    await this.ensureAncestors();
    this.state.phase = "backfill:mints";
    await this.ensureMintInfo();
    this.model.setBackfill({ done: true, ...db.backfillStats() });
    this.state.backfillDoneAt = nowS();
    this.log.info(`backfill: done (${this.model.backfill.resolved}/${this.model.backfill.total} curves, ${this.model.coins.size} coins)`);
    this.state.phase = "backfill:enrich";
    await this.ensurePools();
    await this.ensureShares();
    if (this.opts.createdAtProbe) await this.probeCreatedAt();
    this.state.phase = "live";
  }

  /**
   * Turns staged curves into coins. A curve stores no mint, so the token accounts the curve owns
   * are listed (Token-2022 first, SPL Token for older coins): the one whose mint is not the quote
   * mint is the coin's mint. Priority: graduated first, then biggest raise, then deepest, so the
   * leaderboard fills with the coins that matter first. `backfillLimit` bounds dev runs.
   */
  async resolveCurves() {
    const db = this.model.db;
    const limit = this.opts.backfillLimit;
    const concurrency = Math.max(1, this.rpc.concurrency);
    for (;;) {
      if (this.stopped) return;
      const stats = db.backfillStats();
      if (stats.resolved >= limit) { this.log.info(`backfill: BACKFILL_LIMIT=${limit} reached (${stats.resolved} resolved)`); return; }
      const batch = db.backfillPending(Math.min(50, limit - stats.resolved));
      if (!batch.length) return;
      let i = 0;
      await Promise.all(Array.from({ length: Math.min(concurrency, batch.length) }, async () => {
        while (i < batch.length && !this.stopped) {
          const row = batch[i++];
          try { await this.resolveOne(row); } catch (e) { db.backfillFail(row.curve, e.message); this.log.warn(`backfill: ${row.curve}: ${e.message}`); }
        }
      }));
      this.model.setBackfill({ ...db.backfillStats() });
    }
  }

  async resolveOne(row) {
    const db = this.model.db;
    const curve = decodeCurve(Buffer.from(row.data, "base64"), row.curve);
    // Already known (live CreateEvent or a child's quote mint pointed here): no RPC needed.
    const known = this.model.byCurve(row.curve);
    if (known) { db.backfillResolve(row.curve, known.mint); return; }
    let accounts = await this.rpc.getTokenAccountsByOwner(row.curve, TOKEN_2022_PROGRAM_ID.toBase58());
    if (!accounts.some((a) => a.mint !== curve.quoteMint)) accounts = accounts.concat(await this.rpc.getTokenAccountsByOwner(row.curve, TOKEN_PROGRAM_ID.toBase58()));
    const base = accounts.find((a) => a.mint !== curve.quoteMint);
    if (!base) throw new Error("no base token account on the curve");
    this.model.setMint({ mint: base.mint, tokenProgram: base.tokenProgram });
    this.model.upsertCoin({ mint: base.mint, ...curve, tracked: true });
    db.backfillResolve(row.curve, base.mint);
    // The parent curve is now identified for free: its mint is this coin's quote mint.
    if (curve.quoteMint) this.#resolveByMint(curve.quoteMint);
  }
  #resolveByMint(mint) {
    const db = this.model.db;
    const key = bondingCurvePda(mint).toBase58();
    const row = db.backfillCurve(key);
    if (!row || row.resolvedAt) return;
    const curve = decodeCurve(Buffer.from(row.data, "base64"), key);
    this.model.upsertCoin({ mint, ...curve, tracked: true });
    db.backfillResolve(key, mint);
  }

  /** Every tracked coin's quote-mint chain down to depth 0 lives in the model (DESIGN §6.1). */
  async ensureAncestors({ rpc = this.rpc } = {}) {
    for (let round = 0; round <= 6; round++) {
      const missing = new Set();
      for (const c of this.model.coins.values()) if (c.quoteMint && !this.model.coins.has(c.quoteMint) && !this.#isListedQuote(c.quoteMint)) missing.add(c.quoteMint);
      if (!missing.size) return;
      const mints = [...missing];
      const infos = await rpc.getMultipleAccounts(mints.map((m) => bondingCurvePda(m).toBase58()));
      let added = 0;
      infos.forEach((info, i) => {
        if (!info || info.owner !== PUMP_PROGRAM_ID.toBase58()) return;
        try { this.model.upsertCoin({ mint: mints[i], ...decodeCurve(info.data, bondingCurvePda(mints[i])), tracked: true }); added++; } catch { /* not a curve */ }
      });
      this.log.info(`backfill: ancestors round ${round}: ${added}/${mints.length} added`);
      if (!added) return;
    }
  }
  #isListedQuote(mint) {
    return mint === SOL_MINT || (this.model.global?.whitelistedQuoteMints ?? []).includes(mint) || !!this.quoteControlRaw?.mints.some((m) => m.mint.toBase58() === mint);
  }

  /**
   * Decimals, token program and on-chain name/symbol/uri for every mint we reference (coins and
   * their non-SOL quote mints). Token-2022 mints carry metadata in the mint account itself; SPL
   * mints fall back to the Metaplex PDA. Then the off-chain JSON is queued (lazy, cached).
   */
  async ensureMintInfo(only = null, { rpc = this.rpc } = {}) {
    const wanted = new Set();
    const consider = (m) => { if (!m || m === SOL_MINT) return; const info = this.model.mint(m); if (!info || info.decimals == null || !info.onchainAt) wanted.add(m); };
    for (const c of only ?? this.model.coins.values()) { consider(c.mint); consider(c.quoteMint); }
    const mints = [...wanted];
    const needMetaplex = [];
    for (const part of chunks(mints, 100)) {
      const infos = await rpc.getMultipleAccounts(part);
      infos.forEach((info, i) => {
        const mint = part[i];
        if (!info) { this.model.setMint({ mint, onchainAt: nowS() }); return; }
        const m = decodeMint(info.data, info.owner);
        if (!m) { this.model.setMint({ mint, onchainAt: nowS() }); return; }
        this.model.setMint({ mint, decimals: m.decimals, tokenProgram: m.tokenProgram, supply: m.supply, ...(m.metadata ?? {}), onchainAt: m.metadata ? nowS() : 0 });
        if (!m.metadata) needMetaplex.push(mint);
      });
    }
    for (const part of chunks(needMetaplex, 100)) {
      const infos = await rpc.getMultipleAccounts(part.map((m) => metaplexPda(m).toBase58()));
      infos.forEach((info, i) => { const md = info ? decodeMetaplex(info.data) : null; this.model.setMint({ mint: part[i], ...(md ?? {}), onchainAt: nowS() }); });
    }
    for (const m of mints) { const uri = this.model.mint(m)?.uri; if (uri) this.meta?.request(uri); }
    if (mints.length) this.log.info(`mints: ${mints.length} fetched (${needMetaplex.length} via Metaplex)`);
  }

  /** Canonical pool + vault balances for migrated coins (the price and locked source after graduation). */
  async ensurePools(only = null, { rpc = this.rpc } = {}) {
    const coins = [...(only ?? this.model.coins.values())].filter((c) => c.migrated && !c.poolQuoteVault);
    for (const part of chunks(coins, 100)) {
      const pools = part.map((c) => canonicalPumpPoolPdaWithQuote(pk(c.mint), normalizeQuoteMint(c.quoteMint ? pk(c.quoteMint) : null)).toBase58());
      const infos = await rpc.getMultipleAccounts(pools);
      infos.forEach((info, i) => {
        const p = info ? decodePool(info.data) : null;
        if (p) this.model.upsertCoin({ mint: part[i].mint, pool: pools[i], poolBaseVault: p.baseVault, poolQuoteVault: p.quoteVault });
      });
    }
    await this.refreshVaults(coins.map((c) => this.model.get(c.mint)).filter((c) => c?.poolQuoteVault), { rpc });
  }
  async refreshVaults(coins, { rpc = this.rpc } = {}) {
    const withPool = coins.filter((c) => c.poolBaseVault && c.poolQuoteVault);
    for (const part of chunks(withPool, 50)) {
      const infos = await rpc.getMultipleAccounts(part.flatMap((c) => [c.poolBaseVault, c.poolQuoteVault]));
      part.forEach((c, i) => {
        const base = infos[2 * i] ? decodeTokenAccount(infos[2 * i].data) : null, quote = infos[2 * i + 1] ? decodeTokenAccount(infos[2 * i + 1].data) : null;
        if (base && quote) this.model.upsertCoin({ mint: c.mint, poolBase: base.amount, poolQuote: quote.amount, refreshedAt: nowS() });
      });
    }
  }

  /** Fee-sharing configs (pump-fees) for depth ≥ 1 coins; re-read every 6 h, or now with `force`. */
  async ensureShares(only = null, { force = false } = {}) {
    // Children always; a root (depth 0) only when it can be one of ours: reported through /api/spawned
    // (feePaid set), listed or pending, or already carrying a config. Plain pump.fun roots never need it.
    const wants = (c) => c.depth >= 1 || c.feePaid != null || c.shares != null || this.model.isOurCoin(c);
    const coins = [...(only ?? this.model.coins.values())].filter((c) => wants(c) && (force || nowS() - (c.sharesAt ?? 0) > SHARES_TTL_S));
    for (const part of chunks(coins, 100)) {
      const infos = await this.rpc.getMultipleAccounts(part.map((c) => feeSharingConfigPda(pk(c.mint)).toBase58()));
      infos.forEach((info, i) => this.model.upsertCoin({ mint: part[i].mint, shares: info ? decodeShares(info.data) : null, sharesAt: nowS() }));
    }
    if (coins.length) this.model.sweepPending(); // a config naming the platform confirms a pending spawn
  }
  isYoung(c) { return c.createdAt != null && nowS() - c.createdAt < YOUNG_S; }

  /**
   * A spawn the API verified on-chain (POST /api/spawned, lib/spawned.mjs): insert it from its own
   * CreateEvent when given (roots included — the launch tab defaults to a SOL-quoted root, which the
   * live path ignores), make sure it is tracked, record the launch fee it paid, read its
   * fee-sharing config right away and keep it hot. Returns the coin, or null when the mint has no
   * bonding curve (yet): the pending flag still holds it in the feed for a few minutes. Only verified
   * spawns reach this method, which is what justifies tracking a coin on the caller's word.
   */
  async adopt(mint, { create = null, slot = null, feePaid = null } = {}) {
    if (create && create.mint === mint) this.#insertCreate(create, slot, feePaid != null ? { feePaid: String(feePaid) } : {});
    let c = this.model.get(mint);
    if (!c) { try { c = await this.fetchCoin(mint); } catch (e) { this.log.warn(`adopt ${mint}: ${e.message}`); } }
    if (!c) return null;
    if (!c.tracked || (feePaid != null && c.feePaid == null)) c = this.model.upsertCoin({ mint, tracked: true, createdAt: c.createdAt ?? nowS(), createdProbe: true, ...(feePaid != null ? { feePaid: String(feePaid) } : {}) });
    try { await this.#enrich(mint, c.quoteMint); } catch (e) { this.log.warn(`adopt ${mint}: ${e.message}`); }
    this.hot.add(mint);
    const fresh = this.model.get(mint);
    if (fresh && this.model.isOurCoin(fresh)) this.hub?.emit("coin", this.model.view(fresh));
    this.announcePair(mint);
    return fresh;
  }

  /**
   * Creation time for backfilled coins: the oldest signature on the curve. One call for a coin with
   * under 1 000 transactions; busier coins get up to three more pages, then give up (null stays).
   */
  async probeCreatedAt() {
    const todo = [...this.model.coins.values()].filter((c) => c.tracked && c.createdAt == null && !c.createdProbe)
      .sort((a, b) => b.depth - a.depth || Number(BigInt(b.realQuoteReserves)) - Number(BigInt(a.realQuoteReserves)));
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(2, todo.length) }, async () => {
      while (i < todo.length && !this.stopped) {
        const c = todo[i++];
        try {
          let before, oldest = null, pages = 0, full = true;
          while (full && pages < 4) {
            const sigs = await this.rpc.getSignaturesForAddress(c.curve, before ? { before } : {});
            pages++;
            if (sigs.length) { oldest = sigs[sigs.length - 1]; before = oldest.signature; }
            full = sigs.length >= 1000;
          }
          this.state.created.probed++;
          if (oldest && !full) { this.state.created.found++; this.model.upsertCoin({ mint: c.mint, createdAt: oldest.blockTime ?? null, createdSlot: oldest.slot ?? null, createdProbe: true }); }
          else this.model.upsertCoin({ mint: c.mint, createdProbe: true });
        } catch (e) { this.log.warn(`createdAt ${c.mint}: ${e.message}`); }
      }
    }));
    if (todo.length) this.log.info(`createdAt: ${this.state.created.found}/${todo.length} resolved`);
  }

  // ---------------------------------------------------------------- live
  onLogs({ slot, signature, err, logs }) {
    if (err) return;
    const events = eventsInLogs(logs, LIVE_EVENT_PROGRAMS);
    if (!events.length) return;
    events.forEach(({ name, data }, idx) => {
      try {
        if (name === "CreateEvent") this.#onCreate(decodeEvent(name, data), slot);
        else if (name === "TradeEvent") { if (this.model.coins.has(peekMint(data))) this.#onTrade(decodeEvent(name, data), signature, slot, idx); }
        else if (name === "CompleteEvent") { const e = decodeEvent(name, data); if (this.model.coins.has(e.mint)) this.#onComplete(e); }
        else if (name === "BuyEvent" || name === "SellEvent") { const e = decodeEvent(name, data); const mint = this.model.pools.get(e.pool); if (mint) this.#onPoolTrade(mint, e, signature, slot, idx); }
      } catch (e) { this.state.lastError = `${name}: ${e.message}`; }
    });
  }

  #onCreate(e, slot) {
    // Depth 0 coins are only interesting as parents; a depth ≥ 1 coin is a spawn and joins the tree.
    if (e.depth < 1) return;
    this.#insertCreate(e, slot);
    // The map hears about the pair at once when the parent is already tracked (both modes), and
    // after the parent chain is pulled otherwise (announcePair dedupes the second try).
    this.announcePair(e.mint);
    // In "ours" mode a spawn is announced only once its sharing config names the platform (or the
    // UI reported it); the config lands in the same transaction, so it is read right away.
    const emit = () => { const c = this.model.get(e.mint); if (c && (this.model.mode === "all" || this.model.isOurCoin(c))) this.hub?.emit("coin", this.model.view(c)); this.announcePair(e.mint); };
    this.#enrich(e.mint, e.quoteMint).catch((x) => this.log.warn(`create ${e.mint}: ${x.message}`)).finally(emit);
    this.log.info(`live: spawn ${e.symbol} (${e.mint}) depth ${e.depth} under ${e.quoteMint ?? "SOL"}`);
  }
  /** The coin a CreateEvent describes, straight into the tree (no RPC): curve state at creation, mint data, metadata queued. */
  #insertCreate(e, slot, extra = {}) {
    const quoted = e.virtualQuoteReserves !== "0";
    this.model.upsertCoin({
      mint: e.mint, curve: e.bondingCurve, depth: e.depth, quoteMint: e.quoteMint, creator: e.creator, tracked: true,
      virtualTokenReserves: e.virtualTokenReserves, virtualQuoteReserves: quoted ? e.virtualQuoteReserves : e.virtualSolReserves,
      realTokenReserves: e.realTokenReserves, realQuoteReserves: "0", tokenTotalSupply: e.tokenTotalSupply, initialVirtualQuoteReserves: quoted ? e.virtualQuoteReserves : e.virtualSolReserves,
      complete: false, migrated: false, mayhem: !!e.isMayhemMode, holderReward: !!e.isHolderReward, creatorFeeBps: e.creatorFeeBps,
      createdAt: e.timestamp, createdSlot: slot ?? null, createdProbe: true, ...extra,
    });
    this.model.setMint({ mint: e.mint, decimals: 6, tokenProgram: e.tokenProgram, name: e.name || null, symbol: e.symbol || null, uri: e.uri || null, onchainAt: nowS() });
    if (e.uri) this.meta?.request(e.uri, { front: true });
    this.hot.add(e.mint);
  }
  /** Unknown parent (a depth-0 coin that just became one): pull its chain; then mint data and the sharing config of the coin itself. */
  async #enrich(mint, quoteMint) {
    if (quoteMint && !this.model.coins.has(quoteMint)) await this.ensureAncestors();
    // A parent that was only looked at on demand (untracked, memory only) is a parent now: it
    // joins the tree so the map and the leaderboard can draw the pair.
    const parent = quoteMint ? this.model.get(quoteMint) : null;
    if (parent && !parent.tracked) this.model.upsertCoin({ mint: quoteMint, tracked: true });
    const self = [this.model.get(mint)].filter(Boolean);
    await this.ensureMintInfo(self);
    await this.ensureShares(self, { force: true });
  }

  #onTrade(e, sig, slot, idx) {
    const coin = this.model.get(e.mint);
    if (!coin || coin.migrated) return;
    const c = this.model.upsertCoin({ mint: e.mint, virtualQuoteReserves: e.virtualQuoteReserves, virtualTokenReserves: e.virtualTokenReserves, realQuoteReserves: e.realQuoteReserves, realTokenReserves: e.realTokenReserves });
    const baseDecimals = this.model.decimalsOf(c.mint), quoteDecimals = this.model.quoteDecimals(c);
    const priceQuote = curvePriceQuote(c, baseDecimals, quoteDecimals) ?? (units(e.quoteAmount, quoteDecimals) / Math.max(units(e.tokenAmount, baseDecimals), 1e-12));
    this.#recordTrade(c, { sig, idx, slot: slot ?? 0, time: e.timestamp || nowS(), isBuy: e.isBuy, user: e.user, baseAmount: e.tokenAmount, quoteAmount: e.quoteAmount, priceQuote });
  }
  #onPoolTrade(mint, e, sig, slot, idx) {
    const c = this.model.upsertCoin({ mint, poolBase: e.poolBaseReserves, poolQuote: e.poolQuoteReserves });
    const baseDecimals = this.model.decimalsOf(mint), quoteDecimals = this.model.quoteDecimals(c);
    const priceQuote = poolPriceQuote(e.poolQuoteReserves, e.poolBaseReserves, baseDecimals, quoteDecimals);
    if (priceQuote == null) return;
    this.#recordTrade(c, { sig, idx, slot: slot ?? 0, time: e.timestamp || nowS(), isBuy: e.isBuy, user: e.user, baseAmount: e.baseAmount, quoteAmount: e.quoteAmount, priceQuote });
  }
  #recordTrade(c, t) {
    // One coin's chain, not the whole forest: the upsert just bumped the version, and a full
    // recompute per trade (≈ 90 ms at 15k coins) would eat the live path.
    const d = this.model.priceOf(c.mint);
    const quoteUsd = this.#quoteUsd(c);
    const trade = { ...t, mint: c.mint, priceUsd: d?.priceUsd ?? null, valueUsd: quoteUsd != null ? units(t.quoteAmount, this.model.quoteDecimals(c)) * quoteUsd : null };
    this.model.recordTrade(trade);
    this.hot.add(c.mint);
    this.hub?.emit("trade", { sig: trade.sig, mint: trade.mint, slot: trade.slot, time: trade.time, isBuy: trade.isBuy, user: trade.user, baseAmount: trade.baseAmount, quoteAmount: trade.quoteAmount, priceQuote: trade.priceQuote, priceUsd: trade.priceUsd, valueUsd: trade.valueUsd });
  }
  #quoteUsd(c) { return this.model.quoteUsdOf(c.quoteMint); }
  #onComplete(e) {
    const c = this.model.upsertCoin({ mint: e.mint, complete: true });
    this.hot.add(e.mint);
    this.hub?.emit("coin", this.model.view(c));
    this.log.info(`live: ${e.mint} completed its curve`);
  }

  // ---------------------------------------------------------------- refresh loop
  /**
   * One tick: hot coins (live activity or API views in the last two minutes) plus a rolling slice
   * of every tracked coin sized so the whole set is re-read once per `fullRefreshMs`. Curves come
   * from one getMultipleAccounts per 100; migrated coins also get their vault balances.
   */
  async refresh({ reason = "tick" } = {}) {
    if (this.refreshing || this.stopped) return;
    this.refreshing = true;
    try {
      const all = this.model.tracked();
      const perTick = Math.max(50, Math.ceil(all.length * this.opts.refreshMs / this.opts.fullRefreshMs));
      const slice = all.length ? Array.from({ length: Math.min(perTick, all.length) }, (_, i) => all[(this.cursor + i) % all.length]) : [];
      this.cursor = all.length ? (this.cursor + slice.length) % all.length : 0;
      const recent = Date.now() - 120_000;
      // Views older than the hot window are dead weight; on-demand coins nobody looks at any more leave memory.
      this.model.pruneTouched(120_000);
      this.model.evictUntracked();
      // Hot = live activity, recent API views, spawns the UI reported (pending "ours") and young coins:
      // all of them get their curve and sharing config re-read every tick.
      const hotMints = new Set([...this.hot, ...[...this.model.touched].filter(([, t]) => t > recent).map(([m]) => m), ...this.model.pendingMints()]);
      this.hot.clear();
      for (const c of all) if (this.isYoung(c)) hotMints.add(c.mint);
      const set = new Map(slice.map((c) => [c.mint, c]));
      for (const m of hotMints) { const c = this.model.get(m); if (c) set.set(m, c); }
      const coins = [...set.values()];
      if (!coins.length) return;
      const newlyMigrated = new Set();
      for (const part of chunks(coins, 100)) {
        const infos = await this.rpc.getMultipleAccounts(part.map((c) => c.curve));
        infos.forEach((info, i) => {
          if (!info) return;
          try {
            const cur = decodeCurve(info.data, part[i].curve);
            const wasMigrated = part[i].migrated;
            this.model.upsertCoin({ mint: part[i].mint, ...cur, refreshedAt: nowS() });
            if (cur.migrated && !wasMigrated) newlyMigrated.add(part[i].mint);
          } catch { /* account changed type; keep the last state */ }
        });
      }
      // Re-read the model: the objects in `coins` predate the upserts above.
      const fresh = coins.map((c) => this.model.get(c.mint)).filter(Boolean);
      await this.ensurePools(fresh.filter((c) => newlyMigrated.has(c.mint) || (c.migrated && !c.poolQuoteVault)));
      await this.refreshVaults(fresh.filter((c) => c.migrated && c.poolQuoteVault && !newlyMigrated.has(c.mint)));
      await this.ensureMintInfo(fresh);
      await this.ensureShares(fresh.filter((c) => hotMints.has(c.mint) || nowS() - (c.sharesAt ?? 0) > SHARES_TTL_S), { force: true });
      for (const c of coins) { const uri = this.model.mint(c.mint)?.uri; if (uri) this.meta?.request(uri, { front: hotMints.has(c.mint) }); }
      this.state.lastRefreshAt = nowS();
      this.hub?.emit("stats", this.model.stats());
    } finally { this.refreshing = false; }
  }

  // ---------------------------------------------------------------- on-demand (API)
  /**
   * Live curve state for one mint (used by eligibility and unknown-coin lookups); null when it is
   * not a pump coin. `rpc` lets request-driven callers use the "api" lane. The verdict is remembered
   * for a minute: a positive one serves the model's copy, a negative one answers without the chain.
   */
  async fetchCoin(mint, { rpc = this.rpc } = {}) {
    const hit = this.fetchCache.get(mint);
    if (hit && Date.now() - hit.at < FETCH_CACHE_MS) {
      if (!hit.found) return null;
      const cached = this.model.get(mint);
      if (cached) return cached;
    }
    const result = await this.#fetchCoin(mint, rpc);
    this.fetchCache.set(mint, { at: Date.now(), found: !!result });
    if (this.fetchCache.size > FETCH_CACHE_MAX) this.fetchCache.delete(this.fetchCache.keys().next().value);
    return result;
  }
  async #fetchCoin(mint, rpc) {
    const curveKey = bondingCurvePda(mint).toBase58();
    const [info, mintInfo] = await rpc.getMultipleAccounts([curveKey, mint]);
    if (!info || info.owner !== PUMP_PROGRAM_ID.toBase58()) return null;
    const cur = decodeCurve(info.data, curveKey);
    const m = mintInfo ? decodeMint(mintInfo.data, mintInfo.owner) : null;
    if (m) this.model.setMint({ mint, decimals: m.decimals, tokenProgram: m.tokenProgram, supply: m.supply, ...(m.metadata ?? {}), onchainAt: m.metadata ? nowS() : 0 });
    const known = this.model.get(mint);
    // A coin we did not track yet (a depth-0 coin without children) is kept untracked: it shows on its
    // own page and in eligibility but stays out of the feed and the leaderboard until it has a child.
    const c = this.model.upsertCoin({ mint, ...cur, tracked: known ? known.tracked : false, refreshedAt: nowS() });
    if (c.quoteMint && !this.model.coins.has(c.quoteMint)) await this.ensureAncestors({ rpc });
    if (!m?.metadata) await this.ensureMintInfo([c], { rpc });
    if (c.migrated && !c.poolQuoteVault) await this.ensurePools([c], { rpc }); else if (c.migrated) await this.refreshVaults([c], { rpc });
    return this.model.get(mint);
  }
}

/** base58 of raw bytes for memcmp filters (bs58 is a transitive dependency; a tiny encoder avoids relying on it). */
export function bs58(buf) {
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = 0n; for (const b of buf) n = n * 256n + BigInt(b);
  let out = ""; while (n > 0n) { out = ALPHABET[Number(n % 58n)] + out; n /= 58n; }
  for (const b of buf) { if (b !== 0) break; out = "1" + out; }
  return out;
}
/** The `mint` field of a TradeEvent is its first field: 32 bytes after the discriminator. */
export const peekMint = (data) => new PublicKey(data.subarray(8, 40)).toBase58();
