// A tiny progress model for multi-step wallet flows (upload → build → simulate → sign → confirm).
// The page renders the array; the flow mutates it through `set`/`note`, so every step carries a
// live status line and a failure shows exactly where it hit, in a human sentence.
import { SimulationError } from "./pump";

export type StepState = "todo" | "active" | "done" | "fail";
export type Step = { key: string; label: string; state: StepState; detail?: string; href?: string; logs?: string[] };
export type Report = (steps: Step[]) => void;

export function stepper(labels: [string, string][], report: Report) {
  const steps: Step[] = labels.map(([key, label]) => ({ key, label, state: "todo" }));
  const emit = () => report(steps.map((x) => ({ ...x })));
  const set = (key: string, state: StepState, detail?: string, href?: string) => {
    const s = steps.find((x) => x.key === key);
    if (!s) return;
    s.state = state; s.detail = detail; s.href = href;
    emit();
  };
  /// Update the status line of a step without changing its state ("uploading…" → "publishing…").
  const note = (key: string, detail: string, href?: string) => {
    const s = steps.find((x) => x.key === key);
    if (!s) return;
    s.detail = detail; if (href !== undefined) s.href = href;
    emit();
  };
  const fail = (key: string, e: unknown) => {
    const s = steps.find((x) => x.key === key);
    if (!s) return;
    s.state = "fail"; s.detail = friendlyError(e); s.href = undefined;
    // The program's last log lines, for the "details" disclosure under a failed step.
    s.logs = e instanceof SimulationError ? e.logs.slice(-8) : undefined;
    emit();
  };
  emit();
  return { set, note, fail, steps };
}

const fmtSol = (lamports: number) => `${(lamports / 1e9).toLocaleString("en-US", { maximumFractionDigits: 4 })} SOL`;

/// Wallet and program errors are verbose; the step line shows a short, human cause. Pump's own
/// error codes are already turned into words by `explainSimulationError`; this adds the wallet
/// and network cases, and the exact shortfall when the runtime says how much SOL was missing.
export function friendlyError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  const name = (e as { name?: string })?.name || "";
  const logs = e instanceof SimulationError ? e.logs.join("\n") : "";
  const text = `${raw}\n${logs}`;
  if (/user rejected|rejected the request|cancel|declined/i.test(raw) || name === "WalletSignTransactionError" || name === "WalletSendTransactionError" && /reject/i.test(raw)) return "You cancelled in the wallet. Nothing was sent.";
  const short = text.match(/insufficient lamports (\d+), need (\d+)/i);
  if (short) return `Not enough SOL: the wallet is short by ${fmtSol(Number(short[2]) - Number(short[1]))}. Top up and try again.`;
  if (/found no record of a prior credit|AccountNotFound/i.test(text)) return "The wallet has no SOL yet. Fund it, then try again.";
  if (/insufficient (lamports|funds)|custom program error: 0x1\b/i.test(text)) return "Not enough SOL in the wallet for this.";
  if (/QuoteCurveAwaitingMigration|6107/.test(text + name)) return "A coin on this chain graduated but has not migrated yet. Try again after it migrates.";
  if (/QuoteBondingCurveNotEligible|6100/.test(text + name)) return "This coin cannot be a parent (mayhem mode or an unlisted root quote).";
  if (/CurveDepthExceeded|6105/.test(text + name)) return "The chain is already at the maximum depth.";
  if (/slippage|6003|TooLittle|exceeds desired slippage|6001|6023/i.test(text)) return "The price moved more than your slippage allows. Try a higher tolerance.";
  // "Expired" is what this page's RPC saw; a wallet that re-broadcast through its own RPC can be
  // ahead of it, so the wording stops short of promising nothing was charged.
  if (name === "ExpiredError" || /blockhash|expired/i.test(raw)) return "The transaction expired before it landed, so it should not have been charged. If your wallet shows it as sent, check the explorer before trying again.";
  if (name === "UnconfirmedError") return raw;
  if (/too large|1232|encoding overruns/i.test(raw)) return "The transaction is too large for one signature.";
  if (/API is unreachable|API is down|Failed to fetch|NetworkError/i.test(raw)) return "Spore's API did not answer. Check your connection and try again.";
  if (/429|too many requests/i.test(raw)) return "The network is rate-limiting requests. Wait a few seconds and try again.";
  const clean = raw.replace(/^Simulation failed:\s*/i, "").replace(/\s*\([0-9]{4}\)$/, (m) => m);
  return clean.length > 160 ? `${clean.slice(0, 160)}…` : clean;
}
