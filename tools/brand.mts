// Renders Spore's icon set and the OG image with headless Chrome, the way tools/logo.mts renders
// coin logos: no image libraries, one Chrome, one capture per file. The sources of truth are the
// SVGs in web/public (mark.svg, favicon.svg); this script only rasterises them, so a shape change
// is made once in the SVG (and mirrored in components/Mark.tsx) and re-rendered here.
//
// Usage: node tools/brand.mts                 writes web/public/{favicon-32.png, apple-touch-icon.png,
//                                             icon-192.png, icon-512.png, icon-maskable-512.png, og.png}
//        node tools/brand.mts --sheet <out>   a contact sheet (16…512 px, dark and light tabs) to eyeball
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const PUBLIC = resolve(here, "../web/public");
const mark = readFileSync(join(PUBLIC, "mark.svg"), "utf8");
const favicon = readFileSync(join(PUBLIC, "favicon.svg"), "utf8");
const BG = "#07100b";
const sheetOut = process.argv.includes("--sheet") ? process.argv[process.argv.indexOf("--sheet") + 1] : null;

type Job = { out: string; w: number; h: number; html: string; transparent: boolean; wait?: number };
const page = (body: string, css = "") => `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;overflow:hidden;background:transparent}svg{display:block}${css}</style>${body}`;
// A browser tab icon: the dark tile with transparent corners.
const tile = (px: number): Job => ({ out: `favicon-${px}.png`, w: px, h: px, transparent: true, html: page(favicon.replace(/width="64" height="64"/, `width="${px}" height="${px}"`)) });
// Home-screen icons are opaque: iOS and Android draw their own corner radius over a full-bleed square.
const square = (out: string, px: number, inset: number): Job => ({
  out, w: px, h: px, transparent: false,
  html: page(`<div style="width:${px}px;height:${px}px;background:${BG};display:grid;place-items:center">${mark.replace(/width="64" height="64"/, `width="${px - inset * 2}" height="${px - inset * 2}"`)}</div>`),
});

