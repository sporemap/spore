// Creator-fee accounting shared by the platform treasury view (DESIGN §11.4) and the per-coin
// "Creator fees" card (DESIGN §11.6). A coin's creator fee waits in up to four places: the bonding
// curve's `creatorFee` bucket (trades not yet swept, before migration), the pump-amm pool's
// `creator_fees` bucket (the same, after it), the fee-sharing config's creator vault (SOL as
// lamports on the vault PDA above its rent floor; a token-quoted coin's fees in the vault's quote
// ATA) and the AMM creator vault (a token account of the quote mint, WSOL for a SOL-quoted pool).
// Distribution is permissionless: the browser (web/src/lib/pump/claim.ts) or web/tools/treasury.mts
// sweeps the buckets and runs distribute_creator_fees_v2. Nothing is signed here; this only reads.
import { NATIVE_MINT, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, USDC_MINT, bondingCurvePda, feeSharingConfigPda, creatorVaultPda, ammCreatorVaultPda, canonicalPumpPoolPdaWithQuote, getAssociatedTokenAddressSync, pk } from "./sdk.mjs";
import { decodeCurve, decodePool, decodeShares, decodeTokenAccount } from "./decode.mjs";
import { units } from "./pricing.mjs";

const nowS = () => Math.floor(Date.now() / 1000);
const SOL = NATIVE_MINT.toBase58();
/** rent.minimum_balance(0) on mainnet (2026-10-19): the SOL creator vault keeps this much; the RPC's answer replaces it at runtime. */
export const VAULT_RENT_LAMPORTS = 650_240n;
export const FEES_TTL_MS = 15_000;
const FEES_CACHE_MAX = 2_000;
/** Accounts read per coin, in this order: curve, creator vault, AMM creator vault ATA, canonical pool, sharing config. */
export const KEYS_PER_COIN = 5;
const COINS_PER_CALL = 20; // 100 keys: one getMultipleAccounts
const max0 = (v) => (v > 0n ? v : 0n);

/**
 * The accounts whose balances are `c`'s pending creator fees. The creator vault is the PDA itself
 * for a SOL-quoted coin and its quote ATA otherwise; the AMM creator vault is always a token
 * account (WSOL for SOL). A pump-coin quote is Token-2022 unless the model knows better.
 */
export function feeAccounts(c, model) {
  const mint = pk(c.mint);
  const sharing = feeSharingConfigPda(mint);
  const sol = c.quoteMint == null || c.quoteMint === SOL;
  const quoteMint = sol ? NATIVE_MINT : pk(c.quoteMint);
  const known = sol ? null : model.mint(c.quoteMint)?.tokenProgram;
  const quoteProgram = sol || c.quoteMint === USDC_MINT ? TOKEN_PROGRAM_ID : pk(known ?? TOKEN_2022_PROGRAM_ID.toBase58());
  const ata = (owner) => getAssociatedTokenAddressSync(quoteMint, owner, true, quoteProgram).toBase58();
  const vault = creatorVaultPda(sharing);
  const keys = [c.curve ?? bondingCurvePda(mint).toBase58(), sol ? vault.toBase58() : ata(vault), ata(ammCreatorVaultPda(sharing)), canonicalPumpPoolPdaWithQuote(mint, quoteMint).toBase58(), sharing.toBase58()];
  return { sol, sharing: sharing.toBase58(), keys };
}

/**
 * Balances behind `feeAccounts(c)`'s account infos, raw quote units as bigint. `migrated` and
 * `holderReward` come from the live curve when it decodes, else from the record; `shares` is the
 * live sharing config (null when there is none). Only the SOL vault keeps a rent floor: what sits
 * above it is distributable, like the program's own view (`get_minimum_distributable_fee`).
 */
