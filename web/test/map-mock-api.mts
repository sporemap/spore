// Mock of the DESIGN §11.5 map contract for web tests: a real-data snapshot served as the full tree
// (`limit=all`, `generatedAt`, `version`, `total`), `since=<ms>` answered with the flat delta of nodes
// touched after that stamp (`nodes[]` with `parentMint`, `removed`, `total`, `generatedAt`), an SSE
// stream (heartbeat + `pair`/`mapdelta` on demand), the `/api/map/heat` sidecar (synthetic activity for
// ~300 snapshot mints, same wire shape as the server), and every other /api path proxied to a real server.
// Control endpoints (POST, JSON):
//   /__mock/touch {count}        → bumps `count` random nodes (mcap ×1.1, updatedAt = now), returns the mapdelta
//   /__mock/emit  {event, data}  → broadcasts one SSE event
//   /__mock/add   {parentMint?}  → adds a synthetic child (updatedAt = now) and emits `pair`
//   /__mock/stats                → { nodes, clients, version }
//   /__mock/heat  {status?}      → the next /api/map/heat answers that status (404 = an older server); {} resets
//
//   SNAPSHOT=<file.json> PORT=8798 UPSTREAM=8795 node --import tsx test/map-mock-api.mts
//   (without SNAPSHOT the snapshot is fetched from the upstream: /api/map?scope=all&limit=200&fanout=200&depth=4)
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";

type Coin = { mint: string; name: string | null; symbol: string | null; image: string | null; depth: number; mcapUsd: number | null; lockedUsd: number | null; children: number; descendants: number; migrated: boolean; createdAt: number | null; [k: string]: unknown };
type TreeNode = { coin: Coin; children: TreeNode[] };
type Row = { coin: Coin; parentMint: string | null; updatedAt: number };

const PORT = Number(process.env.PORT || 8798), UPSTREAM = Number(process.env.UPSTREAM || 8795);
const snap: { roots: TreeNode[] } = process.env.SNAPSHOT
  ? JSON.parse(readFileSync(process.env.SNAPSHOT, "utf8"))
  : await fetch(`http://127.0.0.1:${UPSTREAM}/api/map?scope=all&limit=200&fanout=200&depth=4`).then((r) => r.json());
