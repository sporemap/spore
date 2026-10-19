// A coin's quote chain, as the API describes it (self first, down to the depth-0 root), turned
// into the hop list pump-amm's multi_hop_swap takes. Only chains that bottom out in SOL can be
// traded from a SOL wallet: a root quoted in USDC or a tokenized stock would need that asset.
import { PublicKey } from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import type { MultiHopHop } from "@pump-fun/pump-sdk";

export type ChainLink = { mint: string; quoteMint: string | null; tokenProgram: string; quoteTokenProgram: string; migrated: boolean; depth: number };
export type Chain = ChainLink[];
export type Side = "buy" | "sell";

const WSOL = NATIVE_MINT.toBase58();
export const isSolRooted = (chain: Chain) => chain.length > 0 && chain[chain.length - 1].depth === 0 && (chain[chain.length - 1].quoteMint === null || chain[chain.length - 1].quoteMint === WSOL);

/// Buy routes walk from the SOL-quoted root up to the coin (each hop buys a coin quoted in the
/// previous hop's coin); sell routes walk down. pump-amm refuses mixed directions, so the whole
/// list is one or the other.
export function hopsFor(chain: Chain, side: Side): MultiHopHop[] {
  if (chain.length === 0) throw new Error("route: empty chain");
  if (chain.length > 6) throw new Error("route: chain deeper than the program allows");
  if (!isSolRooted(chain)) throw new Error("This coin's tree is not rooted in SOL, so it cannot be traded from a SOL wallet here. Trade it on pump.fun.");
  const hops: MultiHopHop[] = chain.map((l) => ({
    venue: l.migrated ? "pool" : "curve",
    baseMint: new PublicKey(l.mint),
    quoteMint: l.quoteMint ? new PublicKey(l.quoteMint) : NATIVE_MINT,
    baseTokenProgram: new PublicKey(l.tokenProgram),
    quoteTokenProgram: l.quoteMint ? new PublicKey(l.quoteTokenProgram) : TOKEN_PROGRAM_ID,
  }));
  // `chain` is self-first; a buy starts at the root.
  return side === "buy" ? hops.reverse() : hops;
}
