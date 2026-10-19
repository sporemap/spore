// HTTP hardening shared by every route: security headers (CSP with a per-request nonce), CORS from
// an allowlist, per-IP rate limits with X-RateLimit headers, sampled request logging, gzip/brotli
// for text responses and ETag/Cache-Control helpers. No dependencies beyond Node: express is the
// only HTTP package in this server and helmet/compression/express-rate-limit would each pull a
// tree of their own for a few dozen lines of behaviour that is easier to test here.
import { createHash, randomBytes } from "node:crypto";
import { brotliCompressSync, gzipSync, createBrotliCompress, createGzip, constants as Z } from "node:zlib";

// ---------------------------------------------------------------- rate limiting
/**
 * Fixed-window counter per key (client IP). `check` reports the window so a route can answer with
 * X-RateLimit-* headers; `refund` gives a hit back when the request turned out not to count (an
 * upload rejected by validation should not burn one of the caller's five attempts).
 */
export class RateLimiter {
  constructor({ limit, windowMs, now = Date.now }) { this.limit = limit; this.windowMs = windowMs; this.now = now; this.hits = new Map(); }
  check(key) {
    const t = this.now();
    let h = this.hits.get(key);
    if (!h || t - h.at >= this.windowMs) {
      h = { at: t, n: 0 }; this.hits.set(key, h);
      // Opportunistic sweep so a scan of many IPs cannot grow the map without bound.
      if (this.hits.size > 10_000) for (const [k, v] of this.hits) if (t - v.at >= this.windowMs) this.hits.delete(k);
    }
    const resetAt = h.at + this.windowMs;
    if (h.n >= this.limit) return { ok: false, limit: this.limit, remaining: 0, resetAt };
    h.n++;
    return { ok: true, limit: this.limit, remaining: this.limit - h.n, resetAt };
  }
  allow(key) { return this.check(key).ok; }
  refund(key) { const h = this.hits.get(key); if (h && h.n > 0) h.n--; }
}

/** Express middleware: one bucket per client IP; 429 JSON with Retry-After when it is empty. */
export function rateLimit({ limit, windowMs, name = "api", keyOf = (req) => req.ip, now = Date.now, limiter = null } = {}) {
  const rl = limiter ?? new RateLimiter({ limit, windowMs, now });
  const mw = (req, res, next) => {
    const r = rl.check(keyOf(req) ?? "?");
    res.setHeader("x-ratelimit-limit", String(r.limit));
    res.setHeader("x-ratelimit-remaining", String(r.remaining));
    res.setHeader("x-ratelimit-reset", String(Math.ceil(r.resetAt / 1000)));
    res.setHeader("x-ratelimit-policy", `${r.limit};w=${Math.round(rl.windowMs / 1000)};name=${name}`);
    if (r.ok) return next();
    const retryAfter = Math.max(1, Math.ceil((r.resetAt - now()) / 1000));
    res.setHeader("retry-after", String(retryAfter));
    res.status(429).json({ error: `rate limited (${name}: ${r.limit} per ${Math.round(rl.windowMs / 1000)} s), try again in ${retryAfter} s`, retryAfter });
  };
  mw.limiter = rl;
  return mw;
}

// ---------------------------------------------------------------- security headers
export const DEFAULT_CSP_HOSTS = { fonts: ["https://fonts.googleapis.com", "https://fonts.gstatic.com"], frames: ["https://connect.solflare.com"] };

/**
 * Content-Security-Policy for the SPA. Scripts: our own bundles plus a nonce for the one inline
 * theme snippet index.html may carry (`<script nonce="__CSP_NONCE__">`); styles need
 * 'unsafe-inline' because React, d3 and lightweight-charts set style attributes; connect-src is
 * same-origin only (the RPC goes through /api/rpc, the SSE stream is /api/events), plus the
 * metadata host; images are our proxy, data: (wallet icons) and the metadata host; Solflare's
 * web wallet runs in an iframe. Nothing may frame us.
 */
