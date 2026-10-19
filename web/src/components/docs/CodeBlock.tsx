import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { copyText } from "../../lib/hooks";

export type Lang = "json" | "bash" | "js" | "html" | "text";

// One alternation per language; each entry is a regex source with no capturing groups and the
// class it paints. Order matters: the first alternative that matches at a position wins (a JSON
// key is a string followed by a colon, so it is tried before plain strings).
const RULES: Record<Exclude<Lang, "text">, [string, string][]> = {
  json: [
    [String.raw`"(?:[^"\\\n]|\\.)*"(?=\s*:)`, "k"],
    [String.raw`"(?:[^"\\\n]|\\.)*"`, "s"],
    [String.raw`-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b`, "n"],
    [String.raw`\b(?:true|false|null)\b`, "b"],
  ],
  js: [
    [String.raw`\/\/[^\n]*`, "c"],
    [String.raw`"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|\x60(?:[^\x60\\]|\\.)*\x60`, "s"],
    [String.raw`\b(?:const|let|await|async|new|function|return|if|else|for|of|import|from|try|catch|throw)\b`, "kw"],
    [String.raw`\b(?:true|false|null|undefined)\b`, "b"],
    [String.raw`\b\d+(?:\.\d+)?\b`, "n"],
  ],
  bash: [
    [String.raw`(?:^|(?<=\s))#[^\n]*`, "c"],
    [String.raw`"(?:[^"\\]|\\.)*"|'[^']*'`, "s"],
    [String.raw`(?<=\s)--?[A-Za-z][\w-]*`, "f"],
    [String.raw`^(?:curl|node|npx|npm)\b`, "kw"],
  ],
  html: [
    [String.raw`<!--[\s\S]*?-->`, "c"],
    [String.raw`<\/?[A-Za-z][\w-]*|\/?>`, "t"],
    [String.raw`"[^"]*"`, "s"],
    [String.raw`[A-Za-z-]+(?==)`, "a"],
  ],
};
const COMPILED = Object.fromEntries(Object.entries(RULES).map(([lang, rules]) => [lang, { re: new RegExp(rules.map(([src]) => `(${src})`).join("|"), "gm"), classes: rules.map(([, c]) => c) }])) as Record<Exclude<Lang, "text">, { re: RegExp; classes: string[] }>;

/// Splits code into plain text and painted spans. Returns React nodes (never HTML strings), so a
/// pasted mint or any other user text that ends up in a snippet cannot inject markup.
function highlight(code: string, lang: Lang): ReactNode[] {
  if (lang === "text") return [code];
  const { re, classes } = COMPILED[lang];
  const out: ReactNode[] = [];
  let last = 0;
  re.lastIndex = 0;
  for (const m of code.matchAll(re)) {
    const i = m.index ?? 0;
    if (!m[0]) continue;
    if (i > last) out.push(code.slice(last, i));
    const g = m.findIndex((v, k) => k > 0 && v !== undefined);
    out.push(<span key={i} className={`tk-${classes[g - 1]}`}>{m[0]}</span>);
    last = i + m[0].length;
  }
  if (last < code.length) out.push(code.slice(last));
  return out;
}

export function CopyButton({ text, label = "Copy", className = "" }: { text: string; label?: string; className?: string }) {
  const [state, setState] = useState<"idle" | "done" | "fail">("idle");
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const onClick = async () => {
    const ok = await copyText(text);
    setState(ok ? "done" : "fail");
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState("idle"), 1600);
  };
  return (
    <button type="button" className={`docs-copy ${state} ${className}`} onClick={onClick} aria-live="polite">
      {state === "done" ? (
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
      ) : (
        <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5" y="5" width="8.5" height="8.5" rx="2" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="M10.5 3.2V3a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 3v5A1.5 1.5 0 0 0 4 9.5h.3" fill="none" stroke="currentColor" strokeWidth="1.4" /></svg>
      )}
      <span>{state === "done" ? "Copied" : state === "fail" ? "Press ⌘C" : label}</span>
    </button>
  );
}

/// A readable code block: language label, copy button, horizontal scroll inside the block (never
/// the page), an optional caption under it. `tall` caps the height for long JSON responses.
export function CodeBlock({ code, lang = "text", title, caption, tall = false, wrap = false, actions }: { code: string; lang?: Lang; title?: ReactNode; caption?: ReactNode; tall?: boolean; wrap?: boolean; actions?: ReactNode }) {
  return (
    <figure className="docs-code">
      <div className="docs-code-bar">
        <span className="docs-code-lang">{title ?? LANG_LABEL[lang]}</span>
        <span className="docs-code-actions">{actions}<CopyButton text={code} /></span>
      </div>
      <pre className={[tall && "tall", wrap && "wrap"].filter(Boolean).join(" ") || undefined} tabIndex={0}><code>{highlight(code, lang)}</code></pre>
      {caption && <figcaption>{caption}</figcaption>}
    </figure>
  );
}
const LANG_LABEL: Record<Lang, string> = { json: "JSON", bash: "Shell", js: "JavaScript", html: "HTML", text: "Text" };

export type CodeTab = { id: string; label: string; code: string; lang: Lang; caption?: ReactNode };

/// Several versions of one example (curl / fetch / SSE, or two coins) behind a tablist. Arrow
/// keys move between tabs, like every other tablist on the site.
export function CodeTabs({ tabs, tall = false, label, actions, value, onChange }: { tabs: CodeTab[]; tall?: boolean; label: string; actions?: ReactNode; value?: string; onChange?: (id: string) => void }) {
  const [own, setOwn] = useState(tabs[0]?.id);
  // Controlled when the parent passes value (the endpoint card selects its live tab); otherwise local.
  const active = value ?? own;
  const setActive = (id: string) => { setOwn(id); onChange?.(id); };
  const base = useId();
  const cur = tabs.find((t) => t.id === active) ?? tabs[0];
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: React.KeyboardEvent, i: number) => {
    const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const n = (i + d + tabs.length) % tabs.length;
    setActive(tabs[n].id);
    refs.current[n]?.focus();
  };
  if (!cur) return null;
  return (
    <figure className="docs-code">
      <div className="docs-code-bar">
        <div className="docs-tabs" role="tablist" aria-label={label}>
          {tabs.map((t, i) => (
            <button key={t.id} ref={(el) => { refs.current[i] = el; }} type="button" role="tab" id={`${base}-t-${t.id}`} aria-selected={t.id === cur.id} aria-controls={`${base}-p`} tabIndex={t.id === cur.id ? 0 : -1} onClick={() => setActive(t.id)} onKeyDown={(e) => onKey(e, i)}>{t.label}</button>
          ))}
        </div>
        <span className="docs-code-actions">{actions}<CopyButton text={cur.code} /></span>
      </div>
      <pre id={`${base}-p`} role="tabpanel" aria-labelledby={`${base}-t-${cur.id}`} className={tall ? "tall" : undefined} tabIndex={0}><code>{highlight(cur.code, cur.lang)}</code></pre>
      {cur.caption && <figcaption>{cur.caption}</figcaption>}
    </figure>
  );
}
