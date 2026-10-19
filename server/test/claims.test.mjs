// GET /api/fees/:mint (DESIGN §11.6) against a fake RPC: the contract shape for a token-quoted child
// and a migrated SOL-quoted root (vault above its rent floor, AMM WSOL vault + pool bucket), the
// per-shareholder split, the live sharing config adopted into the model, the 15 s per-mint cache,
// ETag/304, 400/404, and the three disabled states (no config, nothing yet, holder-reward coin).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../lib/api.mjs";
import { Treasury, feeAccounts, feeBalances, KEYS_PER_COIN, VAULT_RENT_LAMPORTS } from "../lib/treasury.mjs";
import { decodeShares, decodeCurve } from "../lib/decode.mjs";
import { EventHub } from "../lib/events.mjs";
import { ImageCache } from "../lib/meta.mjs";
import { NATIVE_MINT, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, feeSharingConfigPda, creatorVaultPda, ammCreatorVaultPda, canonicalPumpPoolPdaWithQuote, getAssociatedTokenAddressSync, pk } from "../lib/sdk.mjs";
import { buildTree, K, PLATFORM, T22, base, quiet } from "./helpers/tree.mjs";
import { curveAccount, migratedCurveAccount, curveAccountWith, BUCKET, sharingAccount, poolAccount, tokenAccount, lamportsAccount, TOKEN } from "./helpers/fees.mjs";

// GET /api/claims/:wallet and /api/claims (DESIGN §11.7) on the same fake chain as fees.test.mjs:
// a wallet's coins with its part of each coin's pending fees, sorted by value, totals per quote,
// batched reads shared with /api/fees through the per-mint cache, the public list of Spore launches
// with fees waiting, and input validation.
const SHARES_A = [{ address: K.U, bps: 5000 }, { address: PLATFORM, bps: 5000 }];
const SHARES_S = [{ address: PLATFORM, bps: 10000 }];
let server, url, model, db, hub, dir, t = 1_000_000;
const calls = [];
const accounts = new Map();

before(async () => {
  ({ db, model } = buildTree());
  model.upsertCoin({ mint: K.A, shares: SHARES_A, sharesAt: 1 });
  model.upsertCoin({ mint: K.S, curve: "C_S", depth: 0, quoteMint: null, ...base, migrated: true, complete: true, createdAt: 6000, shares: SHARES_S, sharesAt: 1 });
  model.setMint({ mint: K.S, decimals: 6, tokenProgram: T22, symbol: "SSS", name: "S coin", onchainAt: 1 });
  model.upsertCoin({ mint: K.G, shares: SHARES_A, sharesAt: 1 });
  const sharingA = feeSharingConfigPda(pk(K.A)), sharingS = feeSharingConfigPda(pk(K.S)), sharingG = feeSharingConfigPda(pk(K.G));
  accounts.set("C_A", curveAccount);
  accounts.set(getAssociatedTokenAddressSync(pk(K.ROOT), creatorVaultPda(sharingA), true, TOKEN_2022_PROGRAM_ID).toBase58(), tokenAccount(40_000_000_000));
  accounts.set(sharingA.toBase58(), sharingAccount(K.A, SHARES_A));
  accounts.set("C_S", migratedCurveAccount);
  accounts.set(creatorVaultPda(sharingS).toBase58(), lamportsAccount(3_000_000_000));
  accounts.set(getAssociatedTokenAddressSync(NATIVE_MINT, ammCreatorVaultPda(sharingS), true, TOKEN_PROGRAM_ID).toBase58(), tokenAccount(1_000_000_000, TOKEN));
  accounts.set(canonicalPumpPoolPdaWithQuote(pk(K.S), NATIVE_MINT).toBase58(), poolAccount(500_000_000));
  accounts.set(sharingS.toBase58(), sharingAccount(K.S, SHARES_S));
  accounts.set(sharingG.toBase58(), sharingAccount(K.G, SHARES_A));
  const rpc = { getMultipleAccounts: async (keys) => { calls.push(keys); return keys.map((k) => accounts.get(k) ?? null); }, call: async () => 650_240 };
  const treasury = new Treasury({ model, rpc, platformWallet: PLATFORM, log: quiet, now: () => t });
  hub = new EventHub({ heartbeatMs: 200 });
  dir = mkdtempSync(join(tmpdir(), "spore-claims-"));
  const images = new ImageCache(join(dir, "img"), { fetchImpl: async () => new Response(Buffer.alloc(0)) });
  const indexer = { fetchCoin: async () => null, snapshot: () => ({ phase: "test" }), globalRaw: null, quoteControlRaw: null };
  const app = createApp({ model, indexer, rpc, hub, images, meta: null, treasury, platformWallet: PLATFORM, splitBps: [5000, 0, 0, 5000], distDir: null, log: quiet, now: () => t });
  await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
  url = `http://127.0.0.1:${server.address().port}`;
});
after(() => { hub.close(); server.close(); db.close(); rmSync(dir, { recursive: true, force: true }); });
const get = (p) => fetch(url + p).then(async (r) => ({ status: r.status, body: await r.json() }));