export function buildCsp({ nonce, pagesDomain = null, extraConnect = [], extraFrames = [] } = {}) {
  const pages = pagesDomain ? [`https://${pagesDomain}`] : [];
  const d = [
    "default-src 'self'",
    `script-src 'self'${nonce ? ` 'nonce-${nonce}'` : ""}`,
    `style-src 'self' 'unsafe-inline' ${DEFAULT_CSP_HOSTS.fonts[0]}`,
    `font-src 'self' data: ${DEFAULT_CSP_HOSTS.fonts[1]}`,
    `img-src 'self' data: blob: ${pages.join(" ")}`.trim(),
    `connect-src 'self' ${[...pages, ...extraConnect].join(" ")}`.trim(),
    `frame-src ${[...DEFAULT_CSP_HOSTS.frames, ...extraFrames].join(" ")}`,
    "worker-src 'self' blob:",
    "media-src 'self' data: blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ];
  return d.join("; ");
}
export const API_CSP = "default-src 'none'; frame-ancestors 'none'";

/**
 * Helmet-style headers on every response. HSTS only when the request arrived over TLS (behind a
 * TLS-terminating proxy that is trusted, `req.secure` reflects X-Forwarded-Proto) or when forced
 * by config, so a plain-http dev server never pins browsers to https. Each request gets a nonce
 * (`res.locals.cspNonce`) that the HTML sender puts into the CSP and the inline snippet.
 */
export function securityHeaders({ hsts = "auto" } = {}) {
  return (req, res, next) => {
    res.locals.cspNonce = randomBytes(16).toString("base64");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("x-frame-options", "DENY");
    res.setHeader("referrer-policy", "strict-origin-when-cross-origin");
    res.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()");
    res.setHeader("cross-origin-opener-policy", "same-origin");
    res.setHeader("x-dns-prefetch-control", "off");
    if (hsts === true || (hsts === "auto" && req.secure)) res.setHeader("strict-transport-security", "max-age=15552000; includeSubDomains");
    // API and file responses get the restrictive policy; the HTML sender overrides it with the SPA one.
    res.setHeader("content-security-policy", API_CSP);
    next();
  };
}

/** CORS for an explicit allowlist of origins (a separate dev host); production is same-origin. */
export function cors(origins = []) {
  const allowed = new Set(origins);
  return (req, res, next) => {
    const origin = req.headers.origin;
    if (origin && allowed.has(origin)) {
      res.setHeader("access-control-allow-origin", origin);
      res.setHeader("vary", "origin");
      res.setHeader("access-control-allow-headers", "content-type");
      res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
      res.setHeader("access-control-max-age", "600");
    }
    if (req.method === "OPTIONS" && req.path.startsWith("/api/")) return res.sendStatus(204);
    next();
  };
}

// ---------------------------------------------------------------- logging
/**
 * One line per request with status, latency and bytes. Every error and every slow request is
 * logged; the rest is sampled (`sample` = fraction) so a busy site does not write a line per
 * image. Query strings are dropped: the image proxy's `u=` is long and never needed to debug.
 */
export function requestLog({ log = console, sample = 0.1, slowMs = 1000, random = Math.random } = {}) {
  return (req, res, next) => {
    const t0 = process.hrtime.bigint();
    res.on("finish", () => {
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      const errorish = res.statusCode >= 400, slow = ms >= slowMs;
      if (!errorish && !slow && random() >= sample) return;
      const bytes = res.getHeader("content-length") ?? "-";
      const line = `${req.method} ${req.path} ${res.statusCode} ${ms.toFixed(1)}ms ${bytes}B ${req.ip}${slow ? " SLOW" : ""}`;
      if (res.statusCode >= 500) log.error?.(`http: ${line}`); else if (errorish) log.warn?.(`http: ${line}`); else log.info?.(`http: ${line}`);
    });
    next();
  };
}

// ---------------------------------------------------------------- compression
const COMPRESSIBLE = /json|text\/|javascript|xml|svg|wasm|font\/ttf|font\/otf/i;
const encodingOf = (req) => { const a = String(req.headers["accept-encoding"] ?? ""); return /\bbr\b/.test(a) ? "br" : /\bgzip\b/.test(a) ? "gzip" : null; };

/**
 * gzip/brotli from node:zlib. A response that ends in one call (`res.json`, `res.send`) is
 * compressed synchronously when it is at least `threshold` bytes; a streamed one (express.static
 * piping a file) goes through a zlib stream. Event streams and already-encoded bodies pass
 * untouched. Brotli quality 4 / gzip level 6 keep CPU per request in the sub-millisecond range for
 * API payloads while still cutting JSON by ~80%.
 */
export function compression({ threshold = 1024, brotliQuality = 4, gzipLevel = 6 } = {}) {
  const brOpts = { params: { [Z.BROTLI_PARAM_QUALITY]: brotliQuality } };
  return (req, res, next) => {
    const enc = encodingOf(req);
    if (!enc || req.method === "HEAD") return next();
    const write = res.write.bind(res), end = res.end.bind(res), writeHead = res.writeHead.bind(res);
    let mode = null; // null = undecided, "stream", "sync" or "none"
    let stream = null;
    const compressible = () => {
      if (res.headersSent || res.getHeader("content-encoding") || res.statusCode === 204 || res.statusCode === 304) return false;
      const ct = String(res.getHeader("content-type") ?? "");
      return COMPRESSIBLE.test(ct) && !/event-stream/i.test(ct);
    };
    const mark = () => {
      res.removeHeader("content-length");
      res.setHeader("content-encoding", enc);
      const vary = res.getHeader("vary");
      res.setHeader("vary", vary ? `${vary}, accept-encoding` : "accept-encoding");
    };
    const startStream = () => {
      stream = enc === "br" ? createBrotliCompress(brOpts) : createGzip({ level: gzipLevel });
      stream.on("data", (chunk) => write(chunk));
      stream.on("end", () => end());
      stream.on("error", () => res.destroy());
      mark();
    };
    const decideStream = () => {
      if (mode) return;
      const len = Number(res.getHeader("content-length"));
      if (compressible() && !(Number.isFinite(len) && len > 0 && len < threshold)) { mode = "stream"; startStream(); } else mode = "none";
    };
    res.writeHead = (status, a, b) => {
      // Headers handed to writeHead bypass getHeader, so they are folded into the header store first.
      const hdrs = a && typeof a === "object" ? a : b;
      if (hdrs && !Array.isArray(hdrs)) for (const [k, v] of Object.entries(hdrs)) if (v !== undefined) res.setHeader(k, v);
      if (!res.headersSent) res.statusCode = status;
      decideStream();
      return typeof a === "string" ? writeHead(status, a) : writeHead(status);
    };
    res.write = (chunk, encoding, cb) => {
      if (!mode) decideStream();
      if (mode !== "stream") return write(chunk, encoding, cb);
      if (chunk != null) stream.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof encoding === "string" ? encoding : "utf8"));
      if (typeof encoding === "function") encoding(); else if (cb) cb();
      return true;
    };
    res.end = (chunk, encoding, cb) => {
      if (typeof chunk === "function") { cb = chunk; chunk = null; encoding = undefined; }
      if (typeof encoding === "function") { cb = encoding; encoding = undefined; }
      if (!mode) {
        const buf = chunk == null ? null : Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding ?? "utf8");
        if (buf && buf.length >= threshold && compressible()) {
          mode = "sync";
          const out = enc === "br" ? brotliCompressSync(buf, brOpts) : gzipSync(buf, { level: gzipLevel });
          mark(); res.setHeader("content-length", String(out.length));
          return end(out, cb);
        }
        mode = "none";
      }
      if (mode !== "stream") return end(chunk, encoding, cb);
      if (chunk != null) stream.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding ?? "utf8"));
      stream.end();
      if (cb) res.once("finish", cb);
      return res;
    };
    next();
  };
}

