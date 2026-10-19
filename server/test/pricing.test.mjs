import { test } from "node:test";
import assert from "node:assert/strict";
import { curvePriceQuote, poolPriceQuote, priceQuoteOf, progressOf, chainPrices, splitShares, mergeShares, parseSplitBps, units, launchFeeOf, DEFAULT_SPLIT_BPS, DEFAULT_LAUNCH_FEE_SOL } from "../lib/pricing.mjs";

const PLATFORM = "dBs75Gf7RXQMAsMLuTLYdH2fHV1ac9zgCEh6zC7TxXs";
// A fresh SOL curve as Global seeds it (mainnet 2026-10-17): 30 SOL virtual / 1.073B tokens virtual.
const fresh = { virtualTokenReserves: "1073000000000000", virtualQuoteReserves: "30000000000", realTokenReserves: "793100000000000", realQuoteReserves: "0", complete: false, migrated: false };

test("curve price: 30 SOL / 1.073B tokens ≈ 2.796e-8 SOL per token", () => {
  const p = curvePriceQuote(fresh, 6, 9);
  assert.ok(Math.abs(p - 30 / 1.073e9) < 1e-18);
  assert.equal(curvePriceQuote({ virtualTokenReserves: "0", virtualQuoteReserves: "1" }, 6, 9), null);
});

test("curve price honours quote decimals (a USDC-quoted curve)", () => {
  // 1 000 USDC (6 dp) against 1.073B tokens → 9.3e-7 USDC per token
  const p = curvePriceQuote({ virtualTokenReserves: "1073000000000000", virtualQuoteReserves: "1000000000" }, 6, 6);
  assert.ok(Math.abs(p - 1000 / 1.073e9) < 1e-18);
});

test("pool price = quote vault / base vault, decimal scaled; migrated coins use the pool", () => {
  assert.equal(poolPriceQuote("85000000000", "200000000000000", 6, 9), 85 / 200_000_000);
  assert.equal(poolPriceQuote("1", "0", 6, 9), null);
  assert.equal(poolPriceQuote(null, "1", 6, 9), null);
  const migrated = { ...fresh, virtualTokenReserves: "0", virtualQuoteReserves: "0", migrated: true, poolQuote: "85000000000", poolBase: "200000000000000" };
  assert.equal(priceQuoteOf(migrated, 6, 9), 85 / 200_000_000);
  assert.ok(priceQuoteOf(fresh, 6, 9) > 0);
});

test("progress: 0 on a fresh curve, fraction sold, 1 when complete", () => {
  const initial = "793100000000000";
  assert.equal(progressOf(fresh, initial), 0);
  assert.ok(Math.abs(progressOf({ ...fresh, realTokenReserves: "396550000000000" }, initial) - 0.5) < 1e-12);
  assert.equal(progressOf({ ...fresh, complete: true }, initial), 1);
  assert.equal(progressOf({ ...fresh, realTokenReserves: "0" }, initial), 1);
  assert.equal(progressOf(fresh, "0"), 0);
});

test("chain pricing multiplies up to a SOL root and converts with solUsd", () => {
  // depth-2 coin: 0.5 parent per token; parent: 2 root per token; root: 1e-7 SOL per token
  const r = chainPrices([0.5, 2, 1e-7], "sol", 150);
  assert.ok(Math.abs(r.priceSol - 1e-7) < 1e-20);
  assert.ok(Math.abs(r.priceUsd - 1.5e-5) < 1e-18);
  assert.deepEqual(chainPrices([0.5, 2, 1e-7], "sol", null), { priceSol: 1e-7, priceUsd: null });
});

test("chain pricing: USDC root is USD-denominated, other roots price nothing, a null step prices nothing", () => {
  const usdc = chainPrices([2, 0.001], "usdc", 200);
  assert.equal(usdc.priceUsd, 0.002);
  assert.ok(Math.abs(usdc.priceSol - 0.00001) < 1e-18);
  assert.deepEqual(chainPrices([2, 0.001], "other", 200), { priceSol: null, priceUsd: null });
  // A PUMP-quoted root with a known PUMP price ($0.005): 0.002 PUMP/token → $1e-5 → 5e-8 SOL
  const pump = chainPrices([2, 0.001], "other", 200, 0.005);
  assert.ok(Math.abs(pump.priceUsd - 1e-5) < 1e-18); assert.ok(Math.abs(pump.priceSol - 5e-8) < 1e-20);
  assert.deepEqual(chainPrices([2, 0.001], "other", null, 0.005), { priceSol: null, priceUsd: 1e-5 });
  assert.deepEqual(chainPrices([2, null], "sol", 200), { priceSol: null, priceUsd: null });
  assert.deepEqual(chainPrices([0, 1], "sol", 200), { priceSol: null, priceUsd: null });
});

