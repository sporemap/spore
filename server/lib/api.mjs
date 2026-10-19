// HTTP API (DESIGN §7). Every response is JSON with every contract field present; errors are
// `{ error }` with a 4xx/5xx status. Reads come from the in-memory model, so a request never waits
// on the RPC except the explicitly live ones (eligibility, an unknown coin, the proxy, treasury, fees).
// Hardening (headers, CORS, rate limits, body caps, compression, caching) lives in http.mjs and is
// wired here per route: the upload may carry a 3 MB image, everything else is capped at 16 KB.
import express from "express";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { checkEligibility } from "./eligibility.mjs";
import { PublicKey, PUMP_PROGRAM_ID, PUMP_AMM_PROGRAM_ID, PUMP_FEE_PROGRAM_ID, VersionedTransaction } from "./sdk.mjs";
import { META_NAME_RE, META_TYPES, QuotaError } from "./metahost.mjs";
import { verifySpawnTx } from "./spawned.mjs";
import { shareOf, claimTotals } from "./treasury.mjs";
import { fromBase58 } from "./decode.mjs";
import { launchFeeOf, DEFAULT_LAUNCH_FEE_SOL, splitShares } from "./pricing.mjs";
import { securityHeaders, cors, rateLimit, requestLog, compression, sendCachedJson, sendSpaHtml, prepareJson, sendPrepared, RateLimiter } from "./http.mjs";
import { uploadFields, imageFromDataUrl, LIMITS } from "./validate.mjs";
import { DEFAULT_RATES } from "./config.mjs";

export { RateLimiter };

const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SIG_RE = /^[1-9A-HJ-NP-Za-km-z]{64,128}$/; // a base58 ed25519 signature is 87–88 chars; be lenient, the chain decides
const SPAWNED_CACHE_MS = 10 * 60_000;  // a verified (or refused) signature is not fetched again within this
const SPAWNED_NOTFOUND_MS = 2_000;     // a signature the RPC has not seen yet is retried after this
export const RPC_MAX_BATCH = 5;
export const RPC_MAX_KEYS = 32;
const nowS = () => Math.floor(Date.now() / 1000);
export const BODY_LIMIT = "16kb";
export const UPLOAD_BODY_LIMIT = "3mb";

export const RPC_ALLOW = new Set(["getLatestBlockhash", "sendTransaction", "simulateTransaction", "getSignatureStatuses", "getBalance", "getAccountInfo", "getMultipleAccounts",
  "getTokenAccountBalance", "getTokenAccountsByOwner", "getTokenSupply", "getMinimumBalanceForRentExemption", "getTransaction", "getSlot", "getBlockHeight", "getBlockTime",
  "getEpochInfo", "isBlockhashValid", "getRecentPrioritizationFees", "getFeeForMessage", "getHealth", "getVersion", "getAddressLookupTable"]);

export function isMint(s) { if (typeof s !== "string" || !MINT_RE.test(s)) return false; try { new PublicKey(s); return true; } catch { return false; } }
export function isSig(s) { return typeof s === "string" && SIG_RE.test(s); }

const PUMP_PROGRAMS = new Set([PUMP_PROGRAM_ID.toBase58(), PUMP_AMM_PROGRAM_ID.toBase58(), PUMP_FEE_PROGRAM_ID.toBase58()]);
/**
 * Does a serialized transaction invoke a pump program? The proxy relays sendTransaction and
 * simulateTransaction only for those, so it cannot be used as a free relay for arbitrary
 * transactions through the server's (keyed) RPC. Program ids are always static keys, lookup
 * tables or not, so the check needs no table lookups.
 */
export function txTouchesPump(encoded, encoding = "base64") {
  try {
    const bytes = encoding === "base58" ? fromBase58(encoded) : Buffer.from(encoded, "base64");
    const msg = VersionedTransaction.deserialize(bytes).message;
    const keys = msg.staticAccountKeys.map((k) => k.toBase58());
    return msg.compiledInstructions.some((ix) => PUMP_PROGRAMS.has(keys[ix.programIdIndex]));
  } catch { return false; }
}
/** Per-method parameter rules for the proxy; returns an error message or null. */
export function rpcParamsError(method, params) {
  const p = Array.isArray(params) ? params : [];
  switch (method) {
    case "getMultipleAccounts":
      if (!Array.isArray(p[0]) || p[0].length > RPC_MAX_KEYS || !p[0].every((k) => typeof k === "string")) return `getMultipleAccounts takes at most ${RPC_MAX_KEYS} keys`;
      return null;
    case "getTokenAccountsByOwner":
      if (p[2]?.encoding === "jsonParsed") return "getTokenAccountsByOwner: jsonParsed is not relayed";
      return null;
    case "sendTransaction":
    case "simulateTransaction":
      if (typeof p[0] !== "string" || p[0].length > 4_000) return `${method}: transaction missing or too large`;
      if (!txTouchesPump(p[0], p[1]?.encoding === "base58" ? "base58" : "base64")) return `${method}: only pump.fun transactions are relayed`;
      return null;
    default:
      return null;
  }
}

