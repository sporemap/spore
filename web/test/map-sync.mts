// End-to-end check of the map's delta sync, client cache and live patching (DESIGN §11.5) against
// test/map-mock-api.mts, which serves the exact wire shapes and a real SSE stream. Through CDP (no
// puppeteer): cold load = one full request and a filled cache; touched nodes come back through
// `since=` only (no full reload, no layout restart); `mapdelta` and `pair` events patch the map live;
// a reload paints from the cache before the network answers and asks only for the delta; a cache whose
// last complete load is older than 15 min re-syncs in full (one request, no since=).
//
//   node --import tsx test/map-mock-api.mts &                # :8798, proxies the rest to :8795
//   API_PORT=8798 npx vite --port 5233 --host 127.0.0.1 &    # dev server on the mock
//   node --import tsx test/map-sync.mts --url http://127.0.0.1:5233 --mock http://127.0.0.1:8798
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const opt = (name: string, dflt: string) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt; };
const BASE = opt("--url", "http://127.0.0.1:5233");
const MOCK = opt("--mock", "http://127.0.0.1:8798");
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const port = 9222 + Math.floor(Math.random() * 500);
const profile = mkdtempSync(join(process.env.SPORE_TMP ?? tmpdir(), "spore-sync-"));
const chrome = spawn(CHROME, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--disable-extensions", `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, "--window-size=1440,900", "about:blank"], { stdio: "ignore" });
const errors: string[] = [];
const fails: string[] = [];
const result: Record<string, unknown> = {};
const check = (cond: boolean, msg: string) => { if (!cond) fails.push(msg); };
const post = (path: string, body: unknown) => fetch(`${MOCK}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());

try {
  let version: { webSocketDebuggerUrl: string } | null = null;
  for (let i = 0; i < 50 && !version; i++) { await sleep(200); version = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json()).catch(() => null); }
  if (!version) throw new Error("chrome did not start");
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error("ws")); });
  let id = 0; const pending = new Map<number, { res: (v: unknown) => void; rej: (e: Error) => void }>();
  ws.onmessage = (ev) => {
    const m = JSON.parse(String(ev.data)) as { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message: string } };
    if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id)!; pending.delete(m.id); if (m.error) rej(new Error(m.error.message)); else res(m.result); return; }
    if (m.method === "Runtime.consoleAPICalled") { const p = m.params as { type: string; args: { value?: unknown; description?: string }[] }; if (p.type === "error") errors.push(`console.error: ${p.args.map((a) => a.value ?? a.description ?? "").join(" ")}`); }
    if (m.method === "Runtime.exceptionThrown") { const p = m.params as { exceptionDetails: { text: string; exception?: { description?: string } } }; errors.push(`exception: ${p.exceptionDetails.exception?.description ?? p.exceptionDetails.text}`); }
    if (m.method === "Log.entryAdded") { const p = m.params as { entry: { level: string; source: string; text: string } }; if (p.entry.level === "error" && p.entry.source !== "network") errors.push(`${p.entry.source}: ${p.entry.text}`); }
  };
  const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string) => new Promise<unknown>((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
  const { targetId } = (await send("Target.createTarget", { url: "about:blank" })) as { targetId: string };
  const { sessionId: S } = (await send("Target.attachToTarget", { targetId, flatten: true })) as { sessionId: string };
  await send("Page.enable", {}, S); await send("Runtime.enable", {}, S); await send("Log.enable", {}, S);
  const evalJs = async <T,>(expression: string): Promise<T> => { const r = (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, S)) as { result: { value: T }; exceptionDetails?: { text: string } }; if (r.exceptionDetails) throw new Error(`eval failed: ${r.exceptionDetails.text} :: ${expression.slice(0, 80)}`); return r.result.value; };
  const waitFor = async (expression: string, timeoutMs: number, what: string) => { const t0 = Date.now(); while (Date.now() - t0 < timeoutMs) { let v: unknown = null; try { v = await evalJs(expression); } catch { /* loading */ } if (v) return v; await sleep(100); } throw new Error(`timeout waiting for ${what}`); };
  // /api/map itself (the tree and its deltas), not the /api/map/heat sidecar
  const mapRequests = () => evalJs<{ url: string; ms: number }[]>(`performance.getEntriesByType("resource").filter((e) => /\\/api\\/map(\\?|$)/.test(e.name)).map((e) => ({ url: e.name.replace(/^.*\\/api\\/map/, "/api/map"), ms: Math.round(e.duration) }))`);

  // ---- cold: one full request, bubbles, cache filled
  await send("Page.navigate", { url: `${BASE}/map?roots=all` }, S);
  await waitFor("!!(window.__sporeMap && window.__sporeMap.firstPaintAt() > 0)", 60_000, "first paint");
  await waitFor("__sporeMap.settled()", 120_000, "settle");
  const reqs1 = await mapRequests();
  result.coldRequests = reqs1;
  check(reqs1.length === 1 && /limit=all/.test(reqs1[0].url) && !/since=/.test(reqs1[0].url), "cold open must make exactly one full limit=all request");
  const n0 = await evalJs<number>("__sporeMap.nodes()");
  const ticks0 = await evalJs<number>("__sporeMap.worker().ticks");
  result.nodes = n0;
  check(await evalJs<string>("__sporeMapPage.source()") === "network", "cold source should be network");

  // ---- delta: touch 25 nodes on the server, ask for what changed; only those come back, values move, no restart
  const touched = (await post("/__mock/touch", { count: 25 })) as { touched: string[] };
  const before = await evalJs<number | null>(`__sporeMap.node(${JSON.stringify(touched.touched[0])}).mcapUsd`);
  await evalJs("__sporeMapPage.sync()");
  await sleep(2500);
  const reqs2 = await mapRequests();
  const deltaReq = reqs2.find((r) => /since=\d+/.test(r.url));
  result.deltaRequest = deltaReq ?? null;
  check(!!deltaReq, "sync must request since=<generatedAt>");
  check(reqs2.filter((r) => !/since=/.test(r.url)).length === 1, "no second full request after the delta");
  const after = await evalJs<number | null>(`__sporeMap.node(${JSON.stringify(touched.touched[0])}).mcapUsd`);
  result.touchedValue = { before, after };
  check(after != null && before != null && after > before, "touched node value did not update through the delta");
  check((await evalJs<number>("__sporeMap.nodes()")) === n0, "node count changed on a value-only delta");
  const ticks1 = await evalJs<number>("__sporeMap.worker().ticks");
  result.ticksForDelta = ticks1 - ticks0;
  check(ticks1 - ticks0 < 60, `a value delta reheated the layout too much (${ticks1 - ticks0} ticks)`);

  // ---- live mapdelta event over the real stream
  const target = touched.touched[1];
  const v0 = await evalJs<number | null>(`__sporeMap.node(${JSON.stringify(target)}).mcapUsd`);
  await post("/__mock/emit", { event: "mapdelta", data: { at: Date.now(), updated: [{ mint: target, mcapUsd: (v0 ?? 1000) * 3, lockedUsd: null, children: 0, descendants: 0, migrated: false }] } });
  await sleep(1000);
  const v1 = await evalJs<number | null>(`__sporeMap.node(${JSON.stringify(target)}).mcapUsd`);
  result.mapdelta = { v0, v1 };
  check(v1 != null && v0 != null && Math.abs(v1 - v0 * 3) < 1e-6, "mapdelta event did not patch the node");

  // ---- live pair event over the real stream (a real EventSource, no mock in the page)
  const added = (await post("/__mock/add", {})) as { mint: string; parent: string; clients: number };
  result.pairClients = added.clients;
  const seen = await waitFor(`__sporeMap.has(${JSON.stringify(added.mint)})`, 8000, "pair child").catch(() => false);
  check(!!seen, "pair event did not insert the child");
  check((await evalJs<number>("__sporeMap.nodes()")) === n0 + 1, "pair should add exactly one node");
  await waitFor("__sporeMap.settled()", 60_000, "settle after pair").catch(() => fails.push("no settle after pair"));
  await sleep(1500); // the cache flush timer

  // ---- reload: paint from the cache, then only the delta
  await send("Page.reload", {}, S);
  await waitFor("window.__sporeMapPage === undefined || !window.__sporeMap", 10_000, "new document").catch(() => null);
  await waitFor("!!(window.__sporeMap && window.__sporeMapPage && window.__sporeMap.firstPaintAt() > 0)", 60_000, "warm first paint");
  const warm = await evalJs<{ fp: number; mounted: number; cache: unknown; n: number; settled: boolean }>("({ fp: __sporeMap.firstPaintAt(), mounted: __sporeMapPage.mountedAt, cache: __sporeMapPage.cacheInfo(), n: __sporeMap.nodes(), settled: __sporeMap.settled() })");
  result.warm = { paintAfterMountMs: Math.round(warm.fp - warm.mounted), cache: warm.cache, nodes: warm.n, settledAtPaint: warm.settled };
  check(warm.cache != null, "reload did not read the cache");
  check(warm.n === n0 + 1, `cache held ${warm.n} nodes, expected ${n0 + 1} (the pair child must be cached too)`);
  await sleep(3000);
  const reqs3 = await mapRequests();
  result.warmRequests = reqs3;
  check(reqs3.length >= 1 && reqs3.every((r) => /since=\d+/.test(r.url)), "warm open must only ask for the delta (since=)");
  // a node that never had its position saved (inserted live, then a hard reload) earns a short relaxation; the rest must not move
  check(warm.fp - warm.mounted < 500, `warm paint took ${Math.round(warm.fp - warm.mounted)} ms after mount`);
  await waitFor("__sporeMap.settled()", 20_000, "warm open to settle").catch(() => fails.push("warm open did not settle within 20 s"));

  // ---- stale full load: the cache's last complete load is 20 min old, so the reopen re-syncs in full
  // (bounds the USD drift of a warm cache: since= only carries coins whose own row changed)
  const stamped = await evalJs<string>(`new Promise((res) => { const r = indexedDB.open("spore-map"); r.onerror = () => res("open failed"); r.onsuccess = () => { const db = r.result; const tx = db.transaction("meta", "readwrite"); tx.objectStore("meta").put({ key: "full", at: Date.now() - 20 * 60_000 }); tx.oncomplete = () => { db.close(); res("ok"); }; tx.onerror = () => res("write failed"); }; })`);
  check(stamped === "ok", `could not age the 'full' record (${stamped})`);
  await evalJs("window.__oldDoc = 1");
  await send("Page.reload", {}, S);
  await waitFor("!window.__oldDoc", 30_000, "new document");
  await waitFor("!!(window.__sporeMap && window.__sporeMapPage && window.__sporeMap.firstPaintAt() > 0)", 60_000, "warm first paint (stale full)");
  await sleep(4000);
  const reqs4 = await mapRequests();
  result.staleFullRequests = reqs4;
  check(reqs4.length === 1 && !/since=/.test(reqs4[0].url) && /limit=all/.test(reqs4[0].url), `a stale 'full' record must make exactly one full /api/map request without since= (got ${JSON.stringify(reqs4.map((r) => r.url))})`);
  check((await evalJs<{ count: number } | null>("__sporeMapPage.cacheInfo()")) != null, "the stale-full reopen did not paint from the cache first");
  ws.close();
} catch (e) {
  fails.push(`crashed: ${(e as Error).message}`);
} finally {
  result.consoleErrors = errors;
  check(errors.length === 0, `${errors.length} console error(s): ${errors.slice(0, 3).join(" | ")}`);
  result.failures = fails;
  result.ok = fails.length === 0;
  console.log(JSON.stringify(result, null, 2));
  const exited = new Promise<void>((r) => { chrome.once("exit", () => r()); setTimeout(r, 3000); });
  chrome.kill("SIGKILL");
  await exited;
  for (let i = 0; i < 10; i++) { try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); break; } catch { await sleep(300); } }
}
process.exit(fails.length ? 1 : 0);
