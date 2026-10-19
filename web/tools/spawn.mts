// Launches a coin through the same builders the site uses (lib/pump), signed with a local keypair:
// a root coin quoted in SOL, or a child spawned under a parent pump coin, always with the Spore
// fee split so the coin counts as "ours". Run from web/ so node_modules resolve:
//   cd web && node --import ./test/cjs-sdk-hook.mjs --import tsx tools/spawn.mts \
//     --parent <mint|sol> --name "Name" --symbol TICK --image ./logo.png [--desc "..."] [--buy 0.05] [--dry]
// Metadata is published to our own host first (tools/publish-meta.mjs, Cloudflare Pages)
// does on Solana; pass --uri <https://...json> to reuse an already published file.
// Env: WALLET (keypair json, default ~/.config/solana/spore-dev.json), RPC_URL, API (default http://127.0.0.1:8793),
//      PLATFORM_WALLET (default FcbEAMqBvJVsfcFWDbED7geyBLR88ypcY88BoUSgmeT5). The secret key is never printed.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { Connection, Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, NATIVE_MINT } from "@solana/spl-token";
import BN from "bn.js";
import { OnlinePumpSdk, PUMP_SDK, isBondingCurveMigrated, isLegacyQuoteMint } from "@pump-fun/pump-sdk";
import { buildSpawnTx, buildSwapTx, quoteSwap, splitShares, compileV0, lookupTables, txBytes, MAX_TX_BYTES, type Chain } from "../src/lib/pump/index.ts";
import { ComputeBudgetProgram } from "@solana/web3.js";

const arg = (k: string, d?: string) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
const flag = (k: string) => process.argv.includes(`--${k}`);
const RPC = process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com";
const API = process.env.API ?? "http://127.0.0.1:8793";
const PLATFORM = new PublicKey(process.env.PLATFORM_WALLET ?? "FcbEAMqBvJVsfcFWDbED7geyBLR88ypcY88BoUSgmeT5");
const parentArg = arg("parent", "sol")!; const name = arg("name"); const symbol = arg("symbol"); const image = arg("image"); const desc = arg("desc", "") ?? "";
const buySol = Number(arg("buy", "0")); const dry = flag("dry"); const uriArg = arg("uri");
if (!name || !symbol || !image) { console.error("need --name --symbol --image"); process.exit(2); }

const wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.env.WALLET ?? `${homedir()}/.config/solana/spore-dev.json`, "utf8"))));
const conn = new Connection(RPC, "confirmed");
const online = new OnlinePumpSdk(conn);
// A dry run simulates from a funded public wallet (nothing is signed), so the wiring can be checked
// before the real wallet holds any SOL.
const PROBE = new PublicKey("dBs75Gf7RXQMAsMLuTLYdH2fHV1ac9zgCEh6zC7TxXs");
const me = dry ? PROBE : wallet.publicKey;
console.log(`wallet ${wallet.publicKey.toBase58()} balance ${(await conn.getBalance(wallet.publicKey)) / 1e9} SOL${dry ? ` (dry run: simulating as ${PROBE.toBase58().slice(0, 6)}…, nothing signed or sent)` : ""}`);

// 1. Metadata on our own host (content-addressed, immutable), published by tools/publish-meta.mjs.
let metadataUri = uriArg ?? "";
if (!metadataUri) {
  const { execFileSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");
  const publisher = join(dirname(fileURLToPath(import.meta.url)), "../../tools/publish-meta.mjs");
  metadataUri = execFileSync("node", [publisher, "--image", image, "--name", name, "--symbol", symbol, "--desc", desc], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], timeout: 240_000 }).trim();
}
// This Mac's network blocks *.pages.dev TLS (verified from an external host instead), so a network
// error here is a warning; an HTTP error (404/5xx) still stops the launch.
try {
  const check = await fetch(metadataUri, { signal: AbortSignal.timeout(15_000) });
  if (!check.ok) throw new Error(`metadata not reachable: ${metadataUri} (${check.status})`);
} catch (e) { if (e instanceof Error && /not reachable/.test(e.message)) throw e; console.warn(`warning: could not verify ${metadataUri} from this network (${(e as Error).message.slice(0, 60)})`); }
const upj = { metadataUri };
console.log(`metadata ${metadataUri}`);

const send = async (label: string, tx: VersionedTransaction, signers: Keypair[]) => {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  tx.message.recentBlockhash = blockhash;
  if (!dry) tx.sign(signers);
  const sim = await conn.simulateTransaction(tx, { sigVerify: !dry, replaceRecentBlockhash: dry, commitment: "confirmed" });
  console.log(`[${label}] bytes=${txBytes(tx)} units=${sim.value.unitsConsumed} simulation=${sim.value.err ? JSON.stringify(sim.value.err) : "ok"}`);
  if (sim.value.err) { console.log((sim.value.logs ?? []).slice(-14).join("\n")); throw new Error(`${label}: simulation failed`); }
  if (dry) return null;
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
  for (;;) {
    const st = (await conn.getSignatureStatuses([sig])).value[0];
    if (st?.err) throw new Error(`${label} failed on-chain: ${JSON.stringify(st.err)} ${sig}`);
    if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) break;
    if ((await conn.getBlockHeight("confirmed")) > lastValidBlockHeight && !st) throw new Error(`${label} expired before landing`);
    await new Promise((r) => setTimeout(r, 1200));
  }
  console.log(`[${label}] landed https://solscan.io/tx/${sig}`);
  return sig;
};

