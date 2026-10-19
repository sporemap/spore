import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";

type Kind = "info" | "success" | "error";
type Link = { href: string; label: string };
type Toast = { id: number; kind: Kind; text: string; link?: Link; cycle: number; leaving: boolean };
type ToastApi = {
  info: (text: string, link?: Link) => void;
  success: (text: string, link?: Link) => void;
  error: (text: string, link?: Link) => void;
};
const Ctx = createContext<ToastApi | null>(null);
let seq = 0;
const TTL = 6_000;    // info/success linger this long; errors stay until dismissed
const LEAVE = 220;    // matches .toast.leaving in styles.css
const MAX = 4;

const ICON: Record<Kind, ReactNode> = {
  info: <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><circle cx="10" cy="10" r="7.5" /><path d="M10 9v5M10 6.5v.2" /></svg>,
  success: <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="10" cy="10" r="7.5" /><path d="m6.5 10.2 2.4 2.4 4.6-4.8" /></svg>,
  error: <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><circle cx="10" cy="10" r="7.5" /><path d="m7.5 7.5 5 5M12.5 7.5l-5 5" /></svg>,
};

/// Bottom-right stack. Errors stay until dismissed; the rest leave after a few seconds with a
/// timer bar that pauses while hovered. An identical message already on screen is bumped instead
/// of stacked, Escape dismisses the newest, and leaving toasts animate out before unmounting.
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const timers = useRef(new Map<number, number>());
  const remove = useCallback((id: number) => {
    const t = timers.current.get(id);
    if (t) { clearTimeout(t); timers.current.delete(id); }
    setItems((l) => l.map((x) => (x.id === id ? { ...x, leaving: true } : x)));
    window.setTimeout(() => setItems((l) => l.filter((x) => x.id !== id)), LEAVE);
  }, []);
  const arm = useCallback((id: number, kind: Kind) => {
    if (kind === "error") return;
    const old = timers.current.get(id);
    if (old) clearTimeout(old);
    timers.current.set(id, window.setTimeout(() => remove(id), TTL));
  }, [remove]);
  const push = useCallback((kind: Kind, text: string, link?: Link) => {
    setItems((l) => {
      const dup = l.find((x) => x.kind === kind && x.text === text && !x.leaving);
      if (dup) { arm(dup.id, kind); return l.map((x) => (x.id === dup.id ? { ...x, link, cycle: x.cycle + 1 } : x)); }
      const id = ++seq;
      arm(id, kind);
      return [...l.slice(-(MAX - 1)), { id, kind, text, link, cycle: 0, leaving: false }];
    });
  }, [arm]);
  // Hovering pauses the countdown (and the bar); leaving the toast restarts a full countdown so
  // the bar and the timer agree.
  const hold = useCallback((id: number) => { const t = timers.current.get(id); if (t) { clearTimeout(t); timers.current.delete(id); } }, []);
  const release = useCallback((id: number, kind: Kind) => { arm(id, kind); setItems((l) => l.map((x) => (x.id === id ? { ...x, cycle: x.cycle + 1 } : x))); }, [arm]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      setItems((l) => { const last = [...l].reverse().find((x) => !x.leaving); if (last) remove(last.id); return l; });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [remove]);
  useEffect(() => () => { timers.current.forEach((t) => clearTimeout(t)); }, []);
  const api = useMemo<ToastApi>(() => ({ info: (t, l) => push("info", t, l), success: (t, l) => push("success", t, l), error: (t, l) => push("error", t, l) }), [push]);
  return (
    <Ctx.Provider value={api}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast ${t.kind} ${t.leaving ? "leaving" : ""}`} role={t.kind === "error" ? "alert" : undefined} onMouseEnter={() => hold(t.id)} onMouseLeave={() => release(t.id, t.kind)}>
            <span className="toast-icon" aria-hidden="true">{ICON[t.kind]}</span>
            <span className="toast-text">{t.text}{t.link && <> · <a href={t.link.href} target="_blank" rel="noreferrer">{t.link.label} ↗</a></>}</span>
            <button type="button" aria-label="Dismiss notification" onClick={() => remove(t.id)}>×</button>
            {t.kind !== "error" && <i key={t.cycle} className="toast-timer" aria-hidden="true" style={{ "--ttl": `${TTL}ms` } as CSSProperties} />}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
export function useToast(): ToastApi {
  const api = useContext(Ctx);
  if (!api) throw new Error("useToast outside ToastProvider");
  return api;
}