const clampInt = (v, def, min, max) => { const n = Number.parseInt(v, 10); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def; };
const byLocked = (a, b) => (b.lockedUsd ?? -1) - (a.lockedUsd ?? -1) || (b.mcapUsd ?? -1) - (a.mcapUsd ?? -1);

/** Trades → OHLC candles of `res` seconds; USD when every trade has a USD price, else quote units. */
export function buildCandles(trades, res) {
  const usd = trades.length > 0 && trades.every((t) => t.priceUsd != null);
  const key = usd ? "priceUsd" : "priceQuote";
  const buckets = new Map();
  for (const t of trades) {
    const bucket = Math.floor(t.time / res) * res;
    const price = t[key];
    const vol = usd ? (t.valueUsd ?? 0) : Number(BigInt(t.quoteAmount));
    const c = buckets.get(bucket);
    if (!c) buckets.set(bucket, { t: bucket, o: price, h: price, l: price, c: price, v: vol });
    else { c.h = Math.max(c.h, price); c.l = Math.min(c.l, price); c.c = price; c.v += vol; }
  }
  return { candles: [...buckets.values()].sort((a, b) => a.t - b.t), priceKey: usd ? "usd" : "quote" };
}

/**
 * Health: what a load balancer and an operator need in one read. `ok` turns false when the live
 * socket has been down for a while or the refresh loop stalled; `?strict=1` makes that a 503 so a
 * probe can act on it, while the default stays 200 so a glance always gets the numbers.
 */
export function healthOf({ model, indexer, hub, images, meta, metahost, treasury, rpc, startedAt }) {
  const snap = indexer?.snapshot?.() ?? {};
  const now = nowS(), uptimeS = now - startedAt;
  const ws = snap.live ?? null;
  const lagS = snap.lastRefreshAt ? now - snap.lastRefreshAt : null;
  const wsDown = ws ? !ws.connected && (ws.lastMessageAgoMs == null ? uptimeS > 120 : ws.lastMessageAgoMs > 120_000) : false;
  const stalled = lagS != null ? lagS > 300 : uptimeS > 300;
  const ok = !wsDown && !stalled;
  const mem = process.memoryUsage();
  return {
    ok, status: ok ? "ok" : "degraded", now, uptimeS, mode: model.mode, coins: model.coins.size, ourCoins: model.scope().ours.size,
    indexer: { phase: snap.phase ?? null, lagS, lastRefreshAt: snap.lastRefreshAt ?? null, lastError: snap.lastError ?? null, backfill: { ...model.backfill }, created: snap.created ?? null, map: snap.map ?? null },
    map: { ...(model.mapStats ?? {}), total: model.mapCache?.total ?? null, cachedVersion: model.mapCache?.version ?? null, dirty: model.dirty?.size ?? 0 },
    ws: ws ? { connected: ws.connected, lastMessageAgoMs: ws.lastMessageAgoMs, connects: ws.connects, errors: ws.errors, backoffMs: ws.backoffMs ?? null, reconnecting: !!ws.reconnecting } : null,
    rpc: rpc?.snapshot?.() ?? snap.rpc ?? null, rpcLanes: rpc?.laneSnapshot?.() ?? null, meta: meta?.snapshot?.() ?? meta?.stats ?? snap.meta ?? null, images: images?.stats ?? null,
    metahost: metahost ? { ...metahost.stats, quota: metahost.quota?.snapshot?.() ?? null } : null, treasury: treasury?.stats ?? null,
    sse: hub?.clients?.size ?? 0, sseStats: hub?.stats ?? null, solUsd: model.solUsd, memoryMb: { rss: Math.round(mem.rss / 1e6), heap: Math.round(mem.heapUsed / 1e6) },
  };
}

