// Spore server: pump.fun family-tree indexer + JSON API + static web app. Boots the sqlite-backed
// model, the RPC budget, the live subscription and the backfill, then serves /api/* (and web/dist in
// production). No keys live here; the browser builds and signs every transaction itself.
// Configuration is validated first (lib/config.mjs) so a bad deploy fails before it binds a port.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./lib/config.mjs";
import { Db } from "./lib/db.mjs";
import { Model } from "./lib/model.mjs";
import { Rpc, redact } from "./lib/rpc.mjs";
import { EventHub } from "./lib/events.mjs";
import { ImageCache, MetaFetcher, configureLocalMetaHost } from "./lib/meta.mjs";
import { Indexer } from "./lib/indexer.mjs";
import { createApp } from "./lib/api.mjs";
import { MetaHost, DailyQuota } from "./lib/metahost.mjs";
import { Treasury } from "./lib/treasury.mjs";
import { ApiKeys } from "./lib/apikeys.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const log = {
  info: (m) => console.log(`${new Date().toISOString()} ${m}`),
  warn: (m) => console.warn(`${new Date().toISOString()} WARN ${m}`),
  error: (m) => console.error(`${new Date().toISOString()} ERROR ${m}`),
};

let cfg;
try { cfg = loadConfig(process.env, { here }); }
catch (e) { console.error(`spore: ${e.message}`); process.exit(1); }

const db = new Db(join(cfg.dataDir, "spore.sqlite"));
const model = new Model(db, { platformWallet: cfg.platformWallet, splitBps: cfg.splitBps, platformMinBps: cfg.platformMinBps, mode: cfg.show, log });
model.load();
configureLocalMetaHost({ domain: cfg.pagesDomain, dir: join(cfg.metaDir, "m") });
const metahost = new MetaHost({ root: cfg.metaDir, domain: cfg.pagesDomain, project: cfg.pagesProject, log, ledger: db, quota: new DailyQuota(cfg.uploadQuota) });
const rpc = new Rpc({ url: cfg.rpcUrl, rps: cfg.rpcRps, concurrency: cfg.concurrency, apiRps: cfg.rpcApiRps, proxyRps: cfg.rpcProxyRps, log });
const hub = new EventHub({ maxClients: cfg.sseMaxClients, maxPerIp: cfg.ssePerIp });
const images = new ImageCache(join(cfg.dataDir, "img"), { log, maxBytes: cfg.imgCacheBytes });
const meta = new MetaFetcher(model, { log, concurrency: 6 });
const indexer = new Indexer({ rpc, model, meta, hub, log, opts: { backfill: cfg.backfill, backfillLimit: cfg.backfillLimit, refreshMs: cfg.refreshMs, fullRefreshMs: cfg.fullRefreshMs, wsUrl: cfg.wsUrl, createdAtProbe: cfg.createdAtProbe } });
// Partner keys for /v1 (DESIGN §12): verified per request, usage counters written every 30 s.
const apiKeys = new ApiKeys(db, { log }).start();
const treasury = new Treasury({ model, rpc, platformWallet: cfg.platformWallet, ttlMs: cfg.treasuryTtlMs, log });
const app = createApp({
  model, indexer, rpc, hub, images, meta, metahost, treasury, metaDir: cfg.metaDir, platformWallet: cfg.platformWallet, splitBps: cfg.splitBps, launchFeeSol: cfg.launchFeeSol,
  distDir: cfg.distDir, origins: cfg.origins, log, rates: cfg.rates, trustProxy: cfg.trustProxy, hsts: cfg.hsts, logSample: cfg.logSample, pagesDomain: cfg.pagesDomain, cspConnect: cfg.cspConnect,
  apiKeys, publicUrl: cfg.publicUrl, v1Limits: cfg.v1Limits,
});

const server = app.listen(cfg.port, () => log.info(`spore api on :${cfg.port} → ${redact(cfg.rpcUrl)} (ws ${redact(cfg.wsUrl)}) data ${cfg.dataDir}${cfg.backfill ? (Number.isFinite(cfg.backfillLimit) ? ` backfill limit ${cfg.backfillLimit}` : "") : " backfill off"} mode ${cfg.show} fee ${cfg.launchFeeSol} SOL meta ${cfg.pagesDomain} trust-proxy ${JSON.stringify(cfg.trustProxy)}`));
server.on("error", (e) => { log.error(`listen :${cfg.port} failed: ${e.message}`); process.exit(1); });
// Longer than a typical proxy's upstream keep-alive (nginx 60 s) so the proxy never reuses a socket we just closed.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 70_000;
server.requestTimeout = 120_000; // the upload waits on a wrangler deploy; everything else answers in milliseconds

const imageSweep = setInterval(() => { try { images.sweep(); } catch { /* best effort */ } }, 6 * 3600_000); imageSweep.unref();
// Uploaded metadata nobody launched with is removed after META_GC_HOURS (0 keeps everything); the
// model decides what is referenced, so a file a coin points at is never touched.
const metaGc = cfg.metaGcHours > 0 ? setInterval(() => { metahost.gc({ referenced: (name) => model.referencesMetaFile(name), maxAgeMs: cfg.metaGcHours * 3600_000 }).catch((e) => log.warn(`metahost gc: ${e.message}`)); }, 3600_000) : null; metaGc?.unref();
// A periodic checkpoint keeps the WAL small so a crash loses little and a backup copies one file.
const checkpoint = setInterval(() => db.checkpoint(), 15 * 60_000); checkpoint.unref();

try { await indexer.start(); } catch (e) { log.error(`indexer failed to start: ${e.stack ?? e}`); process.exitCode = 1; shutdown("indexer"); }
// Off-chain metadata for every tracked coin (DESIGN §11.5): a background sweep every minute, by
// locked value then recency; HTTP to gateways only, so it never competes with the RPC lanes.
meta.start();

/**
 * Graceful stop: stop accepting, end every SSE stream (clients reconnect to the new process), let
 * in-flight requests finish, then checkpoint and close sqlite. A hard exit after 8 s guards
 * against a stuck socket; PM2/systemd both wait that long (kill_timeout / TimeoutStopSec).
 */
let stopping = false;
function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log.info(`shutting down (${signal})`);
  clearInterval(imageSweep); clearInterval(checkpoint); if (metaGc) clearInterval(metaGc);
  indexer.stop(); meta.stop(); hub.close(); app.locals.v1?.close(); apiKeys.stop();
  server.close(() => { try { apiKeys.flush(); db.close(); } catch { /* already closed */ } log.info("bye"); process.exit(process.exitCode ?? 0); });
  server.closeIdleConnections?.();
  setTimeout(() => server.closeAllConnections?.(), 2_000).unref();
  setTimeout(() => { log.warn("forced exit"); try { apiKeys.flush(); db.close(); } catch { /* ignore */ } process.exit(process.exitCode ?? 0); }, 8_000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("unhandledRejection", (e) => log.error(`unhandled rejection: ${e?.stack ?? e}`));
process.on("uncaughtException", (e) => { log.error(`uncaught exception: ${e?.stack ?? e}`); process.exitCode = 1; shutdown("uncaughtException"); });
