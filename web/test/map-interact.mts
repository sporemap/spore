// Interaction and data checks of the /map page (DESIGN §11.5 "Map v2") through Chrome's DevTools
// protocol, no puppeteer (same harness as map-perf.mts), against a dev server on the full dataset:
//   (a) cold open starts at the fit: k at first paint within ×1.3 of the settled fit, never a k ≈ 1 frame
//   (b) hovering the largest cluster shows its tree tooltip; clicking it selects the root (?focus) within
//       2 s, with ≥ 80 % of its members on screen and k above the fit
//   (c) a cold deep link to a small far leaf ends with that leaf selected and on screen
//   (d) a mocked SSE trade on a visible coin draws an effect and stamps its last trade
//   (e) /api/map/heat (intercepted) with 3 rows seeds those coins' last trade; a 404 logs nothing
//   (f) production build: an SPA reopen makes exactly one /api/map request, with since=
//   (g) phone (390×844): a deep link to a top-200 root keeps roots at 200 (the widen race)
//   (h) logos: after zooming through three dense clusters the thumbnail cache is under its pixel
//       budget, and a ≥ 200 px bubble draws a 256 px thumbnail
//   and 0 console errors throughout.
//
//   API_PORT=8795 npx vite --port 5252 --host 127.0.0.1 &
//   npx vite build --outDir <scratch>/dist && API_PORT=8795 npx vite preview --outDir <scratch>/dist --port 5253 &
//   node --import tsx test/map-interact.mts --url http://127.0.0.1:5252 [--prod http://127.0.0.1:5253] [--shots DIR]
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const opt = (name: string, dflt: string | null = null) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt; };
const BASE = opt("--url", "http://127.0.0.1:5252")!;
const PROD = opt("--prod");
const ONLY = opt("--only");
const SHOTS = opt("--shots", join(process.env.SPORE_TMP ?? tmpdir(), "spore-interact-shots"))!;
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const W = 1440, H = 900;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const port = 9222 + Math.floor(Math.random() * 500);
const profile = mkdtempSync(join(process.env.SPORE_TMP ?? tmpdir(), "spore-interact-"));
mkdirSync(SHOTS, { recursive: true });
const chrome = spawn(CHROME, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--hide-scrollbars", "--disable-extensions", "--disable-background-timer-throttling", "--disable-renderer-backgrounding", `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, `--window-size=${W},${H}`, "about:blank"], { stdio: "ignore" });

type Msg = { id?: number; method?: string; params?: Record<string, unknown>; sessionId?: string; result?: unknown; error?: { message: string } };
const errors: string[] = [];
const netErrors: string[] = [];
const result: Record<string, unknown> = { url: BASE, prod: PROD };
const fails: string[] = [];
const check = (cond: boolean, msg: string) => { if (!cond) fails.push(msg); };
const want = (k: string) => !ONLY || ONLY.split(",").includes(k);

// EventSource mock (same as map-perf.mts) + a per-frame camera recorder for the cold-open check.
const PRELUDE = `(() => {
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
  const ks = []; window.__ks = ks;
  const rec = () => { const m = window.__sporeMap; if (m && m.firstPaintAt && m.firstPaintAt() > 0 && ks.length < 4000) ks.push(m.zoom()); requestAnimationFrame(rec); };
  requestAnimationFrame(rec);
})();`;

try {
  let version: { webSocketDebuggerUrl: string } | null = null;
  for (let i = 0; i < 50 && !version; i++) { await sleep(200); version = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json()).catch(() => null); }
  if (!version) throw new Error("chrome did not start");
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error("ws")); });
  let id = 0; const pending = new Map<number, { res: (v: unknown) => void; rej: (e: Error) => void }>();
  // heat interception: what the next /api/map/heat answers (null = pass through)
  let heatReply: { status: number; body: string } | null = null;
  let heatHits = 0;
  let S = "";
  const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string) => new Promise<unknown>((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
  ws.onmessage = (ev) => {
    const m = JSON.parse(String(ev.data)) as Msg;
    if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id)!; pending.delete(m.id); if (m.error) rej(new Error(m.error.message)); else res(m.result); return; }
    if (m.method === "Runtime.consoleAPICalled") { const p = m.params as { type: string; args: { value?: unknown; description?: string }[] }; if (p.type === "error") errors.push(`console.error: ${p.args.map((a) => a.value ?? a.description ?? "").join(" ")}`); }
    if (m.method === "Runtime.exceptionThrown") { const p = m.params as { exceptionDetails: { text: string; exception?: { description?: string } } }; errors.push(`exception: ${p.exceptionDetails.exception?.description ?? p.exceptionDetails.text}`); }
    if (m.method === "Log.entryAdded") { const p = m.params as { entry: { level: string; source: string; text: string; url?: string } }; if (p.entry.level === "error") { if (p.entry.source === "network") netErrors.push(`${p.entry.text} ${p.entry.url ?? ""}`); else errors.push(`${p.entry.source}: ${p.entry.text}`); } }
    if (m.method === "Fetch.requestPaused") {
      const p = m.params as { requestId: string; request: { url: string } };
      heatHits++;
      if (heatReply) void send("Fetch.fulfillRequest", { requestId: p.requestId, responseCode: heatReply.status, responseHeaders: [{ name: "content-type", value: "application/json" }, { name: "cache-control", value: "no-store" }], body: Buffer.from(heatReply.body).toString("base64") }, S).catch(() => null);
      else void send("Fetch.continueRequest", { requestId: p.requestId }, S).catch(() => null);
    }
  };
  const { targetId } = (await send("Target.createTarget", { url: "about:blank" })) as { targetId: string };
  const { sessionId } = (await send("Target.attachToTarget", { targetId, flatten: true })) as { sessionId: string };
  S = sessionId;
  await send("Page.enable", {}, S); await send("Runtime.enable", {}, S); await send("Log.enable", {}, S); await send("Network.enable", {}, S);
  await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false }, S);
  await send("Page.addScriptToEvaluateOnNewDocument", { source: PRELUDE }, S);
  await send("Fetch.enable", { patterns: [{ urlPattern: "*/api/map/heat*", requestStage: "Request" }] }, S);
  const evalJs = async <T,>(expression: string): Promise<T> => { const r = (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, S)) as { result: { value: T }; exceptionDetails?: { text: string; exception?: { description?: string } } }; if (r.exceptionDetails) throw new Error(`eval failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text} :: ${expression.slice(0, 80)}`); return r.result.value; };
  const waitFor = async (expression: string, timeoutMs: number, what: string) => { const t0 = Date.now(); while (Date.now() - t0 < timeoutMs) { let v: unknown = null; try { v = await evalJs(expression); } catch { /* page still loading */ } if (v) return v; await sleep(100); } throw new Error(`timeout waiting for ${what}`); };
  const shot = async (name: string) => { const r = (await send("Page.captureScreenshot", { format: "png" }, S)) as { data: string }; const file = join(SHOTS, name); writeFileSync(file, Buffer.from(r.data, "base64")); return file; };
  const mouse = (type: string, x: number, y: number, extra: Record<string, unknown> = {}) => send("Input.dispatchMouseEvent", { type, x, y, button: "none", ...extra }, S);
  const clickAt = async (x: number, y: number) => { await mouse("mouseMoved", x, y); await mouse("mousePressed", x, y, { button: "left", buttons: 1, clickCount: 1 }); await mouse("mouseReleased", x, y, { button: "left", buttons: 0, clickCount: 1 }); };
  /// Drops the map's IndexedDB cache from inside the page (the open connection closes on versionchange).
  const clearIdb = () => evalJs<string>(`new Promise((res) => { const r = indexedDB.deleteDatabase("spore-map"); r.onsuccess = () => res("ok"); r.onerror = () => res("error"); r.onblocked = () => setTimeout(() => res("blocked"), 3000); })`);
  const mapReady = async (timeoutMs = 120_000) => { await waitFor("!!(window.__sporeMap && window.__sporeMap.firstPaintAt() > 0 && window.__sporeMapPage)", timeoutMs, "first paint"); };
  const settle = async (what: string, timeoutMs = 180_000) => { await waitFor("__sporeMap.settled() && !__sporeMap.flying()", timeoutMs, what); await sleep(400); };
  /// Runs a navigation and waits until the old document is gone (a marker on window disappears).
  const fresh = async (go: () => Promise<unknown>) => { await evalJs("window.__oldDoc = 1").catch(() => null); await go(); await waitFor("!window.__oldDoc", 30_000, "the new document"); };
  const onScreen = `(p) => p && p.x >= 0 && p.y >= 0 && p.x <= innerWidth && p.y <= innerHeight`;

  // ---------------------------------------------------------------- (a) cold open starts at the fit
  await send("Page.navigate", { url: `${BASE}/map?roots=all` }, S);
  await mapReady();
  await settle("cold layout to settle");
  {
    const r = await evalJs<{ ks: number[]; fit: number }>("({ ks: window.__ks.slice(), fit: __sporeMap.zoom() })");
    const first = r.ks[0] ?? 0;
    const nearOne = r.ks.filter((k) => Math.abs(k - 1) < 0.03).length;
    const ratio = first > 0 ? Math.max(first / r.fit, r.fit / first) : Infinity;
    result.coldOpen = { firstK: first, fitK: r.fit, ratio: Math.round(ratio * 1000) / 1000, frames: r.ks.length, nearOneFrames: nearOne, minK: Math.min(...r.ks), maxK: Math.max(...r.ks) };
    check(ratio <= 1.3, `(a) first-paint k ${first.toFixed(3)} is not within ×1.3 of the fit ${r.fit.toFixed(3)}`);
    if (Math.abs(r.fit - 1) > 0.2) check(nearOne === 0, `(a) ${nearOne} frame(s) drawn at k ≈ 1 during a cold open (fit ${r.fit.toFixed(3)})`);
  }
  result.shotFit = await shot("interact-1440-fit.png");

  // ---------------------------------------------------------------- (b) cluster hover + click
  if (want("b")) {
    const fitK = await evalJs<number>("__sporeMap.zoom()");
    const big = await evalJs<{ root: string; count: number; cx: number; cy: number; cr: number } | null>("(__sporeMap.clusters(1) || [])[0] || null");
    check(!!big, "(b) no cluster");
    if (big) {
      // a point inside the cluster's screen circle that hands the pointer to the cluster (not a ≥ 3 px bubble)
      const pt = await evalJs<{ x: number; y: number } | null>(`(() => {
        const cam = __sporeMap.camera(), b = document.querySelector(".bm-canvas").getBoundingClientRect();
        const c = ${JSON.stringify(big)};
        const cx = b.left + c.cx * cam.k + cam.x, cy = b.top + c.cy * cam.k + cam.y, r = c.cr * cam.k;
        for (let ring = 0; ring <= 8; ring++) for (let a = 0; a < 24; a++) {
          const rr = r * ring / 10, x = cx + Math.cos(a * Math.PI / 12) * rr, y = cy + Math.sin(a * Math.PI / 12) * rr;
          if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) continue;
          const el = document.elementFromPoint(x, y); if (!el || !el.classList.contains("bm-canvas")) continue;
          const p = __sporeMap.pick(x, y); if (p.cluster === c.root && !p.node) return { x, y };
          if (ring === 0) break;
        }
        return null; })()`);
      result.clusterPoint = pt;
      check(!!pt, "(b) no point inside the largest cluster hands the pointer to the cluster");
      if (pt) {
        await mouse("mouseMoved", pt.x, pt.y);
        await sleep(300);
        const tip = await evalJs<{ text: string; hover: string | null; sym: string | null }>(`({ text: (document.querySelector(".bm-tip-cluster") || {}).textContent || "", hover: __sporeMap.hoverCluster(), sym: (__sporeMap.node(${JSON.stringify(big.root)}) || {}).symbol || null })`);
        result.clusterTip = { ...tip, text: tip.text.slice(0, 160) };
        check(tip.hover === big.root, `(b) hoverCluster ${tip.hover} is not the largest cluster's root ${big.root}`);
        check(!!tip.sym && tip.text.includes(tip.sym), `(b) cluster tooltip does not name the root ticker ${tip.sym}`);
        result.shotClusterHover = await shot("interact-1440-cluster-hover.png");
        const t0 = Date.now();
        await clickAt(pt.x, pt.y);
        await waitFor(`new URLSearchParams(location.search).get("focus") === ${JSON.stringify(big.root)}`, 2000, "?focus=root after the cluster click").catch(() => fails.push("(b) clicking the cluster did not select its root within 2 s"));
        result.clusterSelectMs = Date.now() - t0;
        await waitFor("!__sporeMap.flying()", 4000, "the cluster flight to land").catch(() => fails.push("(b) cluster flight did not land"));
        await sleep(300);
        const vis = await evalJs<{ on: number; total: number; k: number; selected: string | null }>(`(() => { const ms = __sporeMap.members(${JSON.stringify(big.root)}); const ok = ${onScreen}; let on = 0; for (const m of ms) if (ok(__sporeMap.screenOf(m))) on++; return { on, total: ms.length, k: __sporeMap.zoom(), selected: __sporeMap.selected() }; })()`);
        result.clusterClick = { ...vis, fitK, share: Math.round((vis.on / Math.max(1, vis.total)) * 1000) / 1000 };
        check(vis.on / Math.max(1, vis.total) >= 0.8, `(b) only ${vis.on}/${vis.total} members on screen after the cluster click`);
        check(vis.k > fitK, `(b) k ${vis.k.toFixed(3)} after the cluster click is not above the fit ${fitK.toFixed(3)}`);
        check(vis.selected === big.root, "(b) the map's selection is not the cluster root");
        result.shotClusterClick = await shot("interact-1440-cluster-click.png");
      }
    }
  }

  // ---------------------------------------------------------------- (d) a trade draws an effect
  if (want("d")) {
    await evalJs(`history.replaceState({}, "", "/map?roots=all"); dispatchEvent(new PopStateEvent("popstate"))`);
    await evalJs("__sporeMap.fit()");
    await waitFor("!__sporeMap.flying()", 4000, "fit").catch(() => null);
    // a root that is a bubble target at the fit (≥ 3 px), so its tooltip can be checked afterwards
    const mint = await evalJs<string | null>(`(() => { for (const c of __sporeMap.clusters(60)) { const p = __sporeMap.screenOf(c.root); if (p && p.x > 360 && p.x < innerWidth - 40 && p.y > 80 && p.y < innerHeight - 40 && __sporeMap.pick(p.x, p.y).node === c.root) return c.root; } return (__sporeMap.clusters(1)[0] || {}).root || null; })()`);
    if (mint) {
      const before = await evalJs<number>(`__sporeMap.lastTrade(${JSON.stringify(mint)})`);
      const ok = await evalJs<boolean>(`(() => { const es = (window.__es || []).filter((e) => e.readyState !== 2); if (!es.length) return false; const t = { sig: "INTERACT" + Date.now(), mint: ${JSON.stringify(mint)}, slot: 1, time: Math.floor(Date.now() / 1000), isBuy: true, user: "x", baseAmount: "1", quoteAmount: "1", priceQuote: 1, priceUsd: 1, valueUsd: 750 }; es[es.length - 1].dispatch("trade", JSON.stringify(t)); return true; })()`);
      await sleep(120);
      const after = await evalJs<{ fx: number; last: number }>(`({ fx: __sporeMap.fx(), last: __sporeMap.lastTrade(${JSON.stringify(mint)}) })`);
      result.trade = { mint, dispatched: ok, before, ...after };
      check(ok, "(d) no EventSource to dispatch a trade on");
      check(after.fx > 0, "(d) a live trade drew no effect (fx() = 0)");
      check(after.last > 0 && after.last >= before, "(d) a live trade did not stamp lastTrade");
      // its tooltip now carries the activity rows
      const p = await evalJs<{ x: number; y: number } | null>(`__sporeMap.screenOf(${JSON.stringify(mint)})`);
      if (p) {
        await mouse("mouseMoved", p.x, p.y);
        await sleep(300);
        const tipText = await evalJs<string>(`(document.querySelector(".bm-tip:not(.bm-tip-cluster)") || {}).textContent || ""`);
        result.tradeTip = tipText.slice(0, 200);
        check(/trades 1h\s*\d/.test(tipText) && /last trade\s*\d+s ago/.test(tipText), "(d) the bubble tooltip does not show 'trades 1h' and 'last trade' after a trade");
        result.shotTradeTip = await shot("interact-1440-trade-tip.png");
        await mouse("mouseMoved", 5, H - 5);
      }
    } else fails.push("(d) no mint to trade");
  }

  // ---------------------------------------------------------------- (e) heat sidecar, then a 404
  if (want("e")) {
    const mints = await evalJs<string[]>("__sporeMap.sample(40).filter((p, i) => i % 13 === 0).map((p) => p.mint).slice(0, 3)");
    const nowS = Math.floor(Date.now() / 1000);
    heatReply = { status: 200, body: JSON.stringify({ at: nowS, since: nowS - 86_400, mint: mints, t1h: [5, 2, 1], n24: [9, 4, 2], v24: [120.5, 33, 2.25], last: [nowS - 30, nowS - 400, nowS - 1_200], buys1h: [3, 1, 0] }) };
    heatHits = 0;
    await fresh(() => send("Page.reload", {}, S));
    await mapReady(60_000);
    await waitFor(`${JSON.stringify(mints)}.every((m) => __sporeMap.lastTrade(m) > 0)`, 10_000, "heat to seed lastTrade").catch(() => fails.push("(e) heat rows did not seed lastTrade"));
    const seeded = await evalJs<{ last: number[]; t1h: number[] }>(`({ last: ${JSON.stringify(mints)}.map((m) => __sporeMap.lastTrade(m)), t1h: ${JSON.stringify(mints)}.map((m) => __sporeMap.t1h(m)) })`);
    result.heat = { mints, hits: heatHits, ...seeded };
    check(heatHits >= 1, "(e) the page never asked for /api/map/heat");
    check(seeded.t1h[0] === 5 && seeded.t1h[1] === 2, "(e) heat t1h was not written to the store");
    const errsBefore = errors.length;
    heatReply = { status: 404, body: JSON.stringify({ error: "not found" }) };
    heatHits = 0;
    await fresh(() => send("Page.reload", {}, S));
    await mapReady(60_000);
    await sleep(2500);
    result.heat404 = { hits: heatHits, newErrors: errors.length - errsBefore };
    check(heatHits >= 1, "(e) the page never asked for /api/map/heat after the reload");
    check(errors.length === errsBefore, "(e) a heat 404 logged a console error");
    heatReply = null;
  }

  // ---------------------------------------------------------------- (c) cold deep link to a far leaf
  if (want("c")) {
    await settle("settle before choosing a leaf", 120_000).catch(() => null);
    const leaf = await evalJs<string | null>(`(() => { let best = null, bd = -1; for (const p of __sporeMap.sample(20000)) { const n = __sporeMap.node(p.mint); if (!n || n.children > 0 || n.r > 7) continue; const d = Math.hypot(n.x, n.y); if (d > bd) { bd = d; best = p.mint; } } return best; })()`);
    check(!!leaf, "(c) no far leaf found");
    if (leaf) {
      await evalJs(`history.pushState({}, "", "/"); dispatchEvent(new PopStateEvent("popstate"))`);
      await waitFor("!window.__sporeMap", 5000, "map to unmount").catch(() => null);
      result.idbClear = await clearIdb();
      await fresh(() => send("Page.navigate", { url: `${BASE}/map?roots=all&focus=${leaf}` }, S));
      await mapReady();
      await settle("cold deep link to settle");
      await waitFor("!__sporeMap.flying()", 5000, "landing").catch(() => null);
      await sleep(600);
      const r = await evalJs<{ sel: string | null; p: { x: number; y: number; r: number } | null; focus: string | null; source: string | null }>(`({ sel: __sporeMap.selected(), p: __sporeMap.screenOf(${JSON.stringify(leaf)}), focus: new URLSearchParams(location.search).get("focus"), source: __sporeMapPage.source() })`);
      const visible = !!r.p && r.p.x >= 0 && r.p.y >= 0 && r.p.x <= W && r.p.y <= H;
      result.deepLink = { leaf, ...r, visible };
      check(r.sel === leaf, `(c) the deep-linked leaf is not selected (${r.sel})`);
      check(visible, "(c) the deep-linked leaf is not on screen");
      result.shotDeepLink = await shot("interact-1440-deeplink.png");
    }
  }

  // ---------------------------------------------------------------- (h) logos: budget + sharpness
  if (want("h")) {
    await evalJs(`history.replaceState({}, "", "/map?roots=all"); dispatchEvent(new PopStateEvent("popstate"))`);
    const roots = await evalJs<string[]>("__sporeMap.clusters(3).map((c) => c.root)");
    for (const m of roots) { await evalJs(`__sporeMap.zoomTo(${JSON.stringify(m)}, 2.2)`); await sleep(2500); }
    const stats = await evalJs<{ ready: number; failed: number; inflight: number; queued: number; pixels: number; budget: number }>("__sporeMap.images()");
    result.images = stats;
    check(stats.ready > 0, "(h) no logo loaded after zooming through three clusters");
    check(stats.pixels <= stats.budget, `(h) thumbnail pixels ${stats.pixels} over the budget ${stats.budget}`);
    // the biggest bubble with a logo, blown up to ≥ 200 px across
    const big = await evalJs<{ mint: string; r: number } | null>(`(() => { let best = null; for (const c of __sporeMap.clusters(30)) { const n = __sporeMap.node(c.root); if (n && n.image && (!best || n.r > best.r)) best = { mint: c.root, r: n.r }; } return best; })()`);
    if (big) {
      const k = Math.min(6, 104 / Math.max(1, big.r));
      await evalJs(`__sporeMap.zoomTo(${JSON.stringify(big.mint)}, ${k})`);
      await waitFor(`__sporeMap.logo(${JSON.stringify(big.mint)}) >= 256`, 15_000, "a 256 px thumbnail").catch(() => null);
      const r = await evalJs<{ logo: number; sr: number | null }>(`({ logo: __sporeMap.logo(${JSON.stringify(big.mint)}), sr: (__sporeMap.screenOf(${JSON.stringify(big.mint)}) || {}).r ?? null })`);
      result.sharp = { mint: big.mint, ...r };
      check((r.sr ?? 0) >= 100, `(h) the logo bubble is only ${r.sr} px in radius`);
      check(r.logo === 256, `(h) a ${Math.round(2 * (r.sr ?? 0))} px bubble draws a ${r.logo} px thumbnail, expected 256`);
      result.shotSharp = await shot("interact-1440-logo.png");
    }
  }

  // ---------------------------------------------------------------- (g) phone deep link keeps roots=200
  if (want("g")) {
    const gta = await evalJs<string | null>(`(() => { for (const c of __sporeMap.clusters(400)) { const n = __sporeMap.node(c.root); if (n && n.symbol === "GTA") return c.root; } return null; })()`);
    check(!!gta, "(g) $GTA root not found");
    if (gta) {
      await evalJs(`history.pushState({}, "", "/"); dispatchEvent(new PopStateEvent("popstate"))`);
      await waitFor("!window.__sporeMap", 5000, "map to unmount").catch(() => null);
      result.idbClear = await clearIdb();
      await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }, S);
      await fresh(() => send("Page.navigate", { url: `${BASE}/map?focus=${gta}` }, S));
      await mapReady();
      await sleep(3000);
      const r = await evalJs<{ roots: string | null; sel: string | null; nodes: number; total: number }>("({ roots: new URLSearchParams(location.search).get('roots'), sel: __sporeMap.selected(), nodes: __sporeMap.nodes(), total: __sporeMapPage.total() })");
      result.phoneDeepLink = { gta, ...r };
      check(r.roots === null || r.roots === "200", `(g) a phone deep link to a top-200 root widened roots to ${r.roots}`);
      check(r.sel === gta, "(g) the deep-linked root is not selected on the phone");
      check(r.nodes < r.total, "(g) the phone draws every node (roots were widened)");
      result.shotPhone = await shot("interact-390-deeplink.png");
      await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false }, S);
    }
  }

  // ---------------------------------------------------------------- (f) production build: one since= request on an SPA reopen
  if (PROD && want("f")) {
    await send("Page.navigate", { url: `${PROD.replace(/\/$/, "")}/map?roots=all&debug` }, S);
    await mapReady();
    await settle("production layout to settle");
    await sleep(3000); // the full cache write, then the "full" stamp
    await evalJs(`history.pushState({}, "", "/?debug"); dispatchEvent(new PopStateEvent("popstate"))`);
    await waitFor("!window.__sporeMap", 5000, "map to unmount (prod)");
    await sleep(800);
    await evalJs("performance.clearResourceTimings()");
    await evalJs(`history.pushState({}, "", "/map?roots=all&debug"); dispatchEvent(new PopStateEvent("popstate"))`);
    await mapReady(60_000);
    await sleep(4000);
    const reqs = await evalJs<string[]>(`performance.getEntriesByType("resource").filter((e) => /\\/api\\/map(\\?|$)/.test(e.name)).map((e) => e.name.replace(/^.*\\/api\\/map/, "/api/map"))`);
    const src = await evalJs<string | null>("__sporeMapPage.source()");
    result.prodReopen = { requests: reqs, source: src };
    check(reqs.length === 1, `(f) the SPA reopen made ${reqs.length} /api/map request(s), expected exactly 1`);
    check(reqs.length >= 1 && /since=\d+/.test(reqs[0]), "(f) the SPA reopen's /api/map request has no since=");
  }
  ws.close();
} catch (e) {
  fails.push(`crashed: ${(e as Error).message}`);
} finally {
  result.consoleErrors = errors;
  result.networkErrors = netErrors.length;
  check(errors.length === 0, `${errors.length} console error(s): ${errors.slice(0, 3).join(" | ")}`);
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