const og = (): Job => ({
  out: "og.png", w: 1200, h: 630, transparent: false, wait: 2500,
  html: page(`
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Geist:wght@500;600;700&family=Geist+Mono:wght@500&display=block" rel="stylesheet">
    <div class="og">
      <i class="a"></i><i class="b"></i><i class="c"></i>
      <div class="brand">${mark.replace(/width="64" height="64"/, 'width="72" height="72"')}<span>spore</span></div>
      <h1>Coins that <em>grow</em> coins.</h1>
      <p>A pump.fun launchpad for family trees. Launch a root with SOL, launch children under it, keep half of the creator fees.</p>
      <div class="chips"><span>no launch fee</span><span>creator fees 50 / 50</span><span>nothing custodial</span></div>
      <svg class="tree" viewBox="0 0 420 300" width="420" height="300">
        <defs><radialGradient id="gl"><stop offset="0" stop-color="#b6ff5c" stop-opacity=".28"/><stop offset="1" stop-color="#b6ff5c" stop-opacity="0"/></radialGradient>
        <radialGradient id="gt"><stop offset="0" stop-color="#5ce0c8" stop-opacity=".3"/><stop offset="1" stop-color="#5ce0c8" stop-opacity="0"/></radialGradient>
        <radialGradient id="gv"><stop offset="0" stop-color="#b08cff" stop-opacity=".3"/><stop offset="1" stop-color="#b08cff" stop-opacity="0"/></radialGradient></defs>
        <circle cx="90" cy="230" r="110" fill="url(#gl)"/><circle cx="250" cy="130" r="90" fill="url(#gt)"/><circle cx="360" cy="52" r="60" fill="url(#gv)"/>
        <path d="M150 196 L205 158" stroke="#b6ff5c" stroke-width="3" stroke-dasharray="8 9" stroke-linecap="round"/>
        <path d="M296 104 L330 76" stroke="#5ce0c8" stroke-width="3" stroke-dasharray="8 9" stroke-linecap="round"/>
        <circle cx="90" cy="230" r="66" fill="#14301f" stroke="#b6ff5c" stroke-width="3"/>
        <circle cx="250" cy="130" r="48" fill="#0f2a24" stroke="#5ce0c8" stroke-width="3"/>
        <circle cx="360" cy="52" r="30" fill="#1b1430" stroke="#b08cff" stroke-width="3"/>
        <text x="90" y="222" text-anchor="middle" fill="#b6ff5c" font-family="Geist Mono, monospace" font-size="20" font-weight="500">$ROOT</text>
        <text x="90" y="246" text-anchor="middle" fill="#8ea596" font-family="Geist Mono, monospace" font-size="13">SOL · depth 0</text>
        <text x="250" y="126" text-anchor="middle" fill="#8df0de" font-family="Geist Mono, monospace" font-size="17" font-weight="500">$CHILD</text>
        <text x="250" y="146" text-anchor="middle" fill="#8ea596" font-family="Geist Mono, monospace" font-size="12">depth 1</text>
        <text x="360" y="57" text-anchor="middle" fill="#c7adff" font-family="Geist Mono, monospace" font-size="13" font-weight="500">d2</text>
      </svg>
    </div>`, `
    .og{position:relative;width:1200px;height:630px;background:linear-gradient(135deg,#0c1c13,${BG} 60%,#050b07);color:#e8f3e8;font-family:Geist,system-ui,-apple-system,sans-serif;overflow:hidden}
    .og i{position:absolute;border-radius:50%;mix-blend-mode:screen}
    .og .a{left:-260px;top:-320px;width:760px;height:760px;background:radial-gradient(circle,rgba(182,255,92,.2),rgba(182,255,92,0) 62%)}
    .og .b{right:-200px;top:-80px;width:620px;height:620px;background:radial-gradient(circle,rgba(92,224,200,.16),rgba(92,224,200,0) 62%)}
    .og .c{left:360px;bottom:-380px;width:640px;height:640px;background:radial-gradient(circle,rgba(176,140,255,.18),rgba(176,140,255,0) 62%)}
    .brand{position:absolute;left:84px;top:72px;display:flex;align-items:center;gap:18px;font-weight:600;font-size:44px;letter-spacing:-.03em}
    .brand svg{filter:drop-shadow(0 0 22px rgba(182,255,92,.45))}
    h1{position:absolute;left:84px;top:196px;margin:0;width:700px;font-size:96px;line-height:.98;letter-spacing:-.045em;font-weight:700;text-shadow:0 10px 60px rgba(182,255,92,.14)}
    h1 em{font-style:normal;background:linear-gradient(90deg,#d6ff9b,#b6ff5c 40%,#5ce0c8 80%);-webkit-background-clip:text;background-clip:text;color:transparent}
    p{position:absolute;left:84px;top:420px;margin:0;width:640px;font-size:26px;line-height:1.4;color:#a9bfae}
    .chips{position:absolute;left:84px;bottom:56px;display:flex;gap:12px}
    .chips span{display:inline-flex;align-items:center;height:40px;padding:0 18px;border-radius:999px;border:1px solid rgba(182,255,92,.35);background:rgba(182,255,92,.1);color:#b6ff5c;font-family:"Geist Mono",ui-monospace,monospace;font-size:15px;font-weight:500;letter-spacing:.02em}
    .tree{position:absolute;right:56px;top:150px}`),
});

const sheet = (): Job => {
  const at = (svg: string, px: number) => svg.replace(/width="64" height="64"/, `width="${px}" height="${px}"`);
  const row = (bg: string, fg: string) => `<div class="row" style="background:${bg};color:${fg}">${[16, 24, 32, 48, 64, 128].map((px) => `<figure>${at(favicon, px)}<figcaption>${px}</figcaption></figure>`).join("")}<figure>${at(mark, 128)}<figcaption>mark</figcaption></figure><figure><span class="nav">${at(mark, 26)}spore</span><figcaption>nav</figcaption></figure></div>`;
  return {
    out: "sheet.png", w: 900, h: 420, transparent: false, wait: 800,
    html: page(`${row(BG, "#8ea596")}${row("#202124", "#9aa0a6")}${row("#ffffff", "#5f6368")}`,
      `.row{display:flex;gap:28px;align-items:flex-end;padding:18px 24px;font:11px ui-monospace,monospace}figure{margin:0;display:grid;gap:6px;justify-items:center}.nav{display:inline-flex;align-items:center;gap:9px;font:600 19px system-ui;color:inherit}`),
  };
};


