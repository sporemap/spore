// The map's data: cache first, then only what changed (DESIGN §11.5). On mount the IndexedDB cache is
// rendered at once; `GET /api/map?scope=all&limit=all&since=<generatedAt>` then merges the delta. A cold
// cache does one full load. Live `pair` / `mapdelta` / `coin` events patch the same set, and every change
// is written back so the next open is already current. Unchanged nodes keep their object identity, which
// is what lets BubbleMap diff 15 k nodes in a millisecond instead of restarting.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, errorMessage, type Coin, type MapCoin } from "../api";
import { useEvents, useStreamStatus } from "../events";
import { loadCache, saveNodes, savePositions } from "./cache";
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
};

const RESYNC_MS = 120_000;
const FLUSH_MS = 2_000;

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
        const keep = new Set(norm.nodes.map((n) => n.mint));
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
      if (changed.length || removed.length) bump();
      if (since == null) void saveNodes(norm.nodes, gen.current, removed); // the full set, so an empty cache is filled even when nothing "changed"
      else if (changed.length || removed.length) { markDirty(changed); if (removed.length) void saveNodes([], gen.current, removed); }
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
    (async () => {
      const cached = await loadCache();
      if (!alive.current) return;
      if (cached) {
        upsert(set.current, cached.nodes);
        gen.current = cached.meta.generatedAt;
        setCacheInfo({ count: cached.nodes.length, generatedAt: cached.meta.generatedAt, ageMs: Date.now() - cached.meta.savedAt });
        setSource("cache");
        setLoading(false);
        setVersion((v) => v + 1);
        await sync(cached.meta.generatedAt);
      } else {
        setCacheInfo(null);
        await sync(null);
      }
    })();
    const t = setInterval(() => { if (!document.hidden) void sync(gen.current); }, RESYNC_MS);
    return () => { alive.current = false; clearInterval(t); if (bumpTimer.current) clearTimeout(bumpTimer.current); if (flushTimer.current) { clearTimeout(flushTimer.current); flush(); } };
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
    pair: (p) => { const ch = applyPair(set.current, p); if (ch.length) { fresh.current.add(p.coin.mint); markDirty(ch); bump(); } },
    mapdelta: (d) => { const ch = applyDelta(set.current, d.updated); if (ch.length) { markDirty(ch); bump(); } },
    // `coin` is ours-only in production but carries every spawn on an all-mode server: harmless either way.
    coin: (c) => { if (!c.parent?.mint || set.current.has(c.mint)) return; const ch = applyPair(set.current, { coin: coinToMap(c), parent: { mint: c.parent.mint, name: c.parent.name, symbol: c.parent.symbol, image: c.parent.image, depth: c.parent.depth, mcapUsd: null, lockedUsd: null, children: 1, descendants: 1, migrated: false, createdAt: null } }); if (ch.length) { fresh.current.add(c.mint); markDirty(ch); bump(); } },
  }, enabled);

  const reload = useCallback(() => { setError(null); void sync(gen.current); }, [sync]);
  const persistPositions = useCallback((pos: { mint: string; x: number; y: number }[]) => { if (pos.length) void savePositions(pos); }, []);

  const nodes = useMemo(() => {
    const list = Array.from(set.current.values());
    return stress > list.length && import.meta.env.DEV ? stressSet(set.current, stress) : list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, stress]);

  return { nodes, version, generatedAt: gen.current, loading, syncing, error, source, total: set.current.size, fresh: fresh.current, reload, persistPositions, cacheInfo };
}
