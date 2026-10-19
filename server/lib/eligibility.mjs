// "Can this coin be a parent right now?" — answered the way `create_v2` would.
//
// The SDK's `pumpQuoteReserves` runs the program's own admission checks (depth gate, mayhem, a
// chain coin complete but not yet migrated, an unlisted root quote, a seed out of range) and
// throws typed errors. Feeding it live curve and pool state gives the same verdict the
// transaction would get, so the Spawn page never builds something that reverts.
import { PUMP_SDK, PUMP_PROGRAM_ID, PUMP_AMM_PROGRAM_ID, BN, pk, bondingCurvePda, canonicalPumpPoolPdaWithQuote, normalizeQuoteMint, pumpQuoteReserves } from "./sdk.mjs";
import { decodeCurve, decodePool, decodeTokenAccount } from "./decode.mjs";
import { splitShares } from "./pricing.mjs";

const CACHE_MS = 5_000;
const cache = new Map();

export function reasonFor(e, { mint, depth, maxDepth, mayhem }) {
  switch (e?.name) {
    case "CurveDepthExceededError": return `depth limit: a child of this coin would be at depth ${depth}, the current maximum is ${maxDepth}`;
    case "QuoteBondingCurveNotEligibleError": return mayhem ? "mayhem-mode coins cannot be parents" : `${e.mint?.toBase58?.() ?? mint} is quoted in a mint pump.fun no longer lists, so nothing can be spawned under it`;
    case "QuoteCurveAwaitingMigrationError": return `${e.mint?.toBase58?.() ?? mint} completed its bonding curve and is waiting to migrate to PumpSwap; try again in a minute`;
    case "QuoteReservesOutOfRangeError": return "the derived starting reserves are out of range (the chain is too thin to price a child)";
    case "QuotePoolNotFoundError": return "a migrated coin on the chain has no PumpSwap pool yet";
    default: return e?.message ?? "not eligible";
  }
}

/**
 * Builds the SDK's `PumpQuoteCurve` from live accounts and returns the Eligibility object of §7.
 * The chain part (RPC reads) is cached per mint for a few seconds; `creator` (the connected
 * wallet) only shapes the split, which is pure math applied on top of the cached verdict, so a
 * stream of requests with made-up creators costs no RPC. Without a creator the child slot has an
 * empty address.
 */
export async function checkEligibility({ mint, creator = null, model, indexer, rpc, platformWallet, splitBps }) {
  const hit = cache.get(mint);
  let value;
  if (hit && Date.now() - hit.at < CACHE_MS) value = hit.value;
  else {
    value = await compute({ mint, model, indexer, rpc, platformWallet });
    cache.set(mint, { at: Date.now(), value });
    if (cache.size > 500) for (const [k, v] of cache) if (Date.now() - v.at > CACHE_MS) cache.delete(k);
  }
  const { pumpCoin, ...out } = value;
  const shares = pumpCoin ? splitShares({ creator, parentCreator: out.parentCreator, grandparentCreator: out.grandparentCreator, platform: platformWallet, bps: splitBps }) : [];
  return { ...out, shares };
}

async function compute({ mint, model, indexer, rpc, platformWallet }) {
  const base = { ok: false, reason: null, depth: null, chain: [], parentCreator: null, grandparentCreator: null, shares: [], platform: platformWallet, pumpCoin: false };
  const coin = await indexer.fetchCoin(mint, { rpc });
  if (!coin) return { ...base, reason: "not a pump.fun coin (no bonding curve)" };
  const ancestors = model.ancestors(mint);
  const chainCoins = [coin, ...ancestors];
  const parentCreator = coin.creator, grandparentCreator = ancestors[0]?.creator ?? null;
  const refs = chainCoins.map((c) => model.ref(c));
  const depth = coin.depth + 1;
  const common = { ...base, depth, chain: refs, parentCreator, grandparentCreator, pumpCoin: true };
  if (model.global && model.global.createV2Enabled === false) return { ...common, reason: "pump.fun has create_v2 disabled right now" };
  if (!indexer.globalRaw) return { ...common, reason: "pump Global not loaded yet, retry shortly" };

  // Live state for every curve on the chain (the model copy may be up to one refresh cycle old).
  const infos = await rpc.getMultipleAccounts(chainCoins.map((c) => c.curve));
  const raw = [];
  for (let i = 0; i < chainCoins.length; i++) {
    const info = infos[i];
    if (!info || info.owner !== PUMP_PROGRAM_ID.toBase58()) return { ...common, reason: `bonding curve of ${chainCoins[i].mint} not found` };
    raw.push(PUMP_SDK.decodeBondingCurve({ ...info, owner: pk(info.owner) }));
    model.upsertCoin({ mint: chainCoins[i].mint, ...decodeCurve(info.data, chainCoins[i].curve) });
  }
  // Pool reserves for every migrated coin on the chain, as the program reads them.
  const pools = await Promise.all(chainCoins.map(async (c, i) => {
    const bc = raw[i];
    if (!(bc.realQuoteReserves.isZero() && bc.virtualQuoteReserves.isZero() && bc.realTokenReserves.isZero() && bc.virtualTokenReserves.isZero())) return undefined;
    const pool = canonicalPumpPoolPdaWithQuote(pk(c.mint), normalizeQuoteMint(bc.quoteMint)).toBase58();
    const info = await rpc.getAccountInfo(pool);
    const p = info && info.owner === PUMP_AMM_PROGRAM_ID.toBase58() ? decodePool(info.data) : null;
    if (!p) return null;
    const [b, q] = await rpc.getMultipleAccounts([p.baseVault, p.quoteVault]);
    const bt = b ? decodeTokenAccount(b.data) : null, qt = q ? decodeTokenAccount(q.data) : null;
    if (!bt || !qt) return null;
    model.upsertCoin({ mint: c.mint, pool, poolBaseVault: p.baseVault, poolQuoteVault: p.quoteVault, poolBase: bt.amount, poolQuote: qt.amount });
    return { baseReserves: new BN(bt.amount), quoteReserves: new BN(qt.amount), virtualQuoteReserves: new BN(p.virtualQuoteReserves) };
  }));
  if (pools.some((p) => p === null)) return { ...common, reason: "a migrated coin on the chain has no PumpSwap pool yet" };

  const quote = { mint: pk(mint), bondingCurve: raw[0], pool: pools[0], quoteControl: indexer.quoteControlRaw, chain: chainCoins.slice(1).map((c, i) => ({ mint: pk(c.mint), bondingCurve: raw[i + 1], pool: pools[i + 1] })) };
  try {
    const r = pumpQuoteReserves(indexer.globalRaw, quote, indexer.quoteControlRaw);
    return { ...common, ok: true, depth: r.depth };
  } catch (e) {
    return { ...common, reason: reasonFor(e, { mint, depth, maxDepth: Math.min(indexer.globalRaw.maxCurveDepth, 5), mayhem: raw[0].isMayhemMode }) };
  }
}
