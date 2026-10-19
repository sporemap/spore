// Which accounts must pre-exist for update_fee_shares_v2 on a fresh config? Tries variants in simulation.
import { Connection, PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { OnlinePumpSdk, PUMP_SDK, feeSharingConfigPda, creatorVaultPda } from "@pump-fun/pump-sdk";
import { splitShares, compileV0, lookupTables, txBytes } from "../src/lib/pump/index.ts";
import { ComputeBudgetProgram } from "@solana/web3.js";
const conn = new Connection(process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com", "confirmed");
const online = new OnlinePumpSdk(conn);
const PROBE = new PublicKey("dBs75Gf7RXQMAsMLuTLYdH2fHV1ac9zgCEh6zC7TxXs");
const SUBJECT = new PublicKey(process.argv[2] ?? "2uprf2a8svwhjztyKLDpMNiwQcXHa25sNbNnWeo5pump");
const curve = await online.fetchBondingCurve(SUBJECT);
const rootCurve = await online.fetchBondingCurve(curve.quoteMint);
const quoteProgram = (await conn.getAccountInfo(curve.quoteMint))!.owner;
const authority = curve.creator;
const shares = splitShares(authority, rootCurve.creator, null, PROBE);
const config = await PUMP_SDK.createFeeSharingConfig({ creator: authority, mint: SUBJECT, pool: null });
const split = await PUMP_SDK.updateFeeSharesV2({ authority, mint: SUBJECT, currentShareholders: [authority], newShareholders: shares, quoteMint: curve.quoteMint, quoteTokenProgram: quoteProgram, bondingCurveComplete: curve.complete });
const sharing = feeSharingConfigPda(SUBJECT);
const vault = creatorVaultPda(sharing);
const ata = (owner: PublicKey) => createAssociatedTokenAccountIdempotentInstruction(authority, getAssociatedTokenAddressSync(curve.quoteMint, owner, true, quoteProgram), owner, curve.quoteMint, quoteProgram);
const shareholderAtas = shares.map((s) => ata(s.address));
const vaultAta = ata(vault);
const oldVaultAta = ata(creatorVaultPda(authority));
console.log("split accounts:", split.keys.map((k) => k.pubkey.toBase58().slice(0, 6)).join(" "));
console.log("vault", vault.toBase58(), "old vault", creatorVaultPda(authority).toBase58());
const variants: [string, TransactionInstruction[]][] = [
  ["plain", [config, split]],
  ["+shareholder ATAs", [...shareholderAtas, config, split]],
  ["+vault ATA", [vaultAta, config, split]],
  ["+old creator-vault ATA", [oldVaultAta, config, split]],
  ["+all", [...shareholderAtas, vaultAta, oldVaultAta, config, split]],
];
const tables = await lookupTables(conn);
for (const [name, ixs] of variants) {
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  const tx = compileV0(authority, blockhash, [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ...ixs], tables);
  const sim = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" });
  const logs = sim.value.logs ?? [];
  const errLine = [...logs].reverse().find((l) => /Error|failed/.test(l));
  console.log(`\n[${name}] bytes=${txBytes(tx)} units=${sim.value.unitsConsumed} err=${sim.value.err ? JSON.stringify(sim.value.err) : "none"} ${errLine ? "| " + errLine.slice(0, 160) : ""}`);
  await new Promise((r) => setTimeout(r, 1500));
}