let mint: Keypair; let chain: Chain;
if (parentArg.toLowerCase() === "sol") {
  // Root coin: plain create_v2 (SOL quote) plus the Spore split (creator 85 / platform 15).
  mint = Keypair.generate();
  const create = await PUMP_SDK.createV2Instruction({ mint: mint.publicKey, name, symbol, uri: upj.metadataUri, creator: me, user: me, mayhemMode: false, holderReward: false });
  const config = await PUMP_SDK.createFeeSharingConfig({ creator: me, mint: mint.publicKey, pool: null });
  const split = await PUMP_SDK.updateFeeSharesV2({ authority: me, mint: mint.publicKey, currentShareholders: [me], newShareholders: splitShares(me, null, null, PLATFORM), quoteMint: NATIVE_MINT, quoteTokenProgram: TOKEN_PROGRAM_ID, bondingCurveComplete: false });
  const [{ blockhash }, tables] = await Promise.all([conn.getLatestBlockhash("confirmed"), lookupTables(conn)]);
  const cu = [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 })];
  let tx = compileV0(me, blockhash, [...cu, create, config, split], tables);
  let feeTx: VersionedTransaction | null = null;
  const n = txBytes(tx);
  if (n === null || n > MAX_TX_BYTES) { tx = compileV0(me, blockhash, [...cu, create], tables); feeTx = compileV0(me, blockhash, [...cu, config, split], tables); }
  console.log(`root coin mint ${mint.publicKey.toBase58()} split=${feeTx ? "second tx" : "same tx"}`);
  await send("create root", tx, [wallet, mint]);
  if (feeTx) await send("fee split", feeTx, [wallet]);
  chain = [{ mint: mint.publicKey.toBase58(), quoteMint: null, tokenProgram: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", quoteTokenProgram: TOKEN_PROGRAM_ID.toBase58(), migrated: false, depth: 0 }];
} else {
  const parent = new PublicKey(parentArg);
  const pc = await online.fetchBondingCurve(parent);
  const gp = pc.depth > 0 ? (await online.fetchBondingCurve(pc.quoteMint)).creator : null;
  const shares = splitShares(me, pc.creator, gp, PLATFORM);
  console.log(`split: ${shares.map((s) => `${s.address.toBase58().slice(0, 6)}…=${s.shareBps / 100}%`).join(" ")}`);
  const built = await buildSpawnTx(conn, me, parent, { name, symbol, uri: upj.metadataUri }, shares);
  mint = built.mint;
  console.log(`child mint ${mint.publicKey.toBase58()} depth ${built.depth} split=${built.feeTx ? "second tx" : "same tx"}`);
  await send("create child", built.tx, [wallet, mint]);
  if (built.feeTx) await send("fee split", built.feeTx, [wallet]);
  // Chain for the first buy: the new coin, then the parent chain from live accounts.
  const q = await online.fetchPumpQuote(parent);
  const coins = [q!.curve, ...(q!.curve.chain ?? [])];
  const programOf = async (m: PublicKey) => (isLegacyQuoteMint(m) ? TOKEN_PROGRAM_ID : (await conn.getAccountInfo(m))!.owner);
  const parentChain: Chain = [];
  for (const c of coins) { const qm = c.bondingCurve.quoteMint; parentChain.push({ mint: c.mint.toBase58(), quoteMint: isLegacyQuoteMint(qm) ? null : qm.toBase58(), tokenProgram: (await programOf(c.mint)).toBase58(), quoteTokenProgram: (await programOf(qm)).toBase58(), migrated: isBondingCurveMigrated(c.bondingCurve), depth: c.bondingCurve.depth }); }
  chain = [{ mint: mint.publicKey.toBase58(), quoteMint: parent.toBase58(), tokenProgram: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", quoteTokenProgram: (await programOf(parent)).toBase58(), migrated: false, depth: built.depth }, ...parentChain];
}

if (buySol > 0 && !dry) {
  await new Promise((r) => setTimeout(r, 2500));
  const lamports = BigInt(Math.round(buySol * 1e9));
  const q = await quoteSwap(conn, me, chain, "buy", lamports);
  console.log(`first buy quote: ${buySol} SOL → ${Number(q.amountOut) / 1e6} ${symbol}`);
  const tx = await buildSwapTx(conn, me, chain, "buy", lamports, (q.amountOut * 97n) / 100n);
  await send("first buy", tx, [wallet]);
}
console.log(`\nDONE mint=${mint.publicKey.toBase58()} https://pump.fun/coin/${mint.publicKey.toBase58()}  site: ${API}/c/${mint.publicKey.toBase58()}`);
