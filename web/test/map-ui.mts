// Headless checks of the /map page UI (DESIGN §11.5 "Map v2") through Chrome's DevTools protocol, no
// puppeteer (same harness as map-perf.mts). Against a dev server on the full dataset:
//   (a) search results paint above the controls under them and a click selects without touching ?roots
//   (b) the magnifier paints above the search input
//   (c) with /api/coin answering ours-mode zeros, the side panel shows the map node's locked value and children
//   (d) ?hl= chips (pressed state, counts), ?hl updates, ?size=mcap survives a reload
//   (e) arrow keys walk the tree, 0 fits, the aria-live text follows the selection
//   (f) a pasted pump.fun link selects a mapped coin; an unknown mint offers Open / Launch
//   (g) 390×844: no horizontal overflow, the sheet's peek keeps both actions on screen, the handle
//       expands on tap and closes on a 60 px drag, the selected bubble sits between the overlays,
//       a deep link to a top-200 root keeps roots=200
//   (h) the coin page's "whole ecosystem" link focuses the coin
//   (i) no console errors; overlays never overlap at 1440×900 and 1280×720; screenshots of every state
//   (j) a previous visit 3 h ago shows the "new pairs since" digest and the 'since' chip
//   (k) with /api/map/heat answering (intercepted), the Hot rail, the 'Traded 1h' chip and the heat lines
//       appear; without it (the old server's 404) they stay hidden and nothing errors.
//
//   API_PORT=8795 npx vite --port 5254 --host 127.0.0.1 &
//   SPORE_TMP=<dir> node --import tsx test/map-ui.mts --url http://127.0.0.1:5254 --shots <dir>/shots
//   # or against a production build: vite build --outDir <dir>/dist && API_PORT=8795 vite preview --outDir <dir>/dist --port 5254
//   SPORE_TMP=<dir> node --import tsx test/map-ui.mts --url http://127.0.0.1:5254 --prod --shots <dir>/shots
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const opt = (name: string, dflt: string) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt; };
const BASE = opt("--url", "http://127.0.0.1:5254").replace(/\/$/, "");
const SHOTS = opt("--shots", join(process.env.SPORE_TMP ?? tmpdir(), "spore-map-ui-shots"));
/// --prod: the URL serves a production build (vite preview), whose debug hooks need ?debug on every load.
const PROD = args.includes("--prod");
const u = (path: string) => (PROD ? `${path}${path.includes("?") ? "&" : "?"}debug` : path);
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const port = 9222 + Math.floor(Math.random() * 500);
const profile = mkdtempSync(join(process.env.SPORE_TMP ?? tmpdir(), "spore-ui-"));
mkdirSync(SHOTS, { recursive: true });
const chrome = spawn(CHROME, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--hide-scrollbars", "--disable-extensions", "--disable-background-timer-throttling", "--disable-renderer-backgrounding", `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, "--window-size=1440,900", "about:blank"], { stdio: "ignore" });

type Msg = { id?: number; method?: string; params?: Record<string, unknown>; sessionId?: string; result?: unknown; error?: { message: string } };
type Rect = { x: number; y: number; w: number; h: number };
const errors: string[] = [];
const netErrors: string[] = [];
const result: Record<string, unknown> = { url: BASE };
const fails: string[] = [];
const check = (cond: boolean, msg: string) => { if (!cond) fails.push(msg); return cond; };

// What the page should agree with, read straight from the API (through the dev server's proxy).
type Row = { mint: string; parentMint: string | null; depth: number; symbol: string | null; name: string | null; lockedUsd: number | null; mcapUsd: number | null; children: number; ours?: boolean };
async function loadTruth(): Promise<Row[]> {
  const j = await fetch(`${BASE}/api/map?scope=all&limit=all`).then((r) => r.json()) as { roots: { coin: Row; children: unknown[] }[] };
  const out: Row[] = [];
  const walk = (n: { coin: Row; children: unknown[] }, p: string | null) => { out.push({ ...n.coin, parentMint: p }); for (const k of n.children as { coin: Row; children: unknown[] }[]) walk(k, n.coin.mint); };
  for (const r of j.roots) walk(r, null);
  return out;
}
const kidCmp = (a: Row, b: Row) => (b.lockedUsd ?? 0) - (a.lockedUsd ?? 0) || (b.mcapUsd ?? 0) - (a.mcapUsd ?? 0) || (a.mint < b.mint ? -1 : a.mint > b.mint ? 1 : 0);
const overlap = (a: Rect, b: Rect) => a.w > 0 && a.h > 0 && b.w > 0 && b.h > 0 && a.x < b.x + b.w - 0.5 && b.x < a.x + a.w - 0.5 && a.y < b.y + b.h - 0.5 && b.y < a.y + a.h - 0.5;

try {
  const truth = await loadTruth();
  const byMint = new Map(truth.map((r) => [r.mint, r]));
  const find = (sym: string) => truth.filter((r) => r.symbol === sym && r.depth === 0).sort(kidCmp)[0];
  const NTRNDM = find("NTRNDM"), GTA = find("GTA");
  if (!NTRNDM || !GTA) throw new Error("test roots NTRNDM / GTA are not in the dataset");

  let version: { webSocketDebuggerUrl: string } | null = null;
  for (let i = 0; i < 50 && !version; i++) { await sleep(200); version = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json()).catch(() => null); }
  if (!version) throw new Error("chrome did not start");
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error("ws")); });
  let id = 0; const pending = new Map<number, { res: (v: unknown) => void; rej: (e: Error) => void }>();
  let onPaused: ((p: { requestId: string; request: { url: string } }) => Promise<void>) | null = null;
  const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string) => new Promise<unknown>((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
  ws.onmessage = (ev) => {
    const m = JSON.parse(String(ev.data)) as Msg;
    if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id)!; pending.delete(m.id); if (m.error) rej(new Error(m.error.message)); else res(m.result); return; }
    if (m.method === "Runtime.consoleAPICalled") { const p = m.params as { type: string; args: { value?: unknown; description?: string }[] }; if (p.type === "error") errors.push(`console.error: ${p.args.map((a) => a.value ?? a.description ?? "").join(" ")}`); }
    if (m.method === "Runtime.exceptionThrown") { const p = m.params as { exceptionDetails: { text: string; exception?: { description?: string } } }; errors.push(`exception: ${p.exceptionDetails.exception?.description ?? p.exceptionDetails.text}`); }
    if (m.method === "Log.entryAdded") { const p = m.params as { entry: { level: string; source: string; text: string; url?: string } }; if (p.entry.level === "error") { if (p.entry.source === "network") netErrors.push(`${p.entry.text} ${p.entry.url ?? ""}`); else errors.push(`${p.entry.source}: ${p.entry.text}`); } }
    if (m.method === "Fetch.requestPaused" && onPaused) void onPaused(m.params as { requestId: string; request: { url: string } }).catch((e) => { if (!/not enabled/.test((e as Error).message)) errors.push(`fetch intercept: ${(e as Error).message}`); });
  };
  const { targetId } = (await send("Target.createTarget", { url: "about:blank" })) as { targetId: string };
  const { sessionId: S } = (await send("Target.attachToTarget", { targetId, flatten: true })) as { sessionId: string };
  await send("Page.enable", {}, S); await send("Runtime.enable", {}, S); await send("Log.enable", {}, S);
  const viewport = (w: number, h: number) => send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: w < 700 }, S);
  const evalJs = async <T,>(expression: string): Promise<T> => { const r = (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, S)) as { result: { value: T }; exceptionDetails?: { text: string; exception?: { description?: string } } }; if (r.exceptionDetails) throw new Error(`eval failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text} :: ${expression.slice(0, 100)}`); return r.result.value; };
  const waitFor = async (expression: string, timeoutMs: number, what: string) => { const t0 = Date.now(); while (Date.now() - t0 < timeoutMs) { let v: unknown = null; try { v = await evalJs(expression); } catch { /* page still loading */ } if (v) return v; await sleep(100); } throw new Error(`timeout waiting for ${what}`); };
  const shot = async (name: string) => { const r = (await send("Page.captureScreenshot", { format: "png" }, S)) as { data: string }; const file = join(SHOTS, name); writeFileSync(file, Buffer.from(r.data, "base64")); return file; };
  const rect = (sel: string) => evalJs<Rect | null>(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
  const mouse = async (type: "mousePressed" | "mouseReleased" | "mouseMoved", x: number, y: number) => send("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" ? "none" : "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: type === "mouseMoved" ? 0 : 1 }, S);
  const click = async (x: number, y: number) => { await mouse("mouseMoved", x, y); await mouse("mousePressed", x, y); await mouse("mouseReleased", x, y); };
  const clickSel = async (sel: string) => { const r = await rect(sel); if (!r) throw new Error(`no element ${sel}`); await click(r.x + r.w / 2, r.y + r.h / 2); };
  const KEYS: Record<string, [string, number]> = { ArrowUp: ["ArrowUp", 38], ArrowDown: ["ArrowDown", 40], ArrowLeft: ["ArrowLeft", 37], ArrowRight: ["ArrowRight", 39], "0": ["Digit0", 48], Escape: ["Escape", 27] };
  const key = async (k: string) => { const [code, vk] = KEYS[k]; const text = k.length === 1 ? k : undefined; await send("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", key: k, code, windowsVirtualKeyCode: vk, text }, S); await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk }, S); };
  const param = (name: string) => evalJs<string | null>(`new URLSearchParams(location.search).get(${JSON.stringify(name)})`);
  const go = async (path: string) => { await send("Page.navigate", { url: `${BASE}${u(path)}` }, S); await waitFor("!!(window.__sporeMap && window.__sporeMap.firstPaintAt() > 0 && window.__sporeMapPage)", 120_000, `map on ${path}`); };
  const settle = async () => { await waitFor("window.__sporeMap && __sporeMap.settled() && !__sporeMap.flying()", 120_000, "layout + camera to settle").catch(() => { /* a live stream keeps nudging; the checks below tolerate it */ }); await sleep(400); };
  const spa = (path: string) => evalJs(`(history.pushState({}, "", ${JSON.stringify(u(path))}), dispatchEvent(new PopStateEvent("popstate")), true)`);
  const overlaps = async (label: string) => {
    const sels = [".map-overlay > .map-panel", ".map-search", ".map-hl", ".map-rails", ".map-key", ".map-side", ".bm-controls", ".bm-size"];
    const rs = await evalJs<(Rect & { sel: string })[]>(`${JSON.stringify(sels)}.map((s) => { const el = document.querySelector(s); if (!el) return null; const r = el.getBoundingClientRect(); return { sel: s, x: r.left, y: r.top, w: r.width, h: r.height }; }).filter(Boolean)`);
    const bad: string[] = [];
    // the column's own blocks stack (checked as one column); everything else must stay apart
    const col = rs.filter((r) => [".map-overlay > .map-panel", ".map-search", ".map-hl", ".map-rails"].includes(r.sel));
    const others = rs.filter((r) => !col.includes(r));
    for (let i = 0; i < others.length; i++) { for (const c of col) if (overlap(others[i], c)) bad.push(`${others[i].sel}×${c.sel}`); for (let j = i + 1; j < others.length; j++) if (overlap(others[i], others[j])) bad.push(`${others[i].sel}×${others[j].sel}`); }
    for (let i = 0; i < col.length; i++) for (let j = i + 1; j < col.length; j++) if (overlap(col[i], col[j])) bad.push(`${col[i].sel}×${col[j].sel}`);
    result[`overlap_${label}`] = { present: rs.map((r) => r.sel), bad };
    check(bad.length === 0, `${label}: overlapping overlays ${bad.join(", ")}`);
  };

  // ---------------- desktop 1440×900
  await viewport(1440, 900);
  await go("/map");
  await settle();
  result.shotIdle = await shot("ui-1440-idle.png");
  result.noHeat = await evalJs(`({ hotTab: [...document.querySelectorAll(".map-rail-tabs button")].some((b) => b.textContent === "Hot"), activeChip: !!document.querySelector('.map-hl-chip[data-key="active"]') })`);

  // (b) magnifier above the input
  const svg = await evalJs<{ ok: boolean }>(`(() => { const s = document.querySelector(".map-search svg"); s.style.pointerEvents = "auto"; const r = s.getBoundingClientRect(); const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); const ok = !!el && (el === s || s.contains(el)); s.style.pointerEvents = ""; return { ok }; })()`);
  check(svg.ok, "(b) the magnifier is painted under the search input");
  result.b = svg;

  // (a) search results above the roots control; a click selects and leaves ?roots alone
  const rootsBefore = await param("roots");
  await clickSel(".map-search input");
  await send("Input.insertText", { text: "muskonomy" }, S);
  await waitFor(`document.querySelectorAll(".map-results .map-result").length > 0`, 5000, "search results");
  const hit = await evalJs<{ ok: boolean; x: number; y: number; first: string; under: string }>(`(() => { const b = document.querySelector(".map-results .map-result"); const r = b.getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2; const el = document.elementFromPoint(x, y); return { ok: !!el && el.closest(".map-result") === b, x, y, first: b.textContent, under: el ? (el.closest("button") || el).textContent.slice(0, 40) : "" }; })()`);
  check(hit.ok, `(a) the first result is covered by "${hit.under}"`);
  await click(hit.x, hit.y);
  await waitFor(`new URLSearchParams(location.search).has("focus")`, 2000, "?focus after the result click").catch(() => fails.push("(a) clicking the first result did not set ?focus"));
  const rootsAfter = await param("roots");
  check(rootsAfter === rootsBefore, `(a) ?roots changed from ${rootsBefore} to ${rootsAfter}`);
  result.a = { ...hit, focus: await param("focus"), rootsBefore, rootsAfter };

  // search 'elon' screenshot: rows tell coins apart (logo, parent, mcap)
  await key("Escape");
  await clickSel(".map-search input");
  await evalJs(`(() => { const i = document.querySelector(".map-search input"); i.select(); return true; })()`);
  await send("Input.insertText", { text: "elon" }, S);
  await waitFor(`document.querySelectorAll(".map-results .map-result").length >= 3`, 5000, "elon results");
  await sleep(900); // the remote "On pump.fun" section is debounced 250 ms
  result.elonRows = await evalJs(`[...document.querySelectorAll(".map-results .map-result")].slice(0, 4).map((b) => b.innerText.replace(/\\s+/g, " "))`);
  result.shotSearch = await shot("ui-1440-search-elon.png");

  // (f) pasted pump.fun link of a mapped coin selects it; an unknown mint offers Open / Launch
  const leaf = truth.find((r) => r.parentMint === GTA.mint)!;
  await evalJs(`(() => { const i = document.querySelector(".map-search input"); i.select(); return true; })()`);
  await send("Input.insertText", { text: `https://pump.fun/coin/${leaf.mint}` }, S);
  await waitFor(`new URLSearchParams(location.search).get("focus") === ${JSON.stringify(leaf.mint)}`, 3000, "pasted link selects").catch(() => fails.push("(f) a pasted pump.fun link did not select the mapped coin"));
  const unknown = "So11111111111111111111111111111111111111112";
  await clickSel(".map-search input");
  await send("Input.insertText", { text: unknown }, S);
  const off = await waitFor(`(() => { const o = document.querySelector(".map-offmap"); if (!o || !/Not on the map yet/.test(o.textContent)) return null; const hrefs = [...o.querySelectorAll("a")].map((a) => a.getAttribute("href")); return hrefs; })()`, 4000, "not-on-the-map row").catch(() => null) as string[] | null;
  check(!!off && off.includes(`/c/${unknown}`) && off.includes(`/launch?parent=${unknown}`), `(f) unknown mint row: ${JSON.stringify(off)}`);
  result.f = { selected: await param("focus"), offmap: off };
  await evalJs(`(() => { const i = document.querySelector(".map-search input"); i.blur(); return true; })()`);
  check(!(await evalJs<boolean>(`!!document.querySelector(".map-results")`)), "(f) the results list stays open after the input lost focus");
  await clickSel(".map-search input"); await key("Escape"); // Esc in the field clears it
  check((await evalJs<string>(`document.querySelector(".map-search input").value`)) === "", "(f) Esc did not clear the search field");
  await evalJs(`(document.activeElement && document.activeElement.blur && document.activeElement.blur(), true)`);
  await spa("/map");
  await sleep(300);

  // (c) ours-mode /api/coin (zeros) and no candles: the panel keeps the node's numbers; the sparkline shows "—"
  let coinHits = 0, coinLight = 0, candleHits = 0;
  const t0c = Date.now();
  const trace: string[] = [];
  onPaused = async (p) => {
    const url = p.request.url;
    trace.push(`${Date.now() - t0c} paused ${url.replace(/^.*\/api\//, "")}`);
    if (/\/api\/coin\//.test(url)) {
      coinHits++; if (/children=0/.test(url) && /trades=0/.test(url)) coinLight++;
      const real = await fetch(url).then((r) => r.json()) as { coin: Record<string, unknown> };
      const body = { coin: { ...real.coin, children: 0, descendants: 0, lockedUsd: 0, lockedQuote: "0", ours: false }, children: [], trades: [], otherChildren: 297 };
      await send("Fetch.fulfillRequest", { requestId: p.requestId, responseCode: 200, responseHeaders: [{ name: "content-type", value: "application/json" }], body: Buffer.from(JSON.stringify(body)).toString("base64") }, S);
    } else if (/\/api\/candles\//.test(url)) {
      candleHits++;
      await send("Fetch.fulfillRequest", { requestId: p.requestId, responseCode: 404, responseHeaders: [{ name: "content-type", value: "application/json" }], body: Buffer.from(JSON.stringify({ error: "not a Spore coin" })).toString("base64") }, S);
    } else await send("Fetch.continueRequest", { requestId: p.requestId }, S);
    trace.push(`${Date.now() - t0c} done`);
  };
  await send("Fetch.enable", { patterns: [{ urlPattern: "*/api/coin/*" }, { urlPattern: "*/api/candles/*" }] }, S);
  await spa(`/map?focus=${NTRNDM.mint}`);
  await waitFor(`/^notrandom/.test(document.querySelector(".map-side")?.getAttribute("aria-label") ?? "") && !document.querySelector(".map-side .map-side-stats .sk") && !!document.querySelector(".map-side .map-spark-none, .map-side .map-spark")`, 20_000, "side panel numbers").catch(() => fails.push("(c) side panel did not finish loading"));
  const side = await evalJs<{ locked: string; children: string; spark: boolean; dash: boolean }>(`(() => { const st = [...document.querySelectorAll(".map-side .map-side-stats > div")]; const val = (label) => { const d = st.find((x) => x.querySelector("em").textContent.startsWith(label)); return d ? d.querySelector("strong").textContent : ""; }; return { locked: val("locked"), children: val("children"), spark: !!document.querySelector(".map-side .map-spark"), dash: !!document.querySelector(".map-side .map-spark-none") }; })()`);
  const nodeNow = await evalJs<{ lockedUsd: number; children: number }>(`__sporeMap.node(${JSON.stringify(NTRNDM.mint)})`);
  check(side.locked !== "$0" && side.locked !== "—" && side.locked.startsWith("$"), `(c) locked shows ${side.locked}`);
  check(side.children.startsWith(nodeNow.children.toLocaleString("en-US")), `(c) children shows "${side.children}", node has ${nodeNow.children}`);
  check(side.dash && !side.spark, "(c) no candles must read as '—' without a sparkline");
  check(coinHits > 0 && coinLight === coinHits, `(c) /api/coin requests ${coinHits}, light ${coinLight}`);
  result.c = { ...side, node: nodeNow, coinHits, coinLight, candleHits, trace, readyMs: Date.now() - t0c };
  await send("Fetch.disable", {}, S); onPaused = null;
  // the side panel with real candles (screenshot)
  await spa("/map"); await sleep(300);
  await spa(`/map?focus=${NTRNDM.mint}`);
  await waitFor(`!!document.querySelector(".map-side .map-spark, .map-side .map-spark-none") && !document.querySelector(".map-side .map-side-stats .sk")`, 8000, "panel with candles").catch(() => null);
  await settle();
  result.sideReal = await evalJs(`({ spark: !!document.querySelector(".map-side .map-spark"), change: (document.querySelector(".map-side .map-chg") || {}).textContent, launchVisible: (() => { const a = document.querySelector(".map-side .map-side-main"); const r = a.getBoundingClientRect(); return r.bottom <= innerHeight && r.top >= 0; })() })`);
  check((result.sideReal as { launchVisible: boolean }).launchVisible, "Launch under / Open coin are not visible without scrolling at 1440×900");
  result.shotSelected = await shot("ui-1440-ntrndm.png");
  await overlaps("1440-selected");

  // (e) keyboard walk
  await evalJs(`(document.activeElement && document.activeElement.blur && document.activeElement.blur(), true)`);
  const kids = truth.filter((r) => r.parentMint === NTRNDM.mint).sort(kidCmp);
  const live0 = await evalJs<string>(`document.querySelector(".map-sr").textContent`);
  // Key events are logged in the page so a lost keystroke is visible in the report.
  await evalJs(`(window.__k = [], document.addEventListener("keydown", (e) => window.__k.push(e.key + " " + (e.defaultPrevented ? "handled" : "-") + " " + (document.activeElement && document.activeElement.tagName)), true), true)`);
  await sleep(200);
  await key("ArrowDown");
  await sleep(150);
  result.eFirst = await evalJs(`({ keys: window.__k.slice(), url: location.search.slice(0, 60), selected: __sporeMap.selected ? __sporeMap.selected() : null, active: document.activeElement && document.activeElement.tagName })`);
  await waitFor(`new URLSearchParams(location.search).get("focus") === ${JSON.stringify(kids[0].mint)}`, 2000, "↓ to the largest child").catch(() => fails.push(`(e) ↓ did not select the largest child ${kids[0].symbol}`));
  const live1 = await evalJs<string>(`document.querySelector(".map-sr").textContent`);
  check(live1 !== live0 && live1.length > 0, `(e) aria-live did not change (${live0} → ${live1})`);
  await key("ArrowRight");
  const kidsLive = await evalJs<string[]>(`__sporeMap.children(${JSON.stringify(NTRNDM.mint)})`);
  const afterRight = await param("focus");
  check(afterRight !== kids[0].mint && !!afterRight && kidsLive.includes(afterRight), `(e) → did not move to a sibling (${afterRight})`);
  if (afterRight && kids[1]) check(afterRight === kids[1].mint, `(e) → selected ${byMint.get(afterRight)?.symbol}, expected the next in order ${kids[1].symbol}`);
  await key("ArrowUp");
  await waitFor(`new URLSearchParams(location.search).get("focus") === ${JSON.stringify(NTRNDM.mint)}`, 2000, "↑ to the parent").catch(() => fails.push("(e) ↑ did not return to the root"));
  await settle();
  const kSel = await evalJs<number>("__sporeMap.zoom()");
  await key("0");
  await sleep(2200);
  const kFit = await evalJs<number>("__sporeMap.zoom()");
  check(kFit < kSel, `(e) 0 did not zoom out to fit (k ${kSel} → ${kFit})`);
  result.e = { keys: await evalJs("window.__k"), kids: kids.slice(0, 2).map((k) => k.symbol), afterRight: afterRight ? byMint.get(afterRight)?.symbol : null, live0, live1, kSel, kFit };

  // (d) highlights in the URL; ?size=mcap survives a reload
  const oursOnMap = truth.filter((r) => r.ours).map((r) => r.mint);
  await spa("/map?hl=ours");
  await waitFor(`document.querySelector('.map-hl-chip[data-key="ours"]')?.getAttribute("aria-pressed") === "true"`, 3000, "ours chip pressed").catch(() => fails.push("(d) ?hl=ours did not press the chip"));
  const chip = await evalJs<{ count: string; page: number }>(`({ count: document.querySelector('.map-hl-chip[data-key="ours"] b').textContent, page: __sporeMapPage.hlCounts().ours })`);
  const expectOurs = await evalJs<number>(`${JSON.stringify(oursOnMap)}.filter((m) => __sporeMap.has(m)).length`);
  check(Number(chip.count.replace(/,/g, "")) === chip.page && chip.page === expectOurs, `(d) ours chip ${chip.count}, hlCounts ${chip.page}, on the map ${expectOurs}`);
  await sleep(1200);
  result.shotHl = await shot("ui-1440-hl-ours.png");
  await clickSel('.map-hl-chip[data-key="grad"]');
  await sleep(300);
  const hlAfter = await param("hl");
  check(hlAfter === "ours,grad", `(d) toggling grad wrote ?hl=${hlAfter}`);
  await clickSel(".map-hl-chip.clear");
  await sleep(200);
  check((await param("hl")) === null, "(d) clear did not remove ?hl");
  const mcapBtn = await evalJs<boolean>(`(() => { const b = [...document.querySelectorAll(".bm-size button")].find((x) => x.textContent.trim() === "mcap"); if (!b) return false; b.click(); return true; })()`);
  check(mcapBtn, "(d) no mcap size button");
  await sleep(300);
  check((await param("size")) === "mcap", "(d) the size control did not write ?size=mcap");
  await evalJs("window.__oldDoc = true");
  await send("Page.reload", {}, S);
  await waitFor("window.__oldDoc === undefined", 30_000, "the reloaded document"); // the old document answers until the new one commits
  await waitFor("!!(window.__sporeMap && window.__sporeMap.firstPaintAt() > 0 && window.__sporeMapPage && document.querySelector('.bm-size button'))", 60_000, "map after reload");
  const sizeReload = await evalJs<{ param: string | null; pressed: string | null }>(`({ param: new URLSearchParams(location.search).get("size"), pressed: ([...document.querySelectorAll(".bm-size button")].find((x) => x.getAttribute("aria-pressed") === "true") || {}).textContent || null })`);
  check(sizeReload.param === "mcap" && sizeReload.pressed?.trim() === "mcap", `(d) ?size=mcap after reload: ${JSON.stringify(sizeReload)}`);
  result.d = { chip, expectOurs, hlAfter, sizeReload };
  await spa("/map");
  await settle();
  check(!!(await waitFor(`document.querySelectorAll(".map-rails .map-rail-row").length > 0`, 6000, "rails after reload").catch(() => null)), "the New rail is empty after a reload");

  // Key expanded
  await clickSel(".map-key-toggle");
  await sleep(400);
  result.keySize = await evalJs(`[...document.querySelectorAll(".map-key-size text")].map((t) => t.textContent)`);
  check((result.keySize as string[]).length >= 2, "the Key's size section drew fewer than 2 reference circles at fit");
  result.shotKey = await shot("ui-1440-key.png");
  await overlaps("1440-key");
  // 1280×720 with a selection and the Key open
  await viewport(1280, 720);
  await spa(`/map?focus=${NTRNDM.mint}`);
  await sleep(1500);
  if (!(await evalJs<boolean>(`!!document.querySelector(".map-key.open")`))) await clickSel(".map-key-toggle");
  await sleep(300);
  await overlaps("1280-selected-key");
  result.shot1280 = await shot("ui-1280-selected-key.png");

  // (h) the coin page link
  await viewport(1440, 900);
  await spa(`/c/${NTRNDM.mint}`);
  const href = await waitFor(`(() => { const a = [...document.querySelectorAll("a")].find((x) => /whole ecosystem/.test(x.textContent)); return a ? a.getAttribute("href") : null; })()`, 20_000, "coin page link").catch(() => null);
  check(href === `/map?focus=${NTRNDM.mint}`, `(h) whole ecosystem link is ${href}`);
  result.h = href;

  // (j) "since your last visit": a previous visit 3 h ago (written while the map is not mounted, so the
  // page's own pagehide/unmount stamp cannot overwrite it) shows the digest chip and the 'since' chip.
  await evalJs(`new Promise((res, rej) => { const r = indexedDB.open("spore-map"); r.onerror = () => rej(r.error); r.onsuccess = () => { const db = r.result; const tx = db.transaction("meta", "readwrite"); tx.objectStore("meta").put({ key: "seen", at: Date.now() - 3 * 3600e3 }); tx.oncomplete = () => { db.close(); res(true); }; tx.onerror = () => rej(tx.error); }; })`);
  await spa("/map");
  const digest = await waitFor(`(() => { const d = document.querySelector(".map-digest"); return d ? d.textContent : null; })()`, 15_000, "digest chip").catch(() => null) as string | null;
  check(!!digest && /new pairs? since 3h ago/.test(digest), `(j) digest chip: ${digest}`);
  check(await evalJs<boolean>(`!!document.querySelector('.map-hl-chip[data-key="since"]')`), "(j) no 'Since your last visit' chip");
  if (digest) { await clickSel(".map-digest"); await sleep(300); check((await param("hl")) === "since", `(j) the digest chip wrote ?hl=${await param("hl")}`); }
  result.j = { digest, hl: await param("hl") };
  result.shotDigest = await shot("ui-1440-digest-since.png");

  // (k) with the heat sidecar answering (intercepted: the old server has no route), the Hot tab, the
  // 'Traded 1h' chip, the trades/min line and the side panel's heat line appear.
  const hot = truth.filter((r) => r.depth >= 1).slice(0, 3);
  const nowS = Math.floor(Date.now() / 1000);
  const heatBody = { at: nowS, since: nowS - 86400, mint: hot.map((r) => r.mint), t1h: [42, 7, 3], n24: [300, 40, 9], v24: [12000, 900, 50], last: [nowS - 30, nowS - 200, nowS - 900], buys1h: [30, 4, 1] };
  onPaused = async (p) => {
    if (/\/api\/map\/heat/.test(p.request.url)) await send("Fetch.fulfillRequest", { requestId: p.requestId, responseCode: 200, responseHeaders: [{ name: "content-type", value: "application/json" }], body: Buffer.from(JSON.stringify(heatBody)).toString("base64") }, S);
    else await send("Fetch.continueRequest", { requestId: p.requestId }, S);
  };
  await send("Fetch.enable", { patterns: [{ urlPattern: "*/api/map/heat*" }] }, S);
  await send("Page.navigate", { url: `${BASE}${u(`/map?focus=${hot[0].mint}`)}` }, S);
  await waitFor("!!(window.__sporeMap && window.__sporeMap.firstPaintAt() > 0 && window.__sporeMapPage)", 60_000, "map with heat");
  const k = await waitFor(`(() => { const tab = [...document.querySelectorAll(".map-rail-tabs button")].some((b) => b.textContent === "Hot"); const chip = document.querySelector('.map-hl-chip[data-key="active"] b'); const line = document.querySelector(".map-heatline")?.textContent ?? ""; const side = document.querySelector(".map-side-heat")?.textContent ?? ""; return tab && chip && /trades\\/min/.test(line) && /42 trades 1h/.test(side) ? { tab, chip: chip.textContent, line, side } : null; })()`, 15_000, "heat-driven UI").catch(() => null) as { chip: string } | null;
  check(!!k, "(k) heat did not light the Hot tab / Traded 1h chip / trades-per-minute line / side panel heat line");
  // ≥ 3: the live trade stream keeps adding rows to the index between polls.
  if (k) check(Number(k.chip.replace(/,/g, "")) >= 3, `(k) Traded 1h chip counts ${k.chip}, expected at least the 3 intercepted rows`);
  if (k) { const tab = await evalJs<boolean>(`(() => { const b = [...document.querySelectorAll(".map-rail-tabs button")].find((x) => x.textContent === "Hot"); b.click(); return true; })()`); await sleep(300); result.hotRows = tab ? await evalJs(`[...document.querySelectorAll(".map-rails .map-rail-row")].map((r) => r.innerText.replace(/\\s+/g, " "))`) : null; }
  result.k = k;
  result.shotHeat = await shot("ui-1440-heat.png");
  await send("Fetch.disable", {}, S); onPaused = null;

  // ---------------- phone 390×844 (fresh document so the phone defaults apply)
  await viewport(390, 844);
  await go("/map");
  await settle();
  const phone = await evalJs<{ overflowX: boolean; roots: string | null; seg: string | null }>(`({ overflowX: document.documentElement.scrollWidth > innerWidth || document.body.scrollWidth > innerWidth, roots: new URLSearchParams(location.search).get("roots"), seg: null })`);
  check(!phone.overflowX, "(g) horizontal overflow at 390 px");
  result.shot390 = await shot("ui-390-fit.png");
  for (const [pill, name] of [["Live", "live"], ["Filters", "filters"], ["Key", "key"]] as const) {
    await evalJs(`(() => { const b = [...document.querySelectorAll(".map-pill")].find((x) => x.textContent.includes(${JSON.stringify(pill)})); b.click(); return true; })()`);
    await sleep(350);
    const pop = await rect(".map-pop");
    check(!!pop && pop.x >= 0 && pop.x + pop.w <= 390, `(g) the ${pill} popover is off screen: ${JSON.stringify(pop)}`);
    result[`shot390${name}`] = await shot(`ui-390-pop-${name}.png`);
    await clickSel(".map-pop-close");
    await sleep(200);
  }
  // a deep link to a top-200 root keeps roots at 200 (the widen race)
  await go(`/map?focus=${GTA.mint}`);
  await waitFor(`!!document.querySelector(".map-sheet")`, 15_000, "sheet").catch(() => fails.push("(g) no sheet for a selected coin"));
  await settle();
  const g = await evalJs<{ roots: string | null; peek: boolean; acts: Rect[]; sheetTop: number; overlayBottom: number; pt: { x: number; y: number } | null; overflowX: boolean }>(`(() => {
    const acts = [...document.querySelectorAll(".map-sheet .map-side-main > *")].map((a) => { const r = a.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
    const sheet = document.querySelector(".map-sheet").getBoundingClientRect(), ov = document.querySelector(".map-overlay").getBoundingClientRect();
    return { roots: new URLSearchParams(location.search).get("roots"), peek: document.querySelector(".map-sheet").classList.contains("peek"), acts, sheetTop: sheet.top, overlayBottom: ov.bottom, pt: __sporeMap.screenOf(${JSON.stringify(GTA.mint)}), overflowX: document.documentElement.scrollWidth > innerWidth };
  })()`);
  check(g.roots === null || g.roots === "200", `(g) deep link widened roots to ${g.roots}`);
  check(g.peek, "(g) the sheet did not open in peek");
  check(g.acts.length >= 2 && g.acts.every((r) => r.x >= 0 && r.y >= 0 && r.x + r.w <= 390 && r.y + r.h <= 844), `(g) peek actions not fully on screen: ${JSON.stringify(g.acts)}`);
  check(!!g.pt && g.pt.y > g.overlayBottom && g.pt.y < g.sheetTop, `(g) selected bubble at y=${g.pt?.y} is not between the overlay (${g.overlayBottom}) and the sheet (${g.sheetTop})`);
  check(!g.overflowX, "(g) horizontal overflow with the sheet open");
  result.g = g;
  result.shotPeek = await shot("ui-390-peek.png");
  const handle = (await rect(".map-sheet-handle"))!;
  await click(handle.x + handle.w / 2, handle.y + handle.h / 2);
  await waitFor(`document.querySelector(".map-sheet")?.classList.contains("full")`, 2000, "sheet full after a tap").catch(() => fails.push("(g) a tap on the handle did not expand the sheet"));
  await sleep(500);
  result.shotFull = await shot("ui-390-full.png");
  const h2 = (await rect(".map-sheet-handle"))!;
  const hx = h2.x + h2.w / 2, hy = h2.y + h2.h / 2;
  await mouse("mouseMoved", hx, hy); await mouse("mousePressed", hx, hy);
  for (let dy = 10; dy <= 90; dy += 10) { await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: hx, y: hy + dy, button: "left", buttons: 1 }, S); await sleep(16); }
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: hx, y: hy + 90, button: "left", buttons: 0, clickCount: 1 }, S);
  await waitFor(`!new URLSearchParams(location.search).has("focus")`, 2000, "drag down clears focus").catch(() => fails.push("(g) a 90 px drag down on the handle did not clear ?focus"));
  result.gDrag = { focus: await param("focus") };
  ws.close();
} catch (e) {
  fails.push(`crashed: ${(e as Error).message}`);
} finally {
  result.consoleErrors = errors;
  result.networkErrors = netErrors;
  check(errors.length === 0, `(i) ${errors.length} console error(s): ${errors.slice(0, 3).join(" | ")}`);
  result.failures = fails;
  result.ok = fails.length === 0;
  console.log(JSON.stringify(result, null, 2));
  const exited = new Promise<void>((r) => { chrome.once("exit", () => r()); setTimeout(r, 3000); });
  chrome.kill("SIGKILL");
  await exited;
  for (let i = 0; i < 10; i++) { try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); break; } catch { await sleep(300); } }
}
process.exit(fails.length ? 1 : 0);
