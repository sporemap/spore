// The map's data: cache first, then only what changed (DESIGN §11.5). On mount the IndexedDB cache is
// rendered at once; `GET /api/map?scope=all&limit=all&since=<generatedAt>` then merges the delta. A cold
// cache does one full load. Live `pair` / `mapdelta` / `coin` events patch the same set, and every change
// is written back so the next open is already current. Unchanged nodes keep their object identity, which
// is what lets BubbleMap diff 15 k nodes in a millisecond instead of restarting.
//
// `since=` only carries coins whose own row changed, so the USD values of a warm cache drift as SOL and
// parent prices move: when the cache's last complete load is older than FULL_EVERY_MS, the request after
// painting the cache is a full one, and an open page re-syncs in full on the same period. The previous
// visit's end ("seen") is read once at load for "since your last visit" and written only when the page is
// left (pagehide, unmount). `recent` holds the pairs that arrived live, newest first.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, errorMessage, type Coin, type MapCoin } from "../api";
import { useEvents, useStreamStatus } from "../events";
import { loadCache, loadStamps, saveFull, saveNodes, savePositions, saveSeen } from "./cache";
import { applyDelta, applyPair, normalise, remove, stress as stressSet, upsert, type NodeSet } from "./nodes";
import type { BubbleNode } from "./types";

export type MapSource = "cache" | "network" | null;
export type MapData = {
  nodes: BubbleNode[]; version: number; generatedAt: number | null; loading: boolean; syncing: boolean; error: string | null; source: MapSource; total: number;
  /// Mints that arrived live (pulse animation); cleared by BubbleMap once drawn.
  fresh: Set<string>;
  reload: () => void;
  /// BubbleMap hands back settled positions; they go to the cache so the next open skips the layout.
  persistPositions: (pos: { mint: string; x: number; y: number }[]) => void;
  /// For the dev console / perf script: when the cache was read and how many it held.
  cacheInfo: { count: number; generatedAt: number; ageMs: number } | null;
  /// Epoch ms when the previous visit ended (null on a first visit); fixed for the life of the page.
  seenAt: number | null;
  /// Epoch ms of the last complete (non-delta) load the client holds, null when it has never had one.
  fullAt: number | null;
  /// Pairs that arrived live in this session, newest first (≤ RECENT_CAP), a new array per version.
  recent: BubbleNode[];
};

const RESYNC_MS = 120_000;
const FLUSH_MS = 2_000;
/// A warm cache older than this (since its last complete load) is re-synced in full: bounds USD drift.
export const FULL_EVERY_MS = 15 * 60_000;
const RECENT_CAP = 30;
/// A coin inserted live this recently is kept even when a full tree does not list it: the server builds
/// that tree at most every 10 s, so a pair that arrived meanwhile is simply not in it yet.
const LIVE_GRACE_MS = 60_000;

/// True when the next sync must be a full one: never had a complete load, or the last one is stale.
export const needsFull = (fullAt: number | null, now: number): boolean => fullAt == null || !Number.isFinite(fullAt) || now - fullAt > FULL_EVERY_MS;

const coinToMap = (c: Coin): MapCoin => ({ mint: c.mint, parentMint: c.parent?.mint ?? null, depth: c.depth, name: c.name, symbol: c.symbol, image: c.image, mcapUsd: c.mcapUsd, lockedUsd: c.lockedUsd, children: c.children, descendants: c.descendants, migrated: c.migrated, ours: !!c.ours, createdAt: c.createdAt, updatedAt: c.updatedAt ? c.updatedAt * 1000 : undefined });

