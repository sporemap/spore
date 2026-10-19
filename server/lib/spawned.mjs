// Verification of a reported spawn (POST /api/spawned). The browser tells the API "I launched
// `mint` in transaction `sig`"; nothing about that claim is trusted until the transaction itself,
// read back from the chain, shows (1) a pump `CreateEvent` for exactly that mint, (2) a creator
// that is a wallet (a program-derived creator means holder rewards, which the fee split cannot
// apply to) and (3) the launch fee landing in the platform wallet. Only then is the coin listed
// as pending-ours while the indexer looks for its fee-sharing config (DESIGN §11.1, §11.2).
// Pure: the transaction JSON goes in (getTransaction, encoding "json", any version), a verdict
// comes out, so the rules are unit-tested against real bytes.
import { PublicKey, PUMP_PROGRAM_ID } from "./sdk.mjs";
import { decodeEvent, eventsInLogs } from "./decode.mjs";

const PUMP_PROGRAMS = new Set([PUMP_PROGRAM_ID.toBase58()]);

/** The accounts that signed the transaction: the first `numRequiredSignatures` static keys. */
export function signersOf(tx) {
  const msg = tx?.transaction?.message ?? {};
  const n = Number(msg.header?.numRequiredSignatures ?? 0);
  return (msg.accountKeys ?? []).slice(0, n).map(keyOf);
}

const keyOf = (k) => (typeof k === "string" ? k : k?.pubkey ?? null);

/** Every account of the transaction in balance order: static keys, then loaded writable, then loaded readonly. */
export function accountKeysOf(tx) {
  const msg = tx?.transaction?.message ?? {};
  const loaded = tx?.meta?.loadedAddresses ?? {};
  return [...(msg.accountKeys ?? []).map(keyOf), ...(loaded.writable ?? []), ...(loaded.readonly ?? [])];
}

/** Lamports `account` gained (negative when it paid) in the transaction, or 0n when it is not part of it. */
export function balanceDeltaOf(tx, account) {
  const i = accountKeysOf(tx).indexOf(account);
  if (i < 0) return 0n;
  return BigInt(tx.meta?.postBalances?.[i] ?? 0) - BigInt(tx.meta?.preBalances?.[i] ?? 0);
}

/**
 * `{ ok, reason, notFound, create, feePaid, slot, blockTime }`. `feeLamports` is the launch fee the
 * platform expects (0n when launches are free); a creator paying its own wallet (the platform
 * launching) is exempt, since the transfer would net to zero.
 */
export function verifySpawnTx(tx, { mint, platformWallet, feeLamports = 0n } = {}) {
  const no = (reason, extra = {}) => ({ ok: false, reason, notFound: false, create: null, feePaid: null, slot: null, blockTime: null, ...extra });
  if (!tx || !tx.meta) return no("transaction not found", { notFound: true });
  if (tx.meta.err) return no("the transaction failed on-chain");
  let create = null;
  // Only an event emitted inside the pump program's own frame counts (decode.mjs attributes
  // every "Program data:" line to the invoking program), and a genuine create has the new mint
  // among the signers (create_v2's mint account signs).
  for (const { name, data } of eventsInLogs(tx.meta.logMessages ?? [], PUMP_PROGRAMS)) {
    if (name !== "CreateEvent") continue;
    let e;
    try { e = decodeEvent(name, data); } catch { continue; }
    if (e.mint === mint) { create = e; break; }
  }
  if (!create) return no("the transaction carries no pump.fun create of this mint");
  const signers = signersOf(tx);
  if (!signers.includes(mint)) return no("the mint did not sign the transaction, so this is not its create");
  let onCurve = false;
  try { onCurve = PublicKey.isOnCurve(new PublicKey(create.creator).toBytes()); } catch { onCurve = false; }
  if (!onCurve) return no("the coin's creator is a program address (holder-reward coin); the fee split cannot apply");
  const fee = BigInt(feeLamports ?? 0);
  // `creator` is a plain argument of create_v2 (anyone can name any wallet); the exemption needs the platform to have signed.
  const selfPaid = create.creator === platformWallet && signers.includes(platformWallet);
  const feePaid = selfPaid ? fee : balanceDeltaOf(tx, platformWallet);
  if (feePaid < fee) return no(`launch fee not paid: the platform received ${feePaid < 0n ? 0n : feePaid} of ${fee} lamports`);
  return { ok: true, reason: null, notFound: false, create, feePaid: feePaid > 0n ? feePaid : 0n, slot: tx.slot ?? null, blockTime: tx.blockTime ?? null };
}
