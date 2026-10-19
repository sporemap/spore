// Partner API keys for /v1 (DESIGN §12). The only way to issue or revoke one: there is no HTTP admin
// endpoint. A new key is printed once and only its sha256 is stored; the running server picks up a
// new key at once and a revocation within 15 s (its verify cache). Usage counters are written by the
// server every 30 s, so `usage` can trail live traffic by that much.
//
//   node --disable-warning=ExperimentalWarning scripts/keys.mjs create --name <partner> [--contact <x>]
//   node --disable-warning=ExperimentalWarning scripts/keys.mjs list
//   node --disable-warning=ExperimentalWarning scripts/keys.mjs revoke <id>
//   node --disable-warning=ExperimentalWarning scripts/keys.mjs usage
// The database is DATA_DIR/spore.sqlite (`--data <dir>` overrides; default server/data), the same
// file the server uses; it must already exist, so a typo in the path never creates an empty index.
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Db } from "../lib/db.mjs";
import { ApiKeys } from "../lib/apikeys.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (k) => { const i = argv.indexOf(`--${k}`); if (i < 0) return undefined; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const dataDir = resolve(flag("data") ?? process.env.DATA_DIR ?? join(here, "../data"));
const name = flag("name"), contact = flag("contact");
const [cmd, arg] = argv;
const usage = () => { console.error("usage: keys.mjs create --name <partner> [--contact <x>] | list | revoke <id> | usage   [--data <dir>]"); process.exit(2); };
const iso = (s) => (s ? new Date(s * 1000).toISOString().replace(".000Z", "Z") : "-");
const table = (rows, cols) => {
  const w = cols.map(([h, f]) => Math.max(h.length, ...rows.map((r) => String(f(r)).length)));
  console.log(cols.map(([h], i) => h.padEnd(w[i])).join("  "));
  for (const r of rows) console.log(cols.map(([, f], i) => String(f(r)).padEnd(w[i])).join("  "));
};

if (!["create", "list", "revoke", "usage"].includes(cmd)) usage();
const file = join(dataDir, "spore.sqlite");
if (!existsSync(file)) { console.error(`no database at ${file} (set DATA_DIR or --data)`); process.exit(2); }
const db = new Db(file, { busyMs: 5_000 });
const keys = new ApiKeys(db);
try {
  if (cmd === "create") {
    if (!name) usage();
    const k = keys.create({ name, contact: contact ?? null });
    console.log(`created key #${k.id} for ${k.name}${k.contact ? ` (${k.contact})` : ""}, tier ${k.tier}`);
    console.log("");
    console.log(`  ${k.key}`);
    console.log("");
    console.log("This is the only time the key is shown; only its sha256 is stored. Send it to the partner over a private channel.");
  } else if (cmd === "list") {
    const rows = keys.list();
    if (!rows.length) console.log("no keys");
    else table(rows, [["id", (r) => r.id], ["name", (r) => r.name], ["contact", (r) => r.contact ?? "-"], ["tier", (r) => r.tier], ["created", (r) => iso(r.createdAt)], ["status", (r) => (r.revokedAt ? `revoked ${iso(r.revokedAt)}` : "active")]]);
  } else if (cmd === "revoke") {
    const id = Number(arg);
    if (!Number.isInteger(id) || id <= 0) usage();
    const row = keys.list().find((r) => r.id === id);
    if (!row) { console.error(`no key #${id}`); process.exitCode = 1; }
    else if (keys.revoke(id)) console.log(`revoked key #${id} (${row.name}); the server refuses it within 15 s`);
    else console.log(`key #${id} (${row.name}) was already revoked at ${iso(row.revokedAt)}`);
  } else {
    const rows = keys.list().sort((a, b) => b.requests - a.requests);
    if (!rows.length) console.log("no keys");
    else table(rows, [["id", (r) => r.id], ["name", (r) => r.name], ["requests", (r) => r.requests], ["last used", (r) => iso(r.lastUsedAt)], ["status", (r) => (r.revokedAt ? "revoked" : "active")]]);
  }
} finally { db.db.close(); }