export function createApp({ model, indexer, rpc, hub, images, meta, metahost = null, treasury = null, metaDir = null, platformWallet, splitBps, launchFeeSol = DEFAULT_LAUNCH_FEE_SOL, distDir, origins = [], log = console,
  rates = null, trustProxy = "loopback", hsts = "auto", logSample = 0.1, pagesDomain = null, cspConnect = [], now = Date.now }) {
  const app = express();
  const startedAt = nowS();
  const launchFee = launchFeeOf(launchFeeSol, platformWallet);
  // Request-driven chain reads run on the RPC's "api" lane so they can never starve the indexer.
  const apiRpc = typeof rpc?.lane === "function" ? rpc.lane("api") : rpc;
  const limitOf = (name) => ({ limit: rates?.[name]?.limit ?? DEFAULT_RATES[name][0], windowMs: rates?.[name]?.windowMs ?? DEFAULT_RATES[name][1], name, now });
  const limits = { api: rateLimit(limitOf("api")), img: rateLimit(limitOf("img")), rpc: rateLimit(limitOf("rpc")), upload: rateLimit(limitOf("upload")), spawned: rateLimit(limitOf("spawned")), sse: rateLimit(limitOf("sse")) };
  const spawnedCache = new Map(); // sig → { at, result }
  app.disable("x-powered-by");
  app.set("etag", false);
  app.set("trust proxy", trustProxy);
  app.use(securityHeaders({ hsts }));
  app.use(requestLog({ log, sample: logSample }));
  app.use(compression());
  app.use(cors(origins));
  // Body caps per route: the upload carries a data-URL image, nothing else needs more than a few KB.
  const smallJson = express.json({ limit: BODY_LIMIT }), uploadJson = express.json({ limit: UPLOAD_BODY_LIMIT });
  app.use((req, res, next) => (req.path === "/api/upload" ? next() : smallJson(req, res, next)));
  // Default no-store for the API; the cached readers below override it per response.
  app.use("/api", (req, res, next) => {
    res.setHeader("cache-control", "no-store");
    if (req.method === "GET" && req.path !== "/img" && req.path !== "/events") return limits.api(req, res, next);
    next();
  });
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  const view = (c) => model.view(c);
  const spawns = () => model.visibleSpawns();

  app.get("/api/stats", (req, res) => sendCachedJson(req, res, model.stats(), { maxAge: 3 }));
  app.get("/api/health", (req, res) => {
    const h = healthOf({ model, indexer, hub, images, meta, metahost, treasury, rpc, startedAt });
    res.status(!h.ok && req.query.strict != null ? 503 : 200).json(h);
  });

  app.get("/api/feed", (req, res) => {
    const limit = clampInt(req.query.limit, 50, 1, 200);
    const before = req.query.before != null ? Number(req.query.before) : null;
    let coins = spawns();
    if (Number.isFinite(before)) coins = coins.filter((c) => c.createdAt != null && c.createdAt < before);
    coins.sort((a, b) => (b.createdAt ?? -1) - (a.createdAt ?? -1) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    sendCachedJson(req, res, { coins: coins.slice(0, limit).map(view) }, { maxAge: 5 });
  });

  app.get("/api/roots", (req, res) => {
    const sort = ["locked", "children", "new", "volume"].includes(req.query.sort) ? req.query.sort : "locked";
    const limit = clampInt(req.query.limit, 50, 1, 200), offset = clampInt(req.query.offset, 0, 0, 100_000);
    const roots = model.visibleRoots().map(view);
    const lastSpawn = (r) => Math.max(0, ...model.visibleChildren(r.mint).map((c) => c.createdAt ?? 0));
    const cmp = { locked: byLocked, children: (a, b) => b.descendants - a.descendants || byLocked(a, b), new: (a, b) => lastSpawn(b) - lastSpawn(a) || byLocked(a, b), volume: (a, b) => b.volume24hUsd - a.volume24hUsd || byLocked(a, b) }[sort];
    roots.sort(cmp);
    sendCachedJson(req, res, { roots: roots.slice(offset, offset + limit), total: roots.length }, { maxAge: 5 });
  });

  app.get("/api/coin/:mint", wrap(async (req, res) => {
    const { mint } = req.params;
    if (!isMint(mint)) return res.status(400).json({ error: "invalid mint" });
    let c = model.get(mint);
    if (!c) { try { c = await indexer.fetchCoin(mint, { rpc: apiRpc }); } catch (e) { log.warn(`coin ${mint}: live lookup failed: ${e.message}`); } }
    if (!c) return res.status(404).json({ error: "unknown mint" });
    model.touch(mint);
    const uri = model.mint(mint)?.uri; if (uri) meta?.request(uri, { front: true });
    // In ours mode only our children are listed; `otherChildren` says how many pump.fun leaves out.
    const coin = view(c);
    const children = model.visibleChildren(mint).map(view).sort(byLocked);
    sendCachedJson(req, res, { coin, children, otherChildren: coin.otherChildren, trades: model.db.tradesFor(mint, 50) }, { maxAge: 3 });
  }));

  app.get("/api/tree/:mint", (req, res) => {
    const { mint } = req.params;
    if (!isMint(mint)) return res.status(400).json({ error: "invalid mint" });
    const root = model.get(mint);
    if (!root) return res.status(404).json({ error: "unknown mint" });
    const depth = clampInt(req.query.depth, 3, 0, 6), limit = clampInt(req.query.limit, 100, 1, 500);
    let nodes = 0;
    const node = (c, left) => {
      nodes++;
      const kids = left > 0 && nodes < 5_000 ? model.visibleChildren(c.mint).map(view).sort(byLocked).slice(0, limit) : [];
      return { coin: view(c), children: kids.map((k) => node(model.get(k.mint), left - 1)) };
    };
    sendCachedJson(req, res, node(root, depth), { maxAge: 5 });
  });

  // The indexed forest for the bubble map. `limit=all` (DESIGN §11.5) is the whole thing: every
  // root and every descendant, no fan-out cap, built from mapRef only and cached per model version
  // for 10 s with its encoded bytes; `since=<ms>` returns just the nodes whose `updatedAt` moved
  // after that instant (flat, with `parentMint`), so a client with a cache asks for the new ones.
  // `limit=<n>` keeps the top-n behaviour: top roots by locked value, each with its children and
  // grandchildren, per-node fan-out capped so one root with hundreds of children cannot make the
  // payload (or the client's simulation) explode.
  // `scope=all` draws every pump.fun pair the indexer knows, whatever the listing mode: the map is
  // the one place that shows the whole ecosystem, with our launches flagged by `ours` on each node.
  app.get("/api/map", (req, res) => {
    const all = req.query.scope === "all";
    if (req.query.limit === "all") {
      const since = req.query.since != null && req.query.since !== "" ? Number(req.query.since) : null;
      if (since != null && !Number.isFinite(since)) return res.status(400).json({ error: "since must be a millisecond timestamp" });
      const depth = req.query.depth != null && req.query.depth !== "" ? clampInt(req.query.depth, model.mapDepth(), 0, 6) : model.mapDepth();
      const entry = since != null ? model.mapSince({ all, since }) : model.mapAll({ all, depth });
      if (!entry.prepared) { const t0 = performance.now(); entry.prepared = prepareJson(entry.body); entry.encodeMs = Math.round(performance.now() - t0); }
      if (entry.buildMs != null) res.setHeader("x-map-build-ms", String(entry.buildMs)); // tree walk + mapRef; the JSON encode is x-map-encode-ms
      if (entry.encodeMs != null) res.setHeader("x-map-encode-ms", String(entry.encodeMs));
      return sendPrepared(req, res, entry.prepared, { maxAge: 10 });
    }
    const limit = clampInt(req.query.limit, 60, 1, 200), depth = clampInt(req.query.depth, 2, 0, 4), fanout = clampInt(req.query.fanout, 40, 1, 200);
    const d = model.computed();
    const stat = (c) => (all ? model.scopedAll(c) : model.scoped(c));
    const locked = (c) => stat(c).lockedUsd ?? -1, mcap = (c) => d.get(c.mint)?.priceUsd ?? -1; // same 1B supply everywhere: price orders like mcap
    const cmp = (a, b) => locked(b) - locked(a) || mcap(b) - mcap(a) || stat(b).descendants - stat(a).descendants;
    const roots = (all ? model.allRoots() : model.visibleRoots()).sort(cmp).slice(0, limit);
    const kids = (mint) => (all ? model.childrenOf(mint) : model.visibleChildren(mint));
    const node = (c, left) => ({ coin: model.mapRef(c, all), children: left > 0 ? kids(c.mint).sort(cmp).slice(0, fanout).map((k) => node(k, left - 1)) : [] });
    sendCachedJson(req, res, { roots: roots.map((r) => node(r, depth)), scope: all ? "all" : model.mode }, { maxAge: 10 });
  });

  app.get("/api/candles/:mint", (req, res) => {
    const { mint } = req.params;
    if (!isMint(mint)) return res.status(400).json({ error: "invalid mint" });
    if (!model.get(mint)) return res.status(404).json({ error: "unknown mint" });
    if (!model.inScope(mint)) return res.status(404).json({ error: "not a Spore coin" }); // ours mode: charts only for our coins and their ancestors
    const resSec = clampInt(req.query.res, 60, 15, 86_400);
    const trades = model.db.tradesSince(mint, nowS() - resSec * 500);
    sendCachedJson(req, res, buildCandles(trades, resSec), { maxAge: 5 });
  });

  // An exact mint that the index does not know (any pump.fun coin: the parent picker and the search
  // box accept all of pump.fun, DESIGN §11.1) is looked up live, like /api/coin/:mint does; the
  // verdict is cached per mint there, so a repeated paste costs no RPC.
  app.get("/api/search", wrap(async (req, res) => {
    const q = String(req.query.q ?? "").trim().slice(0, 64);
    if (!q) return res.json({ coins: [] });
    if (isMint(q)) {
      let c = model.get(q);
      if (!c) { try { c = await indexer.fetchCoin(q, { rpc: apiRpc }); } catch (e) { log.warn(`search ${q}: live lookup failed: ${e.message}`); } }
      return res.json({ coins: c ? [view(c)] : [] });
    }
    const needle = q.toLowerCase().replace(/^\$/, "");
    const d = model.computed();
    const scored = [];
    for (const c of model.tracked()) {
      const { name, symbol } = model.nameOf(c.mint);
      const sym = (symbol ?? "").toLowerCase(), nm = (name ?? "").toLowerCase();
      const score = sym === needle ? 3 : sym.startsWith(needle) ? 2 : nm.startsWith(needle) ? 1 : 0;
      if (score) scored.push({ c, score, locked: d.get(c.mint)?.lockedUsd ?? -1, children: d.get(c.mint)?.children ?? 0 });
    }
    scored.sort((a, b) => b.score - a.score || b.locked - a.locked || b.children - a.children);
    res.json({ coins: scored.slice(0, 20).map((s) => view(s.c)) });
  }));

  app.get("/api/eligibility/:mint", wrap(async (req, res) => {
    const { mint } = req.params;
    const creator = typeof req.query.creator === "string" && isMint(req.query.creator) ? req.query.creator : null;
    // "sol" = a root coin quoted in SOL: the launch tab's default pool. Always admissible; same split.
    if (mint.toLowerCase() === "sol") {
      const shares = splitShares({ creator, parentCreator: null, grandparentCreator: null, platform: platformWallet, bps: splitBps });
      return res.json({ ok: true, reason: null, depth: 0, chain: [], parentCreator: null, grandparentCreator: null, shares, platform: platformWallet, launchFee, pool: "sol" });
    }
    if (!isMint(mint)) return res.status(400).json({ error: "invalid mint" });
    res.json({ ...await checkEligibility({ mint, creator, model, indexer, rpc: apiRpc, platformWallet, splitBps }), launchFee, pool: mint });
  }));

  // Read-only treasury (DESIGN §11.4): the platform's pending creator-fee share by quote mint.
  app.get("/api/treasury", wrap(async (req, res) => {
    if (!treasury) return res.json({ platform: platformWallet, ourCoins: 0, pendingByQuote: [], coins: [], updatedAt: nowS() });
    try { sendCachedJson(req, res, await treasury.get(), { maxAge: 30 }); }
    catch (e) { res.status(503).json({ error: `treasury unavailable: ${String(e.message ?? e).slice(0, 200)}` }); }
  }));

  // Pending creator fees of one coin for the coin page's "Creator fees" card (DESIGN §11.6): the fee
  // accounts read live on the api lane and cached 15 s per mint, so the page can show the split and
  // the browser can decide whether the permissionless claim is worth a transaction. A coin the index
  // does not know is looked up live like /api/coin does. Nothing is signed here.
  app.get("/api/fees/:mint", wrap(async (req, res) => {
    const { mint } = req.params;
    if (!isMint(mint)) return res.status(400).json({ error: "invalid mint" });
    let c = model.get(mint);
    if (!c) { try { c = await indexer.fetchCoin(mint, { rpc: apiRpc }); } catch (e) { log.warn(`fees ${mint}: live lookup failed: ${e.message}`); } }
    if (!c) return res.status(404).json({ error: "unknown mint" });
    if (!treasury) return res.status(503).json({ error: "fees unavailable" });
    try { sendCachedJson(req, res, await treasury.fees(c, { rpc: apiRpc }), { maxAge: 5 }); }
    catch (e) { res.status(503).json({ error: `fees unavailable: ${String(e.message ?? e).slice(0, 200)}` }); }
  }));

  // The Claim page (DESIGN §11.7). /api/claims/:wallet lists every indexed coin whose fee-sharing
  // config names the wallet, with its pending fees and the wallet's part; /api/claims lists the Spore
  // launches with the most fees waiting (a payout is permissionless, anyone may trigger it). Both
  // read the fee accounts in batches through the per-mint cache /api/fees uses. Nothing is signed.
  const CLAIMS_MAX = 100, claimsPublic = { at: 0, value: null, inFlight: null }, CLAIMS_PUBLIC_MS = 30_000;
  const claimRow = (c, v) => ({ ...model.ref(c), ...v, migrated: v.migrated });
  app.get("/api/claims/:wallet", wrap(async (req, res) => {
    const { wallet } = req.params;
    if (!isMint(wallet)) return res.status(400).json({ error: "invalid wallet" });
    if (!treasury) return res.status(503).json({ error: "claims unavailable" });
    const coins = model.tracked().filter((c) => c.shares?.some((s) => s.address === wallet)).slice(0, CLAIMS_MAX);
    try {
      const views = await treasury.feesMany(coins, { rpc: apiRpc });
      const byMint = new Map(coins.map((c) => [c.mint, c]));
      const rows = views.map((v) => ({ ...claimRow(byMint.get(v.mint), v), ...shareOf(v, wallet) }))
        .sort((a, b) => (b.yourUsd ?? -1) - (a.yourUsd ?? -1) || Number(BigInt(b.yourAmount) - BigInt(a.yourAmount)));
      sendCachedJson(req, res, { wallet, coins: rows, totals: claimTotals(rows, "yourAmount"), updatedAt: nowS() }, { maxAge: 5 });
    } catch (e) { res.status(503).json({ error: `claims unavailable: ${String(e.message ?? e).slice(0, 200)}` }); }
  }));
  app.get("/api/claims", wrap(async (req, res) => {
    const limit = clampInt(req.query.limit, 50, 1, CLAIMS_MAX);
    if (!treasury) return res.status(503).json({ error: "claims unavailable" });
    const fresh = claimsPublic.value && now() - claimsPublic.at < CLAIMS_PUBLIC_MS;
    if (!fresh) {
      claimsPublic.inFlight ??= (async () => {
        const coins = model.tracked().filter((c) => model.isOurCoin(c) && c.shares?.length);
        const views = await treasury.feesMany(coins, { rpc: apiRpc });
        const byMint = new Map(coins.map((c) => [c.mint, c]));
        const rows = views.map((v) => claimRow(byMint.get(v.mint), v)).filter((r) => BigInt(r.total) > 0n)
          .sort((a, b) => (b.totalUsd ?? -1) - (a.totalUsd ?? -1));
        claimsPublic.value = { coins: rows, totals: claimTotals(rows, "total") }; claimsPublic.at = now();
      })().finally(() => { claimsPublic.inFlight = null; });
      try { await claimsPublic.inFlight; } catch (e) { if (!claimsPublic.value) return res.status(503).json({ error: `claims unavailable: ${String(e.message ?? e).slice(0, 200)}` }); }
    }
    const v = claimsPublic.value;
    sendCachedJson(req, res, { coins: v.coins.slice(0, limit), totals: v.totals, updatedAt: Math.floor(claimsPublic.at / 1000) }, { maxAge: 10 });
  }));

  // The Spawn page reports a signed spawn so the coin shows as ours at once. Nothing is taken on
  // trust: the transaction is read back from the chain and must carry a pump CreateEvent for the
  // mint, a wallet creator and the launch fee paid to the platform (lib/spawned.mjs) before the
  // coin is flagged pending; the indexer then confirms it from the fee-sharing config (DESIGN
  // §11.1) and the pending flag expires after a few minutes otherwise. Verified signatures are
  // remembered so a retry (the UI sends one) costs no RPC; refused ones too.
  app.post("/api/spawned", limits.spawned, wrap(async (req, res) => {
    const { mint, sig } = req.body || {};
    if (!isMint(mint)) return res.status(400).json({ error: "invalid mint" });
    if (!isSig(sig)) return res.status(400).json({ error: "the launch transaction signature is required" });
    const known = model.get(mint);
    if (known && model.isOurs(known)) return res.json({ ok: true, mint, ...model.oursOf(known), verified: true, coin: view(known) });
    const pend = model.pending.get(mint);
    if (pend && pend.sig === sig && model.oursOf(known ?? { mint }).oursPending) return res.json({ ok: true, mint, ours: false, oursPending: true, verified: true, coin: known ? view(known) : null });
    let hit = spawnedCache.get(sig);
    if (!hit || now() - hit.at > (hit.result.notFound ? SPAWNED_NOTFOUND_MS : SPAWNED_CACHE_MS)) {
      let tx = null;
      try { tx = await apiRpc.getTransaction(sig); } catch (e) { log.warn(`spawned: ${sig.slice(0, 12)}…: getTransaction failed: ${e.message}`); return res.status(502).json({ error: "could not read the transaction, retry in a few seconds", retryAfter: 3 }); }
      hit = { at: now(), result: verifySpawnTx(tx, { mint, platformWallet, feeLamports: BigInt(launchFee.lamports) }) };
      spawnedCache.set(sig, hit);
      if (spawnedCache.size > 1_000) spawnedCache.delete(spawnedCache.keys().next().value);
    }
    const v = hit.result;
    if (!v.ok) {
      log.info?.(`spawned: ${mint} refused (${sig.slice(0, 12)}…): ${v.reason}`);
      if (v.notFound) { res.setHeader("retry-after", "3"); return res.status(404).json({ error: "transaction not found yet, retry in a few seconds", retryAfter: 3 }); }
      return res.status(400).json({ error: v.reason });
    }
    if (v.create.mint !== mint) return res.status(400).json({ error: "signature belongs to another mint" }); // the cache is per signature; the mint must match it
    // The pending window is anchored to the block time; a transaction the RPC returns without one
    // is still adopted, but not flagged pending (a report-time anchor could be renewed forever).
    if (v.blockTime) model.markPending(mint, sig, { feePaid: v.feePaid.toString(), at: v.blockTime * 1000 });
    const c = indexer.adopt ? await indexer.adopt(mint, { create: v.create, slot: v.slot, feePaid: v.feePaid }) : known;
    const flags = c ? model.oursOf(c) : { ours: false, oursPending: true };
    log.info?.(`spawned: ${mint} verified (${sig.slice(0, 12)}…, fee ${v.feePaid} lamports) → ours=${flags.ours} pending=${flags.oursPending}`);
    res.json({ ok: true, mint, ...flags, verified: true, feePaid: v.feePaid.toString(), coin: c ? view(c) : null });
  }));

  app.get("/api/events", limits.sse, (req, res) => hub.attach(req, res));
  // The proxy serves only images the API handed out (a known coin's image or our own host).
  app.get("/api/img", limits.img, images.handler({ known: (u) => model.knownImage(u) }));

  // Our published metadata files, same bytes as the Pages host (immutable: names are content hashes).
  if (metaDir) {
    app.get("/m/:name", (req, res) => {
      const { name } = req.params;
      if (!META_NAME_RE.test(name)) return res.status(404).json({ error: "not found" });
      const file = join(metaDir, "m", name);
      if (!existsSync(file)) return res.status(404).json({ error: "not found" });
      res.setHeader("content-type", META_TYPES[name.split(".").pop()]);
      res.setHeader("cache-control", "public, max-age=31536000, immutable");
      res.setHeader("access-control-allow-origin", "*");
      res.setHeader("cross-origin-resource-policy", "cross-origin"); // wallets and explorers embed these
      res.sendFile(file);
    });
  }

  // Metadata upload → self-hosted files + Pages deploy (DESIGN §11.3). Image arrives as a data URL
  // (≤ 2 MB, magic bytes checked, EXIF stripped); text fields are plain text with hard caps. The
  // rate limit is taken before the body is parsed (cheapest point to stop a flood) and refunded
  // when validation rejects the request, so a typo never costs one of the five attempts.
  app.post("/api/upload", limits.upload, uploadJson, wrap(async (req, res) => {
    const ip = req.ip;
    let fields, image;
    try { fields = uploadFields(req.body); image = imageFromDataUrl(req.body?.image, { maxBytes: LIMITS.imageBytes }); }
    catch (e) { limits.upload.limiter.refund(ip); return res.status(400).json({ error: e.message }); }
    if (!metahost) { limits.upload.limiter.refund(ip); return res.status(503).json({ error: "metadata host not configured" }); }
    let r;
    try {
      r = await metahost.publish({ ...fields, imageBytes: image.bytes, imageType: image.type }, { ip });
    } catch (e) {
      if (e instanceof QuotaError) { limits.upload.limiter.refund(ip); res.setHeader("retry-after", String(e.retryAfter)); return res.status(429).json({ error: e.message, retryAfter: e.retryAfter }); }
      // The files are on disk and ride along with the next successful deploy, so a retry is cheap.
      res.setHeader("retry-after", "30");
      return res.status(502).json({ error: `metadata publish failed: ${String(e.message ?? e).slice(0, 300)}`, retryAfter: 30, hint: "your files are saved; retry in about 30 s and they will be published with the next deploy" });
    }
    res.json({ metadataUri: r.metadataUri, imageUri: r.imageUri, metadata: r.meta });
  }));

  // JSON-RPC proxy: only what the browser needs to build, simulate, send and confirm its own
  // transactions, on the RPC's own "proxy" lane, with per-method parameter rules (key counts,
  // no parsed token scans, only pump transactions relayed) and a bounded relayed answer.
  app.post("/api/rpc", limits.rpc, wrap(async (req, res) => {
    const body = req.body;
    const calls = Array.isArray(body) ? body : [body];
    if (!calls.length || calls.length > RPC_MAX_BATCH) return res.status(400).json({ error: `bad batch (at most ${RPC_MAX_BATCH} calls)` });
    const denied = calls.find((c) => !c || typeof c.method !== "string" || !RPC_ALLOW.has(c.method));
    if (denied) return res.status(403).json({ error: `method not allowed: ${denied?.method ?? "?"}` });
    for (const c of calls) { const err = rpcParamsError(c.method, c.params); if (err) return res.status(403).json({ error: err }); }
    try {
      const r = await rpc.proxy(body);
      res.status(r.status === 429 ? 429 : 200).type("application/json").send(r.text);
    } catch (e) { res.status(502).json({ error: `rpc unreachable: ${e.message}` }); }
  }));

  app.use("/api", (_req, res) => res.status(404).json({ error: "not found" }));

  // Production: the built web app from the same origin. Hashed assets are immutable; index.html is
  // revalidated every time and sent with the SPA CSP (and the nonce for its inline theme snippet).
  const indexFile = distDir ? join(distDir, "index.html") : null;
  if (indexFile && existsSync(indexFile)) {
    let html = { text: null, mtimeMs: 0 };
    const indexHtml = () => { const st = statSync(indexFile); if (st.mtimeMs !== html.mtimeMs) html = { text: readFileSync(indexFile, "utf8"), mtimeMs: st.mtimeMs }; return html.text; };
    const sendIndex = (_req, res) => sendSpaHtml(res, indexHtml(), { pagesDomain, extraConnect: cspConnect });
    app.get("/", sendIndex);
    app.use(express.static(distDir, { index: false, fallthrough: true, setHeaders: (res, p) => {
      if (p.includes(`${join(distDir, "assets")}/`)) res.setHeader("cache-control", "public, max-age=31536000, immutable");
      else res.setHeader("cache-control", "public, max-age=3600");
    } }));
    app.get(/^(?!\/api(\/|$)).*/, (req, res) => (req.path.includes(".") ? res.status(404).type("text").send("not found") : sendIndex(req, res)));
    log.info?.(`serving ${distDir}`);
  }

  app.use((err, _req, res, _next) => {
    if (err?.type === "entity.parse.failed") return res.status(400).json({ error: "invalid JSON body" });
    if (err?.type === "entity.too.large") return res.status(413).json({ error: `body too large (limit ${err.limit ? `${Math.round(err.limit / 1024)} KB` : BODY_LIMIT})` });
    if (err?.type === "charset.unsupported" || err?.type === "encoding.unsupported") return res.status(415).json({ error: "unsupported body encoding" });
    log.error?.(`api: ${err?.stack ?? err}`);
    res.status(500).json({ error: String(err?.message ?? err).slice(0, 200) });
  });
  return app;
}
