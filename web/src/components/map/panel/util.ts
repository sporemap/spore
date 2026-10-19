// Small hooks shared by the map page's panels.
import { useEffect, useRef, useState } from "react";

/// Trailing throttle: `value` as of at most `ms` ago, updated at most once per `ms`. The map's node list
/// changes identity on every live event; summaries (chip counts, rails, the digest) read this instead,
/// so a burst of events costs one recompute, not one per event. The first change after a quiet period
/// (the data arriving after mount) goes through at once.
export function useThrottled<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  const cur = useRef(value);
  const last = useRef(0);
  useEffect(() => {
    if (Object.is(value, cur.current)) return;
    const wait = Math.max(0, last.current + ms - Date.now());
    const t = setTimeout(() => { last.current = Date.now(); cur.current = value; setV(() => value); }, wait);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}
