// Headless measurement of the /map page (DESIGN §11.5 budgets) through Chrome's DevTools protocol, no
// puppeteer (same pattern as tools/shot.mjs). It loads the map on a dev server, waits for the first
// bubbles and for the layout to settle, samples frame times in both phases, injects one synthetic
// `pair` event through a mocked EventSource, checks labels were drawn, reopens the page (SPA navigation
// and a full reload) to time the warm cache, screenshots 1440 and 390 wide, and fails on any console or
// CSP error. `--prod <url>` instead loads a production build (no mock) and only checks errors + worker.
//
//   node --import tsx test/map-perf.mts [--url http://127.0.0.1:5231] [--stress 20000] [--roots all] [--shots DIR]
//   node --import tsx test/map-perf.mts --prod http://127.0.0.1:8793
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const opt = (name: string, dflt: string | null = null) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt; };
const BASE = opt("--url", "http://127.0.0.1:5231")!;
const PROD = opt("--prod");
const STRESS = Number(opt("--stress", "0"));
const ROOTS = opt("--roots", "all")!;
const SHOTS = opt("--shots", process.env.SHOT_DIR ?? join(process.env.SPORE_TMP ?? tmpdir(), "spore-map-shots"))!;
const BUDGET = { settled: 16, settling: 33, firstPaintCold: 2000, firstPaintWarm: 500 };
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const W = 1440, H = 900;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const port = 9222 + Math.floor(Math.random() * 500);
const profile = mkdtempSync(join(process.env.SPORE_TMP ?? tmpdir(), "spore-perf-"));
mkdirSync(SHOTS, { recursive: true });
// --disable-gpu = software rasterisation for the canvas, which is the budget's stated condition.
const chrome = spawn(CHROME, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--hide-scrollbars", "--disable-extensions", "--disable-background-timer-throttling", "--disable-renderer-backgrounding", `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, `--window-size=${W},${H}`, "about:blank"], { stdio: "ignore" });

type Msg = { id?: number; method?: string; params?: Record<string, unknown>; sessionId?: string; result?: unknown; error?: { message: string } };
const errors: string[] = [];
const netErrors: string[] = [];
const result: Record<string, unknown> = { url: PROD ?? BASE, stress: STRESS, roots: ROOTS };
const fails: string[] = [];
const check = (cond: boolean, msg: string) => { if (!cond) fails.push(msg); };

const MOCK_ES = `(() => {
  const list = []; window.__es = list;
  class MockES {
    constructor(url) { this.url = url; this.readyState = 0; this.listeners = {}; this.onopen = null; this.onerror = null; this.onmessage = null; list.push(this); setTimeout(() => { this.readyState = 1; if (this.onopen) this.onopen(new Event("open")); }, 0); }
    addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }
    removeEventListener(t, f) { this.listeners[t] = (this.listeners[t] || []).filter((g) => g !== f); }
    close() { this.readyState = 2; }
    dispatch(t, data) { for (const f of this.listeners[t] || []) f(new MessageEvent(t, { data })); }
  }
  MockES.CONNECTING = 0; MockES.OPEN = 1; MockES.CLOSED = 2;
  window.EventSource = MockES;
})();`;

try {
  let version: { webSocketDebuggerUrl: string } | null = null;
  for (let i = 0; i < 50 && !version; i++) { await sleep(200); version = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json()).catch(() => null); }
  if (!version) throw new Error("chrome did not start");
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error("ws")); });
  let id = 0; const pending = new Map<number, { res: (v: unknown) => void; rej: (e: Error) => void }>();
  ws.onmessage = (ev) => {
    const m = JSON.parse(String(ev.data)) as Msg;
    if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id)!; pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); return; }
    if (m.method === "Runtime.consoleAPICalled") { const p = m.params as { type: string; args: { value?: unknown; description?: string }[] }; if (p.type === "error") errors.push(`console.error: ${p.args.map((a) => a.value ?? a.description ?? "").join(" ")}`); }
    if (m.method === "Runtime.exceptionThrown") { const p = m.params as { exceptionDetails: { text: string; exception?: { description?: string } } }; errors.push(`exception: ${p.exceptionDetails.exception?.description ?? p.exceptionDetails.text}`); }
    if (m.method === "Log.entryAdded") { const p = m.params as { entry: { level: string; source: string; text: string; url?: string } }; if (p.entry.level === "error") { if (p.entry.source === "network") netErrors.push(`${p.entry.text} ${p.entry.url ?? ""}`); else errors.push(`${p.entry.source}: ${p.entry.text}`); } }
  };
  const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string) => new Promise<unknown>((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
  const { targetId } = (await send("Target.createTarget", { url: "about:blank" })) as { targetId: string };
  const { sessionId } = (await send("Target.attachToTarget", { targetId, flatten: true })) as { sessionId: string };
  const S = sessionId;
  await send("Page.enable", {}, S); await send("Runtime.enable", {}, S); await send("Log.enable", {}, S);
  await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false }, S);
  if (!PROD) await send("Page.addScriptToEvaluateOnNewDocument", { source: MOCK_ES }, S);
  const evalJs = async <T,>(expression: string): Promise<T> => { const r = (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, S)) as { result: { value: T }; exceptionDetails?: { text: string } }; if (r.exceptionDetails) throw new Error(`eval failed: ${r.exceptionDetails.text} :: ${expression.slice(0, 80)}`); return r.result.value; };
  const waitFor = async (expression: string, timeoutMs: number, what: string) => { const t0 = Date.now(); while (Date.now() - t0 < timeoutMs) { let v: unknown = null; try { v = await evalJs(expression); } catch { /* page still loading */ } if (v) return v; await sleep(100); } throw new Error(`timeout waiting for ${what}`); };
  const shot = async (name: string) => { const r = (await send("Page.captureScreenshot", { format: "png" }, S)) as { data: string }; const file = join(SHOTS, name); writeFileSync(file, Buffer.from(r.data, "base64")); return file; };

  if (PROD) {
    await send("Page.navigate", { url: `${PROD.replace(/\/$/, "")}/map` }, S);
    await sleep(8000);
    const info = await evalJs<{ title: string; worker: number; canvas: boolean; assets: number }>(`JSON.stringify({ title: document.title, worker: performance.getEntriesByType("resource").filter((e) => /layout\\.worker/.test(e.name)).length, canvas: !!document.querySelector(".bm-canvas"), assets: performance.getEntriesByType("resource").length })`).then((s) => JSON.parse(s as unknown as string));
    result.prod = info;
    check(info.canvas, "production map did not render a canvas");
    check(info.worker >= 1, "production build did not load the layout worker (CSP worker-src?)");
    result.shot = await shot("map-prod-1440.png");
  } else {
    const url = `${BASE}/map?roots=${ROOTS}${STRESS ? `&stress=${STRESS}` : ""}`;
    // ---- cold open (fresh profile = empty IndexedDB)
    await send("Page.navigate", { url }, S);
    await waitFor("!!(window.__sporeMap && window.__sporeMap.firstPaintAt() > 0)", 120_000, "first paint");
    const cold = await evalJs<{ fp: number; data: number; nodes: number; mounted: number }>(`({ fp: __sporeMap.firstPaintAt(), data: __sporeMap.dataAt(), nodes: __sporeMap.nodes(), mounted: __sporeMapPage.mountedAt })`);
    result.nodesTested = cold.nodes;
    result.firstPaintColdMs = Math.round(cold.fp - cold.data);
    result.firstPaintColdFromNavMs = Math.round(cold.fp);
    check(cold.fp - cold.data <= BUDGET.firstPaintCold, `cold first paint ${Math.round(cold.fp - cold.data)} ms > ${BUDGET.firstPaintCold}`);
    await waitFor("__sporeMap.settled()", 180_000, "layout to settle");
    const settling = await evalJs<{ settling: { n: number; avg: number; p95: number; max: number } }>("__sporeMap.frameStats()");
    result.frameMsSettling = Math.round(settling.settling.avg * 100) / 100;
    result.settling = settling.settling;
    await evalJs("__sporeMap.resetFrames()");
    await sleep(3000);
    const fs = await evalJs<{ settled: { n: number; avg: number; p95: number; max: number }; labels: number; drawn: number }>("__sporeMap.frameStats()");
    result.frameMsSettled = Math.round(fs.settled.avg * 100) / 100;
    result.settled = fs.settled;
    result.labels = fs.labels; result.drawn = fs.drawn;
    result.images = await evalJs("__sporeMap.images()");
    check(settling.settling.avg <= BUDGET.settling, `settling avg ${settling.settling.avg.toFixed(1)} ms > ${BUDGET.settling}`);
    check(fs.settled.avg <= BUDGET.settled, `settled avg ${fs.settled.avg.toFixed(1)} ms > ${BUDGET.settled}`);
    check(fs.settled.p95 <= BUDGET.settled * 1.5, `settled p95 ${fs.settled.p95.toFixed(1)} ms > ${BUDGET.settled * 1.5}`);
    result.shot1440 = await shot(`map-1440${STRESS ? `-stress${STRESS}` : ""}.png`);
    // labels: every bubble ≥ 9 px gets one, so zoom into the biggest root and count them there; logos load lazily there too
    const bigRoot = await evalJs<string | null>("__sporeMap.anyRoot()");
    await evalJs(`__sporeMap.zoomTo(${JSON.stringify(bigRoot)}, 1.4)`);
    await sleep(2500);
    const zoomed = await evalJs<{ labels: number; drawn: number; k: number; images: { ready: number; failed: number; inflight: number; queued: number } }>("({ labels: __sporeMap.labels(), drawn: __sporeMap.drawn(), k: __sporeMap.zoom(), images: __sporeMap.images() })");
    result.zoomed = zoomed;
    check(zoomed.labels > 0, "no labels drawn when zoomed into a root");
    result.shot1440zoom = await shot(`map-1440-zoom${STRESS ? `-stress${STRESS}` : ""}.png`);
    await evalJs("__sporeMap.fit()");
    await sleep(900);
    // ---- one synthetic pair through the EventSource mock: the child must appear under an existing root
    const root = await evalJs<string | null>("__sporeMap.anyRoot()");
    check(!!root, "no root to hang a synthetic pair under");
    if (root) {
      const mint = "PERFTESTpair" + Date.now().toString(36).padEnd(32, "x");
      const before = await evalJs<number>("__sporeMap.nodes()");
      await evalJs(`(() => { const es = window.__es && window.__es[0]; if (!es) return false; es.dispatch("pair", JSON.stringify({ coin: { mint: ${JSON.stringify(mint)}, name: "Perf Test Pair", symbol: "PERF", image: null, depth: 1, mcapUsd: 1200, lockedUsd: null, children: 0, descendants: 0, migrated: false, createdAt: ${Math.floor(Date.now() / 1000)}, parentMint: ${JSON.stringify(root)} }, parent: { mint: ${JSON.stringify(root)}, name: "root", symbol: "ROOT", image: null, depth: 0, mcapUsd: null, lockedUsd: null, children: 1, descendants: 1, migrated: false, createdAt: null } })); return true; })()`);
      const seen = await waitFor(`__sporeMap.has(${JSON.stringify(mint)})`, 5000, "synthetic pair to appear").catch(() => false);
      const after = await evalJs<number>("__sporeMap.nodes()");
      result.pair = { before, after, seen: !!seen, esInstances: await evalJs<number>("window.__es ? window.__es.length : 0") };
      // under ?stress=N the replicator pins the total at N, so only the insert itself is asserted there
      check(!!seen && (STRESS ? true : after === before + 1), `synthetic pair not inserted (before ${before}, after ${after})`);
      await waitFor("__sporeMap.settled()", 60_000, "relaxation after the pair").catch(() => fails.push("layout did not settle after the pair insert"));
    }
    // ---- warm reopen: SPA navigation away and back (positions come from IndexedDB, no settling)
    await evalJs(`history.pushState({}, "", "/"); dispatchEvent(new PopStateEvent("popstate"))`);
    await waitFor("!window.__sporeMap", 5000, "map to unmount");
    await sleep(1500); // let the position write land
    await evalJs(`window.__t0 = performance.now(); history.pushState({}, "", ${JSON.stringify(url.replace(BASE, ""))}); dispatchEvent(new PopStateEvent("popstate"))`);
    await waitFor("!!(window.__sporeMap && window.__sporeMap.firstPaintAt() > 0)", 60_000, "warm first paint (SPA)");
    const warm = await evalJs<{ fp: number; t0: number; src: string | null; nodes: number; settled: boolean; cache: unknown }>(`({ fp: __sporeMap.firstPaintAt(), t0: window.__t0, src: __sporeMapPage.source(), nodes: __sporeMap.nodes(), settled: __sporeMap.settled(), cache: __sporeMapPage.cacheInfo() })`);
    result.firstPaintWarmMs = Math.round(warm.fp - warm.t0);
    result.warm = { source: warm.src, nodes: warm.nodes, settledAtFirstPaint: warm.settled, cache: warm.cache };
    check(warm.src === "cache" || (warm.cache != null), "warm reopen did not render from the cache");
    check(warm.fp - warm.t0 <= BUDGET.firstPaintWarm, `warm first paint ${Math.round(warm.fp - warm.t0)} ms > ${BUDGET.firstPaintWarm}`);
    // ---- warm full reload (new document: includes module loading on the dev server)
    await send("Page.reload", {}, S);
    await waitFor("window.__t0 === undefined", 30_000, "the reloaded document"); // the old document still answers until the new one commits
    await waitFor("!!(window.__sporeMap && window.__sporeMapPage && window.__sporeMap.firstPaintAt() > 0)", 60_000, "warm first paint (reload)");
    const reload = await evalJs<{ fp: number; data: number; mounted: number; src: string | null }>(`({ fp: __sporeMap.firstPaintAt(), data: __sporeMap.dataAt(), mounted: __sporeMapPage.mountedAt, src: __sporeMapPage.source() })`);
    result.warmReload = { fromNavMs: Math.round(reload.fp), fromMountMs: Math.round(reload.fp - reload.mounted), fromDataMs: Math.round(reload.fp - reload.data), source: reload.src };
    await waitFor("__sporeMap.settled()", 60_000, "settle after reload").catch(() => fails.push("layout did not settle after the reload"));
    // ---- phone
    await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }, S);
    await sleep(1500);
    result.shot390 = await shot(`map-390${STRESS ? `-stress${STRESS}` : ""}.png`);
    result.phone = await evalJs(`JSON.stringify({ overflowX: document.documentElement.scrollWidth > window.innerWidth, tools: !!document.querySelector(".map-tools"), labels: __sporeMap.labels(), drawn: __sporeMap.drawn() })`).then((s) => JSON.parse(s as unknown as string));
  }
  ws.close();
} catch (e) {
  fails.push(`crashed: ${(e as Error).message}`);
} finally {
  result.consoleErrors = errors;
  result.networkErrors = netErrors.length;
  check(errors.length === 0, `${errors.length} console/CSP error(s): ${errors.slice(0, 3).join(" | ")}`);
  result.failures = fails;
  result.ok = fails.length === 0;
  console.log(JSON.stringify(result, null, 2));
  // Chrome keeps writing to its profile for a moment after SIGKILL reaches it: wait for the exit, then retry the delete.
  const exited = new Promise<void>((r) => { chrome.once("exit", () => r()); setTimeout(r, 3000); });
  chrome.kill("SIGKILL");
  await exited;
  for (let i = 0; i < 10; i++) { try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); break; } catch { await sleep(300); } }
}
process.exit(fails.length ? 1 : 0);
