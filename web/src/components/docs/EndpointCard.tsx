import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { CodeBlock, CodeTabs, CopyButton, type CodeTab } from "./CodeBlock";
import { API_ORIGIN, json, trimForDisplay } from "./util";

export type Param = { name: string; in: "path" | "query" | "header"; type: string; required?: boolean; desc: ReactNode };
export type Example = { id: string; label: string; value: unknown; caption?: ReactNode };

/// `/v1/coin/:mint/family` with the parameters painted, so the variable parts stand out.
export function PathText({ path }: { path: string }) {
  return <>{path.split(/(:[a-zA-Z]+|<[a-z]+>)/).map((part, i) => (part.startsWith(":") || part.startsWith("<") ? <em key={i}>{part}</em> : <Fragment key={i}>{part}</Fragment>))}</>;
}

export function Params({ params }: { params: Param[] }) {
  return (
    <div className="docs-params" role="list" aria-label="Parameters">
      {params.map((p) => (
        <div className="docs-param" role="listitem" key={`${p.in}:${p.name}`}>
          <div className="docs-param-head">
            <code>{p.name}</code>
            <span className="docs-param-in">{p.in}</span>
            <span className="docs-param-type">{p.type}</span>
            {p.required ? <span className="docs-param-req">required</span> : <span className="docs-param-opt">optional</span>}
          </div>
          <p>{p.desc}</p>
        </div>
      ))}
    </div>
  );
}

export type Field = [name: string, type: string, desc: ReactNode];

/// The response fields worth explaining (not every key: the examples show the rest).
export function Fields({ fields, label = "Fields" }: { fields: Field[]; label?: string }) {
  return (
    <details className="docs-fields">
      <summary>{label} <span className="muted">({fields.length})</span></summary>
      <dl>
        {fields.map(([n, t, d]) => <div key={n}><dt><code>{n}</code><span className="docs-param-type">{t}</span></dt><dd>{d}</dd></div>)}
      </dl>
    </details>
  );
}

type Live = { status: number; ms: number; body: string; headers: [string, string][] } | { error: string };
const SHOWN_HEADERS = ["x-spore-tier", "x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset", "cache-control", "etag"];

/// One endpoint: method and path, what it returns, its parameters, a curl request and recorded
/// responses. "Run live" calls the same path on this site (the public tier, no key) and adds the
/// answer as a tab with its status, timing and rate-limit headers; a failure leaves the recorded
/// examples in place and says why.
export function EndpointCard({ id, path, summary, params, fields, notes, request, examples, live, method = "GET" }: {
  id: string; path: string; summary: ReactNode; params: Param[]; fields?: Field[]; notes?: ReactNode; request: string; examples: Example[];
  live?: () => string; method?: "GET";
}) {
  const [result, setResult] = useState<Live | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState(examples[0]?.id ?? "");
  const ctl = useRef<AbortController | null>(null);
  useEffect(() => () => ctl.current?.abort(), []);
  const run = async () => {
    if (!live) return;
    ctl.current?.abort();
    const ac = new AbortController();
    ctl.current = ac;
    const timer = window.setTimeout(() => ac.abort(), 20_000);
    setBusy(true);
    const t0 = performance.now();
    try {
      const res = await fetch(live(), { headers: { accept: "application/json" }, signal: ac.signal });
      const ms = Math.round(performance.now() - t0);
      const type = res.headers.get("content-type") ?? "";
      const text = await res.text();
      // The single-page app answers unknown paths with index.html, so a missing /v1 shows up as HTML.
      if (!type.includes("json")) throw new Error(res.ok ? "the /v1 API is not available on this host yet (it answered with a web page)" : `HTTP ${res.status}`);
      let body = text;
      try { body = json(trimForDisplay(JSON.parse(text))); } catch { /* keep the raw text */ }
      setResult({ status: res.status, ms, body, headers: SHOWN_HEADERS.flatMap((h) => { const v = res.headers.get(h); return v ? [[h, v] as [string, string]] : []; }) });
      setTab("live");
    } catch (e) {
      if (ac.signal.aborted && ctl.current !== ac) return;
      setResult({ error: ac.signal.aborted ? "timed out after 20 s" : e instanceof Error ? e.message : String(e) });
    } finally {
      window.clearTimeout(timer);
      if (ctl.current === ac) setBusy(false);
    }
  };
  const tabs: CodeTab[] = examples.map((x) => ({ id: x.id, label: x.label, code: json(x.value), lang: "json", caption: x.caption }));
  if (result && "status" in result) {
    tabs.unshift({
      id: "live", label: `Live · ${result.status} · ${result.ms} ms`, code: result.body, lang: "json",
      caption: <>Fetched just now from <code>{live?.()}</code>{result.headers.length > 0 && <> · {result.headers.map(([k, v], i) => <Fragment key={k}>{i > 0 && " · "}<code>{k}: {v}</code></Fragment>)}</>}. Long arrays are cut for display.</>,
    });
  }
  return (
    <article className="docs-endpoint card" id={id} aria-labelledby={`${id}-h`}>
      <header className="docs-endpoint-head">
        <h3 id={`${id}-h`}><span className="docs-method">{method}</span><code className="docs-path"><PathText path={path} /></code></h3>
        <CopyButton text={`${API_ORIGIN}${path}`} label="Copy URL" className="ghost" />
      </header>
      <div className="docs-endpoint-body">
        <div className="docs-endpoint-text">{summary}</div>
        {params.length > 0 && <Params params={params} />}
        {fields && <Fields fields={fields} />}
        <CodeBlock code={request} lang="bash" title="Request" />
        <CodeTabs tabs={tabs} tall label={`${path} responses`} value={tab} onChange={setTab}
          actions={live ? <button type="button" className="docs-run" onClick={run} disabled={busy} aria-busy={busy}>{busy ? <i className="docs-spin" aria-hidden="true" /> : <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 2l7 4-7 4z" fill="currentColor" /></svg>}<span>{busy ? "Running" : result && "status" in result ? "Run again" : "Run live"}</span></button> : undefined} />
        {result && "error" in result && <p className="docs-live-error" role="status">Live request failed: {result.error}. The recorded example above is the documented shape.</p>}
        {notes && <div className="docs-endpoint-notes">{notes}</div>}
      </div>
    </article>
  );
}
