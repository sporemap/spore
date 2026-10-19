// Boot configuration: defaults, every validation message, and the fail-fast aggregate error.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, DEFAULT_PLATFORM_WALLET, DEFAULT_RATES } from "../lib/config.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "spore-cfg-"));

test("defaults: public RPC at 4 rps, ours mode, no launch fee, loopback trust, rate table", () => {
  const dir = tmp();
  try {
    const c = loadConfig({ DATA_DIR: join(dir, "data"), META_DIR: join(dir, "meta") }, { here: dir });
    assert.equal(c.port, 8793); assert.equal(c.rpcRps, 4); assert.equal(c.wsUrl, "wss://api.mainnet-beta.solana.com");
    assert.equal(c.show, "ours"); assert.equal(c.launchFeeSol, 0); assert.equal(c.platformWallet, DEFAULT_PLATFORM_WALLET);
    assert.deepEqual(c.splitBps, [5000, 0, 0, 5000]); assert.equal(c.trustProxy, "loopback"); assert.equal(c.hsts, "auto");
    assert.equal(c.backfillLimit, Infinity); assert.deepEqual(c.origins, []);
    for (const k of Object.keys(DEFAULT_RATES)) assert.deepEqual(c.rates[k], { limit: DEFAULT_RATES[k][0], windowMs: DEFAULT_RATES[k][1] });
    assert.equal(c.rates.sse.limit, 30);
    assert.equal(c.platformMinBps, 5000); assert.equal(c.rpcApiRps, 1); assert.equal(c.rpcProxyRps, 1);
    assert.equal(c.sseMaxClients, 2000); assert.equal(c.ssePerIp, 5);
    assert.deepEqual(c.uploadQuota, { ipPerDay: 20, bytesPerDay: 256 * 1024 * 1024, deploysPerDay: 200 });
    assert.equal(c.metaGcHours, 24); assert.equal(c.imgCacheBytes, 512 * 1024 * 1024);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("overrides: Helius-style URLs derive the socket, ORIGINS parsed, trust proxy forms, rate overrides", () => {
  const dir = tmp();
  try {
    const c = loadConfig({ DATA_DIR: join(dir, "d"), META_DIR: join(dir, "m"), RPC_URL: "https://mainnet.helius-rpc.com/?api-key=abc", ORIGINS: "http://localhost:5174, https://spore.fun", TRUST_PROXY: "1", RATE_API: "50", SHOW: "all", HSTS: "1", BACKFILL_LIMIT: "150", BACKFILL: "0", LOG_SAMPLE: "0" }, { here: dir });
    assert.equal(c.wsUrl, "wss://mainnet.helius-rpc.com/?api-key=abc"); assert.equal(c.rpcRps, 40);
    assert.deepEqual(c.origins, ["http://localhost:5174", "https://spore.fun"]);
    assert.equal(c.trustProxy, 1); assert.equal(c.rates.api.limit, 50); assert.equal(c.show, "all"); assert.equal(c.hsts, true);
    assert.equal(c.backfillLimit, 150); assert.equal(c.backfill, false); assert.equal(c.logSample, 0);
    assert.equal(loadConfig({ DATA_DIR: join(dir, "d"), META_DIR: join(dir, "m"), TRUST_PROXY: "false" }, { here: dir }).trustProxy, false);
    assert.equal(loadConfig({ DATA_DIR: join(dir, "d"), META_DIR: join(dir, "m"), TRUST_PROXY: "10.0.0.0/8, 127.0.0.1" }, { here: dir }).trustProxy, "10.0.0.0/8, 127.0.0.1");
    assert.equal(loadConfig({ DATA_DIR: join(dir, "d"), META_DIR: join(dir, "m"), ORIGIN: "https://old.example" }, { here: dir }).origins[0], "https://old.example", "legacy ORIGIN still read");
    const h = loadConfig({ DATA_DIR: join(dir, "d"), META_DIR: join(dir, "m"), RPC_URL: "https://mainnet.helius-rpc.com/?api-key=abc", PLATFORM_MIN_BPS: "1500", RPC_API_RPS: "3", RPC_PROXY_RPS: "2.5", RATE_SSE: "5", SSE_PER_IP: "2", UPLOAD_DAILY_IP: "3", UPLOAD_DAILY_MB: "1", UPLOAD_DAILY_DEPLOYS: "4", META_GC_HOURS: "0", IMG_CACHE_MB: "64", SPLIT_BPS: "8500,0,0,1500" }, { here: dir });
    assert.equal(h.platformMinBps, 1500); assert.equal(h.rpcApiRps, 3); assert.equal(h.rpcProxyRps, 2.5); assert.equal(h.rates.sse.limit, 5); assert.equal(h.ssePerIp, 2);
    assert.deepEqual(h.uploadQuota, { ipPerDay: 3, bytesPerDay: 1024 * 1024, deploysPerDay: 4 }); assert.equal(h.metaGcHours, 0); assert.equal(h.imgCacheBytes, 64 * 1024 * 1024);
    assert.equal(loadConfig({ DATA_DIR: join(dir, "d"), META_DIR: join(dir, "m"), RPC_URL: "https://mainnet.helius-rpc.com/?api-key=abc", SPLIT_BPS: "8500,0,0,1500" }, { here: dir }).platformMinBps, 1500, "the floor follows the platform slice");
    assert.equal(loadConfig({ DATA_DIR: join(dir, "d"), META_DIR: join(dir, "m"), RPC_URL: "https://mainnet.helius-rpc.com/?api-key=abc" }, { here: dir }).rpcApiRps, 10, "a quarter of RPC_RPS");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("every bad value is reported at once, by name, with the fix", () => {
  const dir = tmp();
  try {
    const bad = { DATA_DIR: join(dir, "d"), META_DIR: join(dir, "m"), PORT: "99999", RPC_URL: "ftp://x", WS_URL: "https://not-ws", PLATFORM_WALLET: "nope", SPLIT_BPS: "1,2,3", LAUNCH_FEE_SOL: "99", SHOW: "mine", ORIGINS: "spore.fun", REFRESH_MS: "10", CONCURRENCY: "0", TRUST_PROXY: "loopback", HSTS: "maybe", LOG_SAMPLE: "2", RATE_RPC: "0", PAGES_DOMAIN: "not a host", PLATFORM_MIN_BPS: "0", SSE_PER_IP: "x", UPLOAD_DAILY_MB: "0" };
    assert.throws(() => loadConfig(bad, { here: dir }), (e) => {
      const m = e.message;
      for (const needle of ["invalid configuration", "PORT=\"99999\"", "RPC_URL must be a http/https URL", "WS_URL must be a ws/wss URL", "PLATFORM_WALLET=\"nope\" is not a Solana public key", "SPLIT_BPS", "LAUNCH_FEE_SOL", "SHOW=\"mine\"", "ORIGINS entry \"spore.fun\"", "REFRESH_MS", "CONCURRENCY", "HSTS", "LOG_SAMPLE", "RATE_RPC", "PAGES_DOMAIN", "PLATFORM_MIN_BPS", "SSE_PER_IP", "UPLOAD_DAILY_MB", "deploy/env.example"]) assert.ok(m.includes(needle), `${needle} in:\n${m}`);
      return true;
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
