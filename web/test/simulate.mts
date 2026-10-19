// Mainnet simulation of the two flows (nothing is signed or sent): a spawn under a live depth-1
// parent, and a SOL → depth-2 buy. Run: npx tsx test/simulate.mts [parentMint] [coinMint]
import { ComputeBudgetProgram, Connection, PublicKey, TransactionMessage, type VersionedTransaction } from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import BN from "bn.js";
import { OnlinePumpSdk, PUMP_PROGRAM_ID, PUMP_SDK, isBondingCurveMigrated, normalizeQuoteMint, isLegacyQuoteMint } from "@pump-fun/pump-sdk";
import { buildSpawnTx, buildFeeSplitTx, buildSwapTx, compileV0, lookupTables, quoteSwap, splitShares, hopsFor, type Chain } from "../src/lib/pump/index.ts";

const RPC = process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com";
const PROBE = new PublicKey("dBs75Gf7RXQMAsMLuTLYdH2fHV1ac9zgCEh6zC7TxXs"); // a funded public wallet; only its pubkey is used
const PARENT = new PublicKey(process.argv[2] ?? "8M8hAuusNmKg6dEwCr7cHmHcaBwdJbPDxM5vEGAapump"); // depth-1, SOL-rooted (per server report)
const COIN = new PublicKey(process.argv[3] ?? "GtsYUp4Gxbyag3c1So1jvfPu54AdU47HGeySBQEvpump"); // depth-2 'ponzi', migrated, SOL root
const conn = new Connection(RPC, "confirmed");
const online = new OnlinePumpSdk(conn);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/// Runs the transaction on the node and reports; `code` is pump's custom error when it failed with
/// one, so a case can assert a specific refusal.
async function simulate(label: string, tx: VersionedTransaction, expectCode?: number): Promise<{ ok: boolean; code: number | null }> {
  const sim = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" });
  const logs = sim.value.logs ?? [];
  const bytes = tx.serialize().length;
  const custom = logs.join("\n").match(/custom program error: 0x([0-9a-f]+)/i);
  const code = custom ? parseInt(custom[1], 16) : null;
  const expected = expectCode !== undefined && code === expectCode;
  console.log(`\n[${label}] bytes=${bytes} accounts=${tx.message.staticAccountKeys.length} units=${sim.value.unitsConsumed} err=${sim.value.err ? JSON.stringify(sim.value.err) : "none"} ${custom?.[0] ?? ""}${expected ? " (expected)" : ""}`);
  if (sim.value.err && !expected) console.log(logs.slice(-12).join("\n"));
  return { ok: !sim.value.err, code };
}

/// The Chain the UI would hand the library, derived from live accounts via the SDK.
async function chainOf(mint: PublicKey): Promise<Chain> {
  const q = await online.fetchPumpQuote(mint);
  if (!q) throw new Error("not a pump coin");
  const coins = [q.curve, ...(q.curve.chain ?? [])];
  const programOf = async (m: PublicKey) => (isLegacyQuoteMint(m) ? TOKEN_PROGRAM_ID : (await conn.getAccountInfo(m))!.owner);
  const out: Chain = [];
  for (const c of coins) {
    const quote = c.bondingCurve.quoteMint;
    const sol = isLegacyQuoteMint(quote) || normalizeQuoteMint(quote).equals(normalizeQuoteMint(new PublicKey(0)));
    out.push({ mint: c.mint.toBase58(), quoteMint: sol ? null : quote.toBase58(), tokenProgram: (await programOf(c.mint)).toBase58(), quoteTokenProgram: (await programOf(quote)).toBase58(), migrated: isBondingCurveMigrated(c.bondingCurve), depth: c.bondingCurve.depth });
    await sleep(150);
  }
  return out;
}