export function feeBalances(c, infos, { sol, rent = VAULT_RENT_LAMPORTS } = {}) {
  const [curveInfo, vaultInfo, ammInfo, poolInfo, sharingInfo] = infos;
  let bucket = 0n, migrated = !!c.migrated, holderReward = !!c.holderReward;
  try { if (curveInfo) { const cur = decodeCurve(curveInfo.data); bucket = BigInt(cur.creatorFee ?? 0); migrated = cur.migrated; holderReward = cur.holderReward; } } catch { /* not a curve any more */ }
  const tokens = (info) => { if (!info) return 0n; try { return BigInt(decodeTokenAccount(info.data)?.amount ?? 0); } catch { return 0n; } };
  const vault = sol ? (vaultInfo ? max0(BigInt(vaultInfo.lamports ?? 0) - rent) : 0n) : tokens(vaultInfo);
  let amm = 0n;
  if (migrated) {
    amm = tokens(ammInfo);
    try { const p = poolInfo ? decodePool(poolInfo.data) : null; if (p) amm += BigInt(p.creatorFees ?? 0); } catch { /* not a pool */ }
  }
  const shares = sharingInfo ? decodeShares(sharingInfo.data) : null;
  return { bucket, vault, amm, total: bucket + vault + amm, migrated, holderReward, shares: shares && shares.length ? shares : null };
}

export class Treasury {
  constructor({ model, rpc, platformWallet, ttlMs = 60_000, feesTtlMs = FEES_TTL_MS, log = console, now = Date.now } = {}) {
    this.model = model; this.rpc = rpc; this.platformWallet = platformWallet; this.ttlMs = ttlMs; this.feesTtlMs = feesTtlMs; this.log = log; this.now = now;
    this.cache = null; this.cachedAt = 0; this.inFlight = null;
    this.feeCache = new Map(); // mint → { at, value, inFlight }
    this.rent = null;
    this.stats = { computes: 0, errors: 0, lastError: null, fees: 0, feesErrors: 0 };
  }

  /** Cached for `ttlMs`; concurrent callers share one computation; a failure serves the last good value. */
  async get() {
    if (this.cache && this.now() - this.cachedAt < this.ttlMs) return this.cache;
    if (!this.inFlight) {
      this.inFlight = this.compute().then((v) => { this.cache = v; this.cachedAt = this.now(); return v; })
        .catch((e) => { this.stats.errors++; this.stats.lastError = String(e.message ?? e).slice(0, 200); this.log.warn?.(`treasury: ${this.stats.lastError}`); if (this.cache) return this.cache; throw e; })
        .finally(() => { this.inFlight = null; });
    }
    return this.inFlight;
  }

  /** Coins whose sharing config names the platform (proven ours, not merely pending). */
  ourCoins() { return [...this.model.coins.values()].filter((c) => this.model.isOurs(c)); }

  /** rent.minimum_balance(0), asked once per process; the constant stands in when the RPC cannot answer. */
  async rentLamports(rpc = this.rpc) {
    if (this.rent != null) return this.rent;
    if (typeof rpc?.call !== "function") return VAULT_RENT_LAMPORTS;
    try { const v = await rpc.call("getMinimumBalanceForRentExemption", [0]); if (Number.isInteger(v) && v >= 0) this.rent = BigInt(v); }
    catch (e) { this.log.warn?.(`treasury: rent lookup failed: ${String(e.message ?? e).slice(0, 120)}`); }
    return this.rent ?? VAULT_RENT_LAMPORTS;
  }

  /** Live balances of `coins` (records), one getMultipleAccounts per 20 coins; rows align with `coins`. */
  async readFees(coins, rpc = this.rpc) {
    const rent = await this.rentLamports(rpc);
    const rows = [];
    for (let i = 0; i < coins.length; i += COINS_PER_CALL) {
      const part = coins.slice(i, i + COINS_PER_CALL);
      const plan = part.map((c) => feeAccounts(c, this.model));
      const infos = await rpc.getMultipleAccounts(plan.flatMap((p) => p.keys));
      part.forEach((c, j) => rows.push({ c, sol: plan[j].sol, ...feeBalances(c, infos.slice(j * KEYS_PER_COIN, (j + 1) * KEYS_PER_COIN), { sol: plan[j].sol, rent }) }));
    }
    return rows;
  }

