import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { splitShares } from "../src/lib/pump/shares.ts";

const [c, p, g, plat] = [0, 1, 2, 3].map(() => Keypair.generate().publicKey);
const by = (s: ReturnType<typeof splitShares>) => Object.fromEntries(s.map((x) => [x.address.toBase58(), x.shareBps]));

test("default split: creator and platform only, zero slices dropped", () => {
  const s = by(splitShares(c, p, g, plat));
  assert.deepEqual(s, { [c.toBase58()]: 5000, [plat.toBase58()]: 5000 });
});
test("upward shares when configured", () => {
  const s = by(splitShares(c, p, g, plat, [5000, 2500, 1000, 1500]));
  assert.deepEqual(s, { [c.toBase58()]: 5000, [p.toBase58()]: 2500, [g.toBase58()]: 1000, [plat.toBase58()]: 1500 });
});
test("no grandparent: its slice goes to the parent creator", () => {
  const s = by(splitShares(c, p, null, plat, [5000, 2500, 1000, 1500]));
  assert.deepEqual(s, { [c.toBase58()]: 5000, [p.toBase58()]: 3500, [plat.toBase58()]: 1500 });
});
test("self-spawn merges creator and parent creator", () => {
  const s = by(splitShares(c, c, g, plat, [5000, 2500, 1000, 1500]));
  assert.deepEqual(s, { [c.toBase58()]: 7500, [g.toBase58()]: 1000, [plat.toBase58()]: 1500 });
});
test("platform-owned parent merges into the platform", () => {
  const s = by(splitShares(c, plat, plat, plat, [5000, 2500, 1000, 1500]));
  assert.deepEqual(s, { [c.toBase58()]: 5000, [plat.toBase58()]: 5000 });
});
test("sum must be 10000", () => {
  assert.throws(() => splitShares(c, p, g, plat, [5000, 2500, 1000, 1000]), /sum/);
});
