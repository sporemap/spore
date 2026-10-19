// Buying and selling any SOL-rooted coin of the tree with pump-amm's multi_hop_swap. Quotes come
// from a simulation rather than curve math: one call covers every venue mix (curve/pool) and the
// fee schedule pump applies that day, and the output is read from the balance the user's account
// ends the simulation with, which is exactly what min_amount_out is compared against.
import { ComputeBudgetProgram, PublicKey, TransactionMessage, VersionedTransaction, type AddressLookupTableAccount, type Connection, type TransactionInstruction } from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import BN from "bn.js";
import { PUMP_SDK, multiHopRouteEnds, pumpIdl } from "@pump-fun/pump-sdk";
import { hopsFor, type Chain, type Side } from "./route";
import { lookupTables } from "./alt";

/// A modest priority fee so trades land during normal load (0.05 lamports per CU: ~0.00002 SOL on
/// a 400k-CU route).
export const CU_PRICE_MICRO = 50_000;
const BASE_FEE_LAMPORTS = 5_000;
const QUOTE_CU_LIMIT = 1_400_000;

export type Quote = {
  amountOut: bigint; logs: string[]; unitsConsumed: number;
  /// Lamports of a WSOL account the user already had that the route closes back into the wallet
  /// (its rent plus any wrapped SOL; 0 when there is none). Real money for the user, but not swap
  /// output; the UI may warn that the wrapped balance gets unwrapped as a side effect.
  unwrapped: bigint;
};

const cuIxs = (units: number) => [ComputeBudgetProgram.setComputeUnitLimit({ units }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: CU_PRICE_MICRO })];

export const MAX_TX_BYTES = 1232;

export function compileV0(payer: PublicKey, blockhash: string, ixs: TransactionInstruction[], tables: AddressLookupTableAccount[] = []): VersionedTransaction {
  return new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message(tables));
}

/// Serialized size, or null when the message is too large to encode at all.
export function txBytes(tx: VersionedTransaction): number | null {
  try { return tx.serialize().length; } catch { return null; }
}

function assertSendable(tx: VersionedTransaction, what: string) {
  const n = txBytes(tx);
  if (n === null || n > MAX_TX_BYTES) throw new Error(`${what} is too large for one transaction (${n ?? ">1232"} bytes). This chain is deeper than the lookup table covers.`);
  return tx;
}

async function swapInstructions(user: PublicKey, chain: Chain, side: Side, amountIn: bigint, minAmountOut: bigint) {
  if (amountIn <= 0n) throw new Error("Enter an amount");
  const hops = hopsFor(chain, side);
  const ixs = await PUMP_SDK.multiHopSwapInstructions({ user, hops, side, amountIn: new BN(amountIn.toString()), minAmountOut: new BN(minAmountOut.toString()) });
  return { hops, ixs };
}

/// SPL Token and Token-2022 share the base account layout: the amount is the u64 at offset 64.
const tokenAmount = (data: Uint8Array | null | undefined) => (data && data.length >= 72 ? new DataView(data.buffer, data.byteOffset + 64, 8).getBigUint64(0, true) : 0n);
const fromBase64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

const lamportsOf = (a: { lamports: number } | null | undefined) => BigInt(a?.lamports ?? 0);

