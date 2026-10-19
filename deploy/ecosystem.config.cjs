// PM2 process file for the Spore API. One process only: the indexer holds the sqlite file and the
// single WebSocket subscription, so a cluster would double every RPC call and fight over the WAL.
//   pm2 start deploy/ecosystem.config.cjs            # reads deploy/.env (copy env.example there)
//   pm2 save && pm2 startup                           # survive reboots
//   pm2 logs spore-api --lines 200
//   pm2 reload spore-api                              # graceful: SIGTERM → SSE closed → sqlite checkpointed
// Logs: install pm2-logrotate (see DEPLOY.md) or point out_file/error_file at a logrotate-managed path.
const { readFileSync, existsSync } = require("node:fs");
const { join } = require("node:path");

const root = join(__dirname, "..");
const envFile = join(__dirname, ".env");
/** KEY=value lines from deploy/.env; the file never enters the repo (.gitignore: .env*). */
function dotenv(file) {
  if (!existsSync(file)) return {};
  const out = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith("#")) out[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2");
  }
  return out;
}

module.exports = {
  apps: [{
    name: "spore-api",
    cwd: join(root, "server"),
    script: "index.mjs",
    interpreter: "node",
    node_args: "--disable-warning=ExperimentalWarning --max-old-space-size=1024",
    instances: 1,
    exec_mode: "fork",
    autorestart: true,
    max_restarts: 20,
    restart_delay: 2000,
    exp_backoff_restart_delay: 500,
    max_memory_restart: "1200M",
    kill_timeout: 10000,          // index.mjs finishes its graceful shutdown within 8 s
    listen_timeout: 15000,
    wait_ready: false,
    time: true,                   // timestamps in pm2 logs (the app prints ISO timestamps too)
    merge_logs: true,
    out_file: join(root, "logs", "spore-api.out.log"),
    error_file: join(root, "logs", "spore-api.err.log"),
    env: {
      NODE_ENV: "production",
      PORT: "8793",
      TRUST_PROXY: "loopback",
      ...dotenv(envFile),
    },
  }],
};
