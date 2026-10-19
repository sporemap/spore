// Spawning a coin under a parent: create_v2 with the parent as quote mint, then the fee-sharing
// config that routes creator fees up the tree. Everything is signed by the creator's wallet (plus
// the fresh mint keypair); the server never sees a key.
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, VersionedTransaction, type Connection } from "@solana/web3.js";
import BN from "bn.js";
import { NATIVE_MINT, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { OnlinePumpSdk, PUMP_SDK, canonicalPumpPoolPdaWithQuote, creatorVaultPda, feeSharingConfigPda, isBondingCurveMigrated, normalizeQuoteMint } from "@pump-fun/pump-sdk";
import { CU_PRICE_MICRO, MAX_TX_BYTES, compileV0, txBytes } from "./trade";
import { lookupTables } from "./alt";
import type { Share } from "./shares";

export type SpawnForm = { name: string; symbol: string; uri: string; creatorFeeBps?: number };
/// The launchpad's flat fee, paid in SOL to the platform wallet inside the create transaction (the
/// upward 15% creator-fee share is separate and accrues in parent tokens). The server tells the UI
/// the current amount and recipient through /api/eligibility.
export type LaunchFee = { to: PublicKey; lamports: bigint } | null;
export type SpawnBuild = {
  tx: VersionedTransaction;
  mint: Keypair;
  depth: number;
  /// Set only when create + fee split do not fit one transaction (1232 bytes): send `tx` first,
  /// then `feeTx` (same signer, no extra keypair). Null when `tx` already carries the split.
  feeTx: VersionedTransaction | null;
  /// What the new curve is quoted in (SOL's native mint for a root): a fee split retried later
  /// (`buildFeeSplitTx`) needs both, and the UI persists them with the in-progress launch.
  quoteMint: PublicKey;
  quoteTokenProgram: PublicKey;
};

const cu = (units: number) => [ComputeBudgetProgram.setComputeUnitLimit({ units }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: CU_PRICE_MICRO })];

/// update_fee_shares_v2 distributes pending fees through the sharing config creator vault and reads
/// that vault quote token account; on a fresh config it does not exist yet (InvalidAccountData, seen
/// in simulation), so it is created idempotently first. The payer funds its rent (~0.002 SOL).
function vaultAtaIx(payer: PublicKey, mint: PublicKey, quoteMint: PublicKey, quoteTokenProgram: PublicKey) {
  const vault = creatorVaultPda(feeSharingConfigPda(mint));
  return createAssociatedTokenAccountIdempotentInstruction(payer, getAssociatedTokenAddressSync(quoteMint, vault, true, quoteTokenProgram), vault, quoteMint, quoteTokenProgram);
}

/// pump refuses `create_fee_sharing_config` (and the share update) while the curve's creator-fee
/// bucket is nonzero: 6095 CreatorFeesNotSwept, because the fees in it belong to the creator the
/// curve has at that moment and the config replaces that creator. Any trade between the create and
/// the split fills the bucket (snipers buy new coins within seconds; the wallet popup alone takes
/// longer), so every split sweeps first. With an empty bucket the instruction is a no-op that costs
/// nothing beyond the base fee ("Nothing to sweep", measured 2026-10-18: no rent, 29k CU).
function sweepIx(payer: PublicKey, mint: PublicKey, curveCreator: PublicKey, quoteMint: PublicKey, quoteTokenProgram: PublicKey) {
  return PUMP_SDK.sweepCreatorFeeInstruction({ payer, mint, creator: curveCreator, quoteMint, quoteTokenProgram });
}