/// The SDK's own simulation of the same route (token-balance delta, or the final curve hop's
/// TradeEvent): the independent reference a quote must match to the lamport.
async function referenceQuote(user: PublicKey, chain: Chain, side: "buy" | "sell", amountIn: bigint): Promise<bigint> {
  const ref = await online.simulateMultiHopSwap({ user, hops: hopsFor(chain, side), side, amountIn: new BN(amountIn.toString()), addressLookupTables: await lookupTables(conn) });
  return BigInt(ref.toString());
}
const fmtChain = (chain: Chain) => chain.map((l) => `${l.mint.slice(0, 6)}… d${l.depth} ${l.migrated ? "pool" : "curve"}`).join(" ← ");

let ok = true;
// 1. Spawn under PARENT with the default split.
try {
  const parentCurve = await online.fetchBondingCurve(PARENT);
  const grand = parentCurve.depth > 0 ? (await online.fetchBondingCurve(parentCurve.quoteMint)).creator : null;
  const shares = splitShares(PROBE, parentCurve.creator, grand, PROBE);
  console.log("shares:", shares.map((s) => `${s.address.toBase58().slice(0, 6)}…:${s.shareBps}`).join(" "));
  const built = await buildSpawnTx(conn, PROBE, PARENT, { name: "Spore Test", symbol: "SPORET", uri: "https://ipfs.io/ipfs/bafkreigexample" }, shares);
  console.log(`spawn depth=${built.depth} mint=${built.mint.publicKey.toBase58()} split=${built.feeTx ? `second tx (${built.feeTx.serialize().length} bytes, sweep first)` : "same tx"}`);
  ok = (await simulate(built.feeTx ? "spawn create (tx 1 of 2)" : "spawn create+split", built.tx)).ok && ok;
  if (built.feeTx) console.log("fee split goes in a second transaction (needs tx 1 landed; validated below on existing coins)");
} catch (e) { ok = false; console.log("spawn FAILED:", (e as Error).message); }

// 1a. A root coin (SOL quote) with the same split and a 0.02 SOL launch fee to the platform.
try {
  const built = await buildSpawnTx(conn, PROBE, null, { name: "Spore Root", symbol: "SROOT", uri: "https://ipfs.io/ipfs/bafkreigexample" }, splitShares(PROBE, null, null, new PublicKey("FcbEAMqBvJVsfcFWDbED7geyBLR88ypcY88BoUSgmeT5")), { to: new PublicKey("FcbEAMqBvJVsfcFWDbED7geyBLR88ypcY88BoUSgmeT5"), lamports: 20_000_000n });
  console.log(`\nroot launch mint=${built.mint.publicKey.toBase58()} split=${built.feeTx ? "second tx" : "same tx"}`);
  ok = (await simulate("root launch (SOL) + split + launch fee", built.tx)).ok && ok;
  if (built.feeTx) ok = (await simulate("root split (tx 2)", built.feeTx)).ok && ok;
} catch (e) { ok = false; console.log("root launch FAILED:", (e as Error).message); }

// 1b. The fee split, validated on an existing pump-quoted coin that has no sharing config yet, with
// its real creator as the simulated signer (sigVerify is off; nothing is sent).
try {
  // A depth-1 coin that is not a holder-reward coin (those have a PDA creator that can never sign)
  // and whose creator wallet holds SOL for the config's rent.
  const SUBJECT = new PublicKey(process.argv[4] ?? "2uprf2a8svwhjztyKLDpMNiwQcXHa25sNbNnWeo5pump");
  const curve = await online.fetchBondingCurve(SUBJECT);
  const rootCurve = await online.fetchBondingCurve(curve.quoteMint);
  const quoteProgram = (await conn.getAccountInfo(curve.quoteMint))!.owner;
  const balance = await conn.getBalance(curve.creator);
  console.log(`\nsplit subject ${SUBJECT.toBase58().slice(0, 8)}… creator ${curve.creator.toBase58().slice(0, 8)}… balance ${balance / 1e9} SOL quote program ${quoteProgram.toBase58().slice(0, 8)}… creator-fee bucket ${curve.creatorFee.toString()}`);
  const tx = await buildFeeSplitTx(conn, curve.creator, SUBJECT, curve.quoteMint, quoteProgram, splitShares(curve.creator, rootCurve.creator, null, PROBE), curve.complete);
  ok = (await simulate("fee split on existing coin (sweep + vault ATA + config + split)", tx)).ok && ok;
} catch (e) { ok = false; console.log("fee split FAILED:", (e as Error).message); }

