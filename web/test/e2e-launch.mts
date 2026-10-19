// End-to-end launch flow in the real page, with no on-chain effect: headless Chrome over the
// DevTools protocol (same approach as tools/shot.mjs) opens /launch?dry=1 on a dev server, fills
// the form the way a user would (typing, choosing a file, pressing Launch), and reads the dry-run
// log the page keeps (`window.sporeDry.log`): every "send" in dry mode is a mainnet simulation
// (sigVerify off, blockhash replaced) that must pass. Two flows: a SOL root, and a child under a
// live pump coin. Screenshots of the filled form, the steps mid-flight and the success screen are
// written to SHOT_DIR.
//
//   cd web && API_PORT=8794 npx vite --port 5191 --strictPort &   # dev server (SHOW=all API)
//   BASE=http://localhost:5191 SHOT_DIR=/tmp/spore-e2e node --import tsx test/e2e-launch.mts [desktop|mobile|both]
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Vite binds "localhost" (which resolves to ::1 here), so 127.0.0.1 would be refused.
const BASE = process.env.BASE ?? "http://localhost:5191";
const SHOT_DIR = process.env.SHOT_DIR ?? join(tmpdir(), "spore-e2e");
const PARENT = process.env.PARENT ?? "BsbsB3WLq7vbY5En3MBCAsTrcwaCxNKY2Mp5pGuLpump";
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const MODES = (process.argv[2] ?? "desktop") === "both" ? ["desktop", "mobile"] : [process.argv[2] ?? "desktop"];
mkdirSync(SHOT_DIR, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Send = (method: string, params?: Record<string, unknown>, sessionId?: string) => Promise<any>;

async function chrome(): Promise<{ send: Send; close: () => void }> {
  const port = 9300 + Math.floor(Math.random() * 500);
  const profile = mkdtempSync(join(tmpdir(), "spore-e2e-"));
  const proc = spawn(CHROME, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--hide-scrollbars", "--disable-extensions", `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, "about:blank"], { stdio: "ignore" });
  let version: any = null;
  for (let i = 0; i < 50 && !version; i++) { await sleep(200); version = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json()).catch(() => null); }
  if (!version) { proc.kill("SIGKILL"); throw new Error("chrome did not start"); }
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = (e) => rej(e); });
  let id = 0; const pending = new Map<number, { res: (v: any) => void; rej: (e: Error) => void }>();
  ws.onmessage = (ev) => { const m = JSON.parse(String(ev.data)); if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id)!; pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); } };
  const send: Send = (method, params = {}, sessionId) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
  return { send, close: () => { ws.close(); proc.kill("SIGKILL"); } };
}