// DESIGN §4 (2026-10-18): two shareholders by default, creator 50 / platform 50.
test("split: default is exactly creator + platform, even with a parent and a grandparent", () => {
  assert.deepEqual(DEFAULT_SPLIT_BPS, [5000, 0, 0, 5000]);
  const s = splitShares({ creator: "C", parentCreator: "P", grandparentCreator: "G", platform: PLATFORM });
  assert.deepEqual(s, [{ address: "C", bps: 5000 }, { address: PLATFORM, bps: 5000 }]);
  assert.deepEqual(splitShares({ creator: "C", parentCreator: "P", grandparentCreator: null, platform: PLATFORM }), [{ address: "C", bps: 5000 }, { address: PLATFORM, bps: 5000 }]);
  assert.ok(s.every((x) => x.bps > 0), "never a 0-bps shareholder");
});

test("split: no creator yet → empty child slot; creator == platform merges to one holder", () => {
  assert.deepEqual(splitShares({ creator: null, parentCreator: "P", grandparentCreator: null, platform: PLATFORM }), [{ address: "", bps: 5000 }, { address: PLATFORM, bps: 5000 }]);
  assert.deepEqual(splitShares({ creator: PLATFORM, parentCreator: "P", grandparentCreator: "G", platform: PLATFORM }), [{ address: PLATFORM, bps: 10000 }]);
});

test("split: an explicit upward SPLIT_BPS (env path) still pays parent and grandparent, folds and merges", () => {
  const bps = parseSplitBps("5000,2500,1000,1500");
  assert.deepEqual(splitShares({ creator: "C", parentCreator: "P", grandparentCreator: "G", platform: PLATFORM, bps }), [{ address: "C", bps: 5000 }, { address: "P", bps: 2500 }, { address: "G", bps: 1000 }, { address: PLATFORM, bps: 1500 }]);
  assert.deepEqual(splitShares({ creator: "C", parentCreator: "P", grandparentCreator: null, platform: PLATFORM, bps }), [{ address: "C", bps: 5000 }, { address: "P", bps: 3500 }, { address: PLATFORM, bps: 1500 }]);
  assert.deepEqual(splitShares({ creator: "C", parentCreator: "C", grandparentCreator: "G", platform: PLATFORM, bps }), [{ address: "C", bps: 7500 }, { address: "G", bps: 1000 }, { address: PLATFORM, bps: 1500 }]);
  assert.deepEqual(splitShares({ creator: "C", parentCreator: PLATFORM, grandparentCreator: null, platform: PLATFORM, bps }), [{ address: "C", bps: 5000 }, { address: PLATFORM, bps: 5000 }]);
  assert.deepEqual(splitShares({ creator: "C", parentCreator: "C", grandparentCreator: "C", platform: "C", bps }), [{ address: "C", bps: 10000 }]);
});

test("launch fee: default 0 (no fee); a configured fee becomes lamports as a string to the platform; bounds enforced", () => {
  assert.deepEqual(launchFeeOf(DEFAULT_LAUNCH_FEE_SOL, PLATFORM), { to: PLATFORM, lamports: "0", sol: 0 });
  assert.deepEqual(launchFeeOf("0.02", PLATFORM), { to: PLATFORM, lamports: "20000000", sol: 0.02 });
  assert.deepEqual(launchFeeOf("0.1", PLATFORM), { to: PLATFORM, lamports: "100000000", sol: 0.1 });
  assert.deepEqual(launchFeeOf(0, PLATFORM), { to: PLATFORM, lamports: "0", sol: 0 });
  assert.throws(() => launchFeeOf("abc", PLATFORM), /LAUNCH_FEE_SOL/);
  assert.throws(() => launchFeeOf(-1, PLATFORM), /LAUNCH_FEE_SOL/);
  assert.throws(() => launchFeeOf(11, PLATFORM), /LAUNCH_FEE_SOL/);
});

test("split: unknown creator keeps an empty child slot; custom bps apply", () => {
  const s = splitShares({ creator: null, parentCreator: "P", grandparentCreator: null, platform: PLATFORM, bps: [6000, 2000, 1000, 1000] });
  assert.deepEqual(s, [{ address: "", bps: 6000 }, { address: "P", bps: 3000 }, { address: PLATFORM, bps: 1000 }]);
});

test("mergeShares rejects bad totals, negative shares and more than ten holders; drops zero shares", () => {
  assert.throws(() => mergeShares([{ address: "A", bps: 5000 }]), /sum to 5000/);
  assert.throws(() => mergeShares([{ address: "A", bps: -1 }, { address: "B", bps: 10001 }]), /invalid share/);
  assert.throws(() => mergeShares(Array.from({ length: 11 }, (_, i) => ({ address: `A${i}`, bps: i === 10 ? 10000 - 10 * 999 : 999 }))), /at most 10/);
  assert.deepEqual(mergeShares([{ address: "A", bps: 10000 }, { address: "B", bps: 0 }]), [{ address: "A", bps: 10000 }]);
});

test("parseSplitBps validates the env format", () => {
  assert.deepEqual(parseSplitBps("5000,2500,1000,1500"), [5000, 2500, 1000, 1500]);
  assert.throws(() => parseSplitBps("5000,2500,1000"), /four integers/);
  assert.throws(() => parseSplitBps("5000,2500,1000,1000"), /summing to 10000/);
});

test("units converts raw u64 strings without precision loss for realistic sizes", () => {
  assert.equal(units("1000000000000000", 6), 1e9);
  assert.equal(units("30000000000", 9), 30);
  assert.equal(units(0n, 6), 0);
});