// 1c. A trade lands between the create and the split (what snipers do to every new coin): in one
// simulated transaction the probe buys 0.001 SOL of a SOL-quoted root that has no sharing config,
// then its creator locks the split. Without the sweep pump refuses the config (6095
// CreatorFeesNotSwept, the fees in the bucket belong to the creator the curve still has); with the
// sweep first, as buildFeeSplitTx and the spawn's second transaction send it, it passes.
try {
  const ROOT = new PublicKey(process.argv[7] ?? "9L4yqKhJSr1eFUTT9vJDLhe41ZS5WPAhmGHQEtL1pump"); // 'Lamport', depth 0, no config
  const curve = await online.fetchBondingCurve(ROOT);
  const tokenProgram = (await conn.getAccountInfo(ROOT))!.owner;
  const chain: Chain = [{ mint: ROOT.toBase58(), quoteMint: null, tokenProgram: tokenProgram.toBase58(), quoteTokenProgram: TOKEN_PROGRAM_ID.toBase58(), migrated: isBondingCurveMigrated(curve), depth: curve.depth }];
  const buy = await PUMP_SDK.multiHopSwapInstructions({ user: PROBE, hops: hopsFor(chain, "buy"), side: "buy", amountIn: new BN(1_000_000), minAmountOut: new BN(1) });
  const splitTx = await buildFeeSplitTx(conn, curve.creator, ROOT, NATIVE_MINT, TOKEN_PROGRAM_ID, splitShares(curve.creator, null, null, PROBE), curve.complete);
  const tables = await lookupTables(conn);
  // The builder's instructions minus its compute budget; the sweep is its only pump-program one.
  const splitIxs = TransactionMessage.decompile(splitTx.message, { addressLookupTableAccounts: tables }).instructions.filter((ix) => !ix.programId.equals(ComputeBudgetProgram.programId));
  const noSweep = splitIxs.filter((ix) => !ix.programId.equals(PUMP_PROGRAM_ID));
  if (noSweep.length !== splitIxs.length - 1) throw new Error("expected exactly one sweep instruction in the split");
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  const budget = ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 });
  console.log(`\ntrade-then-split subject ${ROOT.toBase58().slice(0, 8)}… creator ${curve.creator.toBase58().slice(0, 8)}… bucket before ${curve.creatorFee.toString()} (payer: probe, authority: creator; two signers, unchecked)`);
  const without = await simulate("buy 0.001 SOL, then config + split WITHOUT a sweep", compileV0(PROBE, blockhash, [budget, ...buy, ...noSweep], tables), 6095);
  if (without.code !== 6095) { ok = false; console.log(`expected 6095 CreatorFeesNotSwept, got ${without.code ?? "no custom error"}`); }
  ok = (await simulate("buy 0.001 SOL, then sweep + config + split", compileV0(PROBE, blockhash, [budget, ...buy, ...splitIxs], tables))).ok && ok;
} catch (e) { ok = false; console.log("trade-then-split FAILED:", (e as Error).message); }

