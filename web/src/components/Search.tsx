import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api, errorMessage, type Coin } from "../lib/api";
import { useDebounced } from "../lib/hooks";
import { usd } from "../lib/format";
import { DepthBadge, Logo, nameOf, sym } from "./Bits";

type Props = { onPick?: (c: Coin) => void; placeholder?: string; size?: "sm" | "lg"; autoFocus?: boolean; clearOnPick?: boolean };

/// Typeahead over /api/search: name/ticker prefix or an exact mint. Stale responses are aborted so
/// a fast typist never sees results for an older query. Arrow keys + Enter pick; Esc closes.
export default function Search({ onPick, placeholder = "Search name, ticker or mint", size = "sm", autoFocus = false, clearOnPick = true }: Props) {
  const nav = useNavigate();
  const [q, setQ] = useState("");
  const dq = useDebounced(q.trim(), 220);
  const [results, setResults] = useState<Coin[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const listId = useId();

  useEffect(() => {
    if (dq.length < 1) { setResults([]); setError(null); setBusy(false); return; }
    const ctl = new AbortController();
    setBusy(true);
    api.search(dq, ctl.signal).then((r) => { setResults(r.coins); setError(null); setActive(0); })
      .catch((e) => { if ((e as Error).name !== "AbortError") { setResults([]); setError(errorMessage(e)); } })
      .finally(() => { if (!ctl.signal.aborted) setBusy(false); });
    return () => ctl.abort();
  }, [dq]);
  useEffect(() => {
    const onDoc = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const pick = (c: Coin) => {
    setOpen(false);
    if (clearOnPick) setQ("");
    if (onPick) onPick(c); else nav(`/c/${c.mint}`);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") { setOpen(false); return; }
    if (!results.length) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => (a + 1) % results.length); setOpen(true); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => (a - 1 + results.length) % results.length); setOpen(true); }
    else if (e.key === "Enter") { e.preventDefault(); const c = results[active]; if (c) pick(c); }
  };
  const showList = open && q.trim().length > 0;
  return (
    <div className={`search ${size}`} ref={box}>
      <svg className="search-icon" viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><circle cx="9" cy="9" r="6" fill="none" stroke="currentColor" strokeWidth="1.8" /><path d="M13.5 13.5 18 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
      <input className="input" value={q} placeholder={placeholder} autoFocus={autoFocus} spellCheck={false} autoComplete="off" role="combobox" aria-expanded={showList} aria-controls={listId} aria-autocomplete="list"
        onChange={(e) => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} onKeyDown={onKey} />
      {busy && <span className="search-busy" aria-hidden="true" />}
      {showList && (
        <div className="search-pop" id={listId} role="listbox">
          {error ? <div className="search-note">{error}</div>
            : results.length === 0 ? (busy ? <div className="search-note">Searching…</div> : <div className="search-note">{/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(q.trim()) ? "No pump.fun coin has this mint (or it was created seconds ago — try again)." : `No coin matches “${q.trim()}”.`}</div>)
            : results.map((c, i) => (
              <div key={c.mint} role="option" aria-selected={i === active} className={`search-row ${i === active ? "active" : ""}`} onMouseEnter={() => setActive(i)} onMouseDown={(e) => { e.preventDefault(); pick(c); }}>
                <Logo src={c.image} label={c.symbol} size={28} />
                <span className="search-main"><b>{nameOf(c)}</b> <span className="muted">{sym(c)}</span></span>
                <span className="search-meta"><DepthBadge depth={c.depth} />{c.mcapUsd != null && <span className="mono">{usd(c.mcapUsd)}</span>}</span>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