  async compute() {
    this.stats.computes++;
    const coins = this.ourCoins();
    const rows = (await this.readFees(coins)).map((r) => {
      const ourBps = BigInt(r.c.shares?.find((s) => s.address === this.platformWallet)?.bps ?? 0);
      return { mint: r.c.mint, symbol: this.model.nameOf(r.c.mint).symbol, quoteMint: r.sol ? null : r.c.quoteMint, migrated: r.migrated, ourBps: Number(ourBps), raw: (r.total * ourBps) / 10_000n };
    });
    const byQuote = new Map();
    for (const r of rows) {
      const key = r.quoteMint ?? "SOL";
      const decimals = r.quoteMint ? this.model.decimalsOf(r.quoteMint) : 9;
      const g = byQuote.get(key) ?? { quoteMint: r.quoteMint, symbol: r.quoteMint ? this.model.quoteSymbol({ quoteMint: r.quoteMint }) : "SOL", raw: 0n, decimals, coins: 0 };
      g.raw += r.raw; g.coins++;
      byQuote.set(key, g);
    }
    const pendingByQuote = [...byQuote.values()].map((g) => {
      const amount = units(g.raw, g.decimals);
      const price = this.model.quoteUsdOf(g.quoteMint);
      return { quoteMint: g.quoteMint, symbol: g.symbol, amount, usd: price != null ? amount * price : null, coins: g.coins };
    }).sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1) || b.amount - a.amount);
    const coinsOut = rows.filter((r) => r.raw > 0n).sort((a, b) => (a.raw < b.raw ? 1 : a.raw > b.raw ? -1 : 0)).slice(0, 50)
      .map((r) => ({ mint: r.mint, symbol: r.symbol, quoteMint: r.quoteMint, migrated: r.migrated, ourBps: r.ourBps, amount: units(r.raw, r.quoteMint ? this.model.decimalsOf(r.quoteMint) : 9) }));
    return { platform: this.platformWallet, ourCoins: coins.length, pendingByQuote, coins: coinsOut, updatedAt: nowS() };
  }

  /**
   * The per-coin view behind GET /api/fees/:mint (DESIGN §11.6): the balances, the live sharing
   * config and each shareholder's cut, cached `feesTtlMs` per mint. Concurrent callers share one
   * read; a failed refresh serves the last value when there is one.
   */
  async fees(coin, { rpc = this.rpc } = {}) {
    const hit = this.feeCache.get(coin.mint);
    if (hit?.value && this.now() - hit.at < this.feesTtlMs) return hit.value;
    if (hit?.inFlight) return hit.inFlight;
    const entry = hit ?? { at: 0, value: null, inFlight: null };
    entry.inFlight = this.#computeFees(coin, rpc).then((v) => { entry.value = v; entry.at = this.now(); return v; })
      .catch((e) => { this.stats.feesErrors++; this.stats.lastError = String(e.message ?? e).slice(0, 200); this.log.warn?.(`fees ${coin.mint}: ${this.stats.lastError}`); if (entry.value) return entry.value; throw e; })
      .finally(() => { entry.inFlight = null; });
    if (!hit) {
      this.feeCache.set(coin.mint, entry);
      if (this.feeCache.size > FEES_CACHE_MAX) this.feeCache.delete(this.feeCache.keys().next().value);
    }
    return entry.inFlight;
  }

  async #computeFees(coin, rpc) {
    this.stats.fees++;
    const c = this.model.get(coin.mint) ?? coin;
    const [r] = await this.readFees([c], rpc);
    return this.#feeView(c, r);
  }

  /** The /api/fees view of one coin from its read balances; adopts a config the indexer has not fetched yet. */
  #feeView(c, r) {
    if (r.shares && !c.shares) this.model.upsertCoin({ mint: c.mint, shares: r.shares, sharesAt: nowS() });
    const quoteMint = r.sol ? null : c.quoteMint;
    const decimals = this.model.decimalsOf(quoteMint);
    const quoteUsd = this.model.quoteUsdOf(quoteMint);
    const perShare = (r.shares ?? []).map((s) => ({ address: s.address, bps: s.bps, amount: ((r.total * BigInt(s.bps)) / 10_000n).toString() }));
    const reason = r.holderReward ? "holder-reward coin: its creator fees go to holders, there is no split to distribute"
      : !r.shares ? "no fee-sharing config: nothing routes through a split yet"
      : r.total === 0n ? "nothing to claim yet"
      : null;
    return {
      mint: c.mint, quoteMint, quoteSymbol: this.model.quoteSymbol(c), quoteDecimals: decimals, quoteUsd,
      shares: r.shares, bucket: r.bucket.toString(), vault: r.vault.toString(), amm: r.amm.toString(), total: r.total.toString(),
      totalUsd: quoteUsd != null ? units(r.total, decimals) * quoteUsd : null, perShare, migrated: r.migrated,
      claimable: reason == null, reason, updatedAt: nowS(),
    };
  }

  /**
   * /api/fees views for many coins: fresh cache entries are reused, the rest are read in batches of
   * COINS_PER_CALL (one getMultipleAccounts each) and written back to the per-mint cache, so the
   * claim page and the coin page agree and neither costs a read per coin.
   */
  async feesMany(coins, { rpc = this.rpc } = {}) {
    const out = new Map(), todo = [];
    for (const coin of coins) {
      const hit = this.feeCache.get(coin.mint);
      if (hit?.value && this.now() - hit.at < this.feesTtlMs) out.set(coin.mint, hit.value); else todo.push(this.model.get(coin.mint) ?? coin);
    }
    if (todo.length) {
      this.stats.fees += todo.length;
      const rows = await this.readFees(todo, rpc);
      for (const r of rows) {
        const v = this.#feeView(r.c, r);
        out.set(r.c.mint, v);
        const entry = this.feeCache.get(r.c.mint) ?? { at: 0, value: null, inFlight: null };
        entry.value = v; entry.at = this.now();
        if (!this.feeCache.has(r.c.mint)) { this.feeCache.set(r.c.mint, entry); if (this.feeCache.size > FEES_CACHE_MAX) this.feeCache.delete(this.feeCache.keys().next().value); }
      }
    }
    return coins.map((c) => out.get(c.mint)).filter(Boolean);
  }
}