// 2. Buy COIN from SOL and a sell of what the probe holds (if any).
try {
  const chain = await chainOf(COIN);
  console.log("\nchain:", fmtChain(chain), "| hops:", hopsFor(chain, "buy").length);
  const q = await quoteSwap(conn, PROBE, chain, "buy", 10_000_000n);
  const ref = await referenceQuote(PROBE, chain, "buy", 10_000_000n);
  console.log(`buy quote: 0.01 SOL → ${Number(q.amountOut) / 1e6} tokens, units=${q.unitsConsumed}; SDK reference ${Number(ref) / 1e6} (diff ${q.amountOut - ref})`);
  if (q.amountOut !== ref) { ok = false; console.log("buy quote MISMATCH with the SDK's simulation"); }
  const minOut = (q.amountOut * 97n) / 100n;
  ok = (await simulate("multi-hop buy", await buildSwapTx(conn, PROBE, chain, "buy", 10_000_000n, minOut))).ok && ok;
} catch (e) { ok = false; console.log("buy FAILED:", (e as Error).message); }

/// Token balance of `owner` in `mint`, 0n when the account does not exist.
async function heldBy(mint: PublicKey, owner: PublicKey, tokenProgram: PublicKey): Promise<bigint> {
  try { return BigInt((await conn.getTokenAccountBalance(getAssociatedTokenAddressSync(mint, owner, true, tokenProgram))).value.amount); } catch { return 0n; }
}
/// A wallet (on-curve owner) among the coin's largest holders — on a paid RPC getTokenLargestAccounts
/// works, so the suite no longer depends on a hard-coded holder that may have sold. With `needWsol`
/// the wallet must also keep a funded WSOL account (case 3a); null when none qualifies.
async function pickHolder(mint: PublicKey, needWsol = false): Promise<PublicKey | null> {
  let largest: Awaited<ReturnType<typeof conn.getTokenLargestAccounts>>;
  try { largest = await conn.getTokenLargestAccounts(mint, "confirmed"); } catch { return null; }
  const infos = await conn.getMultipleParsedAccounts(largest.value.map((v) => v.address), "confirmed");
  for (let i = 0; i < infos.value.length; i++) {
    const data = infos.value[i]?.data as { parsed?: { info?: { owner?: string } } } | undefined;
    const owner = data?.parsed?.info?.owner;
    if (!owner || BigInt(largest.value[i].amount) <= 0n) continue;
    const o = new PublicKey(owner);
    if (!PublicKey.isOnCurve(o.toBytes())) continue;
    if (needWsol) { const w = await conn.getAccountInfo(getAssociatedTokenAddressSync(NATIVE_MINT, o, true, TOKEN_PROGRAM_ID), "confirmed"); if (!w || w.lamports <= 2_039_280) continue; }
    return o;
  }
  return null;
}

// 3. Sell from a real holder (simulated signer): a wallet that bought a migrated depth-1 coin under
// a SOL root. The given holder is used while it still holds; otherwise the largest wallet holder.
try {
  const SELL_COIN = new PublicKey(process.argv[5] ?? "3ZvEeeLxo55nKRwHywyxqBpKVouRV4gARNDUCQpapump");
  const chain = await chainOf(SELL_COIN);
  const tokenProgram = new PublicKey(chain[0].tokenProgram);
  let HOLDER = new PublicKey(process.argv[6] ?? "2orGyHSpmFernWiAXRPRVAVDzWoKbwBvWV6vbBGGEm2b");
  let held = await heldBy(SELL_COIN, HOLDER, tokenProgram);
  if (held === 0n) { const h = await pickHolder(SELL_COIN); if (!h) throw new Error("no wallet holder found for the sell case"); HOLDER = h; held = await heldBy(SELL_COIN, HOLDER, tokenProgram); }
  const amount = held < 1_000_000_000n ? held : 1_000_000_000n;
  console.log(`\nsell chain: ${fmtChain(chain)} | holder ${HOLDER.toBase58().slice(0, 8)}… holds ${Number(held) / 1e6}`);
  const sq = await quoteSwap(conn, HOLDER, chain, "sell", amount);
  const ref = await referenceQuote(HOLDER, chain, "sell", amount);
  console.log(`sell quote: ${Number(amount) / 1e6} tokens → ${Number(sq.amountOut) / 1e9} SOL, units=${sq.unitsConsumed}; SDK reference ${Number(ref) / 1e9} (diff ${sq.amountOut - ref})`);
  if (sq.amountOut !== ref) { ok = false; console.log("sell quote MISMATCH with the SDK's simulation"); }
  ok = (await simulate("multi-hop sell", await buildSwapTx(conn, HOLDER, chain, "sell", amount, (sq.amountOut * 97n) / 100n))).ok && ok;
} catch (e) { ok = false; console.log("sell FAILED:", (e as Error).message); }

