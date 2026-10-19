import { useEffect, useRef, useState } from "react";
import { count, short, usd, clock } from "../../lib/format";
import { mintIn } from "./util";

const TYPES = ["pair", "trade", "heat", "mapdelta", "stats"] as const;
type EventType = (typeof TYPES)[number];
type Line = { id: number; type: EventType; at: number; text: string; raw: string };
type Status = "idle" | "connecting" | "live" | "closed";
const MAX_LINES = 40;
// A public client may hold two streams per IP; a forgotten docs tab should not keep one forever.
const AUTO_STOP_MS = 5 * 60_000;

const sym = (c: { symbol?: string | null; mint?: string } | undefined) => (c?.symbol ? `$${c.symbol}` : short(c?.mint ?? ""));

/// One line per event, in words, with the raw JSON a click away.
function describe(type: EventType, d: Record<string, unknown>): string {
  if (type === "trade") return `${d.isBuy ? "buy " : "sell"} ${usd(d.valueUsd as number | null)} · ${short(String(d.mint ?? ""), 5)}`;
  if (type === "pair") return `${sym(d.coin as never)} launched under ${sym(d.parent as never)}`;
  if (type === "heat") return `${short(String(d.mint ?? ""), 5)} · ${count(d.t1h as number)} trades 1h · ${usd(d.v24 as number)} 24h`;
  if (type === "mapdelta") { const u = (d.updated as { symbol?: string | null; mint?: string }[] | undefined) ?? []; return `${u.length} coin${u.length === 1 ? "" : "s"} moved${u[0] ? ` · ${sym(u[0])}${u.length > 1 ? ` +${u.length - 1}` : ""}` : ""}`; }
  return `${count(d.coins as number)} coins · ${usd(d.lockedUsd as number)} locked`;
}

/// Opens /v1/stream from this page (public tier, no key) and prints what arrives, so a partner
/// can see the event mix and the payloads before writing a client.
export default function StreamConsole() {
  const [types, setTypes] = useState<Set<EventType>>(() => new Set(["pair", "trade", "heat"]));
  const [filter, setFilter] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [note, setNote] = useState<string | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const es = useRef<EventSource | null>(null);
  const stopTimer = useRef<number | undefined>(undefined);
  const seq = useRef(0);

  const stop = (why: string | null = null) => {
    es.current?.close();
    es.current = null;
    window.clearTimeout(stopTimer.current);
    setStatus(why === null ? "idle" : "closed");
    setNote(why);
  };
  useEffect(() => () => { es.current?.close(); window.clearTimeout(stopTimer.current); }, []);

  const start = () => {
    stop();
    const mint = mintIn(filter);
    const q = new URLSearchParams({ types: [...types].join(",") });
    if (mint) q.set("mint", mint);
    const src = new EventSource(`/v1/stream?${q}`);
    es.current = src;
    setStatus("connecting");
    setNote(null);
    src.onopen = () => setStatus("live");
    // EventSource retries on its own after a dropped connection; CLOSED means the server refused
    // the stream (wrong status or content type), which retrying would not fix.
    src.onerror = () => {
      if (src.readyState === EventSource.CLOSED) { if (es.current === src) stop("The stream could not be opened. The public tier allows 2 open streams per IP; the /v1 API may also be unavailable on this host."); }
      else setStatus("connecting");
    };
    for (const t of types) {
      src.addEventListener(t, (ev) => {
        const raw = (ev as MessageEvent<string>).data;
        let text = raw.slice(0, 120);
        try { text = describe(t, JSON.parse(raw)); } catch { /* show the raw prefix */ }
        setLines((ls) => [{ id: ++seq.current, type: t, at: Date.now() / 1000, text, raw }, ...ls].slice(0, MAX_LINES));
      });
    }
    stopTimer.current = window.setTimeout(() => stop("Stopped after 5 minutes so a forgotten tab does not hold a stream. Connect again to continue."), AUTO_STOP_MS);
  };

  const toggle = (t: EventType) => setTypes((s) => { const n = new Set(s); if (n.has(t)) { if (n.size > 1) n.delete(t); } else n.add(t); return n; });
  const on = status === "live" || status === "connecting";
  const pretty = (raw: string) => { try { return JSON.stringify(JSON.parse(raw), null, 2); } catch { return raw; } };
  return (
    <div className="docs-console card">
      <div className="docs-console-controls">
        <div className="docs-console-types" role="group" aria-label="Event types">
          {TYPES.map((t) => <label key={t} className={`docs-check type-${t}`}><input type="checkbox" checked={types.has(t)} onChange={() => toggle(t)} disabled={on} /><span>{t}</span></label>)}
        </div>
        <label className="field docs-console-mint">
          <span>Only one tree (optional)</span>
          <input className="input mono" type="text" autoComplete="off" spellCheck={false} value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="root or coin mint" disabled={on} />
        </label>
        <div className="docs-console-actions">
          {on ? <button type="button" className="btn sm" onClick={() => stop()}>Disconnect</button> : <button type="button" className="btn sm accent" onClick={start}>Connect</button>}
          <span className={`docs-status ${status}`} aria-live="polite"><i />{status === "live" ? "live" : status === "connecting" ? "connecting" : status === "closed" ? "closed" : "not connected"}</span>
          {lines.length > 0 && !on && <button type="button" className="linkish" onClick={() => setLines([])}>Clear</button>}
        </div>
      </div>
      {note && <p className="docs-live-error" role="status">{note}</p>}
      <ol className="docs-console-log" aria-label="Received events" aria-live="off">
        {lines.length === 0 ? <li className="docs-console-empty">{on ? "Waiting for the first event… trades arrive every few seconds; new pairs are rarer." : "Press Connect to open the stream from this page."}</li>
          : lines.map((l) => (
            <li key={l.id}>
              <details>
                <summary><time className="mono">{clock(l.at)}</time><span className={`docs-ev type-${l.type}`}>{l.type}</span><span className="docs-console-text">{l.text}</span></summary>
                <pre><code>{pretty(l.raw)}</code></pre>
              </details>
            </li>
          ))}
      </ol>
    </div>
  );
}
