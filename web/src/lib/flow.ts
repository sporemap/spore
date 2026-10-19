// The two wallet flows the pages run: launching a coin (a SOL-quoted root, or a child under a
// parent; optionally with a first buy) and a multi-hop buy/sell. Both are thin orchestration over
// lib/pump plus the step reporting the UI renders. Nothing here signs: the wallet does.
//
// The launch is designed so a user can never be stranded: the built transaction is simulated
// before the wallet opens, the launch record (mint included: it is chosen at build time) is
// persisted before the wallet opens and the signature added the moment the wallet returns it, a
// fee split that fails after the create landed is retried on its own (`finishFeeSplit`), and a
// failed first buy is reported beside a successful launch, never as one.
import { Keypair, PublicKey, type Connection, type VersionedTransaction } from "@solana/web3.js";
import type { WalletContextState } from "@solana/wallet-adapter-react";
import { bondingCurvePda } from "@pump-fun/pump-sdk";
import { api, type Coin, type Eligibility, type UploadBody } from "./api";
import { chainFor, chainForChild, chainForRoot } from "./chain";
import { MAX_LAUNCH_FEE_LAMPORTS, PLATFORM_WALLET, PolicyError, SPLIT_BPS } from "./policy";
import { splitShares, type Share } from "./pump/shares";
import { buildFeeSplitTx, buildSpawnTx, buildSwapTx, estimateFirstBuy, preflight, quoteSwap, sendAndConfirm, signatureState, type Chain, type LaunchFee, type Side } from "./pump";
import { friendlyError, stepper, type Report } from "./steps";
import { clearPending, loadPending, savePendingSafe, type PendingLaunch } from "./launch-store";
import { DRY_METADATA_URI, drySend, drySkip, drySleep, isDry, type TestWallet } from "./dry";

/// Who signs. The real one wraps wallet-adapter; the dry one (dev builds, `?dry=1`) simulates.
export type Signer = { publicKey: PublicKey; dry: boolean; send: (tx: VersionedTransaction, label: string, extraSigners?: Keypair[], onSent?: (sig: string) => void) => Promise<string> };

export function walletSigner(conn: Connection, wallet: WalletContextState): Signer | null {
  if (!wallet.publicKey || !wallet.sendTransaction) return null;
  return { publicKey: wallet.publicKey, dry: false, send: (tx, _label, extra = [], onSent) => sendAndConfirm(conn, wallet, tx, extra, onSent) };
}

export function drySigner(conn: Connection, w: TestWallet): Signer {
  return { publicKey: w.publicKey, dry: true, send: (tx, label) => drySend(conn, tx, label) };
}

/// `parent` null = a root coin quoted in SOL (the launch tab's default pool).
export type SpawnInput = { parent: Coin | null; eligibility: Eligibility; form: UploadBody; creatorFeeBps?: number; firstBuyLamports: bigint; slippageBps: number };
export type SpawnResult = {
  sig: string; mint: string; depth: number; name: string; symbol: string; image: string | null;
  parent: { mint: string; symbol: string | null } | null;
  /// The fee split: landed (in the create or in its own transaction), or still to do.
  split: { done: boolean; sig: string | null; error: string | null };
  buy: { sig: string; amountOut: bigint } | null; buyError: string | null;
  /// Lamports the create transaction took from the wallet, measured by the pre-flight simulation.
  spent: bigint | null;
  dry: boolean;
  /// The record a retry of the fee split is rebuilt from (persisted in localStorage unless dry).
  pending: PendingLaunch;
};

/// minAmountOut = quoted × (1 − bps/10 000), never below 1 so the program's "zero out" guard
/// cannot trip on a dust quote.
export const withSlippage = (amountOut: bigint, slippageBps: number) => { const m = (amountOut * BigInt(10_000 - slippageBps)) / 10_000n; return m > 0n ? m : 1n; };

