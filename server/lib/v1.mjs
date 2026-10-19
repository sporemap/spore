// Partner API v1 (DESIGN §12): the Spore map data for other trading terminals, read-only and
// versioned under /v1. Nothing here signs, sends or accepts a transaction: every route is a GET
// over the in-memory model (plus the live pump.fun lookup /api/coin already does for an unknown
// mint), and anything that is not GET/HEAD/OPTIONS is a 405.
//
// Tiers: no key = public (per client IP), a valid `X-API-Key` = partner (per key), an invalid or
// revoked key = 401. Each tier has a request budget per minute and a cap on concurrent streams;
// both are counted here, before any route runs, and reported in X-RateLimit-* / X-Spore-Tier.
// Responses are cacheable by a CDN for a few seconds (the data moves every refresh tick anyway),
// which is how Cloudflare absorbs a terminal that polls every coin page it shows.
//
// Images: the model hands out same-origin proxy paths (`/api/img?u=…`); a partner page lives on
// another origin, so every image in a /v1 body is made absolute against PUBLIC_URL.
import express from "express";
import { v1Cors, RateLimiter, sendCachedJson, sendPrepared, prepareJson, prepareJsonText } from "./http.mjs";
import { openApiDoc } from "./openapi.mjs";

export const DEFAULT_PUBLIC_URL = "https://sporepad.com";
export const V1_CACHE = "public, max-age=5, s-maxage=10";
export const V1_DOC_CACHE = "public, max-age=300, s-maxage=3600";
/** Stream event types a client may ask for; `heat` is derived here from each trade (the per-mint row of /v1/heat). */
export const V1_STREAM_TYPES = ["pair", "trade", "heat", "stats", "mapdelta", "coin"];
export const V1_DEFAULT_TYPES = ["pair", "trade", "heat", "stats"];
/** Every route this module serves, in OpenAPI path syntax (the OpenAPI test checks each is documented). */
export const V1_ROUTES = ["/v1/coin/{mint}/family", "/v1/tree/{mint}", "/v1/map", "/v1/heat", "/v1/stream", "/v1/openapi.json"];
export const V1_DEFAULTS = { publicPerMin: 60, partnerPerMin: 1200, publicStreams: 2, partnerStreams: 20, maxStreams: 2_000, heartbeatMs: 25_000, maxBuffered: 256 * 1024 };
const FAMILY_TOP = 20;
const FAMILY_CACHE_MS = 5_000;
const TREE_CACHE_MS = 10_000;
const TREE_MAX_NODES = 50_000;
const DAY_S = 86_400;
const HUB_EVENTS = new Set(["pair", "trade", "stats", "mapdelta", "coin"]);
const byLocked = (a, b) => (b.lockedUsd ?? -1) - (a.lockedUsd ?? -1) || (b.mcapUsd ?? -1) - (a.mcapUsd ?? -1);

/**
 * Builds the /v1 router plus the stream it owns. `isMint` comes from api.mjs (same validation as
 * /api); `apiRpc` is the api RPC lane, so a partner's unknown-mint lookups never touch the indexer's.
 */