/// One page session: evaluate JS, wait for a condition, screenshot the full page.
class Page {
  constructor(private send: Send, private sid: string, private width: number, private height: number) {}
  static async open(send: Send, width: number, height: number) {
    const { targetId } = await send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    await send("Page.enable", {}, sessionId);
    await send("Runtime.enable", {}, sessionId);
    await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 700 }, sessionId);
    return new Page(send, sessionId, width, height);
  }
  async goto(url: string) { await this.send("Page.navigate", { url }, this.sid); }
  async eval<T = unknown>(expression: string): Promise<T> {
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, this.sid);
    if (r.exceptionDetails) throw new Error(`page: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value as T;
  }
  /// Polls `expression` (a JS expression returning a truthy value when satisfied) up to `ms`.
  async waitFor<T = unknown>(expression: string, ms = 30_000, label = expression): Promise<T> {
    const started = Date.now();
    for (;;) {
      const v = await this.eval<T>(expression).catch(() => null as T);
      if (v) return v;
      if (Date.now() - started > ms) throw new Error(`timeout waiting for ${label}`);
      await sleep(300);
    }
  }
  async shot(name: string) {
    const metrics = await this.send("Page.getLayoutMetrics", {}, this.sid);
    const full = metrics.cssContentSize ?? metrics.contentSize;
    const height = Math.min(Math.ceil(full.height), 6000);
    await this.send("Emulation.setDeviceMetricsOverride", { width: this.width, height, deviceScaleFactor: 1, mobile: this.width < 700 }, this.sid);
    await sleep(250);
    const shot = await this.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }, this.sid);
    const out = join(SHOT_DIR, `${name}.png`);
    writeFileSync(out, Buffer.from(shot.data, "base64"));
    await this.send("Emulation.setDeviceMetricsOverride", { width: this.width, height: this.height, deviceScaleFactor: 1, mobile: this.width < 700 }, this.sid);
    console.log(`  shot ${out} (${this.width}x${height})`);
  }
}

// Typing into React-controlled inputs: the native value setter + an input event, which is what
// React listens to; assigning `.value` directly would be swallowed by React's value tracker.
const setValue = (selector: string, value: string) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) throw new Error("missing " + ${JSON.stringify(selector)});
  const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event("input", { bubbles: true }));
  // React's onBlur is wired to focusout, not to a synthetic blur event.
  el.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  return true; })()`;

// A 700×460 PNG drawn in the page (not square on purpose, so the crop/resize path runs), handed to
// the file input exactly like a file chooser would.
const chooseImage = `new Promise((res, rej) => {
  const c = document.createElement("canvas"); c.width = 700; c.height = 460;
  const g = c.getContext("2d");
  const grad = g.createLinearGradient(0, 0, 700, 460); grad.addColorStop(0, "#b6ff5c"); grad.addColorStop(1, "#5ce0c8");
  g.fillStyle = grad; g.fillRect(0, 0, 700, 460);
  g.fillStyle = "#07100b"; g.beginPath(); g.arc(350, 230, 150, 0, Math.PI * 2); g.fill();
  g.fillStyle = "#b6ff5c"; g.font = "bold 120px sans-serif"; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText("E2E", 350, 236);
  c.toBlob((blob) => {
    if (!blob) return rej(new Error("no blob"));
    const file = new File([blob], "coin.png", { type: "image/png" });
    const dt = new DataTransfer(); dt.items.add(file);
    const input = document.querySelector(".dropzone input[type=file]");
    if (!input) return rej(new Error("no file input"));
    input.files = dt.files; input.dispatchEvent(new Event("change", { bubbles: true }));
    res(true);
  }, "image/png");
})`;

type DryLog = { label: string; ok: boolean; skipped?: boolean; bytes: number | null; units: number; err: string | null }[];
type Outcome = { flow: string; mode: string; ok: boolean; mint: string | null; log: DryLog; steps: { label: string; state: string; detail?: string }[]; error: string | null; ms: number };

async function runFlow(send: Send, flow: "root" | "child", mode: string): Promise<Outcome> {
  const started = Date.now();
  const [w, h] = mode === "mobile" ? [390, 844] : [1440, 900];
  const page = await Page.open(send, w, h);
  const url = `${BASE}/launch?dry=1${flow === "child" ? `&parent=${PARENT}` : ""}`;
  console.log(`\n[${flow} · ${mode}] ${url}`);
  await page.goto(url);
  // The launch button appears once the dry wallet is set and eligibility came back.
  await page.waitFor(`!!document.querySelector(".launch-btn") && !document.querySelector(".launch-btn").disabled`, 40_000, "launch button enabled (eligibility + dry wallet)");
  await page.eval(`window.sporeDry.slowMs = ${mode === "mobile" ? 0 : 1800}; true`);
  const symbol = flow === "root" ? "E2EROOT" : "E2EKID";
  await page.eval(setValue('input[placeholder="Little Pepe"]', flow === "root" ? "E2E Root Coin" : "E2E Child Coin"));
  await page.eval(setValue('input[placeholder="LILPEPE"]', symbol.toLowerCase()));
  await page.eval(setValue("textarea", flow === "root" ? "Dry-run launch of a SOL-quoted root through the real page. Nothing is sent." : `Dry-run launch of a child under ${PARENT.slice(0, 6)}… through the real page. Nothing is sent.`));
  await page.eval(setValue('input[placeholder="@handle"]', "@spore_e2e"));
  await page.eval(setValue('input[placeholder="https://…"]', "spore.example"));
  await page.eval(chooseImage);
  await page.waitFor(`!!document.querySelector(".dropzone.v2.has .dz-preview")`, 10_000, "image preview");
  await page.eval(setValue('input[placeholder="0.5"]', "0.05"));
  // The ticker must have been upper-cased by the field, the social handle turned into a URL.
  const tickerShown = await page.eval<string>(`document.querySelector('input[placeholder="LILPEPE"]').value`);
  const twitterShown = await page.eval<string>(`document.querySelector('input[placeholder="@handle"]').value`);
  const imgMeta = await page.eval<string>(`document.querySelector(".dz-meta b")?.textContent ?? ""`);
  console.log(`  ticker=${tickerShown} twitter=${twitterShown} image=${imgMeta}`);
  // Wait for the first-buy estimate so the filled-form screenshot shows it (best effort).
  await page.waitFor(`/≈ [\\d,]+ \\$/.test(document.querySelector(".cost")?.textContent ?? "")`, 25_000, "first-buy estimate").catch((e) => console.log(`  (${e.message})`));
  await page.shot(`${flow}-${mode}-1-filled`);
  await page.eval(`document.querySelector(".launch-btn").click(); true`);
  // Steps in progress: catch the sign step while active (slowMs keeps each dry send on screen).
  await page.waitFor(`!!document.querySelector(".tx-steps.v2 li.active")`, 20_000, "steps visible");
  if (mode !== "mobile") await page.waitFor(`document.querySelectorAll(".tx-steps.v2 li.done").length >= 3`, 60_000, "three steps done").catch(() => undefined);
  await page.shot(`${flow}-${mode}-2-steps`);
  const done = await page.waitFor<string>(`document.querySelector(".success.v2") ? "success" : document.querySelector(".launch-error") ? "error" : ""`, 120_000, "success or error");
  await sleep(400);
  await page.shot(`${flow}-${mode}-3-${done}`);
  const log = await page.eval<DryLog>(`JSON.stringify(window.sporeDry.log)`).then((s) => JSON.parse(s as unknown as string));
  const steps = await page.eval<Outcome["steps"]>(`JSON.stringify([...document.querySelectorAll(".tx-steps.v2 li:not(.tx-steps-title)")].map((li) => ({ label: li.querySelector(".tx-step-label")?.textContent, state: li.className, detail: li.querySelector(".tx-step-detail")?.textContent })))`).then((s) => JSON.parse(s as unknown as string));
  const mint = await page.eval<string | null>(`document.querySelector(".success.v2")?.getAttribute("data-mint") ?? null`);
  const error = done === "error" ? await page.eval<string>(`document.querySelector(".launch-error")?.textContent ?? ""`) : null;
  const ok = done === "success" && log.length > 0 && log.every((l) => l.ok) && log.some((l) => l.label === "launch") && tickerShown === symbol && twitterShown === "https://x.com/spore_e2e" && /512×512/.test(imgMeta);
  for (const l of log) console.log(`  sim ${l.label}: ${l.skipped ? "skipped (needs the real mint)" : l.ok ? "ok" : "FAIL"} bytes=${l.bytes} units=${l.units}${l.err ? ` err=${l.err}` : ""}`);
  for (const s of steps) console.log(`  step ${s.state.padEnd(6)} ${s.label} — ${s.detail ?? ""}`);
  if (error) console.log(`  page error: ${error}`);
  return { flow, mode, ok, mint, log, steps, error, ms: Date.now() - started };
}

/// A launch persisted mid-flight (the create landed, the fee split did not) must come back as a
/// Resume card with the one button that finishes it. The record points at a real pump coin so the
/// signature check says "landed"; the finish itself is not attempted (the dry wallet is not its creator).
async function runResume(send: Send, mode: string): Promise<Outcome> {
  const started = Date.now();
  const [w, h] = mode === "mobile" ? [390, 844] : [1440, 900];
  const page = await Page.open(send, w, h);
  console.log(`\n[resume · ${mode}]`);
  await page.goto(`${BASE}/launch?dry=1`);
  await page.waitFor(`!!document.querySelector(".launch-btn")`, 40_000, "page ready");
  const record = { v: 1, mint: PARENT, sig: "5VERYFAKEsig", name: "Resumed Coin", symbol: "RESUME", image: null, parentMint: null, parentSymbol: null, depth: 0, quoteMint: "So11111111111111111111111111111111111111112", quoteTokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", shares: [], splitIncluded: false, splitSig: null, step: "split-pending", createdAt: Date.now() - 60_000 };
  await page.eval(`localStorage.setItem("spore:launch:pending", ${JSON.stringify(JSON.stringify(record))}); location.reload(); true`);
  await page.waitFor(`!!document.querySelector(".resume .btn.accent")`, 30_000, "resume card with Finish button");
  await page.shot(`resume-${mode}`);
  const text = await page.eval<string>(`document.querySelector(".resume")?.textContent ?? ""`);
  const ok = /Unfinished launch/.test(text) && /Finish the fee split/.test(text) && /\$RESUME/.test(text);
  await page.eval(`localStorage.removeItem("spore:launch:pending"); true`);
  console.log(`  resume card: ${ok ? "ok" : "MISSING"}`);
  return { flow: "resume", mode, ok, mint: null, log: [], steps: [], error: null, ms: Date.now() - started };
}

const { send, close } = await chrome();
const outcomes: Outcome[] = [];
try {
  for (const mode of MODES) { for (const flow of ["root", "child"] as const) outcomes.push(await runFlow(send, flow, mode)); outcomes.push(await runResume(send, mode)); }
} finally { close(); }
console.log("\nSUMMARY");
for (const o of outcomes) console.log(`  ${o.ok ? "PASS" : "FAIL"} ${o.flow} ${o.mode} mint=${o.mint ?? "—"} sims=${o.log.length} (${(o.ms / 1000).toFixed(0)}s)`);
process.exit(outcomes.every((o) => o.ok) ? 0 : 1);
