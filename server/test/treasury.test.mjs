// Read-only treasury (DESIGN §11.4): vault balances of our coins' sharing configs, grouped by quote,
// against a fake RPC. The curve bytes are the real depth-2 fixture so the creator-fee bucket is
// decoded the way the indexer decodes it; the migrated root reads its AMM WSOL vault, the pool's
// unswept bucket and the SOL vault above its rent floor.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Treasury, KEYS_PER_COIN } from "../lib/treasury.mjs";
import { NATIVE_MINT, TOKEN_PROGRAM_ID, feeSharingConfigPda, creatorVaultPda, ammCreatorVaultPda, canonicalPumpPoolPdaWithQuote, getAssociatedTokenAddressSync, pk, TOKEN_2022_PROGRAM_ID } from "../lib/sdk.mjs";
import { buildTree, K, PLATFORM, T22, base, quiet } from "./helpers/tree.mjs";
import { curveAccount, migratedCurveAccount, BUCKET, poolAccount, tokenAccount, lamportsAccount, TOKEN } from "./helpers/fees.mjs";

const RENT = 650_240n;

function setup() {
  const { db, model } = buildTree();
  // A (depth 1, quoted in ROOT) is ours; a SOL-quoted migrated root S is ours too; B stays foreign.
  model.upsertCoin({ mint: K.A, shares: [{ address: "CR", bps: 5000 }, { address: PLATFORM, bps: 5000 }], sharesAt: 1 });
  model.upsertCoin({ mint: K.S, curve: "C_S", depth: 0, quoteMint: null, ...base, migrated: true, shares: [{ address: "CR", bps: 7000 }, { address: PLATFORM, bps: 3000 }], sharesAt: 1 });
  model.setMint({ mint: K.S, decimals: 6, tokenProgram: T22, symbol: "SSS", name: "S coin", onchainAt: 1 });
  const sharingA = feeSharingConfigPda(pk(K.A)), sharingS = feeSharingConfigPda(pk(K.S));
  const accounts = new Map([
    ["C_A", curveAccount],
    [getAssociatedTokenAddressSync(pk(K.ROOT), creatorVaultPda(sharingA), true, TOKEN_2022_PROGRAM_ID).toBase58(), tokenAccount(40_000_000_000)], // 40 000 ROOT in the vault ATA
    ["C_S", migratedCurveAccount],
    [creatorVaultPda(sharingS).toBase58(), lamportsAccount(3_000_000_000)],
    [getAssociatedTokenAddressSync(NATIVE_MINT, ammCreatorVaultPda(sharingS), true, TOKEN_PROGRAM_ID).toBase58(), tokenAccount(1_000_000_000, TOKEN)], // 1 SOL of WSOL in the AMM vault
    [canonicalPumpPoolPdaWithQuote(pk(K.S), NATIVE_MINT).toBase58(), poolAccount(500_000_000)], // 0.5 SOL unswept in the pool
  ]);
  const calls = [];
  let rentCalls = 0;
  const rpc = { getMultipleAccounts: async (keys) => { calls.push(keys); return keys.map((k) => accounts.get(k) ?? null); }, call: async () => { rentCalls++; return Number(RENT); } };
  return { db, model, rpc, calls, rent: () => rentCalls };
}

test("pendingByQuote sums bucket + vault (+ AMM vault and pool bucket when migrated) × our bps, per quote mint, with USD", async () => {
  const { db, model, rpc, calls, rent } = setup();
  try {
    let t = 1_000;
    const tr = new Treasury({ model, rpc, platformWallet: PLATFORM, ttlMs: 60_000, log: quiet, now: () => t });
    const r = await tr.get();
    assert.equal(r.platform, PLATFORM); assert.equal(r.ourCoins, 2);
    assert.equal(calls.length, 1, "one getMultipleAccounts for both coins"); assert.equal(calls[0].length, 2 * KEYS_PER_COIN);
    assert.equal(rent(), 1, "rent.minimum_balance(0) asked once");
    const sol = r.pendingByQuote.find((q) => q.quoteMint === null), root = r.pendingByQuote.find((q) => q.quoteMint === K.ROOT);
    const expectSol = Number((BUCKET + (3_000_000_000n - RENT) + 1_000_000_000n + 500_000_000n) * 3000n / 10_000n) / 1e9;
    assert.equal(sol.symbol, "SOL"); assert.equal(sol.amount, expectSol); assert.equal(sol.usd, expectSol * 100); assert.equal(sol.coins, 1);
    const expectRoot = Number((BUCKET + 40_000_000_000n) * 5000n / 10_000n) / 1e6;
    assert.equal(root.symbol, "ROOT"); assert.equal(root.amount, expectRoot); assert.equal(root.coins, 1);
    assert.ok(Math.abs(root.usd - expectRoot * 1e-5) < 1e-9, "ROOT priced through its SOL curve (1e-7 SOL × $100)");
    assert.deepEqual(r.coins.map((c) => c.mint).sort(), [K.A, K.S].sort());
    assert.ok(r.coins.every((c) => typeof c.amount === "number" && c.ourBps > 0));
    assert.equal(r.coins.find((c) => c.mint === K.S).migrated, true, "migration read from the live curve");
    assert.equal(typeof r.updatedAt, "number");
    // Cached: no second RPC round within the TTL; concurrent callers share one computation after it expires.
    await tr.get();
    assert.equal(calls.length, 1);
    t += 61_000;
    await Promise.all([tr.get(), tr.get(), tr.get()]);
    assert.equal(calls.length, 2);
    assert.equal(tr.stats.computes, 2);
    assert.equal(rent(), 1);
  } finally { db.close(); }
});

test("nothing of ours → empty lists and no RPC call; an RPC failure keeps the last good value; no `call` → the rent constant", async () => {
  const { db, model } = buildTree();
  try {
    let fail = false, n = 0;
    const rpc = { getMultipleAccounts: async (keys) => { n++; if (fail) throw new Error("boom"); return keys.map(() => null); } };
    let t = 0;
    const tr = new Treasury({ model, rpc, platformWallet: PLATFORM, ttlMs: 1_000, log: quiet, now: () => t });
    const r = await tr.get();
    assert.deepEqual(r, { platform: PLATFORM, ourCoins: 0, pendingByQuote: [], coins: [], updatedAt: r.updatedAt });
    assert.equal(n, 0);
    model.upsertCoin({ mint: K.B, shares: [{ address: PLATFORM, bps: 10000 }], sharesAt: 1 });
    t = 2_000;
    const r2 = await tr.get();
    assert.equal(r2.ourCoins, 1); assert.equal(n, 1);
    assert.equal(r2.pendingByQuote[0].amount, 0, "no accounts yet: zero pending");
    assert.equal(await tr.rentLamports(), 650_240n);
    fail = true; t = 4_000;
    const r3 = await tr.get();
    assert.equal(r3, r2, "stale value served"); assert.equal(tr.stats.errors, 1); assert.match(tr.stats.lastError, /boom/);
  } finally { db.close(); }
});