test("GET /api/claims/:wallet: every coin naming the wallet, its part, sorted by value, totals per quote; one batched read", async () => {
  calls.length = 0;
  const { status, body } = await get(`/api/claims/${PLATFORM}`);
  assert.equal(status, 200);
  assert.equal(body.wallet, PLATFORM);
  assert.deepEqual(body.coins.map((c) => c.mint).sort(), [K.A, K.G, K.S].sort());
  const s = body.coins.find((c) => c.mint === K.S), a = body.coins.find((c) => c.mint === K.A), g = body.coins.find((c) => c.mint === K.G);
  assert.equal(s.yourBps, 10000); assert.equal(s.yourAmount, s.total); assert.equal(s.quoteMint, null); assert.equal(s.symbol, "SSS");
  assert.equal(a.yourBps, 5000); assert.equal(BigInt(a.yourAmount), BigInt(a.total) / 2n);
  assert.equal(g.total, "0"); assert.equal(g.claimable, false);
  for (const k of ["mint", "name", "symbol", "image", "depth", "quoteSymbol", "quoteDecimals", "shares", "total", "perShare", "claimable", "reason", "yourBps", "yourAmount", "yourUsd"]) assert.ok(k in a, k);
  assert.ok(Array.isArray(body.totals.byQuote) && body.totals.byQuote.length >= 2, "SOL and ROOT totals");
  assert.equal(body.totals.byQuote.find((q) => q.quoteMint === null).amount, s.yourAmount);
  assert.equal(calls.length, 1, "three coins, one getMultipleAccounts");
  const other = await get(`/api/claims/${K.U}`);
  assert.deepEqual(other.body.coins.map((c) => c.mint).sort(), [K.A, K.G].sort());
  assert.equal(calls.length, 1, "the second wallet reuses the per-mint cache");
});

test("GET /api/claims/:wallet: a wallet with no shares is an empty list; a malformed one is 400", async () => {
  const none = await get(`/api/claims/${K.ROOT}`);
  assert.equal(none.status, 200); assert.deepEqual(none.body.coins, []); assert.equal(none.body.totals.usd, 0);
  assert.equal((await get("/api/claims/not-a-wallet")).status, 400);
});

test("GET /api/claims: the Spore launches with fees waiting, biggest first, capped by limit", async () => {
  t += 60_000;
  const { status, body } = await get("/api/claims?limit=1");
  assert.equal(status, 200);
  assert.equal(body.coins.length, 1);
  const all = await get("/api/claims?limit=50");
  assert.ok(all.body.coins.every((c) => BigInt(c.total) > 0n), "nothing-to-claim coins are left out");
  assert.ok(!all.body.coins.some((c) => c.mint === K.G));
  assert.ok(!("yourAmount" in all.body.coins[0]));
});
