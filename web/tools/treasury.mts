// Spore treasury: finds every coin whose fee-sharing config pays the platform wallet (scanned on-chain,
// no database needed), shows the creator fees waiting in each coin's vaults, distributes them
// (permissionless; the platform's 50% lands in its own token/SOL account) and sells collected parent
// tokens back to SOL through the same multi-hop route the site uses. Dry by default: nothing is sent
// without --send. Run from web/:
//   node --import ./test/cjs-sdk-hook.mjs --import tsx tools/treasury.mts list
//   node --import ./test/cjs-sdk-hook.mjs --import tsx tools/treasury.mts claim [--min 0.001] [--send]
//   node --import ./test/cjs-sdk-hook.mjs --import tsx tools/treasury.mts sell <mint> [--amount <tokens>] [--send]
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, VersionedTransaction, type TransactionInstruction } from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { OnlinePumpSdk, PUMP_SDK, PUMP_FEE_PROGRAM_ID, PUMP_PROGRAM_ID, bondingCurvePda, creatorVaultPda, ammCreatorVaultPda, feeSharingConfigPda, isBondingCurveMigrated, isLegacyQuoteMint, normalizeQuoteMint } from "@pump-fun/pump-sdk";
import { buildSwapTx, quoteSwap, compileV0, lookupTables, txBytes, type Chain } from "../src/lib/pump/index.ts";
import bs58 from "bs58";

