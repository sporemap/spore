// Sends a transaction through the wallet and confirms it by polling over HTTP: the API's RPC
// proxy has no websocket, so web3's subscription-based confirm would hang.
import { Connection, Keypair, VersionedTransaction } from "@solana/web3.js";
import type { WalletContextState } from "@solana/wallet-adapter-react";

/// `onSent` fires with the signature as soon as the wallet returned it, before confirmation, so a
/// progress line can link the explorer while the network works.
export async function sendAndConfirm(conn: Connection, wallet: WalletContextState, tx: VersionedTransaction, extraSigners: Keypair[] = [], onSent?: (sig: string) => void): Promise<string> {
  if (!wallet.publicKey || !wallet.sendTransaction) throw new Error("Connect a wallet first");
  // The message was compiled with a fresh blockhash by the builder; refresh it here so a slow
  // review in the wallet does not expire it, then compute the expiry height from that hash.
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  tx.message.recentBlockhash = blockhash;
  if (extraSigners.length) tx.sign(extraSigners);
  const sig = await wallet.sendTransaction(tx, conn, { preflightCommitment: "confirmed", maxRetries: 3 });
  onSent?.(sig);
  await confirm(conn, sig, lastValidBlockHeight);
  return sig;
}

export class ExpiredError extends Error { constructor() { super("The transaction expired before it landed. Nothing was charged; please try again."); this.name = "ExpiredError"; } }
export class UnconfirmedError extends Error { sig: string; constructor(sig: string) { super(`Still not confirmed after two minutes. Check ${sig} in an explorer before retrying.`); this.name = "UnconfirmedError"; this.sig = sig; } }

export async function confirm(conn: Connection, sig: string, lastValidBlockHeight: number) {
  const started = Date.now();
  for (;;) {
    const st = (await conn.getSignatureStatuses([sig])).value[0];
    if (st?.err) throw new Error(`Transaction failed on-chain: ${JSON.stringify(st.err)} (${sig})`);
    if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) return;
    const height = await conn.getBlockHeight("confirmed").catch(() => 0);
    if (height > lastValidBlockHeight && !st) throw new ExpiredError();
    if (Date.now() - started > 120_000) throw new UnconfirmedError(sig);
    await new Promise((r) => setTimeout(r, 1_200));
  }
}

/// Has a signature landed? Used when a tab was closed or reloaded mid-flight: "confirmed" means
/// the launch is on-chain, "failed" means it executed and errored, "unknown" means not seen (yet).
export async function signatureState(conn: Connection, sig: string): Promise<"confirmed" | "failed" | "unknown"> {
  const st = (await conn.getSignatureStatuses([sig], { searchTransactionHistory: true })).value[0];
  if (!st) return "unknown";
  if (st.err) return "failed";
  return st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized" ? "confirmed" : "unknown";
}
