// Creates Spore's own address lookup table: every static account pump
// transactions use, then freezes it (no authority, immutable) so builders can trust it forever.
// Usage (from web/): node --import ./test/cjs-sdk-hook.mjs --import tsx tools/create-alt.mts [--send]
// Without --send it only prints the address list and the rent. Signs with ~/.config/solana/spore-dev.json.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { AddressLookupTableProgram, ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import BN from "bn.js";
import { OnlinePumpSdk, PUMP_SDK, PUMP_PROGRAM_ID, PUMP_AMM_PROGRAM_ID, PUMP_FEE_PROGRAM_ID, GLOBAL_PDA, PUMP_EVENT_AUTHORITY_PDA, PUMP_AMM_EVENT_AUTHORITY_PDA, PUMP_FEE_EVENT_AUTHORITY_PDA, PUMP_FEE_CONFIG_PDA, FEE_PROGRAM_GLOBAL_PDA, AMM_GLOBAL_PDA, GLOBAL_VOLUME_ACCUMULATOR_PDA, AMM_GLOBAL_VOLUME_ACCUMULATOR_PDA, QUOTE_CONTROL_PDA, MAYHEM_PROGRAM_ID, getGlobalParamsPda, getSolVaultPda } from "@pump-fun/pump-sdk";

const send = process.argv.includes("--send");
const conn = new Connection(process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com", "confirmed");
const wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.env.WALLET ?? `${homedir()}/.config/solana/spore-dev.json`, "utf8"))));
const online = new OnlinePumpSdk(conn);
const g = await online.fetchGlobal();
const recipients = [...new Set([g.feeRecipient, ...(g.feeRecipients ?? []), ...(g.buybackFeeRecipients ?? [])].map((k: PublicKey) => k.toBase58()))].map((k) => new PublicKey(k));
const wsol = (o: PublicKey) => getAssociatedTokenAddressSync(NATIVE_MINT, o, true, TOKEN_PROGRAM_ID);
const MINT_AUTHORITY = new PublicKey("TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM");
const list = [
  ComputeBudgetProgram.programId, SystemProgram.programId, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, NATIVE_MINT,
  PUMP_PROGRAM_ID, PUMP_AMM_PROGRAM_ID, PUMP_FEE_PROGRAM_ID, MAYHEM_PROGRAM_ID,
  GLOBAL_PDA, MINT_AUTHORITY, PUMP_EVENT_AUTHORITY_PDA, PUMP_AMM_EVENT_AUTHORITY_PDA, PUMP_FEE_EVENT_AUTHORITY_PDA, PUMP_FEE_CONFIG_PDA, FEE_PROGRAM_GLOBAL_PDA, AMM_GLOBAL_PDA,
  GLOBAL_VOLUME_ACCUMULATOR_PDA, AMM_GLOBAL_VOLUME_ACCUMULATOR_PDA, QUOTE_CONTROL_PDA, getGlobalParamsPda(), getSolVaultPda(),
  ...recipients, ...recipients.map(wsol),
];
// The multi_hop_swap fixed accounts that are neither the user's nor a hop's (pump-amm fee config,
// volume accumulator, buyback token account...), taken from a sample route so nothing is guessed.
const sampleHops = [
  { venue: "curve" as const, baseMint: new PublicKey("8RwfqVijzKgb9URf1F1qbMZpSAuXx3kFn5VJ4rTbpump"), quoteMint: NATIVE_MINT, baseTokenProgram: TOKEN_2022_PROGRAM_ID, quoteTokenProgram: TOKEN_PROGRAM_ID },
];
const sampleIx = await PUMP_SDK.multiHopSwapInstruction({ user: wallet.publicKey, hops: sampleHops, side: "buy", amountIn: new BN(1), minAmountOut: new BN(1) });
const fixed = sampleIx.keys.slice(0, 16).filter((_, i) => ![0, 1, 2, 5].includes(i)).map((k) => k.pubkey);
list.push(...fixed, sampleIx.programId);
const addresses = [...new Set(list.map((k) => k.toBase58()))].map((k) => new PublicKey(k));
const bytes = 56 + 32 * addresses.length;
const rent = await conn.getMinimumBalanceForRentExemption(bytes);
console.log(`payer ${wallet.publicKey.toBase58()} balance ${(await conn.getBalance(wallet.publicKey)) / 1e9} SOL`);
console.log(`${addresses.length} addresses, table ${bytes} bytes, rent ${rent / 1e9} SOL + ~${(3 * 5000) / 1e9} SOL fees`);
addresses.forEach((a, i) => console.log(`${String(i).padStart(2)} ${a.toBase58()}`));
if (!send) { console.log("\n(dry) add --send to create + extend + freeze"); process.exit(0); }
const slot = await conn.getSlot("finalized");
const [createIx, table] = AddressLookupTableProgram.createLookupTable({ authority: wallet.publicKey, payer: wallet.publicKey, recentSlot: slot });
const sig1 = await sendAndConfirmTransaction(conn, new Transaction().add(createIx), [wallet], { commitment: "confirmed" });
console.log(`created ${table.toBase58()} ${sig1}`);
for (let i = 0; i < addresses.length; i += 25) {
  const ix = AddressLookupTableProgram.extendLookupTable({ lookupTable: table, authority: wallet.publicKey, payer: wallet.publicKey, addresses: addresses.slice(i, i + 25) });
  const s = await sendAndConfirmTransaction(conn, new Transaction().add(ix), [wallet], { commitment: "confirmed" });
  console.log(`extended +${Math.min(25, addresses.length - i)} ${s}`);
}
// Freezing removes the authority: the table can never be changed or closed, which is what makes it
// safe for a launchpad to hard-code.
const sigF = await sendAndConfirmTransaction(conn, new Transaction().add(AddressLookupTableProgram.freezeLookupTable({ lookupTable: table, authority: wallet.publicKey })), [wallet], { commitment: "confirmed" });
console.log(`frozen ${sigF}`);
const t = (await conn.getAddressLookupTable(table)).value!;
console.log(`\nTABLE ${table.toBase58()} entries ${t.state.addresses.length} authority ${t.state.authority ?? "none (frozen)"}`);