const [cmd = "list", ...rest] = process.argv.slice(2);
const arg = (k: string, d?: string) => { const i = rest.indexOf(`--${k}`); return i >= 0 ? rest[i + 1] : d; };
const send = rest.includes("--send");
const conn = new Connection(process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com", "confirmed");
const online = new OnlinePumpSdk(conn);
const wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.env.WALLET ?? `${homedir()}/.config/solana/spore-dev.json`, "utf8"))));
// --platform <pubkey> scans another shareholder (dry runs only): lets the claim path be rehearsed on
// coins that pay someone else before Spore has coins of its own.
const PLATFORM = arg("platform") && !send ? new PublicKey(arg("platform")!) : wallet.publicKey; // whose shares to scan
const PAYER = wallet.publicKey;                                                                   // who signs and pays
const LIMIT = Number(arg("limit", "1000"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fmt = (raw: bigint, dec: number) => (Number(raw) / 10 ** dec).toLocaleString("en-US", { maximumFractionDigits: dec > 6 ? 6 : 3 });

// SharingConfig: 8 disc + bump 1 + version 1 + status 1 + mint 32 + admin 32 + admin_revoked 1 + vec len 4
// → shareholder[0].address at 80, [1].address at 114 (each shareholder = 32 + 2 bytes).
const SHARING_DISC = Buffer.from([216, 74, 9, 0, 56, 140, 93, 75]);
async function ourConfigs() {
  const found = new Map<string, { address: PublicKey; config: ReturnType<typeof PUMP_SDK.decodeSharingConfig> }>();
  for (const offset of [114, 80]) {
    const res = await conn.getProgramAccounts(PUMP_FEE_PROGRAM_ID, { filters: [{ memcmp: { offset: 0, bytes: bs58.encode(SHARING_DISC) } }, { memcmp: { offset, bytes: PLATFORM.toBase58() } }] });
    for (const r of res) { const config = PUMP_SDK.decodeSharingConfig(r.account); if (config.shareholders.some((s) => s.address.equals(PLATFORM))) found.set(r.pubkey.toBase58(), { address: r.pubkey, config }); }
    await sleep(300);
  }
  return [...found.values()];
}

type Pending = { mint: PublicKey; sharing: PublicKey; config: ReturnType<typeof PUMP_SDK.decodeSharingConfig>; quoteMint: PublicKey; quoteProgram: PublicKey; decimals: number; migrated: boolean; bucket: bigint; vault: bigint; ammVault: bigint; ourBps: number };
async function pending(): Promise<Pending[]> {
  const out: Pending[] = [];
  for (const { address, config } of (await ourConfigs()).slice(0, LIMIT)) {
    const mint = config.mint;
    const curveInfo = await conn.getAccountInfo(bondingCurvePda(mint));
    if (!curveInfo) continue;
    const curve = PUMP_SDK.decodeBondingCurve(curveInfo);
    const sol = isLegacyQuoteMint(curve.quoteMint);
    const quoteMint = normalizeQuoteMint(curve.quoteMint);
    const quoteProgram = sol ? TOKEN_PROGRAM_ID : (await conn.getAccountInfo(quoteMint))!.owner;
    const decimals = sol ? 9 : 6;
    const vaultPda = creatorVaultPda(address);
    const ammPda = ammCreatorVaultPda(address);
    const bal = async (owner: PublicKey) => {
      if (sol) { const lam = await conn.getBalance(owner); return BigInt(lam); }
      const ata = getAssociatedTokenAddressSync(quoteMint, owner, true, quoteProgram);
      return BigInt((await conn.getTokenAccountBalance(ata).catch(() => ({ value: { amount: "0" } }))).value.amount);
    };
    const migrated = isBondingCurveMigrated(curve);
    const vault = await bal(vaultPda);
    const ammVault = migrated ? await bal(ammPda) : 0n;
    const ourBps = config.shareholders.find((s) => s.address.equals(PLATFORM))!.shareBps;
    out.push({ mint, sharing: address, config, quoteMint, quoteProgram, decimals, migrated, bucket: BigInt(curve.creatorFee.toString()), vault, ammVault, ourBps });
    await sleep(250);
  }
  return out;
}

async function sim(label: string, ixs: TransactionInstruction[], signers: Keypair[]) {
  const [{ blockhash, lastValidBlockHeight }, tables] = await Promise.all([conn.getLatestBlockhash("confirmed"), lookupTables(conn)]);
  const tx = compileV0(PAYER, blockhash, [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }), ...ixs], tables);
  tx.sign(signers);
  const s = await conn.simulateTransaction(tx, { sigVerify: true, commitment: "confirmed" });
  console.log(`  [${label}] bytes=${txBytes(tx)} units=${s.value.unitsConsumed} ${s.value.err ? "FAILED " + JSON.stringify(s.value.err) : "ok"}`);
  if (s.value.err) { console.log("   " + (s.value.logs ?? []).slice(-6).join("\n   ")); return null; }
  if (!send) return "dry";
  const sig = await conn.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
  for (;;) { const st = (await conn.getSignatureStatuses([sig])).value[0]; if (st?.err) throw new Error(`${label} failed: ${JSON.stringify(st.err)}`); if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") break; if ((await conn.getBlockHeight("confirmed")) > lastValidBlockHeight && !st) throw new Error("expired"); await sleep(1200); }
  console.log(`   landed https://solscan.io/tx/${sig}`);
  return sig;
}

if (cmd === "list" || cmd === "claim") {
  console.log(`scanning shares of ${PLATFORM.toBase58()} · payer ${PAYER.toBase58()} balance ${(await conn.getBalance(PAYER)) / 1e9} SOL${send ? "" : " (dry run)"}`);
  const rows = await pending();
  if (!rows.length) console.log("no coins pay the platform yet");
  const minQuote = Number(arg("min", "0"));
  for (const r of rows) {
    const total = r.bucket + r.vault + r.ammVault;
    const ours = (total * BigInt(r.ourBps)) / 10_000n;
    const unit = r.quoteMint.equals(NATIVE_MINT) ? "SOL" : r.quoteMint.toBase58().slice(0, 6) + "…";
    console.log(`\n${r.mint.toBase58()} ${r.migrated ? "pool" : "curve"} quote ${unit} share ${r.ourBps / 100}% | curve bucket ${fmt(r.bucket, r.decimals)} · vault ${fmt(r.vault, r.decimals)} · amm ${fmt(r.ammVault, r.decimals)} → ours ≈ ${fmt(ours, r.decimals)} ${unit}`);
    if (cmd !== "claim") continue;
    if (Number(total) / 10 ** r.decimals < minQuote) { console.log("  below --min, skipped"); continue; }
    const ixs: TransactionInstruction[] = [];
    if (r.bucket > 0n) ixs.push(await PUMP_SDK.sweepCreatorFeeInstruction({ payer: PAYER, mint: r.mint, creator: r.sharing, quoteMint: r.quoteMint, quoteTokenProgram: r.quoteProgram }));
    if (r.migrated) {
      ixs.push(await PUMP_SDK.sweepPoolCreatorFeeInstruction({ payer: PAYER, mint: r.mint, coinCreator: r.sharing, quoteMint: r.quoteMint, quoteTokenProgram: r.quoteProgram }));
      ixs.push(await PUMP_SDK.transferCreatorFeesToPumpV2({ payer: PAYER, mint: r.mint, quoteMint: r.quoteMint, quoteTokenProgram: r.quoteProgram }));
    }
    ixs.push(await PUMP_SDK.distributeCreatorFeesV2({ mint: r.mint, sharingConfig: r.config, sharingConfigAddress: r.sharing, quoteMint: r.quoteMint, payer: PAYER, shouldInitializeAta: true, quoteTokenProgram: r.quoteProgram }));
    await sim(`claim ${r.mint.toBase58().slice(0, 8)}`, ixs, [wallet]);
    await sleep(500);
  }
} else if (cmd === "sell") {
  const mint = new PublicKey(rest[0]);
  const q = await online.fetchPumpQuote(mint);
  if (!q) throw new Error("not a pump coin");
  const coins = [q.curve, ...(q.curve.chain ?? [])];
  const programOf = async (m: PublicKey) => (isLegacyQuoteMint(m) ? TOKEN_PROGRAM_ID : (await conn.getAccountInfo(m))!.owner);
  const chain: Chain = [];
  for (const c of coins) { const qm = c.bondingCurve.quoteMint; chain.push({ mint: c.mint.toBase58(), quoteMint: isLegacyQuoteMint(qm) ? null : qm.toBase58(), tokenProgram: (await programOf(c.mint)).toBase58(), quoteTokenProgram: (await programOf(qm)).toBase58(), migrated: isBondingCurveMigrated(c.bondingCurve), depth: c.bondingCurve.depth }); }
  const ata = getAssociatedTokenAddressSync(mint, PAYER, true, new PublicKey(chain[0].tokenProgram));
  const held = BigInt((await conn.getTokenAccountBalance(ata).catch(() => ({ value: { amount: "0" } }))).value.amount);
  const amount = arg("amount") ? BigInt(Math.round(Number(arg("amount")) * 1e6)) : held;
  console.log(`platform holds ${fmt(held, 6)} of ${mint.toBase58().slice(0, 8)}…; selling ${fmt(amount, 6)} via ${chain.length} hop(s)${send ? "" : " (dry run)"}`);
  if (amount <= 0n) process.exit(0);
  const quote = await quoteSwap(conn, PAYER, chain, "sell", amount);
  console.log(`quote → ${fmt(quote.amountOut, 9)} SOL (${quote.unitsConsumed} CU)`);
  const tx: VersionedTransaction = await buildSwapTx(conn, PAYER, chain, "sell", amount, (quote.amountOut * 97n) / 100n);
  tx.sign([wallet]);
  const s = await conn.simulateTransaction(tx, { sigVerify: true, commitment: "confirmed" });
  console.log(`  [sell] bytes=${txBytes(tx)} units=${s.value.unitsConsumed} ${s.value.err ? "FAILED " + JSON.stringify(s.value.err) : "ok"}`);
  if (!s.value.err && send) { const sig = await conn.sendRawTransaction(tx.serialize(), { maxRetries: 3 }); console.log(`   sent https://solscan.io/tx/${sig}`); }
} else { console.error("commands: list | claim [--min x] [--send] | sell <mint> [--amount n] [--send]"); process.exit(2); }
