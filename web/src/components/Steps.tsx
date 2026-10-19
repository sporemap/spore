import { useState } from "react";
import type { Step } from "../lib/steps";
import "./launch.css";

/// Each step shows its live status line; a signature gets an explorer link, a failure a human
/// sentence with the program's last log lines behind a "details" toggle.
export default function Steps({ steps, title }: { steps: Step[]; title?: string }) {
  const [open, setOpen] = useState<string | null>(null);
  if (!steps.length) return null;
  const done = steps.filter((s) => s.state === "done").length;
  const failed = steps.some((s) => s.state === "fail");
  const finished = done === steps.length;
  return (
    <ol className={`tx-steps v2 ${failed ? "has-fail" : finished ? "all-done" : ""}`} aria-label={title ?? "Progress"} aria-live="polite">
      {title && <li className="tx-steps-title"><span>{title}</span><span className="mono muted">{done}/{steps.length}</span></li>}
      {steps.map((s, i) => (
        <li key={s.key} className={s.state}>
          <i aria-hidden="true">{s.state === "done" ? "✓" : s.state === "fail" ? "✕" : s.state === "active" ? <span className="spin" /> : i + 1}</i>
          <div>
            <span className="tx-step-label">{s.label}</span>
            {s.detail && (
              <small className="tx-step-detail">
                {s.href ? <a href={s.href} target="_blank" rel="noreferrer">{s.detail} ↗</a> : s.detail}
                {s.logs && s.logs.length > 0 && <> · <button type="button" className="linkish inline" onClick={() => setOpen(open === s.key ? null : s.key)}>{open === s.key ? "hide details" : "details"}</button></>}
              </small>
            )}
            {open === s.key && s.logs && <pre className="tx-step-logs">{s.logs.join("\n")}</pre>}
          </div>
        </li>
      ))}
    </ol>
  );
}
