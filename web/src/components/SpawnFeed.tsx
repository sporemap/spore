import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type Coin } from "../lib/api";
import { recentCoins, useEvents, useStreamStatus } from "../lib/events";
import { useAsync, useTick } from "../lib/hooks";
import { age, usd } from "../lib/format";
import { DepthBadge, Empty, ErrorBox, Logo, ParentPill, SkeletonRows, nameOf, sym } from "./Bits";
import "./discover.css";

const STATUS_LABEL = { idle: "offline", connecting: "connecting", live: "live", reconnecting: "reconnecting" } as const;
/// The SSE connection state as a dot + word; used in the nav and above the feed.
export function LiveDot({ short = false }: { short?: boolean }) {
  const s = useStreamStatus();
  return <span className={`live ${s}`} title={`event stream: ${STATUS_LABEL[s]}`}><i aria-hidden="true" />{short ? null : STATUS_LABEL[s]}</span>;
}

/// Tracks which mints arrived live in the last few seconds so rows can flash once.
function useFresh(ms = 5_000): [Set<string>, (mint: string) => void] {
  const [fresh, setFresh] = useState<Set<string>>(() => new Set());
  const mark = (mint: string) => {
    setFresh((s) => new Set(s).add(mint));
    setTimeout(() => setFresh((s) => { const n = new Set(s); n.delete(mint); return n; }), ms);
  };
  return [fresh, mark];
}

/// Newest launches (in ours mode every coin launched here, roots included): one GET for the
/// backlog, then SSE `coin` events prepend live rows with a short highlight. Ages tick every 10 s
/// without refetching.
export default function SpawnFeed({ limit = 12 }: { limit?: number }) {
  const feed = useAsync(() => api.feed(limit), [limit]);
  const [fresh, mark] = useFresh();
  useTick(10_000);
  useEvents({
    coin: (c: Coin) => {
      feed.setData((d) => {
        const coins = d?.coins ?? [];
        if (coins.some((x) => x.mint === c.mint)) return d;
        return { coins: [c, ...coins].slice(0, limit) };
      });
      mark(c.mint);
    },
  });
  if (feed.loading) return <SkeletonRows n={Math.min(limit, 8)} h={52} />;
  if (feed.error && !feed.data) return <ErrorBox error={feed.error} retry={feed.reload} />;
  const coins = feed.data?.coins ?? [];
  if (!coins.length) return <Empty title="Nothing launched yet — launch the first coin" hint="Spore lists only coins launched here; a new coin shows up the moment it is created." action={<Link className="btn sm accent" to="/launch">Launch a coin</Link>} />;
  return (
    <ol className="feed" aria-live="polite">
      {coins.map((c) => (
        <li key={c.mint} className={`feed-row ${fresh.has(c.mint) ? "fresh" : ""}`}>
          <time className="mono" title={c.createdAt ? new Date(c.createdAt * 1000).toLocaleString() : undefined}>{age(c.createdAt)}</time>
          <Link to={`/c/${c.mint}`} className="feed-coin">
            <Logo src={c.image} label={c.symbol} size={30} />
            <span className="feed-text"><b>{nameOf(c)}</b> <span className="mono muted">{sym(c)}</span></span>
          </Link>
          <span className="feed-parent"><ParentPill parent={c.parent} /></span>
          <DepthBadge depth={c.depth} />
          <span className="feed-mcap mono">{usd(c.mcapUsd)}</span>
        </li>
      ))}
    </ol>
  );
}

/// One horizontal strip of the latest launches. A launch that lands over SSE slides in at the
/// left edge and flashes; everything else shifts right. Seeded from the stream's recent buffer so
/// a launch seen on another page is still here, then from /api/feed for the backlog.
export function LaunchTicker({ limit = 14 }: { limit?: number }) {
  const [coins, setCoins] = useState<Coin[]>(() => recentCoins().slice(0, limit));
  const [fresh, mark] = useFresh(4_000);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  useTick(10_000);
  useEffect(() => {
    let alive = true;
    api.feed(limit).then((r) => { if (!alive) return; setCoins((cur) => { const seen = new Set(cur.map((c) => c.mint)); return [...cur, ...r.coins.filter((c) => !seen.has(c.mint))].slice(0, limit); }); setState("ready"); })
      .catch(() => { if (alive) setState((s) => (s === "loading" ? "error" : s)); });
    return () => { alive = false; };
  }, [limit]);
  useEvents({ coin: (c) => { setCoins((cur) => (cur.some((x) => x.mint === c.mint) ? cur : [c, ...cur].slice(0, limit))); mark(c.mint); } });
  if (state === "loading" && coins.length === 0) return <div className="lticker sk-lticker" aria-hidden="true">{[0, 1, 2, 3, 4, 5].map((i) => <span key={i} className="sk lticker-skel" />)}</div>;
  if (coins.length === 0) return null;
  return (
    <div className="lticker" role="list" aria-label="Latest launches">
      {coins.map((c) => (
        <Link key={c.mint} to={`/c/${c.mint}`} className={`lticker-item ${fresh.has(c.mint) ? "fresh" : ""}`} role="listitem" title={`${nameOf(c)} ${sym(c)}${c.parent ? ` · under ${sym(c.parent)}` : ""}`}>
          <Logo src={c.image} label={c.symbol} size={26} />
          <span className="lticker-text"><b>{nameOf(c)}</b><span className="mono">{sym(c)}</span></span>
          {c.parent ? <span className="lticker-under mono">↳ {sym(c.parent)}</span> : <span className="lticker-under mono root">root</span>}
          <time className="mono">{age(c.createdAt)}</time>
        </Link>
      ))}
    </div>
  );
}
