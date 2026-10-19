// Renders a 512×512 PNG coin logo from a word and two colours with headless Chrome (no image libs).
// Usage: node tools/logo.mts <out.png> "<emoji or 1-3 letters>" "<label>" [hue1] [hue2]
import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const [out, glyph = "S", label = "", h1 = "95", h2 = "260"] = process.argv.slice(2);
const html = `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;width:512px;height:512px;background:#07100b;overflow:hidden}
.c{position:absolute;inset:0;background:radial-gradient(circle at 35% 30%,hsl(${h1} 95% 70%) 0%,hsl(${h1} 80% 45%) 35%,hsl(${h2} 70% 35%) 100%)}
.g{position:absolute;inset:0;background:radial-gradient(circle at 70% 75%,rgba(255,255,255,.25),transparent 45%),radial-gradient(circle at 20% 80%,rgba(0,0,0,.35),transparent 50%)}
.r{position:absolute;inset:18px;border-radius:50%;border:10px solid rgba(255,255,255,.18);box-shadow:inset 0 0 60px rgba(0,0,0,.35)}
.t{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;flex-direction:column;font-family:-apple-system,"Helvetica Neue",Arial,sans-serif;color:#fff;text-shadow:0 6px 24px rgba(0,0,0,.45)}
.gl{font-size:${glyph.length > 2 ? 150 : 230}px;line-height:1;font-weight:800;letter-spacing:-6px}.lb{font-size:44px;font-weight:700;letter-spacing:6px;margin-top:8px;opacity:.92}
.sp{position:absolute;width:14px;height:14px;border-radius:50%;background:rgba(255,255,255,.85);box-shadow:0 0 18px 6px rgba(255,255,255,.35)}</style>
<div class=c></div><div class=g></div><div class=r></div>
<div class=sp style="left:88px;top:120px"></div><div class=sp style="left:400px;top:90px;width:9px;height:9px"></div><div class=sp style="left:430px;top:380px;width:11px;height:11px"></div><div class=sp style="left:70px;top:400px;width:8px;height:8px"></div>
<div class=t><div class=gl>${glyph}</div>${label ? `<div class=lb>${label}</div>` : ""}</div>`;
const dir = mkdtempSync(join(tmpdir(), "spore-logo-")); const file = join(dir, "logo.html"); writeFileSync(file, html);
const port = 9700 + Math.floor(Math.random() * 200);
const chrome = spawn(process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", ["--headless=new", "--no-first-run", "--disable-gpu", "--hide-scrollbars", `--user-data-dir=${join(dir, "p")}`, `--remote-debugging-port=${port}`, "--window-size=512,512", "about:blank"], { stdio: "ignore" });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
try {
  let v: any = null; for (let i = 0; i < 50 && !v; i++) { await sleep(200); v = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json()).catch(() => null); }
  const ws = new WebSocket(v.webSocketDebuggerUrl); await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pending = new Map<number, any>();
  ws.onmessage = (ev) => { const m = JSON.parse(String(ev.data)); const p = pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } };
  const send = (method: string, params = {}, sessionId?: string) => new Promise<any>((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
  const { targetId } = await send("Target.createTarget", { url: "about:blank" }); const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Emulation.setDeviceMetricsOverride", { width: 512, height: 512, deviceScaleFactor: 1, mobile: false }, sessionId);
  await send("Page.navigate", { url: `file://${file}` }, sessionId); await sleep(800);
  const shot = await send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: 512, height: 512, scale: 1 } }, sessionId);
  writeFileSync(out, Buffer.from(shot.data, "base64")); console.log(`${out} written`); ws.close();
} finally { chrome.kill("SIGKILL"); }
