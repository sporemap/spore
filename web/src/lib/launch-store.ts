// The in-progress launch, persisted per browser so a reload, a closed tab or a wallet that hung
// after the create transaction never strands a coin: the page offers "Resume" / "Finish the fee
// split" from this record. Storage can be blocked (private mode); every access is guarded.
//
// `signing`: saved before the wallet opens (the mint is chosen at build time, so the record is
// complete without a signature); `sent`: the wallet handed back the signature. A wallet that
// broadcasts and then rejects its promise leaves a `signing` record, which the Resume card resolves
// against the chain (does the bonding curve exist?) instead of against a signature it never got.
export type PendingStep = "signing" | "sent" | "split-pending" | "done";
export type PendingLaunch = {
  v: 1;
  mint: string;
  /// null until the wallet returned it; a coin can exist on-chain while this is still null.
  sig: string | null;
  name: string; symbol: string; image: string | null;
  parentMint: string | null; parentSymbol: string | null; depth: number;
  /// Needed to rebuild the fee split: the new curve's quote mint + token program, and the exact shares.
  quoteMint: string; quoteTokenProgram: string; shares: { address: string; bps: number }[];
  /// true when the create transaction already carried the fee split.
  splitIncluded: boolean;
  splitSig: string | null;
  step: PendingStep;
  createdAt: number;
};

const KEY = "spore:launch:pending";

export function loadPending(): PendingLaunch | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as PendingLaunch;
    return p && p.v === 1 && typeof p.mint === "string" && (typeof p.sig === "string" || p.sig === null) ? p : null;
  } catch { return null; }
}
export function savePending(p: PendingLaunch) {
  try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* private mode: the flow still runs */ }
}
/// Images are kept only while they fit comfortably; a huge data URL is dropped, not the record.
export function savePendingSafe(p: PendingLaunch) {
  const image = p.image && p.image.length < 900_000 ? p.image : null;
  savePending({ ...p, image });
}
export function clearPending() {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
}
