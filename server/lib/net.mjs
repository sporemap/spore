// Outbound-request guards for the metadata and image fetchers (SSRF). URLs are checked before a
// request (meta.mjs allowlists), but a public hostname may still resolve to a private address and
// a redirect may point anywhere, so the host is resolved and checked first and redirects are
// followed by hand with the same checks at every hop.
//
// The vetted address is also the one the socket connects to: a resolver that answered a public
// address once and a private one a moment later (DNS rebinding, TTL 0) would otherwise slip past
// a check made before the fetch. `pinnedFetch` therefore opens the TLS connection to the exact
// address the guard approved while keeping the hostname for SNI and certificate verification.
import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";

const V4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function isPublicV4(s) {
  const v4 = s.match(V4_RE);
  if (!v4) return false;
  const [a, b, c] = v4.slice(1).map(Number);
  if (v4.slice(1).some((o) => Number(o) > 255)) return false;
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;        // CGNAT 100.64/10
  if (a === 169 && b === 254) return false;                   // link-local, cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  if (a >= 224) return false;                                 // multicast + reserved + broadcast
  return true;
}

/** Textual IPv6 (with `::` and an optional dotted IPv4 tail) → 16 bytes, or null when malformed. */
export function parseV6(s) {
  if (typeof s !== "string" || !/^[0-9a-f:.]+$/.test(s)) return null;
  let v4 = null;
  if (s.includes(".")) {
    const i = s.lastIndexOf(":");
    const m = s.slice(i + 1).match(V4_RE);
    if (i < 0 || !m || m.slice(1).some((o) => Number(o) > 255)) return null;
    v4 = m.slice(1).map(Number);
    s = `${s.slice(0, i + 1)}0:0`; // the tail occupies the last two groups
  }
  const parts = s.split("::");
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(":") : [];
  const tail = parts.length === 2 && parts[1] ? parts[1].split(":") : [];
  if (parts.length === 1 ? head.length !== 8 : head.length + tail.length > 7) return null;
  const groups = [...head, ...new Array(8 - head.length - tail.length).fill("0"), ...tail];
  const bytes = Buffer.alloc(16);
  for (let i = 0; i < 8; i++) {
    if (!/^[0-9a-f]{1,4}$/.test(groups[i])) return null;
    const n = parseInt(groups[i], 16);
    bytes[2 * i] = n >> 8; bytes[2 * i + 1] = n & 255;
  }
  if (v4) for (let i = 0; i < 4; i++) bytes[12 + i] = v4[i];
  return bytes;
}

/**
 * True for a globally routable unicast address. IPv4: private, loopback, link-local, CGNAT,
 * multicast and reserved ranges are false. IPv6: only 2000::/3 can be public, minus the
 * documentation, Teredo, benchmarking and ORCHID blocks; the forms that embed an IPv4 address
 * (::ffff:a.b.c.d, NAT64 64:ff9b::/96, 6to4 2002::/16) are judged by that IPv4, and the
 * deprecated IPv4-compatible ::/96 block is refused outright.
 */
export function isPublicIp(ip) {
  if (typeof ip !== "string") return false;
  const s = ip.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];
  if (!s) return false;
  if (!s.includes(":")) return isPublicV4(s);
  const b = parseV6(s);
  if (!b) return false;
  const v4At = (o) => `${b[o]}.${b[o + 1]}.${b[o + 2]}.${b[o + 3]}`;
  const zero = (from, to) => b.subarray(from, to).every((x) => x === 0);
  if (zero(0, 10) && b[10] === 0xff && b[11] === 0xff) return isPublicV4(v4At(12)); // IPv4-mapped
  if (zero(0, 12)) return false;                                                     // ::, ::1, IPv4-compatible ::/96
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) {
    if (b[4] === 0 && b[5] === 1) return false;                                      // 64:ff9b:1::/48 local-use NAT64
    return zero(4, 12) ? isPublicV4(v4At(12)) : false;                              // 64:ff9b::/96 NAT64
  }
  if ((b[0] & 0xe0) !== 0x20) return false;                                          // outside 2000::/3: ULA, link-local, multicast, discard…
  if (b[0] === 0x20 && b[1] === 0x02) return isPublicV4(v4At(2));                    // 6to4 2002::/16
  if (b[0] === 0x20 && b[1] === 0x01) {
    if (b[2] === 0x0d && b[3] === 0xb8) return false;                                // 2001:db8::/32 documentation
    if (b[2] === 0x00 && b[3] === 0x00) return false;                                // 2001::/32 Teredo (obfuscated IPv4 inside)
    if (b[2] === 0x00 && b[3] === 0x02 && b[4] === 0 && b[5] === 0) return false;    // 2001:2::/48 benchmarking
    if (b[2] === 0x00 && (b[3] & 0xf0) === 0x10) return false;                       // 2001:10::/28 ORCHID
  }
  return true;
}

const familyOf = (address) => (address.includes(":") ? 6 : 4);

/**
 * Resolves `hostname`, refuses when any answer is non-public (a public name pointing at a private
 * address is the classic rebinding trick) and returns the vetted address to connect to. Results
 * are cached briefly so a page full of images does not re-resolve ipfs.io per request; the cached
 * answer is safe to reuse because connections are pinned to it (see `pinnedFetch`).
 */
