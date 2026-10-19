// Dev-only dry mode (`?dry=1` on the launch page, development builds only): the whole launch flow
// runs end to end against mainnet state with NOTHING sent. The upload is skipped for a fixed
// metadata URI, the wallet is a shim that never signs, and every "send" becomes a simulation
// (sigVerify off, blockhash replaced) that must succeed. `import.meta.env.DEV` is a build-time
// constant, so in a production bundle every branch below is dead code and `isDry()` is false.
import { Keypair, PublicKey, type Connection, type VersionedTransaction } from "@solana/web3.js";
import { explainSimulationError, txBytes } from "./pump";

export type TestWallet = { publicKey: PublicKey; signTransaction: <T extends VersionedTransaction>(tx: T) => Promise<T>; dry: true; keypair: Keypair };
export type DryLogEntry = { label: string; ok: boolean; skipped?: boolean; bytes: number | null; units: number; err: string | null; at: number };
type DryGlobal = { makeWallet: (funded?: string) => TestWallet; log: DryLogEntry[]; slowMs: number; wallet?: TestWallet };

/// A funded public wallet (DESIGN §9): a simulation needs a payer with SOL, and a throwaway key
/// has none, so the shim signs with its own fresh keypair but presents this public key as payer.
/// Only the public key is used; nothing is ever signed for real with sigVerify off.
export const DRY_FUNDED = "dBs75Gf7RXQMAsMLuTLYdH2fHV1ac9zgCEh6zC7TxXs";
export const DRY_METADATA_URI = "https://spore-2x6.pages.dev/m/dry-run.json";

export const isDry = () => import.meta.env.DEV && typeof window !== "undefined" && new URLSearchParams(window.location.search).get("dry") === "1";

function makeWallet(funded: string = DRY_FUNDED): TestWallet {
  const keypair = Keypair.generate();
  return { publicKey: new PublicKey(funded), signTransaction: async (tx) => tx, dry: true, keypair };
}

/// `window.sporeDry` is the test hook: the e2e script injects a wallet (or lets the page make
/// one), reads `log` to assert every simulation passed and sets `slowMs` to watch the steps.
export function dryGlobal(): DryGlobal | null {
  if (!import.meta.env.DEV || typeof window === "undefined") return null;
  const w = window as unknown as { sporeDry?: DryGlobal; sporeTestWallet?: TestWallet };
  if (!w.sporeDry) w.sporeDry = { makeWallet, log: [], slowMs: 0 };
  return w.sporeDry;
}

export function dryWallet(): TestWallet | null {
  if (!isDry()) return null;
  const w = window as unknown as { sporeTestWallet?: TestWallet };
  const g = dryGlobal()!;
  if (!w.sporeTestWallet) w.sporeTestWallet = makeWallet();
  g.wallet = w.sporeTestWallet;
  return w.sporeTestWallet;
}

/// The dry "send": simulate, log, and hand back a signature-shaped marker that no explorer knows.
export async function drySend(conn: Connection, tx: VersionedTransaction, label: string): Promise<string> {
  const g = dryGlobal()!;
  if (g.slowMs > 0) await new Promise((r) => setTimeout(r, g.slowMs));
  const sim = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" });
  const logs = sim.value.logs ?? [];
  const entry: DryLogEntry = { label, ok: !sim.value.err, bytes: txBytes(tx), units: sim.value.unitsConsumed ?? 0, err: sim.value.err ? explainSimulationError(sim.value.err, logs) : null, at: Date.now() };
  g.log.push(entry);
  if (sim.value.err) throw new Error(`Dry run: ${entry.err}`);
  return `dry${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/// A transaction that can only run after another one landed for real (a fee split on a mint the
/// dry create never made) is recorded as skipped: `test/simulate.mts` validates that builder on
/// an existing coin instead.
export function drySkip(tx: VersionedTransaction, label: string): string {
  dryGlobal()!.log.push({ label, ok: true, skipped: true, bytes: txBytes(tx), units: 0, err: null, at: Date.now() });
  return `dryskip${Date.now().toString(36)}`;
}

export async function drySleep() {
  const g = dryGlobal();
  if (g && g.slowMs > 0) await new Promise((r) => setTimeout(r, g.slowMs));
}