/// The eligibility payload carries the launch fee as strings; lib/pump wants a PublicKey + bigint.
/// A missing field (older server) or a zero amount means no transfer is added. The recipient must
/// be the pinned platform wallet and the amount at most the published fee (lib/policy.ts): a
/// server answer that asks for more, or for another wallet, is refused instead of signed.
export function launchFeeOf(e: Eligibility): LaunchFee {
  const f = e.launchFee;
  if (!f || !f.to) return null;
  let lamports: bigint;
  try { lamports = BigInt(f.lamports); } catch { return null; }
  if (lamports <= 0n) return null;
  if (f.to !== PLATFORM_WALLET.toBase58()) throw new PolicyError("The server asked to send the launch fee to a wallet that is not Spore's; refusing to build.");
  if (lamports > MAX_LAUNCH_FEE_LAMPORTS) throw new PolicyError(`The server asked for a launch fee above Spore's published maximum (${Number(MAX_LAUNCH_FEE_LAMPORTS) / 1e9} SOL); refusing to build.`);
  return { to: PLATFORM_WALLET, lamports };
}

/// The fee split is derived here from the pinned policy (creator 50 / Spore 50); the server's copy
/// must say the same, address for address and bps for bps, or the launch refuses to build. The
/// server can therefore list, explain and preview the split, but never change where fees go.
export function policyShares(creator: PublicKey, e: Pick<Eligibility, "shares" | "parentCreator" | "grandparentCreator">): Share[] {
  const pkOrNull = (s: string | null | undefined) => { try { return s ? new PublicKey(s) : null; } catch { return null; } };
  const expected = splitShares(creator, pkOrNull(e.parentCreator), pkOrNull(e.grandparentCreator), PLATFORM_WALLET, SPLIT_BPS);
  const key = (a: string, bps: number) => `${a}:${bps}`;
  const want = new Set(expected.map((s) => key(s.address.toBase58(), s.shareBps)));
  const got = new Set((e.shares ?? []).map((s) => key(s.address, s.bps)));
  const same = want.size === got.size && [...want].every((k) => got.has(k));
  if (!same) throw new PolicyError("The server's fee split differs from Spore's published policy (creator 50% / Spore 50%); refusing to build.");
  return expected;
}
export const plainShares = (shares: Share[]) => shares.map((s) => ({ address: s.address.toBase58(), bps: s.shareBps }));

/// Fire-and-forget with one retry: the indexer lists the coin as ours right away (§11.1) and
/// verifies the fee split itself, so a lost report only delays the listing, never the spawn.
/// `sig` is null for a launch the Resume card recovered from the chain without a signature: the
/// server verifies every report against the transaction (§11.1), so such a launch is not reported;
/// the indexer lists it once the fee-sharing config names the platform.
function reportSpawned(mint: string, sig: string | null) {
  if (!sig) return;
  api.spawned(mint, sig).catch(() => new Promise((r) => setTimeout(r, 1500)).then(() => api.spawned(mint, sig)).catch(() => { /* the indexer verifies on-chain anyway */ }));
}

/// True only when the wallet refused before anything could be broadcast: the user pressed Reject,
/// the adapter's sign-only path threw, or no wallet was connected. Kept deliberately narrower than
/// `friendlyError`'s wording heuristics, because the cost of a miss is one stale Resume card while
/// the cost of a false positive is a dropped record for a coin that may already be on-chain.
function isWalletRefusal(e: unknown): boolean {
  const name = (e as { name?: string } | null)?.name ?? "";
  const msg = e instanceof Error ? e.message : String(e);
  return name === "WalletSignTransactionError" || name === "WalletNotConnectedError" || /user rejected|rejected the request|user declined|user cancel|cancell?ed by (the )?user/i.test(msg);
}