export function createV1({ model, indexer, apiRpc, hub, meta = null, apiKeys, isMint, publicUrl = DEFAULT_PUBLIC_URL, limits = {}, log = console, now = Date.now }) {
  const cfg = { ...V1_DEFAULTS, ...stripNullish(limits) };
  const base = String(publicUrl).replace(/\/+$/, "");
  const abs = (u) => (typeof u === "string" && u.startsWith("/") ? base + u : u ?? null);
  const coinRef = (c) => { const r = model.ref(c); return { mint: r.mint, name: r.name, symbol: r.symbol, image: abs(r.image), depth: r.depth }; };
  const links = (mint) => ({ spore: `${base}/c/${mint}`, launchUnder: `${base}/launch?parent=${mint}`, embed: `${base}/embed/tree/${mint}` });
  const nowS = () => Math.floor(now() / 1000);

  const pub = new RateLimiter({ limit: cfg.publicPerMin, windowMs: 60_000, now });
  const partner = new RateLimiter({ limit: cfg.partnerPerMin, windowMs: 60_000, now });
  const stream = new V1Stream({ model, hub, abs, cfg, isMint });
  const familyCache = new Map(); // mint → { at, body }
  const treeCache = new Map();   // root mint (+ the asked mint when it is off-tree) → { at, version, prepared }
  const mapPrepared = new WeakMap(); // model map entry → its /v1 bytes (absolute image URLs)
  const docPrepared = prepareJson(openApiDoc({ publicUrl: base, limits: cfg }));

  // ------------------------------------------------------------ tiers
  const rateHeaders = (res, r, tier, windowS = 60) => {
    res.setHeader("x-ratelimit-limit", String(r.limit));
    res.setHeader("x-ratelimit-remaining", String(r.remaining));
    res.setHeader("x-ratelimit-reset", String(Math.ceil(r.resetAt / 1000)));
    res.setHeader("x-ratelimit-policy", `${r.limit};w=${windowS};name=${tier}`);
  };
  const tooMany = (res, r, tier) => {
    const retryAfter = Math.max(1, Math.ceil((r.resetAt - now()) / 1000));
    res.setHeader("retry-after", String(retryAfter));
    return res.status(429).json({ error: `rate limited (${tier} tier: ${r.limit} requests per minute), try again in ${retryAfter} s`, retryAfter, tier });
  };
  function auth(req, res, next) {
    const header = req.get("x-api-key");
    let key = typeof header === "string" && header.trim() !== "" ? header.trim() : null;
    if (key == null && req.query.key != null && req.query.key !== "") {
      // A key in a URL ends up in browser history, proxies and CDN logs; only EventSource, which
      // cannot set headers, gets to use it.
      if (req.path !== "/stream") return res.status(400).json({ error: "send the API key in the X-API-Key header (?key= is accepted only on /v1/stream)" });
      key = String(req.query.key);
    }
    let rec = null;
    if (key != null) {
      rec = apiKeys?.verify(key) ?? null;
      if (!rec) {
        // A wrong key is paid for from the caller's public budget, so guessing is bounded like any anonymous traffic.
        const r = pub.check(`ip:${req.ip}`);
        res.setHeader("x-spore-tier", "public");
        rateHeaders(res, r, "public");
        if (!r.ok) return tooMany(res, r, "public");
        return res.status(401).json({ error: "invalid or revoked API key" });
      }
    }
    const tier = rec ? "partner" : "public";
    const r = rec ? partner.check(`key:${rec.id}`) : pub.check(`ip:${req.ip}`);
    res.setHeader("x-spore-tier", tier);
    rateHeaders(res, r, tier);
    if (!r.ok) return tooMany(res, r, tier);
    if (rec) apiKeys.count(rec.id);
    req.v1 = { tier, keyId: rec?.id ?? null, streamKey: rec ? `key:${rec.id}` : `ip:${req.ip}` };
    next();
  }

  // ------------------------------------------------------------ builders
  /** The coin itself, from the index, or looked up live like /api/coin (null = not a pump.fun coin). */
  async function lookup(mint) {
    let c = model.get(mint);
    if (!c) c = await indexer.fetchCoin(mint, { rpc: apiRpc });
    if (c) { const uri = model.mint(mint)?.uri; if (uri && !model.meta.has(uri)) meta?.request?.(uri); }
    return c ?? null;
  }
  /**
   * Percent price change over 24 h: the current price against the last trade at or before 24 h ago
   * (or the first trade inside the window when the history starts there), in USD when both prices
   * have one, else in quote units. Null when the coin has no recorded trade.
   */
  function change24h(c) {
    const ref = model.db.priceRef(c.mint, nowS() - DAY_S);
    if (!ref) return null;
    const p = model.computed().get(c.mint) ?? {};
    let v = null;
    if (p.priceUsd != null && ref.priceUsd > 0) v = p.priceUsd / ref.priceUsd - 1;
    else if (p.priceQuote != null && ref.priceQuote > 0) v = p.priceQuote / ref.priceQuote - 1;
    return v != null && Number.isFinite(v) ? Math.round(v * 10_000) / 100 : null;
  }
  function family(c) {
    const hit = familyCache.get(c.mint);
    if (hit && now() - hit.at < FAMILY_CACHE_MS) return hit.body;
    const anc = model.ancestors(c.mint);
    const root = anc.length ? anc[anc.length - 1] : c;
    const self = model.mapRef(c, true);
    const kids = model.childrenOf(c.mint).map((k) => model.mapRef(k, true)).sort(byLocked);
    const body = {
      mint: c.mint, name: self.name, symbol: self.symbol, image: abs(self.image), depth: c.depth,
      quoteMint: c.quoteMint ?? null, quoteSymbol: model.quoteSymbol(c),
      root: coinRef(root), parent: anc[0] ? coinRef(anc[0]) : null, ancestors: anc.map(coinRef),
      children: { count: kids.length, top: kids.slice(0, FAMILY_TOP).map((k) => ({ mint: k.mint, name: k.name, symbol: k.symbol, image: abs(k.image), depth: k.depth, mcapUsd: k.mcapUsd, lockedUsd: k.lockedUsd })) },
      descendants: self.descendants, lockedUsd: self.lockedUsd, mcapUsd: self.mcapUsd,
      change24h: change24h(c), trades1h: model.activity?.get(c.mint)?.t1h ?? 0,
      launchedOnSpore: model.isOurCoin(c),
      links: links(c.mint),
    };
    familyCache.set(c.mint, { at: now(), body });
    if (familyCache.size > 2_000) familyCache.delete(familyCache.keys().next().value);
    return body;
  }
  /**
   * The whole tree that contains `c`, from its root: the root first, then breadth-first, siblings by
   * locked value. A coin the index does not track (looked up live) is appended with its chain so the
   * caller always finds the coin it asked for.
   */
  function tree(c) {
    const anc = model.ancestors(c.mint);
    const root = anc.length ? anc[anc.length - 1] : c;
    const cached = (k) => { const h = treeCache.get(k); return h && (h.version === model.version || now() - h.at < TREE_CACHE_MS) ? h : null; };
    const hit = cached(root.mint) ?? cached(`${root.mint}+${c.mint}`);
    if (hit && hit.mints.has(c.mint)) return hit.prepared;
    const nodes = [], mints = new Set();
    const push = (x, parentMint, n = model.mapRef(x, true)) => { n.image = abs(n.image); n.parentMint = parentMint; nodes.push(n); mints.add(x.mint); };
    push(root, null);
    for (let i = 0; i < nodes.length && nodes.length < TREE_MAX_NODES; i++) {
      const parent = nodes[i].mint;
      const kids = model.childrenOf(parent).filter((k) => !mints.has(k.mint)).map((k) => ({ k, n: model.mapRef(k, true) })).sort((a, b) => byLocked(a.n, b.n));
      for (const { k, n } of kids) { if (nodes.length >= TREE_MAX_NODES) break; push(k, parent, n); }
    }
    let key = root.mint;
    if (!mints.has(c.mint)) {
      key = `${root.mint}+${c.mint}`;
      for (const x of [...anc].reverse().concat(c)) if (!mints.has(x.mint)) push(x, x.quoteMint ?? null);
    }
    const prepared = prepareJson({ root: coinRef(root), nodes, total: nodes.length });
    treeCache.set(key, { at: now(), version: model.version, prepared, mints });
    if (treeCache.size > 256) treeCache.delete(treeCache.keys().next().value);
    return prepared;
  }
  const absImagesText = (text) => text.replaceAll('"image":"/api/img?', `"image":"${base}/api/img?`);

  // ------------------------------------------------------------ routes
  const router = express.Router();
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  router.use(v1Cors());
  router.use((req, res, next) => {
    res.setHeader("cache-control", "no-store"); // errors and the stream; cacheable bodies override it
    if (req.method === "GET" || req.method === "HEAD") return next();
    res.setHeader("allow", "GET, HEAD, OPTIONS");
    res.status(405).json({ error: "the Spore API is read-only: GET only" });
  });
  router.use(auth);
  const coinRoute = (build) => wrap(async (req, res) => {
    const { mint } = req.params;
    if (!isMint(mint)) return res.status(400).json({ error: "invalid mint" });
    let c;
    try { c = await lookup(mint); }
    catch (e) { log.warn?.(`v1: lookup ${mint} failed: ${e.message}`); res.setHeader("retry-after", "5"); return res.status(503).json({ error: "pump.fun lookup unavailable, retry shortly", retryAfter: 5 }); }
    if (!c) return res.status(404).json({ error: "not a pump.fun coin" });
    build(req, res, c);
  });
  router.get("/coin/:mint/family", coinRoute((req, res, c) => sendCachedJson(req, res, family(c), { cacheControl: V1_CACHE })));
  router.get("/tree/:mint", coinRoute((req, res, c) => sendPrepared(req, res, tree(c), { cacheControl: V1_CACHE })));
  router.get("/map", (req, res) => {
    const raw = req.query.since;
    let since = raw != null && raw !== "" ? Number(raw) : null;
    if (since != null && !Number.isFinite(since)) return res.status(400).json({ error: "since must be a millisecond timestamp" });
    // Whole seconds: a superset of the exact answer, and one cached delta per second at most
    // however many distinct values partners send.
    if (since != null) since = Math.max(0, Math.floor(since / 1000) * 1000);
    const entry = since != null ? model.mapSince({ all: true, since }) : model.mapAll({ all: true, depth: model.mapDepth() });
    let p = mapPrepared.get(entry);
    if (!p) { entry.prepared ??= prepareJson(entry.body); p = prepareJsonText(absImagesText(entry.prepared.text)); mapPrepared.set(entry, p); }
    sendPrepared(req, res, p, { cacheControl: V1_CACHE });
  });
  router.get("/heat", (req, res) => {
    const entry = model.heatEntry();
    entry.prepared ??= prepareJson(entry.body);
    sendPrepared(req, res, entry.prepared, { cacheControl: V1_CACHE });
  });
  router.get("/stream", (req, res) => stream.attach(req, res));
  router.get("/openapi.json", (req, res) => sendPrepared(req, res, docPrepared, { cacheControl: V1_DOC_CACHE }));
  router.use((_req, res) => res.status(404).json({ error: "not found", docs: `${base}/docs/api`, openapi: `${base}/v1/openapi.json` }));

  return {
    router, stream,
    snapshot: () => ({ streams: stream.clients.size, streamStats: { ...stream.stats }, keys: apiKeys?.snapshot?.() ?? null }),
    close: () => stream.close(),
  };
}

