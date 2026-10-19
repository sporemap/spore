// Pure decoders: bytes in, plain JSON-friendly objects out (u64 → decimal string, pubkey → base58).
// Nothing here touches the network, so every function is unit-testable against captured bytes.
import { PUMP_SDK, pumpIdl, pumpAmmIdl, PUMP_PROGRAM_ID, PublicKey, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, b58 } from "./sdk.mjs";

// ---------------------------------------------------------------- discriminators
const discOf = (idl, kind, name) => Buffer.from(idl[kind].find((x) => x.name === name).discriminator);
export const BONDING_CURVE_DISCRIMINATOR = discOf(pumpIdl, "accounts", "BondingCurve");
export const POOL_DISCRIMINATOR = discOf(pumpAmmIdl, "accounts", "Pool");
/** Event discriminators we act on. pump-amm's Buy/SellEvent keep graduated coins live. */
export const EVENT_DISCRIMINATORS = {
  CreateEvent: discOf(pumpIdl, "events", "CreateEvent"),
  TradeEvent: discOf(pumpIdl, "events", "TradeEvent"),
  CompleteEvent: discOf(pumpIdl, "events", "CompleteEvent"),
  BuyEvent: discOf(pumpAmmIdl, "events", "BuyEvent"),
  SellEvent: discOf(pumpAmmIdl, "events", "SellEvent"),
};
const byDisc = new Map(Object.entries(EVENT_DISCRIMINATORS).map(([name, d]) => [d.toString("hex"), name]));

/** Name of the event an emitted `Program data:` payload encodes, or null when it is not one we track. */
export function eventNameOf(buf) {
  if (buf.length < 8) return null;
  return byDisc.get(buf.subarray(0, 8).toString("hex")) ?? null;
}

const PROGRAM_DATA = "Program data: ";
/** Every tracked event in a transaction's log lines, in emission order, with its raw bytes. */
/**
 * Anchor events in a transaction's log lines, each with the program whose frame emitted it
 * (`Program X invoke [n]` … `Program X success|failed`), so a foreign program cannot pass off a
 * fabricated "Program data:" line as a pump.fun event. `programs` (a Set of base58 ids) keeps only
 * events emitted by those programs; without it every event is returned, tagged with its program.
 */
export function eventsInLogs(logs, programs = null) {
  const out = [];
  const stack = [];
  for (const line of logs ?? []) {
    let m;
    if ((m = /^Program (\S+) invoke \[\d+\]$/.exec(line))) { stack.push(m[1]); continue; }
    if ((m = /^Program (\S+) (success|failed)(?::|$)/.exec(line))) { const i = stack.lastIndexOf(m[1]); if (i >= 0) stack.splice(i); continue; }
    if (!line.startsWith(PROGRAM_DATA)) continue;
    const program = stack.length ? stack[stack.length - 1] : null;
    if (programs && !programs.has(program)) continue;
    let buf;
    try { buf = Buffer.from(line.slice(PROGRAM_DATA.length), "base64"); } catch { continue; }
    const name = eventNameOf(buf);
    if (name) out.push({ name, data: buf, program });
  }
  return out;
}

// ---------------------------------------------------------------- plain conversion
const ZERO_KEY = PublicKey.default.toBase58();
/** Anchor output → JSON-safe: BN → string, PublicKey → base58, nested arrays/objects recursively. */
export function plain(v) {
  if (v == null || typeof v !== "object") return typeof v === "bigint" ? v.toString() : v;
  if (typeof v.toBase58 === "function") return v.toBase58();      // PublicKey, whichever web3.js copy made it
  if (typeof v.toArrayLike === "function") return v.toString(10); // BN
  if (Buffer.isBuffer(v)) return v.toString("base64");
  if (Array.isArray(v)) return v.map(plain);
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]));
}

// ---------------------------------------------------------------- events
/**
 * Decodes one tracked event from its `Program data:` payload. The SDK's event decoders take the
 * borsh body only, so the 8-byte discriminator in front is dropped here. A SOL quote is reported
 * as `quoteMint: null` to match the API.
 */
