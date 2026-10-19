// Records a cinematic fly-through of the ecosystem map with headless Chrome: wide forest → glides into the
// biggest trees (labels + logos) → opens a coin's side panel → fits back out. Pass 1 writes an MP4 from the
// DevTools screencast (ffmpeg); pass 2 re-runs the same shots at 2× and saves 4K keyframes (Higgsfield inputs).
//   node tools/map-video.mjs <base-url> <out-dir> [video|frames|both]
import { spawn, execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [base = "http://127.0.0.1:8795", outDir = join(process.env.HOME, "Downloads", "spore-video"), what = "both"] = process.argv.slice(2);
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const W = 1920, H = 1080;
mkdirSync(outDir, { recursive: true });

// Shots: [label, action, holdMs]. zoom = glide to a mint at zoom k (the map eases there and keeps it centred).
const SHOTS = [
  ["forest", { fit: true }, 3500],
  ["gta", { zoom: ["BsbsB3WLq7vbY5En3MBCAsTrcwaCxNKY2Mp5pGuLpump", 3.2] }, 3500],
  ["chatul", { zoom: ["8kh7mPfHqF4TBbszY3x76GZzt6a3GNLbZNdXjPs3pump", 4.0] }, 3200],
  ["veil", { zoom: ["HgTGdc29D5bDMrDvsCLnorxz899VyDj7ZN7FPa6vpump", 5.0] }, 3200],
  ["core-panel", { zoom: ["4FdojUmXeaFMBG6yUaoufAC5Bz7u9AwnSAMizkx5pump", 4.5], click: "4FdojUmXeaFMBG6yUaoufAC5Bz7u9AwnSAMizkx5pump" }, 4000],
  ["ntrndm", { esc: true, zoom: ["NTRNDMqQSiwEC2jJs3wJiZS6bpGYQJtMNQJgiX3WyV6", 2.6] }, 3200],
  ["forest-out", { fit: true }, 4000],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function run(mode) {
  const dpr = mode === "frames" ? 2 : 1;
  const port = 9300 + Math.floor(Math.random() * 400);
  const profile = mkdtempSync(join(tmpdir(), "spore-video-"));
  const chrome = spawn(CHROME, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--hide-scrollbars", "--disable-extensions", `--window-size=${W},${H}`, `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
  const frames = []; let framesDir = null;
  try {
    let version = null;
    for (let i = 0; i < 50 && !version; i++) { await sleep(200); version = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json()).catch(() => null); }
    if (!version) throw new Error("chrome did not start");
    const ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    let id = 0; const pending = new Map(); const listeners = [];
    ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); } else if (m.method) for (const l of listeners) l(m); };
    const send = (method, params = {}, sessionId) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
    const { targetId } = await send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    await send("Page.enable", {}, sessionId);
    await send("Runtime.enable", {}, sessionId);
    await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: dpr, mobile: false }, sessionId);
    const evaluate = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId)).result.value;
    await send("Page.navigate", { url: `${base}/map?roots=all&debug` }, sessionId);
    // wait for the layout to settle and logos to load
    for (let i = 0; i < 60; i++) { await sleep(500); if (await evaluate("!!(window.__sporeMap && window.__sporeMap.settled() && window.__sporeMap.nodes() > 1000)")) break; }
    await sleep(3000);
    console.log(`[${mode}] nodes ${await evaluate("window.__sporeMap.nodes()")} settled ${await evaluate("window.__sporeMap.settled()")}`);
    // hide the cursor hint line and the roots control for a cleaner frame
    await evaluate(`(() => { const st = document.createElement("style"); st.textContent = ".map-hint,.bm-hint,[class*='hint']{opacity:0 !important}"; document.head.appendChild(st); })()`);

    if (mode === "video") {
      framesDir = mkdtempSync(join(tmpdir(), "spore-frames-"));
      listeners.push((m) => { if (m.method === "Page.screencastFrame" && m.sessionId === sessionId) { const p = m.params; frames.push({ t: p.metadata.timestamp, file: join(framesDir, `f${String(frames.length).padStart(5, "0")}.jpg`) }); writeFileSync(frames[frames.length - 1].file, Buffer.from(p.data, "base64")); send("Page.screencastFrameAck", { sessionId: p.sessionId }, sessionId).catch(() => {}); } });
      await send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: W, maxHeight: H, everyNthFrame: 1 }, sessionId);
    }
    for (const [label, act, hold] of SHOTS) {
      if (act.esc) { await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }, sessionId); await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }, sessionId); await sleep(300); }
      if (act.fit) await evaluate("window.__sporeMap.fit()");
      if (act.zoom) await evaluate(`window.__sporeMap.zoomTo(${JSON.stringify(act.zoom[0])}, ${act.zoom[1]})`);
      await sleep(act.click ? 2200 : 1800); // glide time
      if (act.click) {
        const pt = await evaluate(`JSON.stringify(window.__sporeMap.screenOf(${JSON.stringify(act.click)}))`);
        const { x, y } = JSON.parse(pt) ?? {};
        if (x) { for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 }, sessionId); }
      }
      await sleep(hold);
      if (mode === "frames") {
        const shot = await send("Page.captureScreenshot", { format: "png" }, sessionId);
        const f = join(outDir, `keyframe-${String(SHOTS.indexOf(SHOTS.find((s) => s[0] === label)) + 1).padStart(2, "0")}-${label}.png`);
        writeFileSync(f, Buffer.from(shot.data, "base64")); console.log("keyframe", f);
      }
    }
    if (mode === "video") {
      await send("Page.stopScreencast", {}, sessionId);
      await sleep(500);
      console.log(`[video] ${frames.length} frames captured over ${(frames.at(-1).t - frames[0].t).toFixed(1)} s`);
      const list = frames.map((f, i) => `file '${f.file}'\nduration ${i + 1 < frames.length ? Math.max(0.005, frames[i + 1].t - f.t).toFixed(4) : "0.0333"}`).join("\n") + `\nfile '${frames.at(-1).file}'\n`;
      const listFile = join(framesDir, "list.txt"); writeFileSync(listFile, list);
      const out = join(outDir, "spore-map-flythrough.mp4");
      execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", listFile, "-vf", `fps=30,scale=${W}:${H}:flags=lanczos,format=yuv420p`, "-c:v", "libx264", "-crf", "17", "-preset", "slow", "-movflags", "+faststart", out]);
      console.log("video", out);
    }
    ws.close();
  } finally { chrome.kill("SIGKILL"); await sleep(1500); for (const d of [profile, framesDir]) if (d) { try { rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 }); } catch {} } }
}
if (what === "video" || what === "both") await run("video");
if (what === "frames" || what === "both") await run("frames");
