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

const RENT = 650_240;
const SHARES_A = [{ address: K.U, bps: 5000 }, { address: PLATFORM, bps: 5000 }];
const SHARES_S = [{ address: PLATFORM, bps: 10000 }];
let server, url, model, db, hub, dir, treasury, t = 1_000_000, rentCalls = 0;
const calls = [];
const accounts = new Map();

before(async () => {
  ({ db, model } = buildTree());
  // A: ours, quoted in ROOT (Token-2022), shares known to the model and on chain.
  model.upsertCoin({ mint: K.A, shares: SHARES_A, sharesAt: 1 });
  // S: a migrated SOL-quoted root whose config the indexer has not fetched yet (shares null in the model).
  model.upsertCoin({ mint: K.S, curve: "C_S", depth: 0, quoteMint: null, ...base, migrated: true, complete: true, createdAt: 6000 });
  model.setMint({ mint: K.S, decimals: 6, tokenProgram: T22, symbol: "SSS", name: "S coin", onchainAt: 1 });
  // G: a config but no fees anywhere yet. X: a holder-reward coin.
  model.upsertCoin({ mint: K.G, shares: SHARES_A, sharesAt: 1 });
  model.upsertCoin({ mint: K.X, curve: "C_X", depth: 1, quoteMint: K.ROOT, ...base, virtualQuoteReserves: "1000000000000000", holderReward: true, createdAt: 7000 });
  model.setMint({ mint: K.X, decimals: 6, tokenProgram: T22, symbol: "HLD", name: "holder coin", onchainAt: 1 });
  const sharingA = feeSharingConfigPda(pk(K.A)), sharingS = feeSharingConfigPda(pk(K.S)), sharingG = feeSharingConfigPda(pk(K.G));
  accounts.set("C_A", curveAccount);
  accounts.set(getAssociatedTokenAddressSync(pk(K.ROOT), creatorVaultPda(sharingA), true, TOKEN_2022_PROGRAM_ID).toBase58(), tokenAccount(40_000_000_000)); // 40 000 ROOT
  accounts.set(sharingA.toBase58(), sharingAccount(K.A, SHARES_A));
  accounts.set("C_S", migratedCurveAccount);
  accounts.set(creatorVaultPda(sharingS).toBase58(), lamportsAccount(3_000_000_000));
  accounts.set(getAssociatedTokenAddressSync(NATIVE_MINT, ammCreatorVaultPda(sharingS), true, TOKEN_PROGRAM_ID).toBase58(), tokenAccount(1_000_000_000, TOKEN)); // 1 SOL as WSOL
  accounts.set(canonicalPumpPoolPdaWithQuote(pk(K.S), NATIVE_MINT).toBase58(), poolAccount(500_000_000)); // 0.5 SOL unswept in the pool
  accounts.set(sharingS.toBase58(), sharingAccount(K.S, SHARES_S));
  accounts.set(sharingG.toBase58(), sharingAccount(K.G, SHARES_A));
  accounts.set("C_X", curveAccountWith({ holderReward: true })); // the flag comes from the live curve
  const rpc = { getMultipleAccounts: async (keys) => { calls.push(keys); return keys.map((k) => accounts.get(k) ?? null); }, call: async (method) => { assert.equal(method, "getMinimumBalanceForRentExemption"); rentCalls++; return RENT; }, proxy: async () => ({ status: 200, text: "{}" }) };
  treasury = new Treasury({ model, rpc, platformWallet: PLATFORM, log: quiet, now: () => t });
  hub = new EventHub({ heartbeatMs: 200 });
  dir = mkdtempSync(join(tmpdir(), "spore-fees-"));
  const images = new ImageCache(join(dir, "img"), { fetchImpl: async () => new Response(Buffer.alloc(0)) });
  const indexer = { fetchCoin: async () => null, snapshot: () => ({ phase: "test" }), globalRaw: null, quoteControlRaw: null };
  const app = createApp({ model, indexer, rpc, hub, images, meta: null, treasury, platformWallet: PLATFORM, splitBps: [5000, 0, 0, 5000], distDir: null, log: quiet, now: () => t });
  await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
  url = `http://127.0.0.1:${server.address().port}`;
});
after(() => { hub.close(); server.close(); db.close(); rmSync(dir, { recursive: true, force: true }); });

const get = (p, headers = {}) => fetch(url + p, { headers });
const FIELDS = ["mint", "quoteMint", "quoteSymbol", "quoteDecimals", "quoteUsd", "shares", "bucket", "vault", "amm", "total", "totalUsd", "perShare", "migrated", "claimable", "reason", "updatedAt"];

