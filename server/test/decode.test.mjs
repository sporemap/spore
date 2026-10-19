// Decoders against bytes the pump program really emitted (test/fixtures, captured by
// scripts/capture-fixtures.mjs from the depth-2 curve 9CuFcRfiqEsBEQUCPTTVHaruQU7n9N7HKNSEk5VEivu).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { eventsInLogs, eventNameOf, decodeEvent, decodeCurve, decodeMint, decodeMetaplex, decodePool, decodeTokenAccount, decodeShares, EVENT_DISCRIMINATORS, BONDING_CURVE_DISCRIMINATOR, POOL_DISCRIMINATOR, plain } from "../lib/decode.mjs";
import { bs58, peekMint } from "../lib/indexer.mjs";
import { PublicKey, TOKEN_2022_PROGRAM_ID, BN } from "../lib/sdk.mjs";

const fixtures = JSON.parse(readFileSync(new URL("./fixtures/events.json", import.meta.url), "utf8"));
const accounts = JSON.parse(readFileSync(new URL("./fixtures/accounts.json", import.meta.url), "utf8")).accounts;
const CURVE = "9CuFcRfiqEsBEQUCPTTVHaruQU7n9N7HKNSEk5VEivu";
const MINT = "GtsYUp4Gxbyag3c1So1jvfPu54AdU47HGeySBQEvpump";
const PARENT = "2WTY9AKBhgrBoFpZPeabub73v6gZLHqVnRuWf25Wpump";
const ROOT = "8RwfqVijzKgb9URf1F1qbMZpSAuXx3kFn5VJ4rTbpump";
const b64 = (e) => Buffer.from(e.data, "base64");

test("discriminators match the vendored IDLs", () => {
  assert.deepEqual([...EVENT_DISCRIMINATORS.CreateEvent], [27, 114, 169, 77, 222, 235, 99, 118]);
  assert.deepEqual([...EVENT_DISCRIMINATORS.TradeEvent], [189, 219, 127, 211, 78, 230, 97, 238]);
  assert.deepEqual([...EVENT_DISCRIMINATORS.CompleteEvent], [95, 114, 97, 156, 212, 46, 152, 8]);
  assert.deepEqual([...BONDING_CURVE_DISCRIMINATOR], [23, 183, 248, 55, 96, 216, 172, 96]);
  assert.deepEqual([...POOL_DISCRIMINATOR], [241, 154, 109, 4, 17, 177, 109, 188]);
  for (const [name, d] of Object.entries(fixtures.discriminators)) assert.deepEqual([...EVENT_DISCRIMINATORS[name]], d);
});

test("eventsInLogs picks tracked events out of raw log lines, in order, ignoring the rest", () => {
  const logs = ["Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P invoke [1]", "Program log: Instruction: Create", `Program data: ${fixtures.events.CreateEvent[0].data}`, "Program data: not-base64!!", "Program data: AAAA", `Program data: ${fixtures.events.TradeEvent[0].data}`, "Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P success"];
  assert.deepEqual(eventsInLogs(logs).map((e) => e.name), ["CreateEvent", "TradeEvent"]);
  assert.equal(eventNameOf(Buffer.alloc(4)), null);
  assert.deepEqual(eventsInLogs(undefined), []);
});

