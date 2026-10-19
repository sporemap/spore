// Captures real pump.fun events from mainnet transaction logs into test/fixtures/events.json so
// the decoder tests run offline against bytes the program actually emitted. Reads only.
//   node scripts/capture-fixtures.mjs [curve-or-mint-address]
// Default: the depth-2 bonding curve 9CuFcRfiqEsBEQUCPTTVHaruQU7n9N7HKNSEk5VEivu (DESIGN §9).
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PUMP_PROGRAM_ID, PublicKey, bondingCurvePda } from "../lib/sdk.mjs";
import { EVENT_DISCRIMINATORS, eventNameOf } from "../lib/decode.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const RPC_URL = process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com";
const target = process.argv[2] ?? "9CuFcRfiqEsBEQUCPTTVHaruQU7n9N7HKNSEk5VEivu";
const WANT = { CreateEvent: 1, TradeEvent: 3, CompleteEvent: 1 };
const MAX_TX = Number(process.env.MAX_TX ?? 40);

let id = 0;
async function rpc(method, params) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const r = await fetch(RPC_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
    if (r.status === 429) { await new Promise((res) => setTimeout(res, 1500 * (attempt + 1))); continue; }
    const j = await r.json();
    if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
    return j.result;
  }
  throw new Error(`${method}: rate limited`);
}

const sigs = await rpc("getSignaturesForAddress", [target, { limit: 1000 }]);
console.log(`${sigs.length} signatures for ${target}`);
const ok = sigs.filter((s) => !s.err);
// Oldest first for the create, then newest backwards for trades/complete.
const order = [...new Set([ok[ok.length - 1]?.signature, ...ok.map((s) => s.signature)].filter(Boolean))];
const found = { CreateEvent: [], TradeEvent: [], CompleteEvent: [] };
let fetched = 0;
for (const sig of order) {
  if (fetched >= MAX_TX) break;
  if (Object.keys(WANT).every((k) => found[k].length >= WANT[k])) break;
  // Mainnet carries v1 transactions now; the RPC refuses the fetch unless the client accepts them.
  const tx = await rpc("getTransaction", [sig, { maxSupportedTransactionVersion: 1, encoding: "json" }]);
  fetched++;
  if (!tx?.meta?.logMessages) continue;
  for (const line of tx.meta.logMessages) {
    if (!line.startsWith("Program data: ")) continue;
    const b64 = line.slice("Program data: ".length);
    const name = eventNameOf(Buffer.from(b64, "base64"));
    if (!name || !(name in found) || found[name].length >= WANT[name]) continue;
    found[name].push({ sig, slot: tx.slot, blockTime: tx.blockTime, data: b64 });
    console.log(`  ${name} in ${sig} (slot ${tx.slot})`);
  }
}
const out = { capturedAt: new Date().toISOString(), rpc: RPC_URL.replace(/api-key=.*/, "api-key=…"), program: PUMP_PROGRAM_ID.toBase58(), target, discriminators: Object.fromEntries(Object.entries(EVENT_DISCRIMINATORS).map(([k, v]) => [k, [...v]])), events: found };
mkdirSync(join(here, "../test/fixtures"), { recursive: true });
writeFileSync(join(here, "../test/fixtures/events.json"), JSON.stringify(out, null, 2) + "\n");
console.log(`fetched ${fetched} transactions →`, Object.fromEntries(Object.entries(found).map(([k, v]) => [k, v.length])));

// Account fixtures for the curve/mint decoders: the curve, its mint (resolved through the curve's
// token accounts, as the backfill does) and the parent curve.
const curveInfo = (await rpc("getAccountInfo", [target, { encoding: "base64" }])).value;
const accounts = { curve: { pubkey: target, owner: curveInfo.owner, data: curveInfo.data[0] } };
const quoteMint = new PublicKey(Buffer.from(curveInfo.data[0], "base64").subarray(83, 115)).toBase58();
const tas = await rpc("getTokenAccountsByOwner", [target, { programId: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" }, { encoding: "jsonParsed" }]);
const base = tas.value.find((a) => a.account.data.parsed.info.mint !== quoteMint);
if (base) {
  const mint = base.account.data.parsed.info.mint;
  const [mintInfo, parentInfo] = (await rpc("getMultipleAccounts", [[mint, bondingCurvePda(quoteMint).toBase58()], { encoding: "base64" }])).value;
  accounts.mint = { pubkey: mint, owner: mintInfo.owner, data: mintInfo.data[0] };
  if (parentInfo) accounts.parentCurve = { pubkey: bondingCurvePda(quoteMint).toBase58(), mint: quoteMint, owner: parentInfo.owner, data: parentInfo.data[0] };
}
writeFileSync(join(here, "../test/fixtures/accounts.json"), JSON.stringify({ capturedAt: out.capturedAt, accounts }, null, 2) + "\n");
console.log("accounts →", Object.keys(accounts).join(", "));