test("fixtures decode the way the chain's accounts do", () => {
  assert.deepEqual(decodeShares(sharingAccount(K.A, SHARES_A).data), SHARES_A);
  const live = decodeCurve(curveAccount.data), gone = decodeCurve(migratedCurveAccount.data), holder = decodeCurve(curveAccountWith({ holderReward: true }).data);
  assert.equal(live.creatorFee, BUCKET.toString()); assert.equal(live.migrated, false); assert.equal(live.holderReward, false);
  assert.equal(gone.creatorFee, BUCKET.toString()); assert.equal(gone.migrated, true);
  assert.equal(holder.holderReward, true); assert.equal(holder.migrated, false);
});

test("feeAccounts: five keys per coin; SOL vault = the PDA, token vault = its quote ATA; AMM vault always a token account", () => {
  const a = feeAccounts(model.get(K.A), model), s = feeAccounts(model.get(K.S), model);
  assert.equal(a.keys.length, KEYS_PER_COIN); assert.equal(s.keys.length, KEYS_PER_COIN);
  assert.equal(a.sol, false); assert.equal(s.sol, true);
  const sharingA = feeSharingConfigPda(pk(K.A)), sharingS = feeSharingConfigPda(pk(K.S));
  assert.equal(a.keys[0], "C_A");
  assert.equal(a.keys[1], getAssociatedTokenAddressSync(pk(K.ROOT), creatorVaultPda(sharingA), true, TOKEN_2022_PROGRAM_ID).toBase58());
  assert.equal(s.keys[1], creatorVaultPda(sharingS).toBase58());
  assert.equal(s.keys[2], getAssociatedTokenAddressSync(NATIVE_MINT, ammCreatorVaultPda(sharingS), true, TOKEN_PROGRAM_ID).toBase58());
  assert.equal(s.keys[3], canonicalPumpPoolPdaWithQuote(pk(K.S), NATIVE_MINT).toBase58());
  assert.equal(s.keys[4], sharingS.toBase58());
  // The rent floor stays in a SOL vault; a vault below it (or absent) is empty, never negative.
  const b = feeBalances({ migrated: true }, [null, lamportsAccount(100), null, null, null], { sol: true });
  assert.equal(b.vault, 0n); assert.equal(b.total, 0n);
  assert.equal(feeBalances({ migrated: false }, [null, null, null, null, null], { sol: true }).vault, 0n);
  assert.equal(VAULT_RENT_LAMPORTS, 650_240n);
});

test("GET /api/fees/:mint: token-quoted child, every contract field, split rows, USD through the parent's price, cache headers", async () => {
  const r = await get(`/api/fees/${K.A}`);
  assert.equal(r.status, 200);
  const f = await r.json();
  assert.deepEqual(Object.keys(f).sort(), [...FIELDS].sort());
  const total = BUCKET + 40_000_000_000n;
  assert.equal(f.mint, K.A); assert.equal(f.quoteMint, K.ROOT); assert.equal(f.quoteSymbol, "ROOT"); assert.equal(f.quoteDecimals, 6);
  assert.equal(f.bucket, BUCKET.toString()); assert.equal(f.vault, "40000000000"); assert.equal(f.amm, "0"); assert.equal(f.total, total.toString());
  assert.deepEqual(f.shares, SHARES_A);
  assert.deepEqual(f.perShare, SHARES_A.map((s) => ({ address: s.address, bps: s.bps, amount: (total * BigInt(s.bps) / 10_000n).toString() })));
  assert.ok(Math.abs(f.quoteUsd - 1e-5) < 1e-12, "ROOT priced through its SOL curve (1e-7 SOL × $100)");
  assert.ok(Math.abs(f.totalUsd - Number(total) / 1e6 * 1e-5) < 1e-9);
  assert.equal(f.migrated, false); assert.equal(f.claimable, true); assert.equal(f.reason, null);
  assert.equal(typeof f.updatedAt, "number");
  assert.match(r.headers.get("cache-control"), /public, max-age=5/);
  assert.ok(r.headers.get("etag"));
  assert.equal((await get(`/api/fees/${K.A}`, { "if-none-match": r.headers.get("etag") })).status, 304);
  assert.equal(rentCalls, 1, "rent asked once");
});

