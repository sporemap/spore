// Builds the `Chain` the tx library needs (self first, down to the depth-0 root) from API coins.
// The API's `ancestors` are CoinRefs (no token program, no migration flag), so each ancestor's
// full record is fetched: at most maxCurveDepth requests (2 today, 5 is the program cap).
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { api, type Coin, type CoinRef } from "./api";
import type { Chain, ChainLink } from "./pump";

const SPL_TOKEN = TOKEN_PROGRAM_ID.toBase58();
export const TOKEN_2022 = TOKEN_2022_PROGRAM_ID.toBase58();

const link = (c: Coin, quoteTokenProgram: string): ChainLink => ({ mint: c.mint, quoteMint: c.quoteMint, tokenProgram: c.tokenProgram, quoteTokenProgram, migrated: c.migrated, depth: c.depth });

export async function chainFor(coin: Coin): Promise<Chain> {
  const ancestors = await Promise.all(coin.ancestors.map((a) => api.coin(a.mint).then((r) => r.coin)));
  const coins = [coin, ...ancestors];
  // SOL and USDC, the listed roots this UI can price from, are classic SPL Token mints. A root
  // quoted in anything else is not tradable here, so that fallback never reaches a wallet.
  return coins.map((c, i) => link(c, coins[i + 1]?.tokenProgram ?? SPL_TOKEN));
}

/// The chain of a coin about to be spawned under `parent` (create_v2 always mints Token-2022).
export function chainForChild(newMint: string, parent: Coin, parentChain: Chain): Chain {
  return [{ mint: newMint, quoteMint: parent.mint, tokenProgram: TOKEN_2022, quoteTokenProgram: parent.tokenProgram, migrated: false, depth: parent.depth + 1 }, ...parentChain];
}

/// The chain of a root coin about to be launched with SOL: one link, quoted in the native mint
/// (a classic SPL Token mint), depth 0. Its first buy is a single-hop pump buy.
export function chainForRoot(newMint: string): Chain {
  return [{ mint: newMint, quoteMint: null, tokenProgram: TOKEN_2022, quoteTokenProgram: SPL_TOKEN, migrated: false, depth: 0 }];
}

/// Only a chain that bottoms out in SOL can be bought or sold from SOL with multi_hop_swap.
export const isSolRooted = (chain: Chain) => chain.length > 0 && chain[chain.length - 1].depth === 0 && chain[chain.length - 1].quoteMint === null;

/// Human route for the quote preview: SOL → $ROOT → $PARENT → $COIN (buy) or the reverse (sell).
export function routeLabels(chain: Chain, refs: Map<string, CoinRef | Coin>, side: "buy" | "sell") {
  const names = [...chain].reverse().map((l) => { const r = refs.get(l.mint); return r?.symbol ? `$${r.symbol}` : `${l.mint.slice(0, 4)}…`; });
  const path = ["SOL", ...names];
  return side === "buy" ? path : path.reverse();
}
