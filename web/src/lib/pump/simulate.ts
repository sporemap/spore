// Pre-flight: the exact transaction the wallet is about to sign, run through simulateTransaction
// first. A failing simulation costs nothing and gives a readable reason before the wallet pops up;
// a passing one tells the user what the signature will spend (the payer's lamports before vs
// after, which covers rent, fees, the launch fee and a first buy at once).
import { PublicKey, type Connection, type VersionedTransaction } from "@solana/web3.js";
import { explainSimulationError, txBytes } from "./trade";

export type Preflight = {
  unitsConsumed: number;
  bytes: number | null;
  logs: string[];
  /// Lamports the payer ends up short of their current balance (rent + fees + transfers), or null
  /// when the payer's post-state was not returned.
  spent: bigint | null;
};

/// SPL / Token-2022 accounts both keep the u64 amount at offset 64.
const fromBase64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function preflight(conn: Connection, tx: VersionedTransaction, payer: PublicKey, watch: PublicKey[] = []): Promise<Preflight> {
  const addresses = [payer, ...watch].map((k) => k.toBase58());
  const [before, sim] = await Promise.all([
    conn.getBalance(payer, "confirmed").catch(() => null),
    conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed", accounts: { encoding: "base64", addresses } }),
  ]);
  const logs = sim.value.logs ?? [];
  if (sim.value.err) throw new SimulationError(explainSimulationError(sim.value.err, logs), logs, sim.value.err);
  const post = sim.value.accounts?.[0] ?? null;
  const spent = before !== null && post ? BigInt(before) - BigInt(post.lamports) : null;
  return { unitsConsumed: sim.value.unitsConsumed ?? 0, bytes: txBytes(tx), logs, spent };
}

/// Carries the logs so the UI can show the program's own words under the one-line cause.
export class SimulationError extends Error {
  logs: string[];
  raw: unknown;
  constructor(message: string, logs: string[], raw: unknown) { super(message); this.name = "SimulationError"; this.logs = logs; this.raw = raw; }
}

/// Token balance of a simulated post-state account, for callers that watch an ATA.
export const simulatedTokenAmount = (acc: { data: string[] } | null | undefined) => {
  if (!acc) return 0n;
  const d = fromBase64(acc.data[0]);
  return d.length >= 72 ? new DataView(d.buffer, d.byteOffset + 64, 8).getBigUint64(0, true) : 0n;
};
