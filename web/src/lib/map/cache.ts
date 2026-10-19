// IndexedDB cache of the whole map (DESIGN §11.5 "Delta sync + client cache"): every node keyed by mint,
// its last layout position, and the server's `generatedAt` so the next open only asks for what changed.
// No dependency: three object stores and a handful of promisified requests. Every call swallows a
// missing or broken IndexedDB (private mode, storage pressure) and the caller falls back to the network.
import type { BubbleNode } from "./types";

/// Bump when the record shape changes: the upgrade handler drops every store, so an old cache is cleared.
export const CACHE_V = 2;
const DB_NAME = "spore-map";
const CHUNK = 2500;

export type CacheMeta = { generatedAt: number; savedAt: number; count: number };
export type CachedMap = { nodes: BubbleNode[]; meta: CacheMeta };
type Pos = { mint: string; x: number; y: number };

const hasIdb = () => typeof indexedDB !== "undefined";
const req = <T,>(r: IDBRequest<T>): Promise<T> => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error ?? new Error("idb")); });
const done = (tx: IDBTransaction): Promise<void> => new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error ?? new Error("idb tx")); tx.onabort = () => rej(tx.error ?? new Error("idb abort")); });

let dbp: Promise<IDBDatabase | null> | null = null;
function open(): Promise<IDBDatabase | null> {
  if (dbp) return dbp;
  dbp = new Promise((res) => {
    if (!hasIdb()) return res(null);
    let r: IDBOpenDBRequest;
    try { r = indexedDB.open(DB_NAME, CACHE_V); } catch { return res(null); }
    r.onupgradeneeded = () => {
      const db = r.result;
      for (const name of Array.from(db.objectStoreNames)) db.deleteObjectStore(name);
      db.createObjectStore("nodes", { keyPath: "mint" });
      db.createObjectStore("pos", { keyPath: "mint" });
      db.createObjectStore("meta", { keyPath: "key" });
    };
    r.onsuccess = () => { const db = r.result; db.onversionchange = () => { db.close(); dbp = null; }; res(db); };
    r.onerror = () => res(null);
    r.onblocked = () => res(null);
  });
  return dbp;
}

/// Everything cached, positions joined in, or null on a cold/broken cache.
export async function loadCache(): Promise<CachedMap | null> {
  try {
    const db = await open();
    if (!db) return null;
    const tx = db.transaction(["nodes", "pos", "meta"], "readonly");
    const [nodes, pos, meta] = await Promise.all([
      req(tx.objectStore("nodes").getAll() as IDBRequest<BubbleNode[]>),
      req(tx.objectStore("pos").getAll() as IDBRequest<Pos[]>),
      req(tx.objectStore("meta").get("map") as IDBRequest<(CacheMeta & { key: string }) | undefined>),
    ]);
    if (!meta || !nodes.length) return null;
    const at = new Map<string, Pos>();
    for (const p of pos) at.set(p.mint, p);
    for (const n of nodes) { const p = at.get(n.mint); if (p) { n.x = p.x; n.y = p.y; } }
    return { nodes, meta: { generatedAt: meta.generatedAt, savedAt: meta.savedAt, count: meta.count } };
  } catch { return null; }
}

/// Upserts nodes in chunks (one transaction each, so a 15 k write never blocks the page), then the
/// meta record last: a write that dies halfway leaves the old `generatedAt`, and the next open simply
/// re-asks for that span. `removed` drops rows (reserved on the server side, honoured here).
export async function saveNodes(nodes: BubbleNode[], generatedAt: number | null, removed: string[] = []): Promise<void> {
  try {
    const db = await open();
    if (!db) return;
    for (let i = 0; i < nodes.length; i += CHUNK) {
      const tx = db.transaction("nodes", "readwrite");
      const st = tx.objectStore("nodes");
      for (const n of nodes.slice(i, i + CHUNK)) { const { x: _x, y: _y, ...rec } = n; st.put(rec); }
      await done(tx);
    }
    if (removed.length) {
      const tx = db.transaction(["nodes", "pos"], "readwrite");
      for (const m of removed) { tx.objectStore("nodes").delete(m); tx.objectStore("pos").delete(m); }
      await done(tx);
    }
    if (generatedAt != null) {
      const tx = db.transaction(["meta", "nodes"], "readwrite");
      const count = await req(tx.objectStore("nodes").count());
      tx.objectStore("meta").put({ key: "map", generatedAt, savedAt: Date.now(), count });
      await done(tx);
    }
  } catch { /* cache is best effort */ }
}

export async function savePositions(pos: Pos[]): Promise<void> {
  try {
    const db = await open();
    if (!db) return;
    for (let i = 0; i < pos.length; i += CHUNK) {
      const tx = db.transaction("pos", "readwrite");
      const st = tx.objectStore("pos");
      for (const p of pos.slice(i, i + CHUNK)) st.put(p);
      await done(tx);
    }
  } catch { /* best effort */ }
}

export async function clearCache(): Promise<void> {
  try {
    const db = await open();
    if (!db) return;
    const tx = db.transaction(["nodes", "pos", "meta"], "readwrite");
    tx.objectStore("nodes").clear(); tx.objectStore("pos").clear(); tx.objectStore("meta").clear();
    await done(tx);
  } catch { /* best effort */ }
}