/// The fee-sharing config alone, for a coin that already exists (a spawn whose second transaction
/// did not land, or any coin the connected wallet created). `currentShareholders` is the creator
/// until the config has been set once; after that the program refuses changes.
///
/// The curve is read first and decides the shape: its current creator receives the swept fees, a
/// completed curve must list its canonical pool in the share update, and a migrated coin must hand
/// the pool to the config and sweep the pool's own creator bucket too (pump-amm 6081). The
/// `bondingCurveComplete` argument can only add the pool account (harmless on a live curve); the
/// chain's own `complete` flag can never be overridden to false.
export async function buildFeeSplitTx(conn: Connection, authority: PublicKey, mint: PublicKey, quoteMint: PublicKey, quoteTokenProgram: PublicKey, shares: Share[], bondingCurveComplete = false): Promise<VersionedTransaction> {
  const curve = await new OnlinePumpSdk(conn).fetchBondingCurve(mint);
  const pool = isBondingCurveMigrated(curve) ? canonicalPumpPoolPdaWithQuote(mint, normalizeQuoteMint(quoteMint)) : null;
  const sweeps = [await sweepIx(authority, mint, curve.creator, quoteMint, quoteTokenProgram)];
  if (pool) {
    // pump-amm wants the pool's own coin_creator (bytes 211..243 of the pool account; usually the
    // curve's creator, but set_coin_creator can differ), otherwise the sweep fails ConstraintSeeds.
    const info = await conn.getAccountInfo(pool, "confirmed");
    const coinCreator = info && info.data.length >= 243 ? new PublicKey(info.data.subarray(211, 243)) : curve.creator;
    sweeps.push(await PUMP_SDK.sweepPoolCreatorFeeInstruction({ payer: authority, mint, coinCreator, quoteMint, quoteTokenProgram }));
  }
  const config = await PUMP_SDK.createFeeSharingConfig({ creator: authority, mint, pool });
  const split = await PUMP_SDK.updateFeeSharesV2({ authority, mint, currentShareholders: [authority], newShareholders: shares.map((s) => ({ address: s.address, shareBps: s.shareBps })), quoteMint, quoteTokenProgram, bondingCurveComplete: curve.complete || bondingCurveComplete });
  const [{ blockhash }, tables] = await Promise.all([conn.getLatestBlockhash("confirmed"), lookupTables(conn)]);
  // Measured 2026-10-18: ~190k CU on a live curve; a migrated coin also migrates the pool's creator
  // and distributes its fees, 275k–300k+ (one subject exceeded 300k). The unused part is not charged.
  const tx = compileV0(authority, blockhash, [...cu(pool ? 450_000 : 300_000), ...sweeps, vaultAtaIx(authority, mint, quoteMint, quoteTokenProgram), config, split], tables);
  const n = txBytes(tx);
  if (n === null || n > MAX_TX_BYTES) throw new Error(`The fee split is too large for one transaction (${n ?? ">1232"} bytes)`);
  return tx;
}