export function decodeEvent(name, payload) {
  const data = Buffer.from(payload).subarray(8);
  switch (name) {
    case "CreateEvent": {
      const e = plain(PUMP_SDK.decodeCreateEventBc(data));
      return { ...e, quoteMint: e.quoteMint === ZERO_KEY ? null : e.quoteMint, timestamp: Number(e.timestamp), depth: Number(e.depth), creatorFeeBps: Number(e.creatorFeeBps) };
    }
    case "TradeEvent": {
      const e = plain(PUMP_SDK.decodeTradeEventBc(data));
      // Legacy SOL curves fill the `sol*` fields and leave the quote fields zero; v2 quote curves fill
      // both. Prefer the quote fields when they carry anything so one shape serves every coin.
      const quoted = e.quoteAmount !== "0" || e.virtualQuoteReserves !== "0";
      return {
        mint: e.mint, isBuy: e.isBuy, user: e.user, timestamp: Number(e.timestamp),
        tokenAmount: e.tokenAmount, quoteAmount: quoted ? e.quoteAmount : e.solAmount,
        virtualQuoteReserves: quoted ? e.virtualQuoteReserves : e.virtualSolReserves,
        virtualTokenReserves: e.virtualTokenReserves,
        realQuoteReserves: quoted ? e.realQuoteReserves : e.realSolReserves,
        realTokenReserves: e.realTokenReserves,
        quoteMint: e.quoteMint === ZERO_KEY ? null : e.quoteMint,
        creator: e.creator, fee: e.fee, creatorFee: e.creatorFee, ixName: e.ixName, mayhemMode: e.mayhemMode,
      };
    }
    case "CompleteEvent": {
      const e = plain(PUMP_SDK.decodeCompleteEventBc(data));
      return { ...e, timestamp: Number(e.timestamp), quoteMint: e.quoteMint === ZERO_KEY ? null : e.quoteMint };
    }
    case "BuyEvent": {
      const e = plain(PUMP_SDK.decodeBuyEventAmm(data));
      return { pool: e.pool, isBuy: true, user: e.user, timestamp: Number(e.timestamp), baseAmount: e.baseAmountOut, quoteAmount: e.quoteAmountIn, poolBaseReserves: e.poolBaseTokenReserves, poolQuoteReserves: e.poolQuoteTokenReserves };
    }
    case "SellEvent": {
      const e = plain(PUMP_SDK.decodeSellEventAmm(data));
      return { pool: e.pool, isBuy: false, user: e.user, timestamp: Number(e.timestamp), baseAmount: e.baseAmountIn, quoteAmount: e.quoteAmountOut, poolBaseReserves: e.poolBaseTokenReserves, poolQuoteReserves: e.poolQuoteTokenReserves };
    }
    default:
      throw new Error(`unknown event ${name}`);
  }
}

// ---------------------------------------------------------------- accounts
/** `BondingCurve` account → plain object. `quoteMint` null means SOL (the zero key on chain). */
export function decodeCurve(data, pubkey = null) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (!buf.subarray(0, 8).equals(BONDING_CURVE_DISCRIMINATOR)) throw new Error("not a BondingCurve account");
  const c = plain(PUMP_SDK.decodeBondingCurve({ data: buf, owner: PUMP_PROGRAM_ID, executable: false, lamports: 0 }));
  const migrated = c.realQuoteReserves === "0" && c.virtualQuoteReserves === "0" && c.realTokenReserves === "0" && c.virtualTokenReserves === "0";
  return {
    curve: pubkey ? b58(pubkey) : null,
    virtualTokenReserves: c.virtualTokenReserves, virtualQuoteReserves: c.virtualQuoteReserves,
    realTokenReserves: c.realTokenReserves, realQuoteReserves: c.realQuoteReserves,
    tokenTotalSupply: c.tokenTotalSupply, complete: !!c.complete, migrated,
    creator: c.creator, mayhem: !!c.isMayhemMode, holderReward: !!c.isHolderReward,
    quoteMint: c.quoteMint === ZERO_KEY ? null : c.quoteMint,
    creatorFeeBps: Number(c.creatorFeeBps), depth: Number(c.depth),
    creatorFee: c.creatorFee ?? "0", // creator fees accrued on the curve, not yet swept to the vault (treasury)
    initialVirtualQuoteReserves: c.initialVirtualQuoteReserves,
  };
}

/** `SharingConfig` (pump-fees) → `[{address, bps}]`, or null for a non-config account. */
export function decodeShares(data) {
  try {
    const s = PUMP_SDK.decodeSharingConfig({ data: Buffer.from(data), owner: PublicKey.default, executable: false, lamports: 0 });
    return s.shareholders.map((x) => ({ address: b58(x.address), bps: Number(x.shareBps) }));
  } catch { return null; }
}

/**
 * pump-amm `Pool`: the two vault token accounts whose balances are the pool's reserves, plus the
 * signed i128 `virtual_quote_reserves` the program adds to the quote side when it prices a chain.
 */
