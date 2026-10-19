// Online backup of the sqlite index while the server runs (node:sqlite's backup API copies a
// consistent snapshot page by page without blocking writers). Keeps the last `--keep` files.
//   node --disable-warning=ExperimentalWarning scripts/backup.mjs [--data server/data] [--out /var/backups/spore] [--keep 14]
// Cron (daily 04:10): 10 4 * * * cd /opt/spore/server && node --disable-warning=ExperimentalWarning scripts/backup.mjs --out /var/backups/spore >> /var/log/spore-backup.log 2>&1
// Restore: stop the service, copy the file to DATA_DIR/spore.sqlite (delete -wal/-shm), start.
import { DatabaseSync, backup } from "node:sqlite";
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
const dataDir = resolve(arg("data", process.env.DATA_DIR ?? join(here, "../data")));
const outDir = resolve(arg("out", join(dataDir, "backups")));
const keep = Math.max(1, Number(arg("keep", "14")));
const src = join(dataDir, "spore.sqlite");
if (!existsSync(src)) { console.error(`no database at ${src}`); process.exit(2); }
mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const dest = join(outDir, `spore-${stamp}.sqlite`);
const db = new DatabaseSync(src, { readOnly: true });
const t0 = Date.now();
await backup(db, dest, { rate: 256 }); // 256 pages per step keeps the writer responsive
db.close();
// The copy inherits WAL mode from the source; switch it to a rollback journal so the backup is one
// self-contained file (no -wal/-shm siblings to carry along), then verify it.
const check = new DatabaseSync(dest);
check.exec("PRAGMA journal_mode = DELETE");
const ok = check.prepare("PRAGMA integrity_check").get();
const coins = check.prepare("SELECT COUNT(*) AS n FROM coins").get().n;
check.close();
if (ok.integrity_check !== "ok") { console.error(`backup ${dest} failed integrity check: ${ok.integrity_check}`); unlinkSync(dest); process.exit(1); }
const files = readdirSync(outDir).filter((f) => /^spore-.*\.sqlite$/.test(f)).sort();
for (const f of files.slice(0, Math.max(0, files.length - keep))) unlinkSync(join(outDir, f));
console.log(`${new Date().toISOString()} backup ${dest} ${(statSync(dest).size / 1e6).toFixed(1)} MB, ${coins} coins, ${Date.now() - t0} ms, keeping ${Math.min(keep, files.length)}`);