test("CreateEvent: the depth-2 spawn under its parent", () => {
  const e = decodeEvent("CreateEvent", b64(fixtures.events.CreateEvent[0]));
  assert.equal(e.mint, MINT); assert.equal(e.bondingCurve, CURVE); assert.equal(e.quoteMint, PARENT); assert.equal(e.depth, 2);
  assert.equal(e.name, "ponzi"); assert.equal(e.symbol, "ponzi"); assert.match(e.uri, /^https:\/\//);
  assert.equal(e.tokenProgram, TOKEN_2022_PROGRAM_ID.toBase58());
  assert.equal(e.isHolderReward, true); assert.equal(e.isMayhemMode, false);
  assert.equal(typeof e.timestamp, "number"); assert.ok(e.timestamp > 1_700_000_000);
  assert.equal(e.virtualTokenReserves, "1073000000000000"); assert.equal(e.tokenTotalSupply, "1000000000000000");
  assert.match(e.virtualQuoteReserves, /^\d+$/); assert.notEqual(e.virtualQuoteReserves, "0", "a pump-quoted curve seeds virtualQuoteReserves");
  assert.equal(e.creatorFeeBps, 0);
});

test("TradeEvents: one multi-hop buy emits a trade per hop, in execution order from the SOL root up to the leaf", () => {
  const trades = fixtures.events.TradeEvent.map((f) => decodeEvent("TradeEvent", b64(f)));
  assert.deepEqual(trades.map((t) => t.mint), [ROOT, PARENT, MINT]);
  assert.deepEqual(trades.map((t) => t.quoteMint), [null, ROOT, PARENT]);
  for (const t of trades) {
    assert.equal(t.isBuy, true); assert.equal(typeof t.user, "string");
    for (const k of ["tokenAmount", "quoteAmount", "virtualQuoteReserves", "virtualTokenReserves", "realQuoteReserves", "realTokenReserves"]) assert.match(t[k], /^\d+$/, k);
    assert.notEqual(t.quoteAmount, "0");
  }
  // The SOL hop reports its amounts in the legacy sol fields; decodeEvent folds them into the quote fields.
  assert.notEqual(trades[0].virtualQuoteReserves, "0");
  assert.equal(peekMint(b64(fixtures.events.TradeEvent[2])), MINT);
});

test("CompleteEvent", () => {
  const e = decodeEvent("CompleteEvent", b64(fixtures.events.CompleteEvent[0]));
  assert.equal(e.mint, MINT); assert.equal(e.bondingCurve, CURVE); assert.equal(e.quoteMint, PARENT); assert.ok(e.timestamp > 1_700_000_000);
});

test("BondingCurve accounts: the depth-2 curve (migrated) and its depth-1 parent", () => {
  const c = decodeCurve(Buffer.from(accounts.curve.data, "base64"), accounts.curve.pubkey);
  assert.equal(c.curve, CURVE); assert.equal(c.depth, 2); assert.equal(c.quoteMint, PARENT); assert.equal(c.complete, true); assert.equal(c.migrated, true);
  assert.equal(c.holderReward, true); assert.equal(c.tokenTotalSupply, "1000000000000000"); assert.match(c.initialVirtualQuoteReserves, /^\d+$/);
  const p = decodeCurve(Buffer.from(accounts.parentCurve.data, "base64"), accounts.parentCurve.pubkey);
  assert.equal(p.depth, 1); assert.equal(p.quoteMint, ROOT); assert.equal(accounts.parentCurve.mint, PARENT);
  assert.throws(() => decodeCurve(Buffer.alloc(166)), /not a BondingCurve/);
});

test("Token-2022 mint: decimals, supply, owner program and the TokenMetadata extension", () => {
  const m = decodeMint(Buffer.from(accounts.mint.data, "base64"), accounts.mint.owner);
  assert.equal(m.decimals, 6); assert.equal(m.tokenProgram, TOKEN_2022_PROGRAM_ID.toBase58()); assert.match(m.supply, /^\d+$/);
  assert.equal(m.metadata.name, "ponzi"); assert.equal(m.metadata.symbol, "ponzi"); assert.match(m.metadata.uri, /^https:\/\//);
  // A plain SPL mint (82 bytes) has no extension and therefore no metadata.
  const spl = Buffer.alloc(82); spl[44] = 9;
  assert.deepEqual(decodeMint(spl, "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"), { decimals: 9, supply: "0", tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", metadata: null });
  assert.equal(decodeMint(Buffer.alloc(10), "x"), null);
});

test("Metaplex metadata: NUL-padded borsh strings", () => {
  const str = (s, width) => { const b = Buffer.alloc(4 + width); b.writeUInt32LE(width, 0); b.write(s, 4); return b; };
  const buf = Buffer.concat([Buffer.from([4]), Buffer.alloc(64), str("Old Coin", 32), str("OLD", 10), str("https://ipfs.io/ipfs/Qm", 200)]);
  assert.deepEqual(decodeMetaplex(buf), { name: "Old Coin", symbol: "OLD", uri: "https://ipfs.io/ipfs/Qm" });
  assert.equal(decodeMetaplex(Buffer.alloc(20)), null);
});

test("pump-amm Pool: vault keys at 139/171, the signed i128 virtual quote reserves and the creator-fee bucket at 279", () => {
  const buf = Buffer.alloc(300);
  POOL_DISCRIMINATOR.copy(buf, 0);
  const k = (seed) => { const b = Buffer.alloc(32); b[0] = seed; return new PublicKey(b); };
  k(1).toBuffer().copy(buf, 43); k(2).toBuffer().copy(buf, 75); k(3).toBuffer().copy(buf, 139); k(4).toBuffer().copy(buf, 171);
  buf.writeBigInt64LE(-5n, 245); buf.writeBigInt64LE(-1n, 253); // i128 = -5
  buf.writeBigUInt64LE(99_443_184n, 279); // creator_fees: the pool's unswept creator-fee bucket
  const p = decodePool(buf);
  assert.deepEqual(p, { baseMint: k(1).toBase58(), quoteMint: k(2).toBase58(), baseVault: k(3).toBase58(), quoteVault: k(4).toBase58(), virtualQuoteReserves: "-5", creatorFees: "99443184" });
  assert.equal(decodePool(buf.subarray(0, 270)).creatorFees, "0", "an older, shorter Pool has no bucket");
  assert.equal(decodePool(Buffer.alloc(300)), null, "wrong discriminator");
});

test("token account amount at offset 64", () => {
  const buf = Buffer.alloc(165); buf.writeBigUInt64LE(123456789n, 64);
  const t = decodeTokenAccount(buf);
  assert.equal(t.amount, "123456789"); assert.equal(t.mint, PublicKey.default.toBase58());
  assert.equal(decodeTokenAccount(Buffer.alloc(10)), null);
});

test("decodeShares returns null for a non-config account", () => {
  assert.equal(decodeShares(Buffer.alloc(50)), null);
});

test("plain() flattens BN, PublicKey, bigint and nested structures", () => {
  const out = plain({ a: new BN("18446744073709551615"), k: new PublicKey(CURVE), n: 7n, list: [new BN(1)], s: "x", b: true });
  assert.deepEqual(out, { a: "18446744073709551615", k: CURVE, n: "7", list: ["1"], s: "x", b: true });
});

test("bs58 helper matches the bs58 package for memcmp filter bytes", () => {
  const require = createRequire(import.meta.url);
  const lib = require("bs58"); const enc = (lib.default ?? lib).encode;
  for (const bytes of [[1], [2], [0, 0, 1], [...BONDING_CURVE_DISCRIMINATOR], [255, 255, 255, 255]]) assert.equal(bs58(Buffer.from(bytes)), enc(Buffer.from(bytes)));
  assert.equal(bs58(Buffer.from([1])), "2"); assert.equal(bs58(Buffer.from([2])), "3");
});
