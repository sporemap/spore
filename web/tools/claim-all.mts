// Pays out the creator fees of every coin whose fee-sharing config names a wallet (by default the
// Spore platform wallet), using the same transaction builder as the site's Claim page. The coin
// list comes from the public API (/api/claims/<wallet>). Dry by default: each claim is simulated
// and its payout printed; nothing is signed or sent without --send. Run from web/:
//   node --import ./test/cjs-sdk-hook.mjs --import tsx tools/claim-all.mts [--wallet <pubkey>] [--min-usd 0.5]
//   WALLET=<keypair.json> node --import ./test/cjs-sdk-hook.mjs --import tsx tools/claim-all.mts --send
// Env: RPC_URL (a paid RPC), API (default https://sporepad.com), WALLET (keypair file, only read with --send).
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { buildClaimTx, parseClaimLogs } from "../src/lib/pump/index.ts";
import { PLATFORM_WALLET } from "../src/lib/policy.ts";

const args = process.argv.slice(2);
const arg = (k: string, d?: string) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const send = args.includes("--send");
const API = process.env.API ?? "https://sporepad.com";
const conn = new Connection(process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com", "confirmed");
const signer = send ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.env.WALLET ?? `${homedir()}/.config/solana/spore-dev.json`, "utf8")))) : null;
const wallet = signer ? signer.publicKey : new PublicKey(arg("wallet", PLATFORM_WALLET.toBase58())!);
const minUsd = Number(arg("min-usd", "0"));
const fmt = (raw: bigint, dec: number) => (Number(raw) / 10 ** dec).toLocaleString("en-US", { maximumFractionDigits: dec > 6 ? 6 : 2 });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Row = { mint: string; symbol: string | null; quoteSymbol: string; quoteDecimals: number; total: string; totalUsd: number | null; yourBps: number; yourAmount: string; yourUsd: number | null; claimable: boolean; reason: string | null };
const res = await fetch(`${API}/api/claims/${wallet.toBase58()}`);
if (!res.ok) throw new Error(`claims list: HTTP ${res.status}`);
const { coins } = (await res.json()) as { coins: Row[] };
const todo = coins.filter((c) => c.claimable && (c.yourUsd ?? 0) >= minUsd);
console.log(`${wallet.toBase58()} · ${coins.length} coins with a share · ${todo.length} to claim${minUsd ? ` (≥ $${minUsd})` : ""} · payer balance ${(await conn.getBalance(wallet)) / 1e9} SOL${send ? "" : " · DRY RUN"}`);

let ok = 0, failed = 0, sumUsd = 0;
for (const c of todo) {
  const label = `$${c.symbol ?? c.mint.slice(0, 6)}`.padEnd(12);
  try {
    const tx = await buildClaimTx(conn, wallet, new PublicKey(c.mint));
    if (signer) tx.sign([signer]);
    const sim = await conn.simulateTransaction(tx, { sigVerify: !!signer, replaceRecentBlockhash: !signer, commitment: "confirmed" });
    if (sim.value.err) { failed++; console.log(`${label} simulation FAILED ${JSON.stringify(sim.value.err)} ${(sim.value.logs ?? []).slice(-2).join(" | ").slice(0, 160)}`); continue; }
    const payout = parseClaimLogs(sim.value.logs ?? []);
    const mine = payout?.shares.find((s) => s.address.equals(wallet))?.amount ?? 0n;
    const line = `${label} pays ${fmt(payout?.distributed ?? 0n, c.quoteDecimals)} ${c.quoteSymbol} · yours ${fmt(mine, c.quoteDecimals)} ${c.quoteSymbol}${c.yourUsd != null ? ` (~$${c.yourUsd.toFixed(2)})` : ""} · ${sim.value.unitsConsumed} CU`;
    if (!signer) { ok++; sumUsd += c.yourUsd ?? 0; console.log(`${line} · simulated ok`); continue; }
    const sig = await conn.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
    const conf = await conn.confirmTransaction(sig, "confirmed");
    if (conf.value.err) { failed++; console.log(`${line} · FAILED on-chain https://solscan.io/tx/${sig}`); }
    else { ok++; sumUsd += c.yourUsd ?? 0; console.log(`${line} · claimed https://solscan.io/tx/${sig}`); }
  } catch (e) { failed++; console.log(`${label} error: ${(e as Error).message.slice(0, 200)}`); }
  await sleep(400);
}
console.log(`\n${send ? "claimed" : "would claim"} ${ok} coin(s), ~$${sumUsd.toFixed(2)} to this wallet${failed ? ` · ${failed} failed` : ""}${send ? "" : "\nrun again with --send to sign and send (from your own terminal)"}`);
