// Self-hosted token metadata (DESIGN §11.3). pump.fun's IPFS upload is gone, so an upload becomes two
// content-addressed files under deploy/pages/public/m (`<sha256>.<ext>` image, `<sha256>.json`
// metadata) and the directory is published to the Cloudflare Pages project with wrangler. Every
// deploy ships the whole directory, so earlier files stay reachable and one deploy can carry several
// uploads: concurrent callers share a single in-flight deploy plus at most one queued after it.
// The server also serves the same directory at /m/<name> (api.mjs) and reads it before the network
// (meta.mjs), so a coin page works even where *.pages.dev is unreachable.
//
// The upload is reachable before any wallet signs anything, so it is bounded on its own: per-IP and
// global daily quotas (files, bytes, deploys), a ledger of what /api/upload wrote, and a garbage
// collector that removes files no indexed coin ever claimed. Files other tools put in the directory
// are not in the ledger and are never touched.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";

export const DEFAULT_PAGES_PROJECT = "spore";
export const DEFAULT_PAGES_DOMAIN = "spore-2x6.pages.dev";
export const DEFAULT_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID ?? null; // the Cloudflare account that owns the Pages project (env)
export const DEFAULT_TOKEN_FILE = join(homedir(), ".cloudflare-token");
export const DEFAULT_META_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../deploy/pages/public");
export const DEPLOY_TIMEOUT_MS = 240_000;
export const WRANGLER = "wrangler@3.99.0";
/** Published file names: hex sha256 plus one of the four image types or json. Anything else is not ours. */
export const META_NAME_RE = /^[a-f0-9]{64}\.(png|jpg|gif|webp|json)$/;
export const META_TYPES = { png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp", json: "application/json" };
export const DEFAULT_QUOTA = { ipPerDay: 20, bytesPerDay: 256 * 1024 * 1024, deploysPerDay: 200 };
export const DEFAULT_GC_MS = 24 * 3600_000;
const DAY_MS = 24 * 3600_000;

/** Thrown when a daily quota is exhausted; the API answers 429 with `retryAfter`. */
export class QuotaError extends Error {
  constructor(message, retryAfter) { super(message); this.name = "QuotaError"; this.retryAfter = retryAfter; }
}

/** Fixed 24 h window of counters: uploads per IP, bytes written and deploys run. */
export class DailyQuota {
  constructor({ ipPerDay = DEFAULT_QUOTA.ipPerDay, bytesPerDay = DEFAULT_QUOTA.bytesPerDay, deploysPerDay = DEFAULT_QUOTA.deploysPerDay, now = Date.now } = {}) {
    this.limits = { ipPerDay, bytesPerDay, deploysPerDay }; this.now = now;
    this.reset();
  }
  reset() { this.startedAt = this.now(); this.bytes = 0; this.deploys = 0; this.byIp = new Map(); }
  #roll() { if (this.now() - this.startedAt >= DAY_MS) this.reset(); }
  get retryAfter() { return Math.max(1, Math.ceil((this.startedAt + DAY_MS - this.now()) / 1000)); }
  /** Throws QuotaError when `ip` has used its uploads or the day's bytes/deploys are spent. */
  check(ip, bytes = 0) {
    this.#roll();
    if ((this.byIp.get(ip) ?? 0) >= this.limits.ipPerDay) throw new QuotaError(`upload limit reached (${this.limits.ipPerDay} per day per client)`, this.retryAfter);
    if (this.bytes + bytes > this.limits.bytesPerDay) throw new QuotaError("the metadata host is full for today, try again tomorrow", this.retryAfter);
    if (this.deploys >= this.limits.deploysPerDay) throw new QuotaError("the metadata host has published as much as it can today, try again tomorrow", this.retryAfter);
  }
  charge(ip, bytes) { this.#roll(); this.byIp.set(ip, (this.byIp.get(ip) ?? 0) + 1); this.bytes += bytes; if (this.byIp.size > 10_000) this.byIp.clear(); }
  canDeploy() { this.#roll(); return this.deploys < this.limits.deploysPerDay; }
  snapshot() { this.#roll(); return { bytes: this.bytes, deploys: this.deploys, clients: this.byIp.size, resetsInS: this.retryAfter }; }
}
const EXT_OF = { "image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg", "image/gif": "gif", "image/webp": "webp" };

const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const str = (v, max) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : "");

/**
 * Pure part of an upload: the two file names, the metadata JSON (same shape pump.fun's upload
 * produced: name, symbol, description, image, showName, createdOn, optional socials) and the URIs.
 * The image name is the hash of its bytes, the JSON name the hash of its exact text, so re-uploading
 * the same content yields the same URIs and never a duplicate file.
 */
export function metaFiles({ name, symbol, description = "", imageBytes, imageType, twitter = "", telegram = "", website = "", domain = DEFAULT_PAGES_DOMAIN }) {
  const ext = EXT_OF[String(imageType).toLowerCase()];
  if (!ext) throw new Error(`unsupported image type ${imageType}`);
  if (!(imageBytes instanceof Uint8Array) || !imageBytes.length) throw new Error("empty image");
  const imgName = `${sha256(imageBytes)}.${ext}`;
  const imageUri = `https://${domain}/m/${imgName}`;
  const meta = {
    name: str(name, 32), symbol: str(symbol, 13).toUpperCase(), description: str(description, 400),
    image: imageUri, showName: true, createdOn: `https://${domain}`,
    ...(str(twitter, 100) ? { twitter: str(twitter, 100) } : {}), ...(str(telegram, 100) ? { telegram: str(telegram, 100) } : {}), ...(str(website, 200) ? { website: str(website, 200) } : {}),
  };
  const json = JSON.stringify(meta);
  const jsonName = `${sha256(Buffer.from(json))}.json`;
  return { imgName, jsonName, json, meta, imageUri, metadataUri: `https://${domain}/m/${jsonName}` };
}

export class MetaHost {
  /**
   * `ledger` (optional, the Db) records what /api/upload wrote so `gc` can later remove unclaimed
   * files; `quota` bounds a day of uploads. Without a ledger nothing is ever deleted.
   */
  constructor({ root = DEFAULT_META_DIR, domain = DEFAULT_PAGES_DOMAIN, project = DEFAULT_PAGES_PROJECT, accountId = DEFAULT_ACCOUNT_ID, tokenFile = DEFAULT_TOKEN_FILE, cwd = null, timeoutMs = DEPLOY_TIMEOUT_MS, deployImpl = null, log = console, ledger = null, quota = null, now = Date.now } = {}) {
    this.root = root; this.dir = join(root, "m"); this.domain = domain; this.project = project; this.accountId = accountId; this.tokenFile = tokenFile;
    this.cwd = cwd ?? resolve(root, "../../.."); // the repo root: wrangler keeps its .wrangler scratch there, as tools/publish-meta.mjs did
    this.timeoutMs = timeoutMs; this.deployImpl = deployImpl; this.log = log; this.now = now;
    this.ledger = ledger; this.quota = quota ?? new DailyQuota({ now });
    this.current = null; this.queued = null;
    this.stats = { written: 0, deploys: 0, failed: 0, lastDeployAt: 0, lastUrl: null, lastError: null, collected: 0 };
  }

  /** Writes the image and JSON (idempotent, atomic rename) and the Pages headers; no network. */
  write(input, { ip = null } = {}) {
    const r = metaFiles({ ...input, domain: this.domain });
    mkdirSync(this.dir, { recursive: true });
    let bytes = 0;
    const put = (name, data, kind, pair = null) => {
      const file = join(this.dir, name);
      if (existsSync(file)) return;
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, data); renameSync(tmp, file);
      this.stats.written++; bytes += data.length;
      this.ledger?.uploadRecord({ name, kind, pair, ip, bytes: data.length, at: Math.floor(this.now() / 1000) });
    };
    put(r.imgName, input.imageBytes, "image");
    put(r.jsonName, Buffer.from(r.json), "json", r.imgName);
    r.bytes = bytes;
    // Immutable and cross-origin readable: pump.fun, wallets and explorers fetch these from other origins.
    writeFileSync(join(this.root, "_headers"), "/m/*\n  Cache-Control: public, max-age=31536000, immutable\n  Access-Control-Allow-Origin: *\n");
    if (!existsSync(join(this.root, "index.html"))) writeFileSync(join(this.root, "index.html"), '<!doctype html><title>Spore</title><meta name="robots" content="noindex"><p>Spore metadata host.</p>');
    return r;
  }

  /**
   * Write, then publish; resolves once a deploy that includes these files has finished. The quota
   * is checked before anything is written and charged for what was actually new on disk.
   */
  async publish(input, { ip = "?" } = {}) {
    this.quota.check(ip, input.imageBytes?.length ?? 0);
    const r = this.write(input, { ip });
    this.quota.charge(ip, r.bytes);
    await this.deploy();
    return r;
  }

  /**
   * Removes ledger files older than `maxAgeMs` that no indexed coin references (`referenced(name)`
   * is the model's view: a mint's uri or a metadata image on our host). A JSON goes first; its image
   * only once no surviving JSON points at it, since identical images share one file. A deploy
   * follows when something was removed so the public host forgets it too.
   */
  async gc({ referenced, maxAgeMs = DEFAULT_GC_MS, deploy = true } = {}) {
    if (!this.ledger) return { removed: 0, kept: 0 };
    const before = Math.floor((this.now() - maxAgeMs) / 1000);
    const stale = this.ledger.uploadsStale(before);
    let removed = 0, kept = 0;
    const drop = (name) => { try { unlinkSync(join(this.dir, name)); } catch { /* already gone */ } this.ledger.uploadForget(name); removed++; };
    for (const row of stale.filter((r) => r.kind === "json")) { if (referenced(row.name)) kept++; else drop(row.name); }
    for (const row of stale.filter((r) => r.kind !== "json")) { if (referenced(row.name) || this.ledger.uploadsUsingImage(row.name) > 0) kept++; else drop(row.name); }
    this.stats.collected += removed;
    if (removed) {
      this.log.info?.(`metahost: gc removed ${removed} unclaimed file(s), kept ${kept}`);
      if (deploy && this.quota.canDeploy()) await this.deploy().catch((e) => this.log.warn?.(`metahost: gc deploy failed: ${e.message}`));
    }
    return { removed, kept };
  }

  /**
   * Single-flight: a running deploy is shared by everyone who was already waiting on it; callers
   * arriving while it runs share one follow-up deploy (their files are on disk by then), which starts
   * when the current one finishes. Never more than one wrangler process at a time.
   */
  deploy() {
    if (!this.current) {
      this.current = this.#run().finally(() => { this.current = null; });
      return this.current;
    }
    if (!this.queued) this.queued = this.current.catch(() => {}).then(() => { this.queued = null; return this.deploy(); });
    return this.queued;
  }

  async #run() {
    this.stats.deploys++; this.quota.deploys++;
    try {
      const url = await (this.deployImpl ? this.deployImpl(this) : this.#wrangler());
      this.stats.lastDeployAt = Date.now(); this.stats.lastUrl = url ?? null; this.stats.lastError = null;
      this.log.info?.(`metahost: deployed ${this.project}${url ? ` (${url})` : ""}`);
      return url ?? null;
    } catch (e) {
      this.stats.failed++; this.stats.lastError = String(e.message ?? e).slice(0, 300);
      this.log.error?.(`metahost: deploy failed: ${this.stats.lastError}`);
      throw e;
    }
  }

  #wrangler() {
    let token;
    try { token = readFileSync(this.tokenFile, "utf8").trim(); } catch { throw new Error(`Cloudflare token file ${this.tokenFile} is missing or unreadable`); }
    if (!token) throw new Error(`Cloudflare token file ${this.tokenFile} is empty`);
    return new Promise((resolveP, reject) => {
      // Never put the token on the command line: it travels in the environment only.
      const env = { ...process.env, CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: this.accountId };
      execFile("npx", [WRANGLER, "pages", "deploy", this.root, "--project-name", this.project, "--branch", "main", "--commit-dirty=true"],
        { env, cwd: this.cwd, timeout: this.timeoutMs, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" },
        (err, stdout, stderr) => {
          if (err) {
            const why = err.killed || err.signal === "SIGTERM" ? `timed out after ${Math.round(this.timeoutMs / 1000)} s` : (String(stderr || stdout || err.message).trim().split("\n").filter(Boolean).slice(-3).join(" | ") || `exit ${err.code}`);
            return reject(new Error(`wrangler pages deploy failed: ${why.slice(0, 300)}`));
          }
          const m = String(stdout).match(/https:\/\/[a-z0-9.-]+\.pages\.dev/g);
          resolveP(m ? m[m.length - 1] : null);
        });
    });
  }
}
