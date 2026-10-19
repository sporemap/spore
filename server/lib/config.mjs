// Boot configuration: every variable read once, validated together, and reported as one readable
// error so a bad deploy fails before it binds a port or touches the chain. The table in
// deploy/env.example and server/README.md mirrors this file.
import { mkdirSync, accessSync, constants as FS } from "node:fs";
import { join } from "node:path";
import { PublicKey } from "./sdk.mjs";
import { parseSplitBps, DEFAULT_SPLIT_BPS, DEFAULT_LAUNCH_FEE_SOL, launchFeeOf } from "./pricing.mjs";
import { deriveWsUrl } from "./rpc.mjs";
import { DEFAULT_PAGES_DOMAIN, DEFAULT_PAGES_PROJECT, DEFAULT_META_DIR, DEFAULT_QUOTA } from "./metahost.mjs";

export const DEFAULT_PLATFORM_WALLET = "FcbEAMqBvJVsfcFWDbED7geyBLR88ypcY88BoUSgmeT5";
export const DEFAULT_RPC_URL = "https://api.mainnet-beta.solana.com";
// Per-IP rate limits (requests per window) — DEPLOY.md documents each.
export const DEFAULT_RATES = { api: [300, 60_000], img: [900, 60_000], rpc: [60, 60_000], upload: [5, 10 * 60_000], spawned: [20, 10 * 60_000], sse: [30, 60_000] };

