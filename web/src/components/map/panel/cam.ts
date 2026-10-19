// The map's zoom level as a tiny external store: BubbleMap reports it (≤ 4 Hz) through `onCamera`, and
// only the components that draw from it (the Key's true-scale size circles, the centred hint) re-render.
// The page itself never re-renders on a camera move.
import { useSyncExternalStore } from "react";

export type CamStore = { set: (c: { k: number }) => void; get: () => number; subscribe: (f: () => void) => () => void };

export function createCamStore(k0 = 1): CamStore {
  let k = k0;
  const subs = new Set<() => void>();
  return {
    set: (c) => { if (Number.isFinite(c.k) && c.k !== k) { k = c.k; subs.forEach((f) => f()); } },
    get: () => k,
    subscribe: (f) => { subs.add(f); return () => { subs.delete(f); }; },
  };
}

export const useCamK = (store: CamStore): number => useSyncExternalStore(store.subscribe, store.get, store.get);