export function useMapData({ stress = 0, enabled = true }: { stress?: number; enabled?: boolean } = {}): MapData {
  const set = useRef<NodeSet>(new Map());
  const gen = useRef<number | null>(null);
  const dirty = useRef<Map<string, BubbleNode>>(new Map());
  const fresh = useRef(new Set<string>());
  const [version, setVersion] = useState(0);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState<MapSource>(null);
  const [cacheInfo, setCacheInfo] = useState<MapData["cacheInfo"]>(null);
  const bumpTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);
  const inflight = useRef<Promise<void> | null>(null);
  const cacheRead = useRef<ReturnType<typeof loadCache> | null>(null);
  const fullAtRef = useRef<number | null>(null);
  const [fullAt, setFullAt] = useState<number | null>(null);
  const [seenAt, setSeenAt] = useState<number | null>(null);
  const recentRef = useRef<BubbleNode[]>([]);
  /// mint → when it was inserted from the event stream (pruned past LIVE_GRACE_MS)
  const liveAt = useRef(new Map<string, number>());
  const pushRecent = useCallback((mint: string, parentMint?: string | null) => {
    const now = Date.now();
    liveAt.current.set(mint, now);
    if (parentMint) liveAt.current.set(parentMint, now);
    const n = set.current.get(mint);
    if (!n) return;
    const list = recentRef.current.filter((x) => x.mint !== mint);
    list.unshift(n);
    if (list.length > RECENT_CAP) list.length = RECENT_CAP;
    recentRef.current = list;
  }, []);

  // Many events can land in one tick; one re-render per ~80 ms is plenty for a canvas that reads refs.
  const bump = useCallback(() => { if (bumpTimer.current) return; bumpTimer.current = setTimeout(() => { bumpTimer.current = null; if (alive.current) setVersion((v) => v + 1); }, 80); }, []);
  const flush = useCallback(() => {
    flushTimer.current = null;
    if (!dirty.current.size) return;
    const rows = Array.from(dirty.current.values());
    dirty.current = new Map();
    void saveNodes(rows, gen.current);
  }, []);
  const markDirty = useCallback((rows: BubbleNode[]) => {
    for (const r of rows) dirty.current.set(r.mint, r);
    if (!flushTimer.current) flushTimer.current = setTimeout(flush, FLUSH_MS);
  }, [flush]);

  /// One request: full (since = null) or delta. A full tree replaces the set (nodes the server no
  /// longer lists are dropped); a delta upserts. Either way the merge is incremental for the map.
  const sync = useCallback((since: number | null) => {
    if (inflight.current) return inflight.current;
    setSyncing(true);
    const p = api.map({ scope: "all", limit: "all", since: since ?? undefined }).then((res) => {
      if (!alive.current) return;
      const norm = normalise(res);
      const s = set.current;
      let changed: BubbleNode[] = [];
      let removed: string[] = norm.removed;
      if (since == null && norm.tree) {
        // a full tree replaces the set, except coins that arrived live after the server built it
        const keep = new Set(norm.nodes.map((n) => n.mint));
        const now = Date.now();
        for (const [m, at] of liveAt.current) if (now - at > LIVE_GRACE_MS) liveAt.current.delete(m); else keep.add(m);
        removed = Array.from(s.keys()).filter((m) => !keep.has(m));
        remove(s, removed);
        changed = upsert(s, norm.nodes);
      } else {
        remove(s, removed);
        changed = upsert(s, norm.nodes);
      }
      gen.current = norm.generatedAt ?? Date.now();
      setError(null);
      setSource("network");
      setLoading(false);
      // Render first, persist after: the 15 k-row cache write takes a second on a slow disk and must
      // never sit between the data and the first bubbles (the next open re-asks the span if it dies).
      // A full load publishes its version in the same tick as `loading = false`, so the page never sees
      // "loaded" with an empty set (which used to widen a phone deep link to every root).
      if (since == null) {
        if (changed.length || removed.length) { if (bumpTimer.current) { clearTimeout(bumpTimer.current); bumpTimer.current = null; } setVersion((v) => v + 1); }
        const at = Date.now();
        fullAtRef.current = at; setFullAt(at);
        // the full set, so an empty cache is filled even when nothing "changed"; the "full" stamp only
        // once those rows are stored, so it never claims a complete cache that is not
        void saveNodes(norm.nodes, gen.current, removed).then(() => saveFull(at));
      } else if (changed.length || removed.length) { bump(); markDirty(changed); if (removed.length) void saveNodes([], gen.current, removed); }
      else void saveNodes([], gen.current); // only the stamp moved
    }).catch((e) => {
      if (!alive.current) return;
      setError(errorMessage(e));
      setLoading(false);
    }).finally(() => { inflight.current = null; if (alive.current) setSyncing(false); });
    inflight.current = p;
    return p;
  }, [bump, markDirty]);

  useEffect(() => {
    alive.current = true;
    if (!enabled) return;
    // Per run, not per hook: a development double-mount must not let the first run's cache read fire a
    // second request. Both runs share one read, so the surviving run paints as early as the first would.
    let cancelled = false;
    const read = cacheRead.current ?? (cacheRead.current = loadCache());
    (async () => {
      const cached = await read;
      if (cancelled || !alive.current) return;
      cacheRead.current = null;
      if (cached) {
        upsert(set.current, cached.nodes);
        gen.current = cached.meta.generatedAt;
        fullAtRef.current = cached.meta.fullAt; setFullAt(cached.meta.fullAt);
        setSeenAt(cached.meta.seenAt);
        setCacheInfo({ count: cached.nodes.length, generatedAt: cached.meta.generatedAt, ageMs: Date.now() - cached.meta.savedAt });
        setSource("cache");
        setLoading(false);
        setVersion((v) => v + 1);
        // paint the cache first; then the delta, or everything when the last complete load is stale
        await sync(needsFull(cached.meta.fullAt, Date.now()) ? null : cached.meta.generatedAt);
      } else {
        setCacheInfo(null);
        void loadStamps().then((st) => { if (!cancelled && alive.current) setSeenAt(st.seenAt); });
        await sync(null);
      }
    })();
    const t = setInterval(() => { if (!document.hidden) void sync(needsFull(fullAtRef.current, Date.now()) ? null : gen.current); }, RESYNC_MS);
    // The end of this visit, for the next one's "since your last visit". Never written at open: a
    // development double-mount unmounts within the same moment, which is not a visit.
    const openedAt = Date.now();
    const seen = () => { if (Date.now() - openedAt > 1_500) void saveSeen(Date.now()); };
    window.addEventListener("pagehide", seen);
    return () => { cancelled = true; alive.current = false; clearInterval(t); window.removeEventListener("pagehide", seen); seen(); if (bumpTimer.current) clearTimeout(bumpTimer.current); if (flushTimer.current) { clearTimeout(flushTimer.current); flush(); } };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  // After a reconnect the stream may have skipped events: ask for the span.
  const status = useStreamStatus();
  const prevStatus = useRef(status);
  useEffect(() => {
    if (status === "live" && prevStatus.current === "reconnecting" && gen.current != null) void sync(gen.current);
    prevStatus.current = status;
  }, [status, sync]);

  useEvents({
    pair: (p) => { const ch = applyPair(set.current, p); if (ch.length) { fresh.current.add(p.coin.mint); pushRecent(p.coin.mint, p.parent?.mint); markDirty(ch); bump(); } },
    mapdelta: (d) => { const ch = applyDelta(set.current, d.updated); if (ch.length) { markDirty(ch); bump(); } },
    // `coin` is ours-only in production but carries every spawn on an all-mode server: harmless either way.
    coin: (c) => { if (!c.parent?.mint || set.current.has(c.mint)) return; const ch = applyPair(set.current, { coin: coinToMap(c), parent: { mint: c.parent.mint, name: c.parent.name, symbol: c.parent.symbol, image: c.parent.image, depth: c.parent.depth, mcapUsd: null, lockedUsd: null, children: 1, descendants: 1, migrated: false, createdAt: null } }); if (ch.length) { fresh.current.add(c.mint); pushRecent(c.mint, c.parent.mint); markDirty(ch); bump(); } },
  }, enabled);

  const reload = useCallback(() => { setError(null); void sync(gen.current); }, [sync]);
  const persistPositions = useCallback((pos: { mint: string; x: number; y: number }[]) => { if (pos.length) void savePositions(pos); }, []);

  const nodes = useMemo(() => {
    const list = Array.from(set.current.values());
    return stress > list.length && import.meta.env.DEV ? stressSet(set.current, stress) : list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, stress]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const recent = useMemo(() => recentRef.current.slice(), [version]);

  return { nodes, version, generatedAt: gen.current, loading, syncing, error, source, total: set.current.size, fresh: fresh.current, reload, persistPositions, cacheInfo, seenAt, fullAt, recent };
}