// ---------------------------------------------------------------- caching helpers
export const etagOf = (body) => `W/"${createHash("sha1").update(body).digest("base64url").slice(0, 20)}"`;

/**
 * JSON with a weak ETag and a short public max-age: feeds and leaderboards change every refresh
 * tick, so a few seconds of caching lets a CDN or a browser tab absorb repeat loads, and an
 * If-None-Match hit costs nothing but the hash.
 */
export function sendCachedJson(req, res, body, { maxAge = 5, swr = maxAge * 4 } = {}) {
  const text = JSON.stringify(body);
  const tag = etagOf(text);
  res.setHeader("etag", tag);
  res.setHeader("cache-control", `public, max-age=${maxAge}, stale-while-revalidate=${swr}`);
  if (req.headers["if-none-match"] === tag) return res.status(304).end();
  res.type("application/json").send(text);
}

/**
 * A JSON body encoded once and served many times: the text, its ETag and, lazily, the gzip and
 * brotli bytes. The whole-forest map is ~5 MB of JSON for 15k coins; compressing it per request
 * would cost more than building it, so the cache entry holds the bytes for the 10 s it lives.
 */
export function prepareJson(body, { brotliQuality = 4, gzipLevel = 6 } = {}) {
  const text = JSON.stringify(body);
  const buf = Buffer.from(text, "utf8");
  const p = { text, bytes: buf, etag: etagOf(text), br: null, gz: null };
  p.encoded = (enc) => {
    if (enc === "br") return (p.br ??= brotliCompressSync(buf, { params: { [Z.BROTLI_PARAM_QUALITY]: brotliQuality } }));
    if (enc === "gzip") return (p.gz ??= gzipSync(buf, { level: gzipLevel }));
    return buf;
  };
  return p;
}
/** Sends a `prepareJson` result with the cache headers of `sendCachedJson`, pre-encoded for the client's accept-encoding. */
export function sendPrepared(req, res, prepared, { maxAge = 5, swr = maxAge * 4 } = {}) {
  res.setHeader("etag", prepared.etag);
  res.setHeader("cache-control", `public, max-age=${maxAge}, stale-while-revalidate=${swr}`);
  if (req.headers["if-none-match"] === prepared.etag) return res.status(304).end();
  const enc = req.method === "HEAD" ? null : encodingOf(req);
  const out = enc && prepared.bytes.length >= 1024 ? prepared.encoded(enc) : prepared.bytes;
  res.setHeader("content-type", "application/json; charset=utf-8");
  if (out !== prepared.bytes) { res.setHeader("content-encoding", enc); const vary = res.getHeader("vary"); res.setHeader("vary", vary ? `${vary}, accept-encoding` : "accept-encoding"); }
  res.setHeader("content-length", String(out.length));
  res.end(out);
}

/** Serves index.html with the SPA CSP and the per-request nonce substituted into `__CSP_NONCE__`. */
export function sendSpaHtml(res, html, { pagesDomain, extraConnect = [], extraFrames = [] } = {}) {
  const nonce = res.locals.cspNonce;
  res.setHeader("content-security-policy", buildCsp({ nonce, pagesDomain, extraConnect, extraFrames }));
  res.setHeader("cache-control", "no-cache");
  res.type("html").send(html.includes("__CSP_NONCE__") ? html.replaceAll("__CSP_NONCE__", nonce) : html);
}
