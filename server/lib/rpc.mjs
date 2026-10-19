// JSON-RPC client with per-lane request budgets.
//
// The public mainnet RPC allows roughly 100 requests per 10 s per IP (40 per method) and answers
// 429 above that. Every request goes through a token bucket and a concurrency gate, and a 429
// pauses the lane that hit it with growing backoff. There are three lanes: "main" for the indexer
// (backfill, refresh, live), "api" for lookups a request triggers (an unknown coin page, an
// eligibility check) and "proxy" for the browser's own JSON-RPC traffic. The two request-driven
// lanes are small and separate so that one client hammering the API, or a burst of 429s its
// traffic provoked upstream, can slow its own lane but never stall the indexer. Paid RPCs just get
// a higher RPC_RPS.

export class RpcError extends Error {
  constructor(method, code, message, data) { super(`${method}: ${message} (${code})`); this.name = "RpcError"; this.code = code; this.data = data; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function deriveWsUrl(rpcUrl) {
  // Keep path and query: Helius-style keys live in the query string and are valid on the socket too.
  return rpcUrl.replace(/^https:/, "wss:").replace(/^http:/, "ws:");
}
export const redact = (url) => String(url).replace(/(api[-_]?key=)[^&]+/i, "$1…");
export const PROXY_MAX_BYTES = 2 * 1024 * 1024;

/** One token bucket + concurrency gate + 429 pause. */
class Lane {
  constructor(name, { rps, concurrency }) {
    this.name = name; this.rps = rps; this.capacity = Math.max(1, Math.ceil(rps * 2)); this.tokens = this.capacity; this.refilledAt = Date.now();
    this.concurrency = concurrency; this.inFlight = 0; this.waiters = [];
    this.pausedUntil = 0; this.backoffMs = 0;
  }
  snapshot() { return { inFlight: this.inFlight, queued: this.waiters.length, pausedMs: Math.max(0, this.pausedUntil - Date.now()) }; }
}

/** Reads a body up to `max` bytes as text; throws when the upstream answer is larger. */
async function readText(res, max) {
  const reader = res.body?.getReader?.();
  if (!reader) return res.text();
  const chunks = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { reader.cancel().catch(() => {}); throw new Error(`response over ${max} bytes`); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export class Rpc {
  constructor({ url, rps = 6, concurrency = 4, timeoutMs = 30_000, log = console, fetchImpl = fetch, backoffMinMs = 1_000, backoffMaxMs = 30_000, apiRps = null, proxyRps = null, apiConcurrency = 2, proxyConcurrency = 2 } = {}) {
    if (!url) throw new Error("RPC url required");
    this.url = url; this.log = log; this.gpaV2 = false; this.timeoutMs = timeoutMs; this.fetch = fetchImpl;
    this.backoffMinMs = backoffMinMs; this.backoffMaxMs = backoffMaxMs;
    this.rps = rps; this.concurrency = concurrency;
    // Request-driven lanes default to a quarter of the indexer's rate: enough for a coin page or a
    // launch flow, far too little to starve the refresh loop.
    this.lanes = {
      main: new Lane("main", { rps, concurrency }),
      api: new Lane("api", { rps: apiRps ?? Math.max(1, rps / 4), concurrency: apiConcurrency }),
      proxy: new Lane("proxy", { rps: proxyRps ?? Math.max(1, rps / 4), concurrency: proxyConcurrency }),
    };
    this.stats = { calls: 0, errors: 0, rateLimited: 0, lastError: null };
    this.id = 0;
  }

  // The main lane's state stays reachable under its historical names (health, tests).
  get pausedUntil() { return this.lanes.main.pausedUntil; }
  get backoffMs() { return this.lanes.main.backoffMs; }
  set backoffMs(v) { this.lanes.main.backoffMs = v; }
  get inFlight() { return this.lanes.main.inFlight; }
  get waiters() { return this.lanes.main.waiters; }

  /**
   * The same client on another budget: `rpc.lane("api").getMultipleAccounts(...)` runs every
   * helper of this class through the "api" bucket. The returned object inherits from this instance,
   * so the helpers (which call `this.call`) pick the lane up without knowing about it.
   */
  lane(name) {
    if (!this.lanes[name]) throw new Error(`unknown rpc lane ${name}`);
    const base = this;
    return Object.assign(Object.create(this), { laneName: name, call: (method, params = [], opts = {}) => base.call(method, params, { ...opts, lane: name }), lane: (n) => base.lane(n) });
  }

  // ---- budget: token bucket + semaphore, per lane
  async #take(L) {
    for (;;) {
      const now = Date.now();
      if (now < L.pausedUntil) { await sleep(L.pausedUntil - now); continue; }
      L.tokens = Math.min(L.capacity, L.tokens + ((now - L.refilledAt) / 1000) * L.rps);
      L.refilledAt = now;
      if (L.tokens >= 1) { L.tokens -= 1; return; }
      await sleep(Math.ceil(((1 - L.tokens) / L.rps) * 1000));
    }
  }
  async #enter(L) {
    if (L.inFlight < L.concurrency) { L.inFlight++; return; }
    await new Promise((resolve) => L.waiters.push(resolve));
    L.inFlight++;
  }
  #leave(L) { L.inFlight--; const next = L.waiters.shift(); if (next) next(); }
  #rateLimited(L, retryAfterSec) {
    this.stats.rateLimited++;
    // Concurrent requests that were already in flight all come back 429 together; that burst is one
    // event, so the backoff only grows when a 429 arrives after the previous pause has ended.
    if (Date.now() < L.pausedUntil) return;
    L.backoffMs = Math.min(this.backoffMaxMs, Math.max(this.backoffMinMs, L.backoffMs * 2 || this.backoffMinMs, (retryAfterSec || 0) * 1000));
    L.pausedUntil = Date.now() + L.backoffMs;
    L.tokens = 0;
  }

  async call(method, params = [], { timeoutMs = this.timeoutMs, retries = 3, lane = "main" } = {}) {
    const L = this.lanes[lane] ?? this.lanes.main;
    let attempt = 0, rateLimitHits = 0;
    for (;;) {
      await this.#take(L);
      await this.#enter(L);
      this.stats.calls++;
      let res, text;
      try {
        res = await this.fetch(this.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++this.id, method, params }), signal: AbortSignal.timeout(timeoutMs) });
        text = await res.text();
      } catch (e) {
        this.#leave(L);
        this.stats.errors++; this.stats.lastError = `${method}: ${e.message}`;
        if (attempt++ >= retries) throw e;
        await sleep(1_000 * 2 ** attempt);
        continue;
      }
      this.#leave(L);
      if (res.status === 429) {
        this.#rateLimited(L, Number(res.headers.get("retry-after")));
        if (++rateLimitHits > 12) throw new Error(`${method}: rate limited ${rateLimitHits} times`);
        continue;
      }
      if (!res.ok) {
        this.stats.errors++; this.stats.lastError = `${method}: HTTP ${res.status}`;
        if (attempt++ >= retries) throw new Error(`${method}: HTTP ${res.status}`);
        await sleep(1_000 * 2 ** attempt);
        continue;
      }
      let json;
      try { json = JSON.parse(text); } catch { this.stats.errors++; if (attempt++ >= retries) throw new Error(`${method}: bad JSON from RPC`); continue; }
      if (json.error) {
        // Some providers answer rate limits inside the JSON envelope rather than with HTTP 429.
        if (json.error.code === 429 || /too many requests|rate limit/i.test(json.error.message ?? "")) { this.#rateLimited(L); if (++rateLimitHits > 12) throw new RpcError(method, json.error.code, json.error.message); continue; }
        if (json.error.code === -32005 && attempt++ < retries) { await sleep(1_000); continue; } // node is behind / unhealthy
        this.stats.errors++; this.stats.lastError = `${method}: ${json.error.message}`;
        throw new RpcError(method, json.error.code, json.error.message, json.error.data);
      }
      L.backoffMs = 0;
      return json.result;
    }
  }

  // ---- helpers (all return plain data; account data as Buffer)
  static account(v) { return v ? { owner: v.owner, lamports: v.lamports, data: Buffer.from(v.data[0], "base64"), executable: v.executable } : null; }

  /** Accounts for `keys` (strings), chunked by 100; result aligned with input, null for missing. */
  async getMultipleAccounts(keys, { chunk = 100, commitment = "confirmed" } = {}) {
    const out = new Array(keys.length).fill(null);
    for (let i = 0; i < keys.length; i += chunk) {
      const slice = keys.slice(i, i + chunk);
      const r = await this.call("getMultipleAccounts", [slice, { encoding: "base64", commitment }]);
      r.value.forEach((v, j) => { out[i + j] = Rpc.account(v); });
    }
    return out;
  }
  async getAccountInfo(key, { commitment = "confirmed" } = {}) {
    const r = await this.call("getAccountInfo", [key, { encoding: "base64", commitment }]);
    return Rpc.account(r.value);
  }
  /**
   * `[{pubkey, account}]` for every account of `program` matching the memcmp `filters`.
   * Helius refuses plain getProgramAccounts on programs with millions of accounts (pump.fun has
   * ~10 M) and asks for getProgramAccountsV2, a paginated scan: each call returns the matches of
   * one slice of the key space plus a `paginationKey` for the next one, until it is null. The
   * switch is made on the first refusal and remembered for the life of the process.
   */
  async getProgramAccounts(program, filters, { commitment = "confirmed", dataSlice } = {}) {
    const cfg = { encoding: "base64", commitment, filters };
    if (dataSlice) cfg.dataSlice = dataSlice;
    if (!this.gpaV2) {
      try {
        const r = await this.call("getProgramAccounts", [program, cfg], { timeoutMs: 120_000 });
        return r.map((x) => ({ pubkey: x.pubkey, account: Rpc.account(x.account) }));
      } catch (e) {
        if (!(e instanceof RpcError) || !/getProgramAccountsV2/i.test(e.message)) throw e;
        this.gpaV2 = true;
        this.log.info?.("rpc: getProgramAccounts refused by the provider, switching to getProgramAccountsV2 pagination");
      }
    }
    const out = [];
    let paginationKey = null, pages = 0;
    const t0 = Date.now();
    do {
      const r = await this.call("getProgramAccountsV2", [program, { ...cfg, limit: 10_000, ...(paginationKey ? { paginationKey } : {}) }], { timeoutMs: 120_000 });
      for (const x of r.accounts ?? []) out.push({ pubkey: x.pubkey, account: Rpc.account(x.account) });
      paginationKey = r.paginationKey ?? null;
      if (++pages % 100 === 0) this.log.info?.(`rpc: getProgramAccountsV2 page ${pages}, ${out.length} matches, ${Math.round((Date.now() - t0) / 1000)} s`);
    } while (paginationKey);
    this.log.info?.(`rpc: getProgramAccountsV2 done: ${pages} pages, ${out.length} matches, ${Math.round((Date.now() - t0) / 1000)} s`);
    return out;
  }
  /** Parsed token accounts of `owner` under `programId`: `[{pubkey, mint, amount, tokenProgram}]`. */
  async getTokenAccountsByOwner(owner, programId, { commitment = "confirmed" } = {}) {
    const r = await this.call("getTokenAccountsByOwner", [owner, { programId }, { encoding: "jsonParsed", commitment }]);
    return r.value.map((x) => ({ pubkey: x.pubkey, mint: x.account.data.parsed.info.mint, amount: x.account.data.parsed.info.tokenAmount.amount, tokenProgram: x.account.owner }));
  }
  async getSignaturesForAddress(address, opts = {}) {
    return this.call("getSignaturesForAddress", [address, { limit: 1000, commitment: "confirmed", ...opts }]);
  }
  /** Mainnet carries v1 transactions (2026); an RPC refuses the fetch unless the client accepts them. */
  async getTransaction(sig) {
    return this.call("getTransaction", [sig, { maxSupportedTransactionVersion: 1, encoding: "json", commitment: "confirmed" }]);
  }
  async getSlot() { return this.call("getSlot", [{ commitment: "confirmed" }]); }

  /**
   * Raw pass-through for the browser proxy on its own lane: body forwarded verbatim, the answer
   * relayed up to `maxBytes` (a getTokenAccountsByOwner of a whale is megabytes; nothing the
   * browser legitimately asks for is).
   */
  async proxy(body, { timeoutMs = 20_000, maxBytes = PROXY_MAX_BYTES } = {}) {
    const L = this.lanes.proxy;
    await this.#take(L);
    await this.#enter(L);
    this.stats.calls++;
    try {
      const res = await this.fetch(this.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
      const text = await readText(res, maxBytes);
      if (res.status === 429) this.#rateLimited(L, Number(res.headers.get("retry-after")));
      else L.backoffMs = 0;
      return { status: res.status, text };
    } finally { this.#leave(L); }
  }

  snapshot() { return { ...this.stats, ...this.lanes.main.snapshot() }; }
  /** Per-lane budget state for /api/health. */
  laneSnapshot() { return Object.fromEntries(Object.values(this.lanes).map((L) => [L.name, { rps: L.rps, ...L.snapshot() }])); }
}
