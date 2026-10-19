// The fee split signed at spawn time. pump's fee-sharing config refuses duplicate addresses and
// zero shares, so the four conceptual slots (child creator, parent creator, grandparent creator,
// platform) are merged into unique shareholders before they reach the program.
import { PublicKey } from "@solana/web3.js";

export type Share = { address: PublicKey; shareBps: number };
export const DEFAULT_SPLIT_BPS = [5000, 0, 0, 5000] as const; // creator / parent / grandparent / platform — two shareholders by default

export function splitShares(creator: PublicKey, parentCreator: PublicKey | null, grandparentCreator: PublicKey | null, platform: PublicKey, bps: readonly number[] = DEFAULT_SPLIT_BPS): Share[] {
  if (bps.length !== 4 || bps.some((b) => !Number.isInteger(b) || b < 0)) throw new Error("split: four non-negative integer bps values expected");
  const total = bps.reduce((a, b) => a + b, 0);
  if (total !== 10_000) throw new Error(`split: bps sum ${total}, expected 10000`);
  // A missing grandparent hands its slice to the parent creator; a missing parent creator (never the
  // case for a pump coin, but the type allows it) hands both slices to the child creator.
  const slots: [PublicKey, number][] = [[creator, bps[0]]];
  const parentSlice = bps[1] + (grandparentCreator ? 0 : bps[2]);
  if (parentCreator) slots.push([parentCreator, parentSlice]); else slots[0][1] += parentSlice;
  if (grandparentCreator) slots.push([grandparentCreator, bps[2]]);
  slots.push([platform, bps[3]]);
  const merged = new Map<string, Share>();
  for (const [address, shareBps] of slots) {
    const key = address.toBase58();
    const cur = merged.get(key);
    if (cur) cur.shareBps += shareBps; else merged.set(key, { address, shareBps });
  }
  const shares = [...merged.values()].filter((s) => s.shareBps > 0);
  const sum = shares.reduce((a, s) => a + s.shareBps, 0);
  if (sum !== 10_000 || shares.length === 0 || shares.length > 10) throw new Error(`split: invalid result (${shares.length} shareholders, ${sum} bps)`);
  return shares;
}
