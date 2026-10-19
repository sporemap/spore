// The full map's listed-asset families: pump.fun counts a coin quoted in a listed quote asset (PUMP,
// USDC, a graduated coin such as $baton) as a root, so the map draws the asset as the top of a
// family and every coin quoted in it underneath, children or not. The ours-mode map is unchanged.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTree, K, T22, base } from "./helpers/tree.mjs";

function withAsset() {
  const { db, model } = buildTree();
  // ASSET (K.X) is a listed quote mint: U (depth 0, quoted in ASSET, no children) and S (depth 0, quoted in ASSET, with a child B2).
  model.setMint({ mint: K.X, decimals: 6, tokenProgram: T22, name: "Asset coin", symbol: "ASSET", uri: null, onchainAt: 1 });
  model.upsertCoin({ mint: K.U, curve: "C_U", depth: 0, quoteMint: K.X, ...base, virtualQuoteReserves: "1000000000000000", realQuoteReserves: "3000000", tracked: true, createdAt: 5000 });
  model.upsertCoin({ mint: K.S, curve: "C_S", depth: 0, quoteMint: K.X, ...base, virtualQuoteReserves: "1000000000000000", realQuoteReserves: "2000000", tracked: true, createdAt: 6000 });
  for (const [mint, symbol] of [[K.U, "UUU"], [K.S, "SSS"]]) model.setMint({ mint, decimals: 6, tokenProgram: T22, name: `${symbol} coin`, symbol, uri: null, onchainAt: 1 });
  return { db, model };
}

test("full map: a listed quote asset is the top of its family; every coin quoted in it is under it, childless ones included", () => {
  const { db, model } = withAsset();
  try {
    const { body } = model.mapAll({ all: true });
    const asset = body.roots.find((r) => r.coin.mint === K.X);
    assert.ok(asset, "asset family drawn");
    assert.equal(asset.coin.asset, true);
    assert.equal(asset.coin.symbol, "ASSET");
    assert.deepEqual(asset.children.map((k) => k.coin.mint).sort(), [K.S, K.U].sort());
    assert.equal(asset.coin.children, 2);
    assert.ok(!body.roots.some((r) => r.coin.mint === K.U || r.coin.mint === K.S), "asset-quoted coins are not separate roots");
    assert.ok(body.roots.some((r) => r.coin.mint === K.ROOT), "SOL roots stay roots");
    let walked = 0; const w = (n) => { walked++; n.children.forEach(w); }; body.roots.forEach(w);
    assert.equal(body.total, walked);
    assert.equal(model.mapTotal(true), walked);
  } finally { db.close(); }
});

test("delta: an asset-quoted coin carries the asset as parentMint and the asset node comes along", () => {
  const { db, model } = withAsset();
  try {
    const { body } = model.mapSince({ all: true, since: 0 });
    const u = body.nodes.find((n) => n.mint === K.U);
    assert.equal(u.parentMint, K.X);
    const a = body.nodes.find((n) => n.mint === K.X);
    assert.ok(a && a.asset && a.parentMint === null);
  } finally { db.close(); }
});