// X profile header (1500×500): the og composition at 3:1; X crops ~60 px top/bottom on phones, so everything stays mid-band.
const banner = (): Job => ({
  out: "x-banner.png", w: 1500, h: 500, transparent: false, wait: 2500,
  html: page(`
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Geist:wght@500;600;700&family=Geist+Mono:wght@500&display=block" rel="stylesheet">
    <div class="bn">
      <i class="a"></i><i class="b"></i><i class="c"></i>
      <div class="left">
        <div class="brand">${mark}<span>spore</span><em>sporepad.com</em></div>
        <h1>Coins that <b>grow</b> coins.</h1>
        <p>Launch a coin under any pump.fun coin. Every buy of the child buys and locks its parent. You keep half of the creator fees, forever.</p>
        <div class="chips"><span>no launch fee</span><span>creator fees 50 / 50</span><span>nothing custodial</span><span>live family-tree map</span></div>
      </div>
      <svg class="tree" viewBox="0 0 420 300" width="392" height="280">
        <defs><radialGradient id="gl"><stop offset="0" stop-color="#b6ff5c" stop-opacity=".28"/><stop offset="1" stop-color="#b6ff5c" stop-opacity="0"/></radialGradient>
        <radialGradient id="gt"><stop offset="0" stop-color="#5ce0c8" stop-opacity=".3"/><stop offset="1" stop-color="#5ce0c8" stop-opacity="0"/></radialGradient>
        <radialGradient id="gv"><stop offset="0" stop-color="#b08cff" stop-opacity=".3"/><stop offset="1" stop-color="#b08cff" stop-opacity="0"/></radialGradient></defs>
        <circle cx="90" cy="230" r="110" fill="url(#gl)"/><circle cx="250" cy="130" r="90" fill="url(#gt)"/><circle cx="360" cy="52" r="60" fill="url(#gv)"/>
        <path d="M150 196 L205 158" stroke="#b6ff5c" stroke-width="3" stroke-dasharray="8 9" stroke-linecap="round"/>
        <path d="M296 104 L330 76" stroke="#5ce0c8" stroke-width="3" stroke-dasharray="8 9" stroke-linecap="round"/>
        <circle cx="90" cy="230" r="66" fill="#14301f" stroke="#b6ff5c" stroke-width="3"/>
        <circle cx="250" cy="130" r="48" fill="#0f2a24" stroke="#5ce0c8" stroke-width="3"/>
        <circle cx="360" cy="52" r="30" fill="#1b1430" stroke="#b08cff" stroke-width="3"/>
        <text x="90" y="222" text-anchor="middle" fill="#b6ff5c" font-family="Geist Mono, monospace" font-size="20" font-weight="500">$ROOT</text>
        <text x="90" y="246" text-anchor="middle" fill="#8ea596" font-family="Geist Mono, monospace" font-size="13">SOL · depth 0</text>
        <text x="250" y="126" text-anchor="middle" fill="#8df0de" font-family="Geist Mono, monospace" font-size="17" font-weight="500">$CHILD</text>
        <text x="250" y="146" text-anchor="middle" fill="#8ea596" font-family="Geist Mono, monospace" font-size="12">depth 1</text>
        <text x="360" y="57" text-anchor="middle" fill="#c7adff" font-family="Geist Mono, monospace" font-size="13" font-weight="500">d2</text>
      </svg>
    </div>`, `
    .bn{position:relative;width:1500px;height:500px;overflow:hidden;background:linear-gradient(120deg,#0c1c13,${BG} 55%,#050b07);color:#e8f3e8;font-family:Geist,system-ui,-apple-system,sans-serif;display:flex;align-items:center;justify-content:space-between;padding:0 96px;box-sizing:border-box}
    .bn i{position:absolute;border-radius:50%;mix-blend-mode:screen}
    .bn .a{left:-260px;top:-360px;width:820px;height:820px;background:radial-gradient(circle,rgba(182,255,92,.2),rgba(182,255,92,0) 62%)}
    .bn .b{right:-160px;top:-240px;width:620px;height:620px;background:radial-gradient(circle,rgba(92,224,200,.16),rgba(92,224,200,0) 62%)}
    .bn .c{left:620px;bottom:-420px;width:640px;height:640px;background:radial-gradient(circle,rgba(176,140,255,.18),rgba(176,140,255,0) 62%)}
    .left{position:relative;max-width:900px}
    .brand{display:flex;align-items:center;gap:14px;font-weight:700;font-size:30px;letter-spacing:-.02em}
    .brand svg{width:64px;height:64px}
    .brand em{font-style:normal;font-family:"Geist Mono",monospace;font-weight:500;font-size:16px;color:#8ea596;margin-left:10px}
    h1{margin:22px 0 12px;font-size:64px;line-height:1;letter-spacing:-.035em;font-weight:700}
    h1 b{font-weight:700;background:linear-gradient(90deg,#b6ff5c,#5ce0c8 70%,#b08cff);-webkit-background-clip:text;color:transparent}
    p{margin:0 0 20px;font-size:22px;line-height:1.35;color:#c7d6c9;max-width:820px}
    .chips{display:flex;gap:10px;flex-wrap:wrap}
    .chips span{font-family:"Geist Mono",monospace;font-size:15px;padding:8px 14px;border:1px solid rgba(182,255,92,.35);border-radius:999px;color:#b6ff5c;background:rgba(182,255,92,.06)}
    .tree{position:relative;flex:none}`),
});