const fmtSol = (lamports: bigint | number) => `${(Number(lamports) / 1e9).toLocaleString("en-US", { maximumFractionDigits: 4 })} SOL`;
const fmtUnits = (u: number) => `${Math.round(u / 1000)}k CU`;
const fmtTokens = (raw: bigint, symbol: string) => `${(Number(raw) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 0 })} ${symbol}`;
const shortUri = (u: string) => u.replace(/^https?:\/\//, "").replace(/^(.{22}).+(.{14})$/, "$1…$2");
export const solscanTxUrl = (sig: string) => `https://solscan.io/tx/${sig}`;
const txHref = (sig: string, dry: boolean) => (dry ? undefined : solscanTxUrl(sig));

export async function runSpawn(conn: Connection, signer: Signer, input: SpawnInput, report: Report): Promise<SpawnResult> {
  const creator = signer.publicKey;
  const dry = signer.dry && isDry();
  const { parent, eligibility, form } = input;
  const wantsBuy = input.firstBuyLamports > 0n;
  const launchFee = launchFeeOf(eligibility);
  const st = stepper([
    ["upload", "Upload image and metadata"],
    ["build", launchFee ? `Build the launch transaction · create + fee split + ${fmtSol(launchFee.lamports)} launch fee` : "Build the launch transaction · create + fee split"],
    ["preflight", "Simulate it before you sign"],
    ["sign", "Approve in your wallet"],
    ["split", "Lock the fee split on-chain"],
    ...(wantsBuy ? ([["quote", "Quote your first buy"], ["buy", "Buy from the new curve"]] as [string, string][]) : []),
  ], report);

  // 1. Metadata. Dry runs never touch the host: the URI is a fixed https placeholder.
  st.set("upload", "active", "uploading the image…");
  let uri: string;
  try {
    if (dry) { await drySleep(); uri = DRY_METADATA_URI; st.set("upload", "done", "dry run · fixed metadata URI", uri); }
    else {
      const r = await api.upload(form);
      uri = r.metadataUri;
      st.set("upload", "done", shortUri(uri), uri);
    }
  } catch (e) { st.fail("upload", e); throw e; }

  // 2. Build.
  st.set("build", "active", "resolving the pool and compiling…");
  let built: Awaited<ReturnType<typeof buildSpawnTx>>;
  try {
    const shares = policyShares(creator, eligibility);
    built = await buildSpawnTx(conn, creator, parent ? new PublicKey(parent.mint) : null, { name: form.name, symbol: form.symbol, uri, ...(input.creatorFeeBps ? { creatorFeeBps: input.creatorFeeBps } : {}) }, shares, launchFee);
    const bytes = built.tx.serialize().length;
    st.set("build", "done", `${bytes} bytes · depth ${built.depth} · mint ${built.mint.publicKey.toBase58().slice(0, 6)}…${built.feeTx ? " · fee split in a second transaction" : ""}`);
  } catch (e) { st.fail("build", e); throw e; }

  // 3. Pre-flight: the same bytes the wallet gets, simulated. A failure here never reaches the
  // wallet; a pass tells the exact cost (rent + fees + launch fee) before anything is signed.
  st.set("preflight", "active", "running the transaction on a fork of the chain…");
  let spent: bigint | null = null;
  try {
    const pf = await preflight(conn, built.tx, creator);
    spent = pf.spent;
    st.set("preflight", "done", `passes · ${fmtUnits(pf.unitsConsumed)}${pf.spent !== null ? ` · this signature spends ${fmtSol(pf.spent)}` : ""}`);
  } catch (e) { st.fail("preflight", e); throw e; }

  // 4. Sign + confirm. The record is persisted BEFORE the wallet opens: wallets do sign, broadcast
  // and then reject their promise (RPC timeout, "already processed", a popup closed after approval,
  // a mobile deep link that never returns), and in that case the coin exists on-chain although no
  // signature ever reached this code. The mint is known from the build, so `checkPending` can
  // resolve such a record against the chain; the signature is added the moment the wallet returns it.
  const mint = built.mint.publicKey.toBase58();
  const pending: PendingLaunch = {
    v: 1, mint, sig: null, name: form.name, symbol: form.symbol, image: form.image || null,
    parentMint: parent?.mint ?? null, parentSymbol: parent?.symbol ?? null, depth: built.depth,
    quoteMint: built.quoteMint.toBase58(), quoteTokenProgram: built.quoteTokenProgram.toBase58(), shares: plainShares(policyShares(creator, eligibility)),
    splitIncluded: !built.feeTx, splitSig: null, step: "signing", createdAt: Date.now(),
  };
  if (!dry) savePendingSafe(pending);
  st.set("sign", "active", dry ? "dry run · simulating instead of signing" : "approve the transaction in your wallet…");
  let sig: string;
  try {
    sig = await signer.send(built.tx, "launch", [built.mint], (s) => {
      pending.sig = s; pending.step = "sent";
      if (!dry) savePendingSafe(pending);
      st.note("sign", `sent · waiting for confirmation…`, txHref(s, dry));
    });
    pending.sig = sig; pending.step = "sent";
    st.set("sign", "done", dry ? "simulated · passes" : "confirmed", txHref(sig, dry));
  } catch (e) {
    // A refusal in the wallet never broadcast anything, so its record would only nag. Any other
    // failure may sit on-chain already; the record stays and the Resume card settles it.
    if (!dry && !pending.sig && isWalletRefusal(e)) clearPending();
    st.fail("sign", e);
    // A failure after the wallet returned a signature (expired, unconfirmed, errored on-chain) is
    // only a claim this page's RPC makes; the explorer link lets the user verify it themselves.
    if (pending.sig) st.note("sign", `${friendlyError(e)} · ${pending.sig.slice(0, 8)}…`, txHref(pending.sig, dry));
    throw e;
  }
  if (!dry) reportSpawned(mint, sig);

  const result: SpawnResult = {
    sig, mint, depth: built.depth, name: form.name, symbol: form.symbol, image: form.image || null,
    parent: parent ? { mint: parent.mint, symbol: parent.symbol } : null,
    split: { done: !built.feeTx, sig: built.feeTx ? null : sig, error: null }, buy: null, buyError: null, spent, dry, pending,
  };

  // 5. Fee split. Deep chains need a second transaction; shallow ones carried it in the first. A
  // failure here is NOT a failed launch: the coin exists, the split is retried from the page.
  if (built.feeTx) {
    pending.step = "split-pending";
    if (!dry) savePendingSafe(pending);
    st.set("split", "active", dry ? "dry run · second transaction" : "approve the second transaction in your wallet…");
    try {
      // Dry runs cannot simulate this one: it needs the mint the (unsent) create would have made.
      const s2 = dry ? drySkip(built.feeTx, "fee split") : await signer.send(built.feeTx, "fee split", [], (s) => st.note("split", "sent · waiting for confirmation…", txHref(s, dry)));
      st.set("split", "done", dry ? `dry run · ${built.feeTx.serialize().length} bytes, built; it needs the real mint, so it is validated on an existing coin by test/simulate.mts` : "confirmed", txHref(s2, dry));
      result.split = { done: true, sig: s2, error: null };
    } catch (e) {
      st.fail("split", e);
      result.split = { done: false, sig: null, error: e instanceof Error ? e.message : String(e) };
    }
  } else st.set("split", "done", "included in the launch transaction");
  // A finished launch needs no record; an unfinished split keeps one so a reload can resume it.
  pending.step = result.split.done ? "done" : "split-pending";
  pending.splitSig = result.split.sig;
  if (!dry) { if (result.split.done) clearPending(); else savePendingSafe(pending); }
  if (!wantsBuy) return result;

  // 6. Optional first buy. From here errors are recorded on the result instead of thrown.
  let phase: "quote" | "buy" = "quote";
  try {
    st.set("quote", "active", "simulating the route…");
    if (dry) {
      // The curve exists only after a real launch, so the dry run quotes with pump's curve math.
      const parentChain = parent ? await chainFor(parent) : null;
      const est = await estimateFirstBuy(conn, creator, parent ? new PublicKey(parent.mint) : null, parentChain, input.firstBuyLamports, input.creatorFeeBps);
      st.set("quote", "done", `≈ ${fmtTokens(est.tokens, form.symbol)} for ${fmtSol(input.firstBuyLamports)} (curve math, dry run)`);
      st.set("buy", "done", "dry run · the buy needs the real curve, nothing sent");
      result.buy = null;
      return result;
    }
    const chain: Chain = parent ? chainForChild(mint, parent, await chainFor(parent)) : chainForRoot(mint);
    const q = await quoteSwap(conn, creator, chain, "buy", input.firstBuyLamports);
    st.set("quote", "done", `${fmtTokens(q.amountOut, form.symbol)} for ${fmtSol(input.firstBuyLamports)} · ${chain.length} hop${chain.length === 1 ? "" : "s"}`);
    phase = "buy";
    st.set("buy", "active", "approve the buy in your wallet…");
    const tx = await buildSwapTx(conn, creator, chain, "buy", input.firstBuyLamports, withSlippage(q.amountOut, input.slippageBps));
    const buySig = await signer.send(tx, "first buy", [], (s) => st.note("buy", "sent · waiting for confirmation…", txHref(s, false)));
    st.set("buy", "done", "confirmed", txHref(buySig, false));
    result.buy = { sig: buySig, amountOut: q.amountOut };
  } catch (e) {
    st.fail(phase, e);
    result.buyError = e instanceof Error ? e.message : String(e);
  }
  return result;
}

/// The fee split alone, for a launch whose create landed but whose second transaction did not
/// (or a tab that died in between). Rebuilt from the persisted record: no re-upload, no new mint.
export async function finishFeeSplit(conn: Connection, signer: Signer, p: PendingLaunch, report: Report): Promise<string> {
  const dry = signer.dry && isDry();
  const st = stepper([["build", "Rebuild the fee split"], ["preflight", "Simulate it before you sign"], ["sign", "Approve in your wallet"]], report);
  st.set("build", "active", "compiling…");
  let tx: VersionedTransaction;
  try {
    // Never from the stored record (it could be edited): the split is the pinned policy for the
    // wallet that signs, which must be the coin's creator (the program refuses anyone else).
    const shares = splitShares(signer.publicKey, null, null, PLATFORM_WALLET, SPLIT_BPS);
    tx = await buildFeeSplitTx(conn, signer.publicKey, new PublicKey(p.mint), new PublicKey(p.quoteMint), new PublicKey(p.quoteTokenProgram), shares, false);
    st.set("build", "done", `${tx.serialize().length} bytes · ${shares.length} shareholders`);
  } catch (e) { st.fail("build", e); throw e; }
  st.set("preflight", "active", "running it on a fork of the chain…");
  try {
    const pf = await preflight(conn, tx, signer.publicKey);
    st.set("preflight", "done", `passes · ${fmtUnits(pf.unitsConsumed)}${pf.spent !== null ? ` · spends ${fmtSol(pf.spent)}` : ""}`);
  } catch (e) { st.fail("preflight", e); throw e; }
  st.set("sign", "active", dry ? "dry run · simulating instead of signing" : "approve the transaction in your wallet…");
  try {
    const sig = await signer.send(tx, "fee split", [], (s) => st.note("sign", "sent · waiting for confirmation…", txHref(s, dry)));
    st.set("sign", "done", dry ? "simulated · passes" : "confirmed", txHref(sig, dry));
    if (!dry) clearPending();
    return sig;
  } catch (e) { st.fail("sign", e); throw e; }
}

/// Has the create landed? The bonding curve lives at a PDA of the mint, and the mint was chosen
/// before signing, so the chain answers even when no signature was ever returned.
const curveExists = async (conn: Connection, mint: string) => !!(await conn.getAccountInfo(bondingCurvePda(new PublicKey(mint)), "confirmed"));

/// What a persisted launch looks like now, for the Resume card. A `signing` record (no signature)
/// is settled by looking for the coin's bonding curve; a `sent` one by its signature, with the
/// curve as a second opinion before the record is dropped, since the status this page's RPC
/// reports can lag a transaction the wallet broadcast through its own. A create never seen within
/// its blockhash window expired and the record is dropped. The indexer is told about a launch that
/// landed here, because the normal report in `runSpawn` never ran for it.
export async function checkPending(conn: Connection, p: PendingLaunch): Promise<{ status: "landed" | "expired" | "failed" | "unknown"; p: PendingLaunch }> {
  if (p.step === "split-pending" || p.step === "done") return { status: "landed", p };
  const landed = () => {
    const next: PendingLaunch = { ...p, step: p.splitIncluded ? "done" : "split-pending" };
    // Reported once per record: a concurrent check of the same record (React's dev double mount,
    // a second tab) finds the stored step already advanced and stays quiet.
    const stored = loadPending();
    const reported = stored?.mint === p.mint && (stored.step === "split-pending" || stored.step === "done");
    savePendingSafe(next);
    if (!reported) reportSpawned(p.mint, p.sig);
    return { status: "landed" as const, p: next };
  };
  if (p.sig) {
    // A status call that fails (rate limit, a malformed signature) is not an answer; the curve below is.
    const s = await signatureState(conn, p.sig).catch(() => "unknown" as const);
    if (s === "confirmed") return landed();
    if (s === "failed") { clearPending(); return { status: "failed", p }; }
  }
  // No signature, or one this RPC has not seen: the curve is the ground truth either way.
  if (await curveExists(conn, p.mint)) return landed();
  // Blockhashes live ~60–90 s and the wallet refreshes it when it opens; after a few minutes a
  // create that is neither confirmed nor on-chain can only have expired.
  if (Date.now() - p.createdAt > 5 * 60_000) { clearPending(); return { status: "expired", p }; }
  return { status: "unknown", p };
}

export async function runSwap(conn: Connection, wallet: WalletContextState, chain: Chain, side: Side, amountIn: bigint, amountOutQuoted: bigint, slippageBps: number, report: Report): Promise<{ sig: string; minOut: bigint }> {
  if (!wallet.publicKey) throw new Error("Connect a wallet first");
  const st = stepper([["build", side === "buy" ? "Build the multi-hop buy" : "Build the multi-hop sell"], ["sign", "Sign in your wallet and confirm on-chain"]], report);
  st.set("build", "active");
  const minOut = withSlippage(amountOutQuoted, slippageBps);
  let tx: Awaited<ReturnType<typeof buildSwapTx>>;
  try { tx = await buildSwapTx(conn, wallet.publicKey, chain, side, amountIn, minOut); st.set("build", "done", `${chain.length} hop${chain.length === 1 ? "" : "s"}`); }
  catch (e) { st.fail("build", e); throw e; }
  st.set("sign", "active", "approve in your wallet…");
  try { const sig = await sendAndConfirm(conn, wallet, tx, [], (s) => st.note("sign", "sent · waiting for confirmation…", solscanTxUrl(s))); st.set("sign", "done", "confirmed", solscanTxUrl(sig)); return { sig, minOut }; }
  catch (e) { st.fail("sign", e); throw e; }
}

/// A public key used only as the simulated payer for buy quotes before a wallet is connected
/// (DESIGN.md §9 simulates from the same funded public wallet). Nothing is ever signed with it.
export const QUOTE_PROBE = new PublicKey("FcbEAMqBvJVsfcFWDbED7geyBLR88ypcY88BoUSgmeT5");