export class HostGuard {
  constructor({ resolve = (h) => lookup(h, { all: true, verbatim: true }), ttlMs = 10 * 60_000, now = Date.now } = {}) { this.resolve = resolve; this.ttlMs = ttlMs; this.now = now; this.cache = new Map(); }
  /** `{ address, family }` of the vetted address; throws when the host must not be contacted. */
  async assertPublic(hostname) {
    const host = String(hostname).toLowerCase().replace(/^\[|\]$/g, "");
    if (isPublicIp(host)) return { address: host, family: familyOf(host) }; // a literal public IP needs no lookup
    if (V4_RE.test(host) || host.includes(":")) throw new Error(`refusing non-public address ${host}`);
    const hit = this.cache.get(host);
    if (hit && this.now() - hit.at < this.ttlMs) {
      if (!hit.ok) throw new Error(`refusing ${host}: resolves to a non-public address`);
      return { address: hit.address, family: familyOf(hit.address) };
    }
    let addrs;
    try { addrs = await this.resolve(host); } catch (e) { throw new Error(`cannot resolve ${host}: ${e.code ?? e.message}`); }
    const list = (Array.isArray(addrs) ? addrs : [addrs]).map((a) => (typeof a === "string" ? a : a?.address)).filter(Boolean);
    const ok = list.length > 0 && list.every(isPublicIp);
    this.cache.set(host, { at: this.now(), ok, address: ok ? list[0] : null });
    if (this.cache.size > 2_000) for (const [k, v] of this.cache) if (this.now() - v.at >= this.ttlMs) this.cache.delete(k);
    if (!ok) throw new Error(`refusing ${host}: resolves to a non-public address`);
    return { address: list[0], family: familyOf(list[0]) };
  }
}

const NULL_BODY_STATUS = new Set([204, 205, 304]);
const headerList = (h) => {
  if (!h) return {};
  if (typeof h.entries === "function" && !Array.isArray(h)) return Object.fromEntries([...h.entries()]);
  return Array.isArray(h) ? Object.fromEntries(h) : { ...h };
};

/**
 * `fetch`-shaped https request whose TCP connection goes to `address` while TLS still verifies
 * the certificate against the URL's hostname (SNI + checkServerIdentity use the name). Built on
 * node:https because Node's fetch cannot be told which address to use without the undici package.
 * Only what the fetchers use is implemented: method, headers, signal, `redirect: "manual"`
 * semantics (no automatic redirects) and a streamed body behind the Response interface.
 */
export function pinnedFetch(url, init = {}, { address = null, family = 0 } = {}) {
  const u = new URL(String(url));
  if (u.protocol !== "https:") return Promise.reject(new Error(`pinned fetch is https only (${u.protocol})`));
  return new Promise((resolve, reject) => {
    const signal = init.signal;
    if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"));
    const req = httpsRequest({
      host: u.hostname, servername: u.hostname, port: u.port || 443, path: `${u.pathname}${u.search}`,
      method: init.method ?? "GET", headers: headerList(init.headers),
      // net may ask for every address (autoSelectFamily) or just one: answer the pinned one either way.
      lookup: address ? (host, opts, cb) => { const fam = family || familyOf(address); if (opts?.all) cb(null, [{ address, family: fam }]); else cb(null, address, fam); } : undefined,
    }, (res) => {
      const status = res.statusCode ?? 0;
      if (status < 200 || status > 599) { res.resume(); return reject(new Error(`unexpected status ${status}`)); }
      const body = NULL_BODY_STATUS.has(status) ? (res.resume(), null) : Readable.toWeb(res);
      resolve(new Response(body, { status, statusText: res.statusMessage ?? "", headers: Object.entries(res.headers).filter(([, v]) => v != null).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : String(v)]) }));
    });
    const onAbort = () => req.destroy(signal?.reason ?? new Error("aborted"));
    signal?.addEventListener("abort", onAbort, { once: true });
    req.on("error", (e) => { signal?.removeEventListener("abort", onAbort); reject(e); });
    req.on("close", () => signal?.removeEventListener("abort", onAbort));
    if (init.body != null) req.write(init.body);
    req.end();
  });
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/**
 * `fetch` with manual redirects: each hop's URL must pass `allow(url)` (the caller's allowlist)
 * and its host the guard, at most `maxRedirects` hops; the connection of every hop is pinned to
 * the address the guard vetted. Returns the final response and URL.
 */
export async function guardedFetch(url, init = {}, { allow = () => true, guard = null, fetchImpl = pinnedFetch, maxRedirects = 3 } = {}) {
  let current = String(url);
  for (let hop = 0; ; hop++) {
    if (!allow(current)) throw new Error(`blocked url ${current.slice(0, 120)}`);
    const pin = guard ? await guard.assertPublic(new URL(current).hostname) : {};
    const res = await fetchImpl(current, { ...init, redirect: "manual" }, pin);
    if (!REDIRECTS.has(res.status)) return { res, url: current };
    const loc = res.headers.get("location");
    try { res.body?.cancel?.(); } catch { /* nothing to drain */ }
    if (!loc || hop >= maxRedirects) throw new Error(`too many redirects from ${current.slice(0, 120)}`);
    current = new URL(loc, current).toString();
  }
}