test("GET /api/fees/:mint: migrated SOL root — vault above rent, AMM WSOL vault + pool bucket, live config adopted into the model", async () => {
  assert.equal(model.get(K.S).shares, null);
  const f = await (await get(`/api/fees/${K.S}`)).json();
  const vault = 3_000_000_000n - BigInt(RENT), amm = 1_000_000_000n + 500_000_000n, total = BUCKET + vault + amm;
  assert.equal(f.quoteMint, null); assert.equal(f.quoteSymbol, "SOL"); assert.equal(f.quoteDecimals, 9); assert.equal(f.quoteUsd, 100);
  assert.equal(f.bucket, BUCKET.toString()); assert.equal(f.vault, vault.toString()); assert.equal(f.amm, amm.toString()); assert.equal(f.total, total.toString());
  assert.ok(Math.abs(f.totalUsd - Number(total) / 1e9 * 100) < 1e-6);
  assert.equal(f.migrated, true);
  assert.deepEqual(f.shares, SHARES_S, "the on-chain config, not the model's null");
  assert.deepEqual(f.perShare, [{ address: PLATFORM, bps: 10000, amount: total.toString() }]);
  assert.equal(f.claimable, true); assert.equal(f.reason, null);
  assert.deepEqual(model.get(K.S).shares, SHARES_S, "adopted: the coin is now provably ours");
  assert.equal(rentCalls, 1);
});

test("GET /api/fees/:mint: cached 15 s per mint, one RPC round for concurrent callers, refreshed after", async () => {
  const before = calls.length;
  const [a, b] = await Promise.all([get(`/api/fees/${K.A}`), get(`/api/fees/${K.A}`)]);
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  assert.equal(calls.length, before, "served from the per-mint cache");
  t += 14_000;
  await get(`/api/fees/${K.A}`);
  assert.equal(calls.length, before, "still within 15 s");
  t += 2_000;
  const fresh = await (await get(`/api/fees/${K.A}`)).json();
  assert.equal(calls.length, before + 1, "re-read after the TTL");
  assert.equal(fresh.total, (BUCKET + 40_000_000_000n).toString());
  assert.equal(calls[calls.length - 1].length, KEYS_PER_COIN, "one coin: five keys");
  assert.equal(treasury.stats.feesErrors, 0);
});

test("GET /api/fees/:mint: no sharing config → claimable false with the reason, balances still shown", async () => {
  const f = await (await get(`/api/fees/${K.B}`)).json();
  assert.equal(f.shares, null); assert.deepEqual(f.perShare, []);
  assert.equal(f.claimable, false); assert.match(f.reason, /no fee-sharing config/);
  assert.equal(f.bucket, "0"); assert.equal(f.total, "0");
});

test("GET /api/fees/:mint: a config but nothing accrued → claimable false, 'nothing to claim'", async () => {
  const f = await (await get(`/api/fees/${K.G}`)).json();
  assert.deepEqual(f.shares, SHARES_A); assert.equal(f.total, "0");
  assert.deepEqual(f.perShare, SHARES_A.map((s) => ({ address: s.address, bps: s.bps, amount: "0" })));
  assert.equal(f.claimable, false); assert.match(f.reason, /nothing to claim/);
});

test("GET /api/fees/:mint: holder-reward coin → claimable false", async () => {
  const f = await (await get(`/api/fees/${K.X}`)).json();
  assert.equal(f.claimable, false); assert.match(f.reason, /holder-reward/);
});

test("GET /api/fees/:mint: 404 for an unknown mint, 400 for a malformed one, rate-limit headers like every api route", async () => {
  const r = await get("/api/fees/9CuFcRfiqEsBEQUCPTTVHaruQU7n9N7HKNSEk5VEivu");
  assert.equal(r.status, 404); assert.deepEqual(await r.json(), { error: "unknown mint" });
  assert.equal((await get("/api/fees/not-a-mint")).status, 400);
  assert.ok(r.headers.get("x-ratelimit-limit"));
});

test("Treasury.fees: an RPC failure serves the last value and counts the error; without one it throws", async () => {
  const failing = { getMultipleAccounts: async () => { throw new Error("boom"); } };
  t += 20_000;
  const cached = await treasury.fees(model.get(K.A), { rpc: failing });
  assert.equal(cached.mint, K.A); assert.equal(treasury.stats.feesErrors, 1); assert.match(treasury.stats.lastError, /boom/);
  await assert.rejects(treasury.fees(model.get(K.ROOT), { rpc: failing }), /boom/);
});