export function loadConfig(env = process.env, { here = process.cwd() } = {}) {
  const errors = [];
  const get = (k, d) => (env[k] === undefined || env[k] === "" ? d : String(env[k]));
  const num = (k, d, { min = -Infinity, max = Infinity, integer = false } = {}) => {
    const raw = get(k, d);
    const v = Number(raw);
    if (!Number.isFinite(v) || (integer && !Number.isInteger(v)) || v < min || v > max) { errors.push(`${k}=${JSON.stringify(raw)} must be ${integer ? "an integer" : "a number"}${min > -Infinity ? ` ≥ ${min}` : ""}${max < Infinity ? ` ≤ ${max}` : ""}`); return d; }
    return v;
  };
  const bool = (k, d) => { const v = get(k, d ? "1" : "0").toLowerCase(); if (!["0", "1", "true", "false", "yes", "no"].includes(v)) { errors.push(`${k} must be 0 or 1`); return d; } return ["1", "true", "yes"].includes(v); };
  const oneOf = (k, d, list) => { const v = get(k, d); if (!list.includes(v)) { errors.push(`${k}=${JSON.stringify(v)} must be one of ${list.join(", ")}`); return d; } return v; };
  const url = (k, d, protocols) => { const v = get(k, d); try { const u = new URL(v); if (!protocols.includes(u.protocol)) throw new Error(); return v; } catch { errors.push(`${k} must be a ${protocols.map((p) => p.replace(":", "")).join("/")} URL`); return d; } };
  const pubkey = (k, d) => { const v = get(k, d); try { new PublicKey(v); if (v.length < 32) throw new Error(); return v; } catch { errors.push(`${k}=${JSON.stringify(v)} is not a Solana public key`); return d; } };
  const dir = (k, d) => { const v = get(k, d); try { mkdirSync(v, { recursive: true }); accessSync(v, FS.W_OK); return v; } catch (e) { errors.push(`${k}=${JSON.stringify(v)} is not a writable directory (${e.code ?? e.message})`); return v; } };

  const port = num("PORT", 8793, { min: 1, max: 65535, integer: true });
  const rpcUrl = url("RPC_URL", DEFAULT_RPC_URL, ["http:", "https:"]);
  const wsUrl = url("WS_URL", deriveWsUrl(rpcUrl), ["ws:", "wss:"]);
  const dataDir = dir("DATA_DIR", join(here, "data"));
  const platformWallet = pubkey("PLATFORM_WALLET", DEFAULT_PLATFORM_WALLET);
  let splitBps = DEFAULT_SPLIT_BPS;
  try { splitBps = parseSplitBps(get("SPLIT_BPS", DEFAULT_SPLIT_BPS.join(","))); } catch (e) { errors.push(e.message); }
  let launchFeeSol = DEFAULT_LAUNCH_FEE_SOL;
  try { launchFeeSol = launchFeeOf(get("LAUNCH_FEE_SOL", String(DEFAULT_LAUNCH_FEE_SOL)), platformWallet).sol; } catch (e) { errors.push(e.message); }
  // A sharing config counts as ours only when the platform's share is at least this (default: its SPLIT_BPS slice).
  const platformMinBps = num("PLATFORM_MIN_BPS", Math.max(1, splitBps[3]), { min: 1, max: 10_000, integer: true });
  const refreshMs = num("REFRESH_MS", 30_000, { min: 1_000, integer: true });
  const fullRefreshMs = num("FULL_REFRESH_MS", 20 * 60_000, { min: refreshMs, integer: true });
  const backfill = bool("BACKFILL", true);
  const backfillLimit = get("BACKFILL_LIMIT", "") ? num("BACKFILL_LIMIT", 0, { min: 0, integer: true }) : Infinity;
  const concurrency = num("CONCURRENCY", 4, { min: 1, max: 64, integer: true });
  // The public RPC caps each method at ~40 requests per 10 s per IP; 4/s keeps the backfill's
  // getTokenAccountsByOwner stream under it without leaning on 429 backoff.
  const rpcRps = num("RPC_RPS", rpcUrl.includes("api.mainnet-beta.solana.com") ? 4 : 40, { min: 0.1, max: 10_000 });
  // Request-driven lanes (unknown-coin lookups, eligibility, the browser proxy) get their own small budgets.
  const rpcApiRps = num("RPC_API_RPS", Math.max(1, rpcRps / 4), { min: 0.1, max: 10_000 });
  const rpcProxyRps = num("RPC_PROXY_RPS", Math.max(1, rpcRps / 4), { min: 0.1, max: 10_000 });
  const createdAtProbe = bool("CREATED_AT_PROBE", true);
  // `ORIGINS` is the documented name; `ORIGIN` stays accepted from the first version.
  const origins = get("ORIGINS", get("ORIGIN", "")).split(",").map((s) => s.trim()).filter(Boolean);
  for (const o of origins) { try { if (new URL(o).origin !== o) throw new Error(); } catch { errors.push(`ORIGINS entry ${JSON.stringify(o)} is not an origin (scheme://host[:port], no path)`); } }
  const show = oneOf("SHOW", "ours", ["ours", "all"]);
  const pagesDomain = get("PAGES_DOMAIN", DEFAULT_PAGES_DOMAIN).toLowerCase();
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(pagesDomain)) errors.push(`PAGES_DOMAIN=${JSON.stringify(pagesDomain)} must be a hostname`);
  const pagesProject = get("PAGES_PROJECT", DEFAULT_PAGES_PROJECT);
  const metaDir = dir("META_DIR", DEFAULT_META_DIR);
  // express "trust proxy": false (direct), true (any proxy), a hop count, or a list of addresses/subnets.
  const trustRaw = get("TRUST_PROXY", "loopback");
  const trustProxy = /^(true|false)$/i.test(trustRaw) ? trustRaw.toLowerCase() === "true" : /^\d+$/.test(trustRaw) ? Number(trustRaw) : trustRaw;
  const hstsRaw = oneOf("HSTS", "auto", ["auto", "0", "1"]);
  const hsts = hstsRaw === "auto" ? "auto" : hstsRaw === "1";
  const logSample = num("LOG_SAMPLE", 0.1, { min: 0, max: 1 });
  const rates = {};
  for (const [name, [limit, windowMs]] of Object.entries(DEFAULT_RATES)) rates[name] = { limit: num(`RATE_${name.toUpperCase()}`, limit, { min: 1, integer: true }), windowMs };
  const cspConnect = get("CSP_CONNECT", "").split(",").map((s) => s.trim()).filter(Boolean);
  const treasuryTtlMs = num("TREASURY_TTL_MS", 60_000, { min: 5_000, integer: true });
  const sseMaxClients = num("SSE_MAX_CLIENTS", 2_000, { min: 1, integer: true });
  const ssePerIp = num("SSE_PER_IP", 5, { min: 1, integer: true });
  const uploadQuota = { ipPerDay: num("UPLOAD_DAILY_IP", DEFAULT_QUOTA.ipPerDay, { min: 1, integer: true }), bytesPerDay: num("UPLOAD_DAILY_MB", DEFAULT_QUOTA.bytesPerDay / 1024 / 1024, { min: 1 }) * 1024 * 1024, deploysPerDay: num("UPLOAD_DAILY_DEPLOYS", DEFAULT_QUOTA.deploysPerDay, { min: 1, integer: true }) };
  const metaGcHours = num("META_GC_HOURS", 24, { min: 0 }); // 0 = never delete uploaded files
  const imgCacheBytes = num("IMG_CACHE_MB", 512, { min: 1 }) * 1024 * 1024;
  const distDir = get("DIST_DIR", join(here, "../web/dist"));

  if (errors.length) throw new Error(`invalid configuration:\n  - ${errors.join("\n  - ")}\nSee deploy/env.example for every variable.`);
  return { port, rpcUrl, wsUrl, dataDir, platformWallet, splitBps, platformMinBps, launchFeeSol, refreshMs, fullRefreshMs, backfill, backfillLimit, concurrency, rpcRps, rpcApiRps, rpcProxyRps, createdAtProbe, origins, show, pagesDomain, pagesProject, metaDir, trustProxy, hsts, logSample, rates, cspConnect, treasuryTtlMs, sseMaxClients, ssePerIp, uploadQuota, metaGcHours, imgCacheBytes, distDir };
}