// 3a. The same from a holder who keeps a funded WSOL account. The route closes that account into
// the wallet, so a quote measured as the wallet's lamport delta would count its rent and wrapped
// balance as proceeds (7.35 SOL "for" a 0.013 SOL sell was measured before the fix) and the sell
// would fail its own min_amount_out. The quote must equal the SDK's reference and report the
// unwrapped lamports separately; the sell at 1% slippage must pass.
try {
  const WSOL_COIN = new PublicKey(process.argv[9] ?? "BsbsB3WLq7vbY5En3MBCAsTrcwaCxNKY2Mp5pGuLpump"); // $GTA, depth 0, migrated (pool end)
  const chain = await chainOf(WSOL_COIN);
  const tokenProgram = new PublicKey(chain[0].tokenProgram);
  let WSOL_HOLDER = new PublicKey(process.argv[8] ?? "H9kuqGKNYgPFYCA17uUTkaqXGum7MK8y1GwbS7cxsjDg");
  let held = await heldBy(WSOL_COIN, WSOL_HOLDER, tokenProgram);
  if (held === 0n) { const h = (await pickHolder(WSOL_COIN, true)) ?? (await pickHolder(WSOL_COIN)); if (!h) throw new Error("no wallet holder found for the WSOL case"); WSOL_HOLDER = h; held = await heldBy(WSOL_COIN, WSOL_HOLDER, tokenProgram); }
  const wsol = await conn.getAccountInfo(getAssociatedTokenAddressSync(NATIVE_MINT, WSOL_HOLDER, true, TOKEN_PROGRAM_ID), "confirmed");
  const amount = held < 1_000_000_000n ? held : 1_000_000_000n;
  console.log(`\nsell chain: ${fmtChain(chain)} | holder ${WSOL_HOLDER.toBase58().slice(0, 8)}… holds ${Number(held) / 1e6}, WSOL account ${wsol ? `${wsol.lamports} lamports` : "none (pick a holder with one: this case then only checks the reference)"}`);
  const sq = await quoteSwap(conn, WSOL_HOLDER, chain, "sell", amount);
  const ref = await referenceQuote(WSOL_HOLDER, chain, "sell", amount);
  console.log(`sell quote: ${Number(amount) / 1e6} tokens → ${Number(sq.amountOut) / 1e9} SOL, unwrapped=${sq.unwrapped}; SDK reference ${Number(ref) / 1e9} (diff ${sq.amountOut - ref})`);
  if (sq.amountOut !== ref) { ok = false; console.log("sell quote MISMATCH with the SDK's simulation"); }
  if (sq.unwrapped !== BigInt(wsol?.lamports ?? 0)) { ok = false; console.log("unwrapped lamports MISMATCH with the WSOL account"); }
  ok = (await simulate("multi-hop sell from a WSOL holder, 1% slippage", await buildSwapTx(conn, WSOL_HOLDER, chain, "sell", amount, (sq.amountOut * 99n) / 100n))).ok && ok;
} catch (e) { ok = false; console.log("WSOL-holder sell FAILED:", (e as Error).message); }

console.log(ok ? "\nALL SIMULATIONS OK" : "\nSOME SIMULATIONS FAILED");
process.exit(ok ? 0 : 1);