/// Launches a coin through Spore. `parentMint` null = a root coin quoted in SOL (the launch tab's
/// default); a pump coin = a child quoted in that coin. Both carry the same split and launch fee.
export async function buildSpawnTx(conn: Connection, creator: PublicKey, parentMint: PublicKey | null, form: SpawnForm, shares: Share[], launchFee: LaunchFee = null): Promise<SpawnBuild> {
  if (!form.name.trim() || form.name.length > 32) throw new Error("Name: 1–32 characters");
  if (!/^[A-Za-z0-9]{1,13}$/.test(form.symbol)) throw new Error("Ticker: 1–13 letters or digits");
  if (!/^https:\/\//.test(form.uri)) throw new Error("Metadata URI must be https");
  if (form.creatorFeeBps !== undefined && (!Number.isInteger(form.creatorFeeBps) || form.creatorFeeBps < 0 || form.creatorFeeBps > 300)) throw new Error("Creator fee: 0–300 bps");
  const mint = Keypair.generate();
  const fee = launchFee && launchFee.lamports > 0n ? [SystemProgram.transfer({ fromPubkey: creator, toPubkey: launchFee.to, lamports: launchFee.lamports })] : [];
  const cfg = (quoteMint: PublicKey, quoteTokenProgram: PublicKey) => Promise.all([
    PUMP_SDK.createFeeSharingConfig({ creator, mint: mint.publicKey, pool: null }),
    PUMP_SDK.updateFeeSharesV2({ authority: creator, mint: mint.publicKey, currentShareholders: [creator], newShareholders: shares.map((s) => ({ address: s.address, shareBps: s.shareBps })), quoteMint, quoteTokenProgram, bondingCurveComplete: false }),
  ]);
  if (!parentMint) {
    // Root coin: pump's plain SOL curve. The SOL creator vault holds lamports, so no vault token
    // account is needed before the split.
    const create = await PUMP_SDK.createV2Instruction({ mint: mint.publicKey, name: form.name.trim(), symbol: form.symbol.toUpperCase(), uri: form.uri, creator, user: creator, mayhemMode: false, holderReward: false, ...(form.creatorFeeBps ? { creatorFeeBps: new BN(form.creatorFeeBps) } : {}) });
    const [config, split] = await cfg(NATIVE_MINT, TOKEN_PROGRAM_ID);
    const [{ blockhash }, tables] = await Promise.all([conn.getLatestBlockhash("confirmed"), lookupTables(conn)]);
    const single = compileV0(creator, blockhash, [...cu(400_000), ...fee, create, config, split], tables);
    const n = txBytes(single);
    const root = { mint, depth: 0, quoteMint: NATIVE_MINT, quoteTokenProgram: TOKEN_PROGRAM_ID };
    if (n !== null && n <= MAX_TX_BYTES) return { ...root, tx: single, feeTx: null };
    // The split waits for a second signature, during which the new curve can be traded: sweep
    // first (see sweepIx). The curve's creator is still the wallet at that point.
    const sweep = await sweepIx(creator, mint.publicKey, creator, NATIVE_MINT, TOKEN_PROGRAM_ID);
    return { ...root, tx: compileV0(creator, blockhash, [...cu(300_000), ...fee, create], tables), feeTx: compileV0(creator, blockhash, [...cu(300_000), sweep, config, split], tables) };
  }
  const online = new OnlinePumpSdk(conn);
  // Throws pump's own typed errors when the parent is not admissible (depth, mayhem, pending migration).
  const resolved = await online.resolveQuoteMint(parentMint);
  if (resolved.source !== "pumpCoin" || !resolved.pumpQuote) throw new Error("The parent must be a pump.fun coin");
  const { quoteTokenProgram, pumpQuote } = resolved;
  const create = await PUMP_SDK.createV2Instruction({
    mint: mint.publicKey, name: form.name.trim(), symbol: form.symbol.toUpperCase(), uri: form.uri, creator, user: creator,
    mayhemMode: false, quoteMint: parentMint, quoteTokenProgram, holderReward: false,
    ...(form.creatorFeeBps ? { creatorFeeBps: new BN(form.creatorFeeBps) } : {}),
    pumpQuote: pumpQuote.accounts,
  });
  const [config, split] = await cfg(parentMint, quoteTokenProgram);
  const [{ blockhash }, tables] = await Promise.all([conn.getLatestBlockhash("confirmed"), lookupTables(conn)]);
  const vaultAta = vaultAtaIx(creator, mint.publicKey, parentMint, quoteTokenProgram);
  // The fee travels with the create instruction so a launch without it cannot be submitted through
  // this builder; on-chain the coin is still a plain pump coin.
  const single = compileV0(creator, blockhash, [...cu(450_000), ...fee, create, vaultAta, config, split], tables);
  const n1 = txBytes(single);
  const child = { mint, depth: pumpQuote.depth, quoteMint: parentMint, quoteTokenProgram };
  if (n1 !== null && n1 <= MAX_TX_BYTES) return { ...child, tx: single, feeTx: null };
  // The two instructions' accounts do not fit one transaction: the split follows in a second one,
  // and because the curve exists (and gets sniped) between the two signatures, that one sweeps
  // the creator-fee bucket first (see sweepIx; the curve's creator is still the wallet then).
  const tx = compileV0(creator, blockhash, [...cu(300_000), ...fee, create], tables);
  const sweep = await sweepIx(creator, mint.publicKey, creator, parentMint, quoteTokenProgram);
  const feeTx = compileV0(creator, blockhash, [...cu(300_000), sweep, vaultAta, config, split], tables);
  for (const [t, what] of [[tx, "The spawn"], [feeTx, "The fee split"]] as const) {
    const n = txBytes(t);
    if (n === null || n > MAX_TX_BYTES) throw new Error(`${what} is too large for one transaction (${n ?? ">1232"} bytes): this parent chain is deeper than the lookup table covers.`);
  }
  return { ...child, tx, feeTx };
}