/**
 * /v1/stream: the hub's events for partners, filtered by type and, with `mint=`, by family tree
 * (the root of the given coin, resolved per event so a coin that joins a tree later is followed).
 * Each event is encoded once per dispatch however many clients receive it; a `mapdelta` is
 * narrowed per distinct tree. Heartbeat comments every 25 s keep proxies from closing idle
 * streams. A client whose socket stops draining is cut once `maxBuffered` bytes wait for it.
 */
export class V1Stream {
  constructor({ model, hub, abs = (u) => u, cfg = V1_DEFAULTS, isMint = isMintShape }) {
    this.model = model; this.abs = abs; this.cfg = { ...V1_DEFAULTS, ...cfg }; this.isMint = isMint;
    this.clients = new Set();
    this.perKey = new Map();
    this.stats = { opened: 0, refused: 0, dropped: 0, frames: 0 };
    this.unsubscribe = hub?.subscribe?.((event, data) => this.dispatch(event, data)) ?? null;
    this.timer = setInterval(() => this.#heartbeat(), this.cfg.heartbeatMs);
    this.timer.unref();
  }

  /** `{ types: Set, mint }` from the query, or `{ error }`. */
  static parse(query, isMint) {
    const raw = query.types == null || query.types === "" ? V1_DEFAULT_TYPES : String(query.types).split(",").map((s) => s.trim()).filter(Boolean);
    const bad = raw.filter((t) => !V1_STREAM_TYPES.includes(t));
    if (bad.length || !raw.length) return { error: `unknown stream type ${JSON.stringify(bad[0] ?? "")}; allowed: ${V1_STREAM_TYPES.join(", ")}` };
    const mint = query.mint == null || query.mint === "" ? null : String(query.mint);
    if (mint != null && !isMint(mint)) return { error: "invalid mint" };
    return { types: new Set(raw), mint };
  }

  attach(req, res) {
    const q = V1Stream.parse(req.query, this.isMint);
    if (q.error) return res.status(400).json({ error: q.error });
    if (req.method === "HEAD") { res.setHeader("content-type", "text/event-stream; charset=utf-8"); return res.status(200).end(); }
    const tier = req.v1?.tier ?? "public";
    const key = req.v1?.streamKey ?? `ip:${req.ip}`;
    const cap = tier === "partner" ? this.cfg.partnerStreams : this.cfg.publicStreams;
    const mine = this.perKey.get(key) ?? 0;
    if (mine >= cap) {
      this.stats.refused++; res.setHeader("retry-after", "10");
      return res.status(429).json({ error: `at most ${cap} concurrent streams per ${tier === "partner" ? "API key" : "client IP"} on the ${tier} tier`, retryAfter: 10, tier });
    }
    if (this.clients.size >= this.cfg.maxStreams) {
      this.stats.refused++; res.setHeader("retry-after", "30");
      return res.status(503).json({ error: "too many streams open, try again shortly", retryAfter: 30 });
    }
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
    res.write(`retry: 3000\n: connected tier=${tier} types=${[...q.types].join(",")}${q.mint ? ` mint=${q.mint}` : ""}\n\n`);
    const client = { res, key, types: q.types, mint: q.mint };
    this.clients.add(client);
    this.perKey.set(key, mine + 1);
    this.stats.opened++;
    req.on("close", () => this.#forget(client));
  }

  /** Root mint of a coin's tree as the model knows it now (the coin itself when it is a root or unknown). */
  rootOf(mint) { const anc = this.model.ancestors(mint); return anc.length ? anc[anc.length - 1].mint : mint; }

  dispatch(event, data) {
    if (!this.clients.size || !HUB_EVENTS.has(event) || data == null) return;
    const roots = new Map();
    const rootOf = (m) => { if (m == null) return null; let r = roots.get(m); if (r === undefined) { r = this.rootOf(m); roots.set(m, r); } return r; };
    const frames = new Map();
    // One encoded frame per (type, tree) per dispatch; `key` tells apart the per-tree mapdelta payloads.
    const frame = (type, build, key = type) => { let f = frames.get(key); if (f === undefined) { const d = build(); f = d == null ? null : `event: ${type}\ndata: ${JSON.stringify(d)}\n\n`; frames.set(key, f); } return f; };
    const mintOf = event === "pair" ? data.coin?.mint : data.mint;
    for (const cl of this.clients) {
      const root = cl.mint ? rootOf(cl.mint) : null;
      let f = null;
      if (event === "stats") { if (cl.types.has("stats")) f = frame("stats", () => data); }
      else if (event === "mapdelta") {
        if (!cl.types.has("mapdelta")) continue;
        f = frame("mapdelta", () => {
          const updated = (data.updated ?? []).filter((u) => !root || rootOf(u.mint) === root).map((u) => ({ ...u, image: this.abs(u.image) }));
          return updated.length ? { ...data, updated } : null;
        }, `mapdelta:${root ?? "*"}`);
      } else {
        if (root && rootOf(mintOf) !== root) continue;
        if (cl.types.has(event)) { const x = frame(event, () => this.#absolute(event, data)); if (x) this.#write(cl, x); }
        if (event === "trade" && cl.types.has("heat")) f = frame("heat", () => this.#heat(data.mint));
      }
      if (f) this.#write(cl, f);
    }
  }

  /** The /v1/heat row of one mint, sent after each of its trades. */
  #heat(mint) {
    const a = this.model.activity?.get(mint);
    if (!a) return null;
    return { mint, at: Math.floor(Date.now() / 1000), t1h: a.t1h, n24: a.trades, v24: Math.round(a.usd * 100) / 100, last: a.last, buys1h: a.buys1h };
  }
  #absolute(event, data) {
    const ref = (r) => (r ? { ...r, image: this.abs(r.image) } : r);
    if (event === "pair") return { ...data, coin: ref(data.coin), parent: ref(data.parent) };
    if (event === "coin") return { ...data, image: this.abs(data.image), parent: ref(data.parent), root: ref(data.root), ancestors: (data.ancestors ?? []).map(ref) };
    return data;
  }
  #write(cl, frame) {
    try {
      cl.res.write(frame); this.stats.frames++;
      if (cl.res.writableLength > this.cfg.maxBuffered) { this.stats.dropped++; this.#drop(cl); }
    } catch { this.#drop(cl); }
  }
  #heartbeat() { const f = `: hb ${Date.now()}\n\n`; for (const cl of this.clients) this.#write(cl, f); }
  #forget(cl) {
    if (!this.clients.delete(cl)) return;
    const n = (this.perKey.get(cl.key) ?? 1) - 1;
    if (n > 0) this.perKey.set(cl.key, n); else this.perKey.delete(cl.key);
  }
  #drop(cl) { this.#forget(cl); try { cl.res.destroy(); } catch { /* already gone */ } }
  close() {
    this.unsubscribe?.(); clearInterval(this.timer);
    for (const cl of this.clients) { try { cl.res.end(); } catch { /* closing */ } }
    this.clients.clear(); this.perKey.clear();
  }
}

// Shape-only fallback when no validator is passed in (createV1 passes api.mjs's isMint).
const isMintShape = (s) => typeof s === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
function stripNullish(o) { return Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => v != null)); }
