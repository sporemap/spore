// The map's node record: what every bubble is drawn from, and what the client cache stores per mint.
// Flat (parent by mint) so a tree, a delta list and a live event all become the same thing.
export type BubbleNode = {
  mint: string; parentMint: string | null; depth: number;
  name: string | null; symbol: string | null; image: string | null;
  mcapUsd: number | null; lockedUsd: number | null; children: number; descendants?: number; migrated: boolean;
  ours?: boolean; createdAt?: number | null; updatedAt?: number;
  /// Last layout position (world units), restored from the cache so a warm open paints without settling.
  x?: number; y?: number;
};
export type SizeMode = "locked" | "mcap";
export type RootsLimit = "all" | 200 | 60;
