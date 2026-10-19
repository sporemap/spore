// A small in-memory family tree shared by the model and API tests:
//   ROOT (SOL-quoted, 1e-7 SOL/token) → A (depth 1, 2 ROOT/token) → G (depth 2, 0.5 A/token, complete)
//                                      → B (depth 1, 1 ROOT/token)
// Mints are real base58 public keys so the API's mint validation accepts them.
import { Db } from "../../lib/db.mjs";
import { Model } from "../../lib/model.mjs";
import { PublicKey } from "../../lib/sdk.mjs";

export const PLATFORM = "dBs75Gf7RXQMAsMLuTLYdH2fHV1ac9zgCEh6zC7TxXs";
export const quiet = { info() {}, warn() {}, error() {} };
const key = (seed) => new PublicKey(Buffer.alloc(32, seed)).toBase58();
export const K = { ROOT: key(1), A: key(2), B: key(3), G: key(4), X: key(5), U: key(6), S: key(7) };
export const T22 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const base = { virtualTokenReserves: "1000000000000000", realTokenReserves: "500000000000000", tokenTotalSupply: "1000000000000000", initialVirtualQuoteReserves: "0", complete: false, migrated: false, creator: "CR" };

export function buildTree() {
  const db = new Db(":memory:");
  const model = new Model(db, { platformWallet: PLATFORM, splitBps: [5000, 2500, 1000, 1500], log: quiet });
  model.load();
  model.setGlobal({ maxCurveDepth: 2, initialRealTokenReserves: "793100000000000", createV2Enabled: true, whitelistedQuoteMints: [] });
  model.setSolUsd(100);
  model.upsertCoin({ mint: K.ROOT, curve: "C_ROOT", depth: 0, quoteMint: null, ...base, virtualQuoteReserves: "100000000000", createdAt: 1000 }); // 100 SOL / 1e9 tokens = 1e-7
  model.upsertCoin({ mint: K.A, curve: "C_A", depth: 1, quoteMint: K.ROOT, ...base, virtualQuoteReserves: "2000000000000000", realQuoteReserves: "50000000000000", createdAt: 2000 }); // 2 ROOT per A; 50M ROOT raised
  model.upsertCoin({ mint: K.B, curve: "C_B", depth: 1, quoteMint: K.ROOT, ...base, virtualQuoteReserves: "1000000000000000", realQuoteReserves: "10000000000000", createdAt: 3000 });
  model.upsertCoin({ mint: K.G, curve: "C_G", depth: 2, quoteMint: K.A, ...base, virtualQuoteReserves: "500000000000000", realQuoteReserves: "7000000000000", createdAt: 4000, complete: true }); // 0.5 A per G; 7M A raised
  for (const [mint, symbol] of [[K.ROOT, "ROOT"], [K.A, "AAA"], [K.B, "BBB"], [K.G, "GGG"]]) model.setMint({ mint, decimals: 6, tokenProgram: T22, name: `${symbol} coin`, symbol, uri: `https://ipfs.io/ipfs/${symbol}`, onchainAt: 1 });
  model.setMeta("https://ipfs.io/ipfs/AAA", { image: "https://ipfs.io/ipfs/imgA", description: "A desc", twitter: "https://x.com/a", telegram: null, website: null, fetchedAt: 1, ok: true });
  return { db, model };
}