const T0 = Date.now();
const nodes = new Map<string, Row>();
const walk = (n: TreeNode, parentMint: string | null) => { nodes.set(n.coin.mint, { coin: n.coin, parentMint, updatedAt: T0 }); n.children.forEach((k) => walk(k, n.coin.mint)); };
snap.roots.forEach((r) => walk(r, null));
let version = 1;
// Synthetic heat: a deterministic slice of the snapshot (every k-th node) with plausible counters.
let heatStatus = 200;
const heatRows = (() => {
  const all = Array.from(nodes.keys());
  const step = Math.max(1, Math.floor(all.length / 300));
  const out: { mint: string; t1h: number; n24: number; v24: number; last: number; buys1h: number }[] = [];
  const nowS = Math.floor(T0 / 1000);
  for (let i = 0, q = 0; i < all.length && out.length < 300; i += step, q++) {
    const t1h = q % 3 === 0 ? 0 : (q * 7) % 23 + 1;
    const n24 = t1h + (q * 13) % 90 + 1;
    out.push({ mint: all[i], t1h, n24, v24: Math.round(n24 * (12 + (q % 17) * 9.5) * 100) / 100, last: nowS - (t1h ? (q * 37) % 3_000 : 3_700 + (q * 101) % 80_000), buys1h: Math.floor(t1h * 0.6) });
  }
  return out.sort((a, b) => b.t1h - a.t1h || b.v24 - a.v24);
})();
const clients = new Set<ServerResponse>();
const emit = (event: string, data: unknown) => { const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`; for (const res of clients) res.write(frame); };
setInterval(() => { for (const res of clients) res.write(": hb\n\n"); }, 15_000);
const tree = () => {
  const kids = new Map<string, Row[]>();
  for (const n of nodes.values()) { if (!n.parentMint) continue; const g = kids.get(n.parentMint); if (g) g.push(n); else kids.set(n.parentMint, [n]); }
  const node = (n: Row): TreeNode => ({ coin: n.coin, children: (kids.get(n.coin.mint) ?? []).map(node) });
  return Array.from(nodes.values()).filter((n) => !n.parentMint || !nodes.has(n.parentMint)).map(node);
};
const json = (res: ServerResponse, body: unknown, status = 200) => { const s = JSON.stringify(body); res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(s) }); res.end(s); };
const body = (req: IncomingMessage) => new Promise<Record<string, unknown>>((r) => { let s = ""; req.on("data", (c) => (s += c)); req.on("end", () => { try { r(JSON.parse(s || "{}")); } catch { r({}); } }); });

createServer(async (req, res) => {
  const u = new URL(req.url ?? "/", "http://x");
  if (u.pathname === "/api/map") {
    const since = Number(u.searchParams.get("since"));
    const limit = u.searchParams.get("limit");
    const generatedAt = Date.now();
    if (since) {
      const out: unknown[] = [];
      for (const n of nodes.values()) if (n.updatedAt > since) out.push({ ...n.coin, parentMint: n.parentMint, updatedAt: n.updatedAt });
      return json(res, { nodes: out, removed: [], scope: "all", version, generatedAt, total: nodes.size });
    }
    let roots = tree();
    if (limit && limit !== "all") roots = roots.slice(0, Number(limit));
    return json(res, { roots, scope: "all", version, generatedAt, total: nodes.size });
  }
  if (u.pathname === "/api/map/heat") {
    if (heatStatus !== 200) return json(res, { error: "not found" }, heatStatus);
    const at = Math.floor(Date.now() / 1000);
    return json(res, { at, since: at - 86_400, mint: heatRows.map((r) => r.mint), t1h: heatRows.map((r) => r.t1h), n24: heatRows.map((r) => r.n24), v24: heatRows.map((r) => r.v24), last: heatRows.map((r) => r.last), buys1h: heatRows.map((r) => r.buys1h) });
  }
  if (u.pathname === "/__mock/heat") { const { status } = await body(req) as { status?: number }; heatStatus = typeof status === "number" ? status : 200; return json(res, { ok: true, status: heatStatus, rows: heatRows.length }); }
  if (u.pathname === "/api/events") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.write(": hello\n\n"); clients.add(res); req.on("close", () => clients.delete(res)); return;
  }
  if (u.pathname === "/__mock/touch") {
    const { count = 10 } = await body(req) as { count?: number };
    const all = Array.from(nodes.values()); const upd: unknown[] = []; const touched: string[] = [];
    for (let i = 0; i < count; i++) { const n = all[Math.floor(Math.random() * all.length)]; n.coin.mcapUsd = (n.coin.mcapUsd ?? 1000) * 1.1; n.updatedAt = Date.now(); touched.push(n.coin.mint); upd.push({ mint: n.coin.mint, mcapUsd: n.coin.mcapUsd, lockedUsd: n.coin.lockedUsd, children: n.coin.children, descendants: n.coin.descendants, migrated: n.coin.migrated }); }
    version++; return json(res, { touched, delta: { at: Date.now(), updated: upd } });
  }
  if (u.pathname === "/__mock/emit") { const { event, data } = await body(req) as { event: string; data: unknown }; emit(event, data); return json(res, { ok: true, clients: clients.size }); }
  if (u.pathname === "/__mock/add") {
    const { parentMint } = await body(req) as { parentMint?: string };
    const parent = (parentMint ? nodes.get(parentMint) : undefined) ?? Array.from(nodes.values()).find((n) => !n.parentMint)!;
    const mint = "MOCK" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    const coin: Coin = { mint, name: "Mock child " + nodes.size, symbol: "MK" + (nodes.size % 1000), image: null, depth: parent.coin.depth + 1, ours: false, oursPending: false, mcapUsd: 2500, lockedUsd: null, children: 0, descendants: 0, otherChildren: 0, migrated: false, createdAt: Math.floor(Date.now() / 1000) };
    nodes.set(mint, { coin, parentMint: parent.coin.mint, updatedAt: Date.now() });
    parent.coin.children++; parent.coin.descendants++; parent.updatedAt = Date.now(); version++;
    emit("pair", { coin: { ...coin, parentMint: parent.coin.mint }, parent: parent.coin });
    return json(res, { mint, parent: parent.coin.mint, clients: clients.size });
  }
  if (u.pathname === "/__mock/stats") return json(res, { nodes: nodes.size, clients: clients.size, version });
  // everything else (stats, coin, img, …) → the real server
  const up = httpRequest({ host: "127.0.0.1", port: UPSTREAM, path: req.url, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${UPSTREAM}` } }, (r) => { res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res); });
  up.on("error", () => json(res, { error: "upstream down" }, 502));
  req.pipe(up);
}).listen(PORT, "127.0.0.1", () => console.log(`mock api :${PORT} nodes=${nodes.size} upstream=:${UPSTREAM}`));
