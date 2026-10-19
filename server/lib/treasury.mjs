// Read-only treasury view (DESIGN §11.4): what the platform's 50% share of creator fees would pay
// out right now, computed from the same accounts `web/tools/treasury.mts claim` sweeps: for every
// coin whose fee-sharing config names the platform, the curve's creator-fee bucket, the
// creator vault of the sharing config and, once migrated, the AMM creator vault. Fees are paid in
// the coin's quote (SOL for a root, parent tokens for a child), so the answer is grouped by quote
// mint. Nothing is signed here; the claim itself runs from the tool with the platform keypair.
import { NATIVE_MINT, TOKEN_PROGRAM_ID, feeSharingConfigPda, creatorVaultPda, ammCreatorVaultPda, getAssociatedTokenAddressSync, pk } from "./sdk.mjs";
import { decodeCurve, decodeTokenAccount } from "./decode.mjs";
import { units } from "./pricing.mjs";

const nowS = () => Math.floor(Date.now() / 1000);
const SOL = NATIVE_MINT.toBase58();

export class Treasury {
  constructor({ model, rpc, platformWallet, ttlMs = 60_000, log = console, now = Date.now } = {}) {
    this.model = model; this.rpc = rpc; this.platformWallet = platformWallet; this.ttlMs = ttlMs; this.log = log; this.now = now;
    this.cache = null; this.cachedAt = 0; this.inFlight = null;
    this.stats = { computes: 0, errors: 0, lastError: null };
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

  async compute() {
    this.stats.computes++;
    const coins = this.ourCoins();
    const rows = [];
    // Three accounts per coin: the curve (its creator-fee bucket), the creator vault, the AMM vault.
    // SOL-quoted coins hold fees as lamports on the vault PDA itself; token-quoted ones in the
    // vault's ATA for the quote mint.
    for (let i = 0; i < coins.length; i += 33) {
      const part = coins.slice(i, i + 33);
      const keys = [];
      const plan = part.map((c) => {
        const sharing = feeSharingConfigPda(pk(c.mint));
        const sol = c.quoteMint == null || c.quoteMint === SOL;
        const quoteProgram = sol ? TOKEN_PROGRAM_ID : pk(this.model.mint(c.quoteMint)?.tokenProgram ?? TOKEN_PROGRAM_ID.toBase58());
        const holder = (owner) => (sol ? owner : getAssociatedTokenAddressSync(pk(c.quoteMint), owner, true, quoteProgram));
        const idx = keys.length;
        keys.push(c.curve, holder(creatorVaultPda(sharing)).toBase58(), holder(ammCreatorVaultPda(sharing)).toBase58());
        return { c, sol, idx };
      });
      const infos = await this.rpc.getMultipleAccounts(keys);
      for (const { c, sol, idx } of plan) {
        const [curveInfo, vaultInfo, ammInfo] = [infos[idx], infos[idx + 1], infos[idx + 2]];
        let bucket = 0n;
        try { if (curveInfo) bucket = BigInt(decodeCurve(curveInfo.data, c.curve).creatorFee ?? 0); } catch { /* not a curve any more */ }
        const held = (info) => { if (!info) return 0n; if (sol) return BigInt(info.lamports ?? 0); try { return BigInt(decodeTokenAccount(info.data)?.amount ?? 0); } catch { return 0n; } };
        const vault = held(vaultInfo), amm = c.migrated ? held(ammInfo) : 0n;
        const ourBps = BigInt(c.shares?.find((s) => s.address === this.platformWallet)?.bps ?? 0);
        const total = bucket + vault + amm;
        rows.push({ mint: c.mint, symbol: this.model.nameOf(c.mint).symbol, quoteMint: sol ? null : c.quoteMint, migrated: c.migrated, ourBps: Number(ourBps), raw: (total * ourBps) / 10_000n });
      }
    }
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
}
