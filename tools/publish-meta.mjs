// Hosts coin metadata on our own https host, immutable and
// content-addressed, instead of pump.fun's retired IPFS pinner. Files land in deploy/pages/public/m/
// as <sha256>.<ext> and <sha256>.json and the Cloudflare Pages project is redeployed (every deploy
// carries the whole directory, so earlier files stay reachable).
// Usage: node tools/publish-meta.mjs --image logo.png --name "Name" --symbol TICK [--desc ..] [--twitter ..] [--telegram ..] [--website ..] [--no-deploy]
// Env: PAGES_PROJECT (default spore), PAGES_DOMAIN (default <project>.pages.dev), CLOUDFLARE token file ~/.cloudflare-token, CLOUDFLARE_ACCOUNT_ID.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
const flag = (k) => process.argv.includes(`--${k}`);
const PROJECT = process.env.PAGES_PROJECT ?? "spore";
const DOMAIN = process.env.PAGES_DOMAIN ?? (PROJECT === "spore" ? "spore-2x6.pages.dev" : `${PROJECT}.pages.dev`);
const ROOT = join(here, "../deploy/pages/public");
const image = arg("image"); const name = arg("name"); const symbol = arg("symbol");
if (!image || !name || !symbol) { console.error("need --image --name --symbol"); process.exit(2); }
mkdirSync(join(ROOT, "m"), { recursive: true });
const sha = (b) => createHash("sha256").update(b).digest("hex");
const bytes = readFileSync(image);
const ext = image.toLowerCase().endsWith(".png") ? "png" : image.toLowerCase().endsWith(".gif") ? "gif" : image.toLowerCase().endsWith(".webp") ? "webp" : "jpg";
const imgName = `${sha(bytes)}.${ext}`;
if (!existsSync(join(ROOT, "m", imgName))) copyFileSync(image, join(ROOT, "m", imgName));
const meta = {
  name, symbol, description: arg("desc", "") ?? "",
  image: `https://${DOMAIN}/m/${imgName}`,
  showName: true,
  createdOn: `https://${DOMAIN}`,
  ...(arg("twitter") ? { twitter: arg("twitter") } : {}), ...(arg("telegram") ? { telegram: arg("telegram") } : {}), ...(arg("website") ? { website: arg("website") } : {}),
};
const json = JSON.stringify(meta);
const jsonName = `${sha(Buffer.from(json))}.json`;
writeFileSync(join(ROOT, "m", jsonName), json);
// Immutable, cross-origin readable (pump.fun and wallets fetch these from other origins).
writeFileSync(join(ROOT, "_headers"), `/m/*\n  Cache-Control: public, max-age=31536000, immutable\n  Access-Control-Allow-Origin: *\n`);
if (!existsSync(join(ROOT, "index.html"))) writeFileSync(join(ROOT, "index.html"), `<!doctype html><title>Spore</title><meta name="robots" content="noindex"><p>Spore metadata host.</p>`);
const uri = `https://${DOMAIN}/m/${jsonName}`;
if (!flag("no-deploy")) {
  const token = readFileSync(`${homedir()}/.cloudflare-token`, "utf8").trim();
  const out = execFileSync("npx", ["wrangler@3.99.0", "pages", "deploy", ROOT, "--project-name", PROJECT, "--branch", "main", "--commit-dirty=true"], { env: { ...process.env, CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID ?? "<account-id>" }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 180_000 });
  const m = out.match(/https:\/\/[a-z0-9.-]+\.pages\.dev/g);
  console.error(`deployed${m ? ` (${m[m.length - 1]})` : ""}`);
}
console.log(uri);