export function decodePool(data) {
  const buf = Buffer.from(data);
  if (buf.length < 203 || !buf.subarray(0, 8).equals(POOL_DISCRIMINATOR)) return null;
  // discriminator 8 + bump 1 + index 2 + creator 32 + base_mint 32 + quote_mint 32 + lp_mint 32 = 139
  const key = (o) => new PublicKey(buf.subarray(o, o + 32)).toBase58();
  let virtualQuoteReserves = "0", creatorFees = "0";
  if (buf.length >= 261) {
    // 203 + lp_supply 8 + coin_creator 32 + is_mayhem 1 + is_cashback 1 = 245
    const lo = buf.readBigUInt64LE(245), hi = buf.readBigInt64LE(253);
    virtualQuoteReserves = ((hi << 64n) | lo).toString();
  }
  // 261 + creator_fee_bps 8 + can_edit_creator_fee 1 + is_holder_reward 1 + protocol_fees 8 = 279: the pool's
  // unswept creator-fee bucket (pump-amm `sweep_creator_fee` moves it to the AMM creator vault; treasury).
  if (buf.length >= 287) creatorFees = buf.readBigUInt64LE(279).toString();
  return { baseMint: key(43), quoteMint: key(75), baseVault: key(139), quoteVault: key(171), virtualQuoteReserves, creatorFees };
}

/** SPL / Token-2022 token account: mint, owner and amount (u64 at offset 64). Null when too short. */
export function decodeTokenAccount(data) {
  const buf = Buffer.from(data);
  if (buf.length < 72) return null;
  return { mint: new PublicKey(buf.subarray(0, 32)).toBase58(), owner: new PublicKey(buf.subarray(32, 64)).toBase58(), amount: buf.readBigUInt64LE(64).toString() };
}

// Borsh string: u32 length prefix, utf8 bytes; Metaplex pads with NULs to a fixed width.
function borshString(buf, offset) {
  const len = buf.readUInt32LE(offset);
  const end = offset + 4 + len;
  if (end > buf.length) throw new RangeError("string runs past the buffer");
  return { value: buf.subarray(offset + 4, end).toString("utf8").replace(/\0+$/, "").trim(), next: end };
}

/** Metaplex `Metadata` account → `{name, symbol, uri}`. Key(1) + updateAuthority(32) + mint(32) precede the data. */
export function decodeMetaplex(data) {
  const buf = Buffer.from(data);
  if (buf.length < 65 + 4) return null;
  try {
    const name = borshString(buf, 65);
    const symbol = borshString(buf, name.next);
    const uri = borshString(buf, symbol.next);
    return { name: name.value || null, symbol: symbol.value || null, uri: uri.value || null };
  } catch { return null; }
}

const EXT_TOKEN_METADATA = 19;
/**
 * Mint account → decimals, supply, owning token program and, for Token-2022 mints carrying the
 * `TokenMetadata` extension (every `create_v2` coin), the on-chain name/symbol/uri. Reading it here
 * means the metadata of a new coin costs no RPC call beyond the mint fetch we need for decimals.
 */
export function decodeMint(data, owner) {
  const buf = Buffer.from(data);
  if (buf.length < 82) return null;
  const tokenProgram = b58(owner);
  const out = { decimals: buf[44], supply: buf.readBigUInt64LE(36).toString(), tokenProgram, metadata: null };
  if (tokenProgram !== TOKEN_2022_PROGRAM_ID.toBase58() || buf.length < 166 || buf[165] !== 1) return out;
  // TLV extensions start at 166: [type u16][len u16][data].
  let o = 166;
  while (o + 4 <= buf.length) {
    const type = buf.readUInt16LE(o), len = buf.readUInt16LE(o + 2);
    const start = o + 4, end = start + len;
    if (end > buf.length) break;
    if (type === EXT_TOKEN_METADATA) {
      try {
        // update_authority(32) + mint(32) then name, symbol, uri as borsh strings.
        const name = borshString(buf, start + 64);
        const symbol = borshString(buf, name.next);
        const uri = borshString(buf, symbol.next);
        out.metadata = { name: name.value || null, symbol: symbol.value || null, uri: uri.value || null };
      } catch { /* a malformed extension leaves metadata null; the Metaplex fallback still runs */ }
      break;
    }
    o = end;
  }
  return out;
}

export const isTokenProgram = (owner) => owner === TOKEN_PROGRAM_ID.toBase58() || owner === TOKEN_2022_PROGRAM_ID.toBase58();

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
/** base58 → bytes (the inverse of indexer.mjs's `bs58`); throws on a character outside the alphabet. */
export function fromBase58(s) {
  let n = 0n;
  for (const ch of String(s)) { const v = B58.indexOf(ch); if (v < 0) throw new Error("invalid base58"); n = n * 58n + BigInt(v); }
  const out = [];
  while (n > 0n) { out.unshift(Number(n % 256n)); n /= 256n; }
  for (const ch of String(s)) { if (ch !== "1") break; out.unshift(0); }
  return Buffer.from(out);
}
