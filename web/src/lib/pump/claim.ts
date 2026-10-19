// Claiming creator fees (DESIGN §11.6). A coin's creator fee accrues in three places: the bonding
// curve's creator-fee bucket (v3 curve trades), the sharing config's creator vault (lamports on
// the vault PDA for a SOL-quoted coin, the vault's quote ATA for a token-quoted one) and, once
// the coin has migrated, the pump-amm pool's own bucket plus the AMM creator vault. Distribution
// is permissionless: whoever pays the transaction sweeps the buckets into the vault and runs
// distribute_creator_fees_v2, which pays every shareholder of the sharing config in the coin's
// quote (SOL for a root, parent tokens for a child). Any connected wallet can therefore claim for
// everyone; the signature only costs the network fee (plus rent for shareholder token accounts
// that do not exist yet, which the program creates with shouldInitializeAta).
import { ComputeBudgetProgram, PublicKey, type Connection, type TransactionInstruction, type VersionedTransaction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PUMP_SDK, ammCreatorVaultPda, bondingCurvePda, canonicalPumpPoolPdaWithQuote, creatorVaultPda, feeSharingConfigPda, isBondingCurveMigrated, isLegacyQuoteMint, normalizeQuoteMint, pumpIdl, type SharingConfig } from "@pump-fun/pump-sdk";
import { CU_PRICE_MICRO, MAX_TX_BYTES, compileV0, txBytes } from "./trade";
import { lookupTables } from "./alt";

/// Everything the claim needs, read live in three round trips (curve + config, the quote mint's
/// owner program, then the vaults + pool). `total` is what a distribution would pay out before
/// the vault's rent floor; the API reports the same figures for the card.
export type ClaimState = {
  mint: PublicKey;
  sharing: PublicKey;
  /// Null when the coin has no fee-sharing config: nothing can be claimed through this path.
  config: SharingConfig | null;
  quoteMint: PublicKey;
  quoteTokenProgram: PublicKey;
  sol: boolean;
  complete: boolean;
  migrated: boolean;
  holderReward: boolean;
  /// The curve's creator: the sharing config PDA once a config exists, a wallet before, the
  /// holder-rewards PDA on a holder-reward coin. The curve sweep pays this account's vault.
  curveCreator: PublicKey;
  /// The pool's own coin_creator (bytes 211..243), which pump-amm's sweep is keyed on; null until
  /// the coin has a pool.
  poolCoinCreator: PublicKey | null;
  bucket: bigint;
  vault: bigint;
  /// pump-amm: the pool's creator-fee bucket plus the AMM creator vault's quote balance.
  amm: bigint;
  total: bigint;
};

/// Why a claim cannot be built, as one sentence for a disabled button.
export class ClaimError extends Error {
  constructor(message: string) { super(message); this.name = "ClaimError"; }
}

const cu = (units: number) => [ComputeBudgetProgram.setComputeUnitLimit({ units }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: CU_PRICE_MICRO })];
/// SPL Token and Token-2022 keep the u64 amount at offset 64.
const tokenAmount = (data: Uint8Array | null | undefined) => (data && data.length >= 72 ? new DataView(data.buffer, data.byteOffset + 64, 8).getBigUint64(0, true) : 0n);
const u64At = (data: Uint8Array, offset: number) => (data.length >= offset + 8 ? new DataView(data.buffer, data.byteOffset + offset, 8).getBigUint64(0, true) : 0n);

export async function readClaimState(conn: Connection, mint: PublicKey): Promise<ClaimState> {
  const sharing = feeSharingConfigPda(mint);
  const [curveInfo, configInfo] = await conn.getMultipleAccountsInfo([bondingCurvePda(mint), sharing], "confirmed");
  if (!curveInfo) throw new ClaimError("This mint has no pump.fun bonding curve");
  const curve = PUMP_SDK.decodeBondingCurve(curveInfo);
  const sol = isLegacyQuoteMint(curve.quoteMint);
  const quoteMint = normalizeQuoteMint(curve.quoteMint);
  // The quote token program is the mint account's owner (Token-2022 for pump coins, SPL for SOL).
  const quoteTokenProgram = sol ? TOKEN_PROGRAM_ID : (await conn.getAccountInfo(quoteMint, "confirmed"))?.owner ?? TOKEN_PROGRAM_ID;
  const migrated = isBondingCurveMigrated(curve);
  const vaultPda = creatorVaultPda(sharing), ammPda = ammCreatorVaultPda(sharing);
  // A SOL vault holds its fees as lamports on the PDA itself; the AMM vault always holds a token
  // account (wrapped SOL for a SOL pool), which transfer_creator_fees_to_pump_v2 unwraps.
  const vaultHolder = sol ? vaultPda : getAssociatedTokenAddressSync(quoteMint, vaultPda, true, quoteTokenProgram);
  const ammAta = getAssociatedTokenAddressSync(quoteMint, ammPda, true, quoteTokenProgram);
  const pool = canonicalPumpPoolPdaWithQuote(mint, quoteMint);
  const [vaultInfo, ammInfo, poolInfo] = await conn.getMultipleAccountsInfo([vaultHolder, ammAta, pool], "confirmed");
  const bucket = BigInt(curve.creatorFee.toString());
  const vault = sol ? BigInt(vaultInfo?.lamports ?? 0) : tokenAmount(vaultInfo?.data);
  // Pool bytes 211..243 are coin_creator and 279..287 the pool's creator_fees bucket (the layout
  // only ever grew at the end; the SDK reads the same offsets).
  const poolCoinCreator = poolInfo && poolInfo.data.length >= 243 ? new PublicKey(poolInfo.data.subarray(211, 243)) : null;
  const poolBucket = poolInfo ? u64At(poolInfo.data, 279) : 0n;
  const amm = migrated ? poolBucket + tokenAmount(ammInfo?.data) : 0n;
  return {
    mint, sharing, config: configInfo ? PUMP_SDK.decodeSharingConfig(configInfo) : null, quoteMint, quoteTokenProgram, sol,
    complete: curve.complete, migrated, holderReward: curve.isHolderReward, curveCreator: curve.creator, poolCoinCreator,
    bucket, vault, amm, total: bucket + vault + amm,
  };
}

