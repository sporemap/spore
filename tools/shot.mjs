// Full-page screenshots of the running site through headless Chrome's DevTools protocol (no
// puppeteer, no download). Usage: node tools/shot.mjs <url> <out.png> [width] [height] [waitMs]
import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [url, out, w = "1440", h = "900", waitMs = "6000"] = process.argv.slice(2);
if (!url || !out) { console.error("usage: node tools/shot.mjs <url> <out.png> [width] [height] [waitMs]"); process.exit(2); }
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const port = 9222 + Math.floor(Math.random() * 500);
const profile = mkdtempSync(join(tmpdir(), "spore-shot-"));
const chrome = spawn(CHROME, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--hide-scrollbars", "--disable-extensions", `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, `--window-size=${w},${h}`, "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  let version = null;
  for (let i = 0; i < 50 && !version; i++) { await sleep(200); version = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json()).catch(() => null); }
  if (!version) throw new Error("chrome did not start");
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pending = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); } };
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Page.enable", {}, sessionId);
  await send("Emulation.setDeviceMetricsOverride", { width: Number(w), height: Number(h), deviceScaleFactor: 1, mobile: Number(w) < 700 }, sessionId);
  await send("Page.navigate", { url }, sessionId);
  await sleep(Number(waitMs));
  const metrics = await send("Page.getLayoutMetrics", {}, sessionId);
  const full = metrics.cssContentSize ?? metrics.contentSize;
  const height = Math.min(Math.ceil(full.height), 6000);
  await send("Emulation.setDeviceMetricsOverride", { width: Number(w), height, deviceScaleFactor: 1, mobile: Number(w) < 700 }, sessionId);
  await sleep(400);
  const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }, sessionId);
  writeFileSync(out, Buffer.from(shot.data, "base64"));
  const errors = await send("Runtime.evaluate", { expression: "JSON.stringify({title: document.title, h: document.documentElement.scrollHeight, w: document.documentElement.scrollWidth, overflowX: document.documentElement.scrollWidth > window.innerWidth})", returnByValue: true }, sessionId);
  console.log(`${out} ${w}x${height} ${errors.result.value}`);
  ws.close();
} finally {
  // Chrome keeps writing to its profile for a moment after SIGKILL reaches it: wait for the exit,
  // then retry the delete, so no spore-shot-* directory is left behind.
  const exited = new Promise((r) => { if (chrome.exitCode !== null || chrome.signalCode !== null) r(); else { chrome.once("exit", () => r()); setTimeout(r, 3000); } });
  chrome.kill("SIGKILL");
  await exited;
  for (let i = 0; i < 10; i++) { try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); break; } catch { await sleep(300); } }
}
