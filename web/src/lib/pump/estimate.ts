// What the optional first buy would return, computed before the coin exists. The curve cannot be
// simulated yet (it is created by the launch transaction), so this uses pump's own curve math on
// a fresh curve: for a root, SOL straight into the new curve; for a child, SOL → parent through
// the live chain (a real simulation), then the parent tokens into the new curve. An estimate:
// multi-hop charges the protocol fee once on the SOL hop, so the child figure is slightly low.
import { PublicKey, type Connection } from "@solana/web3.js";
import { NATIVE_MINT } from "@solana/spl-token";
import BN from "bn.js";
import { OnlinePumpSdk, getBuyTokenAmountFromSolAmount } from "@pump-fun/pump-sdk";
import { quoteSwap } from "./trade";
import type { Chain } from "./route";

export type FirstBuyEstimate = {
  /// Tokens of the new coin, raw (6 decimals).
  tokens: bigint;
  /// What reaches the new curve: lamports for a root, parent tokens (raw) for a child.
  quoteIn: bigint;
  hops: number;
};

export async function estimateFirstBuy(conn: Connection, user: PublicKey, parentMint: PublicKey | null, parentChain: Chain | null, lamports: bigint, creatorFeeBps?: number): Promise<FirstBuyEstimate> {
  if (lamports <= 0n) return { tokens: 0n, quoteIn: 0n, hops: 0 };
  const online = new OnlinePumpSdk(conn);
  const [global, feeConfig] = await Promise.all([online.fetchGlobal(), online.fetchFeeConfig().catch(() => null)]);
  const fee = creatorFeeBps ? new BN(creatorFeeBps) : undefined;
  if (!parentMint) {
    const tokens = getBuyTokenAmountFromSolAmount({ global, feeConfig, mintSupply: null, bondingCurve: null, amount: new BN(lamports.toString()), quoteMint: NATIVE_MINT, creatorFeeBps: fee });
    return { tokens: BigInt(tokens.toString()), quoteIn: lamports, hops: 1 };
  }
  if (!parentChain || parentChain.length === 0) throw new Error("estimate: the parent chain is needed for a child");
  const [resolved, parentQuote] = await Promise.all([online.resolveQuoteMint(parentMint), quoteSwap(conn, user, parentChain, "buy", lamports)]);
  if (!resolved.pumpQuote) throw new Error("The parent must be a pump.fun coin");
  const tokens = getBuyTokenAmountFromSolAmount({ global, feeConfig, mintSupply: null, bondingCurve: null, amount: new BN(parentQuote.amountOut.toString()), quoteMint: parentMint, pumpQuote: resolved.pumpQuote.curve, creatorFeeBps: fee });
  return { tokens: BigInt(tokens.toString()), quoteIn: parentQuote.amountOut, hops: parentChain.length + 1 };
}