/// Each shareholder's cut of `total` by its bps (the program's own integer split).
export const perShare = (config: SharingConfig, total: bigint) => config.shareholders.map((s) => ({ address: s.address, bps: s.shareBps, amount: (total * BigInt(s.shareBps)) / 10_000n }));

/// The instructions of a claim, in the order pump requires: curve sweep, then (migrated) the pool
/// sweep and the AMM → pump vault transfer, then the distribution.
export async function claimInstructions(payer: PublicKey, s: ClaimState): Promise<TransactionInstruction[]> {
  if (s.holderReward) throw new ClaimError("Creator fees of this coin go to its holders; there is no sharing config to claim through");
  if (!s.config) throw new ClaimError("This coin has no fee-sharing config, so there is nothing to claim through it");
  if (!s.curveCreator.equals(s.sharing)) throw new ClaimError("This coin's fees are not routed through its sharing config");
  const { mint, quoteMint, quoteTokenProgram } = s;
  const ixs: TransactionInstruction[] = [];
  // The distribution refuses an un-swept curve bucket (6095 CreatorFeesNotSwept). A live curve is
  // traded between this read and the signature (the wallet popup alone takes seconds), so the
  // sweep goes in whenever trades can still fill the bucket; with nothing in it the instruction
  // logs "Nothing to sweep" and costs only compute. A migrated curve takes no more v3 trades, so
  // its empty bucket needs no sweep.
  if (s.bucket > 0n || !s.migrated) ixs.push(await PUMP_SDK.sweepCreatorFeeInstruction({ payer, mint, creator: s.sharing, quoteMint, quoteTokenProgram }));
  if (s.migrated) {
    // pump-amm keys its sweep on the pool's own coin_creator (ConstraintSeeds otherwise); it is
    // the sharing config for every coin whose config predates the migration.
    ixs.push(await PUMP_SDK.sweepPoolCreatorFeeInstruction({ payer, mint, coinCreator: s.poolCoinCreator ?? s.sharing, quoteMint, quoteTokenProgram }));
    ixs.push(await PUMP_SDK.transferCreatorFeesToPumpV2({ payer, mint, quoteMint, quoteTokenProgram }));
  }
  ixs.push(await PUMP_SDK.distributeCreatorFeesV2({ mint, sharingConfig: s.config, sharingConfigAddress: s.sharing, quoteMint, payer, shouldInitializeAta: true, quoteTokenProgram }));
  return ixs;
}

/// The claim as the wallet signs it: v0 with Spore's lookup table, compute budget set. `state`
/// skips the reads when the caller already has a fresh one (the card refetches before building).
export async function buildClaimTx(conn: Connection, payer: PublicKey, mint: PublicKey, state?: ClaimState): Promise<VersionedTransaction> {
  const s = state ?? (await readClaimState(conn, mint));
  const ixs = await claimInstructions(payer, s);
  const [{ blockhash }, tables] = await Promise.all([conn.getLatestBlockhash("confirmed"), lookupTables(conn)]);
  // Measured 2026-10-19 (test/README.md): a live token-quoted child with two shareholders and
  // their ATAs to create ~70k CU; a migrated SOL root with pool sweep + transfer ~60k. The limits
  // leave room for ten shareholders with fresh ATAs; the unused part is not charged.
  const tx = compileV0(payer, blockhash, [...cu(s.migrated ? 250_000 : 200_000), ...ixs], tables);
  const n = txBytes(tx);
  if (n === null || n > MAX_TX_BYTES) throw new ClaimError(`The claim is too large for one transaction (${n ?? ">1232"} bytes)`);
  return tx;
}

const DISTRIBUTE_DISCRIMINATOR = Uint8Array.from((pumpIdl as { events: { name: string; discriminator: number[] }[] }).events.find((e) => e.name === "DistributeCreatorFeesEvent")!.discriminator);
const fromBase64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export type ClaimPayout = { distributed: bigint; quoteMint: PublicKey; shares: { address: PublicKey; bps: number; amount: bigint }[] };

/// The distribution event in a transaction's (or simulation's) logs: how much the vault paid out
/// and each shareholder's cut. Null when no distribution ran.
export function parseClaimLogs(logs: readonly string[]): ClaimPayout | null {
  for (const line of logs) {
    if (!line.startsWith("Program data: ")) continue;
    const data = fromBase64(line.slice("Program data: ".length));
    if (data.length < 8 || !data.subarray(0, 8).every((b, i) => b === DISTRIBUTE_DISCRIMINATOR[i])) continue;
    const ev = PUMP_SDK.decodeDistributeCreatorFeesEvent(Buffer.from(data.subarray(8)));
    const distributed = BigInt(ev.distributed.toString());
    return { distributed, quoteMint: ev.quoteMint, shares: ev.shareholders.map((s) => ({ address: s.address, bps: s.shareBps, amount: (distributed * BigInt(s.shareBps)) / 10_000n })) };
  }
  return null;
}