/** A wallet's slice of one coin's pending fees (raw quote units as a string, USD when priced). */
export function shareOf(view, wallet) {
  const s = (view.shares ?? []).find((x) => x.address === wallet);
  const bps = s?.bps ?? 0;
  const amount = (BigInt(view.total) * BigInt(bps)) / 10_000n;
  return { yourBps: bps, yourAmount: amount.toString(), yourUsd: view.totalUsd != null && Number(view.total) > 0 ? (view.totalUsd * bps) / 10_000 : (view.totalUsd != null ? 0 : null) };
}

/** Totals of a claim list: USD overall and the raw amount per quote mint (SOL is quoteMint null). */
export function claimTotals(rows, amountKey) {
  const byQuote = new Map();
  let usd = 0;
  for (const r of rows) {
    const k = r.quoteMint ?? "SOL";
    const cur = byQuote.get(k) ?? { quoteMint: r.quoteMint, quoteSymbol: r.quoteSymbol, quoteDecimals: r.quoteDecimals, amount: 0n, usd: 0 };
    cur.amount += BigInt(r[amountKey]);
    const u = amountKey === "yourAmount" ? r.yourUsd : r.totalUsd;
    if (u != null) { cur.usd += u; usd += u; }
    byQuote.set(k, cur);
  }
  return { usd, byQuote: [...byQuote.values()].map((q) => ({ ...q, amount: q.amount.toString() })).sort((a, b) => b.usd - a.usd) };
}