const jobs: Job[] = sheetOut ? [{ ...sheet(), out: resolve(sheetOut) }] : [
  // X / Telegram avatar: the mark on the dark tile with room for a circular crop.
  square("x-avatar.png", 400, 64),
  banner(),
  tile(32),
  square("apple-touch-icon.png", 180, 22),
  { ...tile(192), out: "icon-192.png" },
  { ...tile(512), out: "icon-512.png" },
  // Maskable: the mark inside the 80% safe zone, so a circular or squircle mask never clips it.
  square("icon-maskable-512.png", 512, 92),
  og(),
];

const dir = mkdtempSync(join(tmpdir(), "spore-brand-"));
const port = 9700 + Math.floor(Math.random() * 200);
const chrome = spawn(process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ["--headless=new", "--no-first-run", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1", `--user-data-dir=${join(dir, "p")}`, `--remote-debugging-port=${port}`, "--window-size=1200,630", "about:blank"], { stdio: "ignore" });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
try {
  let v: { webSocketDebuggerUrl: string } | null = null;
  for (let i = 0; i < 50 && !v; i++) { await sleep(200); v = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json()).catch(() => null); }
  if (!v) throw new Error("chrome did not start");
  const ws = new WebSocket(v.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pending = new Map<number, { res: (v: any) => void; rej: (e: Error) => void }>();
  ws.onmessage = (ev) => { const m = JSON.parse(String(ev.data)); const p = pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } };
  const send = (method: string, params = {}, sessionId?: string) => new Promise<any>((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  for (const [i, job] of jobs.entries()) {
    const file = join(dir, `${i}.html`);
    writeFileSync(file, job.html);
    await send("Emulation.setDeviceMetricsOverride", { width: job.w, height: job.h, deviceScaleFactor: 1, mobile: false }, sessionId);
    // Alpha survives only when the page background is cleared to transparent before the capture.
    await send("Emulation.setDefaultBackgroundColorOverride", job.transparent ? { color: { r: 0, g: 0, b: 0, a: 0 } } : {}, sessionId);
    await send("Page.navigate", { url: `file://${file}` }, sessionId);
    await sleep(job.wait ?? 500);
    // Web fonts (the OG headline) must be in before the capture; `document.fonts.ready` resolves even offline.
    await send("Runtime.evaluate", { expression: "document.fonts ? document.fonts.ready.then(() => true) : true", awaitPromise: true }, sessionId).catch(() => null);
    const shot = await send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: job.w, height: job.h, scale: 1 } }, sessionId);
    const out = job.out.startsWith("/") ? job.out : join(PUBLIC, job.out);
    writeFileSync(out, Buffer.from(shot.data, "base64"));
    console.log(`${out} ${job.w}x${job.h}`);
  }
  ws.close();
} finally {
  chrome.kill("SIGKILL");
  // A Chrome profile is tens of MB; left behind after every run they fill the disk.
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
