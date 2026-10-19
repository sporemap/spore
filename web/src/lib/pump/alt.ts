// pump's create_v2 with a pump-coin quote and multi_hop_swap carry too many accounts for a legacy
// transaction (1232 bytes), so transactions reference a public address lookup table holding the
// static accounts every pump transaction uses (programs, pump PDAs, fee recipients and their WSOL
// accounts). It is Spore's own table 5WK4ta…PQRnx (56 entries, created and frozen 2026-10-18 by the
// platform wallet: no authority, so it can never change or close).
import { PublicKey, type AddressLookupTableAccount, type Connection } from "@solana/web3.js";

export const LOOKUP_TABLE = new PublicKey("5WK4tafybAnHV4grvSipYfLfV8Bd7Rzcwb5eNE1PQRnx");
const cache = new WeakMap<Connection, Promise<AddressLookupTableAccount[]>>();

/// The table's entries, fetched once per connection. A fetch failure is not cached and throws:
/// compiling without the table would silently push every launch into the two-transaction path.
export function lookupTables(conn: Connection): Promise<AddressLookupTableAccount[]> {
  let p = cache.get(conn);
  if (!p) {
    p = conn.getAddressLookupTable(LOOKUP_TABLE, { commitment: "confirmed" }).then((r) => {
      if (!r.value) throw new Error(`Spore's address lookup table ${LOOKUP_TABLE.toBase58().slice(0, 8)}… was not found; try again`);
      return [r.value];
    });
    p.catch(() => cache.delete(conn));
    cache.set(conn, p);
  }
  return p;
}