export async function quoteSwap(conn: Connection, user: PublicKey, chain: Chain, side: Side, amountIn: bigint): Promise<Quote> {
  const { hops, ixs } = await swapInstructions(user, chain, side, amountIn, 1n);
  const { input, output } = multiHopRouteEnds(hops, side);
  const solOut = output.mint.equals(NATIVE_MINT);
  // SOL proceeds land in the wallet itself (a WSOL account is closed back into it); tokens land in
  // the user's associated token account, created by the route when missing.
  const outAccount = solOut ? user : getAssociatedTokenAddressSync(output.mint, user, true, output.tokenProgram);
  // Whenever SOL is the route's input or output, the SDK creates the user's WSOL account
  // idempotently and closes it at the end. One that already existed (anyone who wrapped SOL or
  // used another DEX) then pours its rent and wrapped balance into the wallet inside the same
  // transaction. The program's min_amount_out never sees those lamports, so a quote that counted
  // them would demand a minimum the swap cannot reach (the 0.002 SOL rent alone is 4x the
  // tolerance of a 0.05 SOL sell at 1% slippage; a wrapped balance makes it absurd: a 7.3 SOL
  // "quote" for a 0.013 SOL sell was measured). Reading the account before and after cancels it.
  const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, user, true, TOKEN_PROGRAM_ID);
  const touchesWsol = solOut || input.mint.equals(NATIVE_MINT);
  const [[pre, wsolPre], { blockhash }, tables] = await Promise.all([conn.getMultipleAccountsInfo([outAccount, wsolAta], "confirmed"), conn.getLatestBlockhash("confirmed"), lookupTables(conn)]);
  const tx = assertSendable(compileV0(user, blockhash, [...cuIxs(QUOTE_CU_LIMIT), ...ixs], tables), "The route");
  const sim = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed", accounts: { encoding: "base64", addresses: [outAccount.toBase58(), wsolAta.toBase58()] } });
  const logs = sim.value.logs ?? [];
  if (sim.value.err) throw new Error(explainSimulationError(sim.value.err, logs));
  const post = sim.value.accounts?.[0] ?? null;
  // Null after the route closed it; counted in case a route ever leaves it open holding output.
  const wsolPost = sim.value.accounts?.[1] ?? null;
  const before = solOut ? lamportsOf(pre) + lamportsOf(wsolPre) : tokenAmount(pre?.data);
  const after = solOut ? lamportsOf(post) + lamportsOf(wsolPost) : tokenAmount(post ? fromBase64(post.data[0]) : null);
  let amountOut = after - before;
  // The simulated bank charged the transaction fee to the wallet; the program's min_amount_out
  // check sees the hop output before that, so add it back for SOL proceeds.
  if (solOut) amountOut += BigInt(BASE_FEE_LAMPORTS + Math.ceil((QUOTE_CU_LIMIT * CU_PRICE_MICRO) / 1_000_000));
  if (amountOut <= 0n) throw new Error("The route returned nothing for that amount");
  return { amountOut, logs, unitsConsumed: sim.value.unitsConsumed ?? 0, unwrapped: touchesWsol ? lamportsOf(wsolPre) : 0n };
}

export async function buildSwapTx(conn: Connection, user: PublicKey, chain: Chain, side: Side, amountIn: bigint, minAmountOut: bigint): Promise<VersionedTransaction> {
  if (minAmountOut <= 0n) throw new Error("minAmountOut must be at least 1");
  const { hops, ixs } = await swapInstructions(user, chain, side, amountIn, minAmountOut);
  // ~30–50k CU per hop plus account creation; sized generously, the unused part is not charged.
  const units = Math.min(QUOTE_CU_LIMIT, 150_000 + 80_000 * hops.length);
  const [{ blockhash }, tables] = await Promise.all([conn.getLatestBlockhash("confirmed"), lookupTables(conn)]);
  return assertSendable(compileV0(user, blockhash, [...cuIxs(units), ...ixs], tables), "The route");
}

const PUMP_ERRORS = new Map<number, string>((pumpIdl as { errors?: { code: number; name: string; msg?: string }[] }).errors?.map((e) => [e.code, e.msg || e.name]) ?? []);
const KNOWN: Record<number, string> = { 6086: "the route mixes buy and sell directions", 6023: "slippage: the output fell below your minimum", 6024: "slippage: the input exceeded your maximum", 1: "insufficient funds in the wallet for this trade" };

/// Turns a simulation failure into one readable sentence: pump's own error message when the code
/// is one of its, otherwise the last program log line.
export function explainSimulationError(err: unknown, logs: string[]): string {
  const m = logs.join("\n").match(/custom program error: 0x([0-9a-f]+)/i);
  if (m) {
    const code = parseInt(m[1], 16);
    const text = PUMP_ERRORS.get(code) ?? KNOWN[code];
    if (text) return `${text} (${code})`;
  }
  if (logs.some((l) => /insufficient lamports|insufficient funds/i.test(l))) return "Insufficient SOL in the wallet for this trade";
  const last = [...logs].reverse().find((l) => l.startsWith("Program log:") && !/^Program log: Instruction:/.test(l));
  return last ? last.replace(/^Program log:\s*/, "") : `Simulation failed: ${JSON.stringify(err)}`;
}
