// Fee-account fixtures shared by the treasury and fees tests: a SharingConfig account encoded the
// way pump-fees lays it out (disc 8, bump, version, status, mint 32, admin 32, admin_revoked,
// vec<Shareholder{pubkey, u16}>), a pump-amm Pool with a creator-fee bucket, SPL token accounts and
// the real depth-2 curve fixture with its reserves zeroed so it decodes as migrated.
import { readFileSync } from "node:fs";
import { PUMP_FEE_PROGRAM_ID, PUMP_AMM_PROGRAM_ID, pk } from "../../lib/sdk.mjs";
import { POOL_DISCRIMINATOR } from "../../lib/decode.mjs";
import { T22 } from "./tree.mjs";

const fixture = JSON.parse(readFileSync(new URL("../fixtures/accounts.json", import.meta.url), "utf8")).accounts.curve;
const raw = Buffer.from(fixture.data, "base64"); // a real (migrated, holder-reward, empty-bucket) curve: the fields below are rewritten per case
export const BUCKET = 123_456_789n;
/**
 * The fixture curve with the fields the fee reader looks at set per case: reserves (8..40, zero =
 * migrated), `complete` (48), `is_holder_reward` (124) and the `creator_fee` bucket (125).
 */
export function curveAccountWith({ bucket = BUCKET, migrated = false, holderReward = false } = {}) {
  const data = Buffer.from(raw);
  if (migrated) data.fill(0, 8, 40);
  else { data.writeBigUInt64LE(1_000_000_000_000_000n, 8); data.writeBigUInt64LE(100_000_000_000n, 16); data.writeBigUInt64LE(500_000_000_000_000n, 24); data.writeBigUInt64LE(1_000_000_000n, 32); }
  data[48] = migrated ? 1 : 0;
  data[124] = holderReward ? 1 : 0;
  data.writeBigUInt64LE(bucket, 125);
  return { owner: fixture.owner, lamports: 1, data, executable: false };
}
export const curveAccount = curveAccountWith();
export const migratedCurveAccount = curveAccountWith({ migrated: true });
export const SYSTEM = "11111111111111111111111111111111";
export const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

export const SHARING_DISC = Buffer.from([216, 74, 9, 0, 56, 140, 93, 75]);
export function sharingAccount(mint, shares, admin = mint) {
  const b = Buffer.alloc(80 + shares.length * 34);
  SHARING_DISC.copy(b, 0);
  b[8] = 255; b[9] = 1; b[10] = 0; // bump, version, status
  pk(mint).toBuffer().copy(b, 11); pk(admin).toBuffer().copy(b, 43); b[75] = 0;
  b.writeUInt32LE(shares.length, 76);
  shares.forEach((s, i) => { pk(s.address).toBuffer().copy(b, 80 + i * 34); b.writeUInt16LE(s.bps, 112 + i * 34); });
  return { owner: PUMP_FEE_PROGRAM_ID.toBase58(), lamports: 1, data: b, executable: false };
}
export function poolAccount(creatorFees) {
  const b = Buffer.alloc(301);
  POOL_DISCRIMINATOR.copy(b, 0);
  b.writeBigUInt64LE(BigInt(creatorFees), 279);
  return { owner: PUMP_AMM_PROGRAM_ID.toBase58(), lamports: 1, data: b, executable: false };
}
export const tokenAccount = (amount, owner = T22) => { const b = Buffer.alloc(165); b.writeBigUInt64LE(BigInt(amount), 64); return { owner, lamports: 2_039_280, data: b, executable: false }; };
export const lamportsAccount = (lamports) => ({ owner: SYSTEM, lamports, data: Buffer.alloc(0), executable: false });
