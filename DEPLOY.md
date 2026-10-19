# Deploying Spore

One Node process (`server/index.mjs`) does everything: indexes pump.fun, serves `/api/*`, serves the
built web app and publishes token metadata. It holds no keys. Put it behind a TLS reverse proxy,
give it a paid RPC and a writable data directory, and it runs on a 1 vCPU / 2 GB VPS.

## 1. Requirements

- Node **25** (`node:sqlite` is built in; no native modules, no node-gyp).
- A Solana RPC with WebSocket support. Helius Business (`RPC_URL=https://mainnet.helius-rpc.com/?api-key=…`,
  `WS_URL` derived) is what the numbers below assume; the public RPC works for development only.
- Cloudflare Pages project `spore` (metadata host) and an API token with *Pages: Edit* on it, stored in
  `$HOME/.cloudflare-token` (mode 600) of the service user. `npx wrangler@3.99.0` is downloaded on
  first use; run one `node tools/publish-meta.mjs --no-deploy …` dry run or `npx wrangler@3.99.0 --version`
  as the service user to warm the cache.
- A reverse proxy: Caddy (`deploy/Caddyfile.example`) or nginx (`deploy/nginx.conf.example`).

## 2. Install

```sh
sudo useradd --system --create-home --home /opt/spore --shell /usr/sbin/nologin spore
sudo -u spore git clone <repo> /opt/spore          # or rsync the tree
cd /opt/spore/server && sudo -u spore npm ci --omit=dev
cd /opt/spore/web    && sudo -u spore npm ci && sudo -u spore npm run build     # → web/dist (served by the API)
sudo -u spore cp /opt/spore/deploy/env.example /opt/spore/deploy/.env && sudo -u spore chmod 600 /opt/spore/deploy/.env
sudo -u spore $EDITOR /opt/spore/deploy/.env       # RPC_URL, PLATFORM_WALLET, PAGES_DOMAIN at least
sudo -u spore install -m 600 /dev/stdin /opt/spore/.cloudflare-token <<< "<cloudflare api token>"
```

Every variable is documented in `deploy/env.example` and validated at boot (`server/lib/config.mjs`):
a bad value prints `spore: invalid configuration: - PORT=… must be …` and exits 1 before binding a port.

Check once by hand before installing a supervisor:

```sh
cd /opt/spore/server && set -a && . ../deploy/.env && set +a && node --disable-warning=ExperimentalWarning index.mjs
curl -s localhost:8793/api/health | head -c 400
```

## 3. Run it

### PM2 (`deploy/ecosystem.config.cjs`)

```sh
npm i -g pm2 && pm2 install pm2-logrotate            # rotates logs/spore-api.*.log (10 MB × 30 by default)
pm2 set pm2-logrotate:max_size 50M && pm2 set pm2-logrotate:retain 14 && pm2 set pm2-logrotate:compress true
cd /opt/spore && pm2 start deploy/ecosystem.config.cjs && pm2 save && pm2 startup   # follow the printed command
pm2 logs spore-api --lines 100
pm2 reload spore-api                                  # after a deploy: graceful (SIGTERM → SSE closed → sqlite checkpointed → exit ≤ 8 s)
```

`ecosystem.config.cjs` reads `deploy/.env` itself, runs **one** fork (the indexer owns the sqlite file
and the single WebSocket; a cluster would double every RPC call), restarts on crash with backoff and
at 1.2 GB RSS (a full-tree index sits around 250–400 MB).

### systemd (`deploy/spore-api.service`)

```sh
sudo cp deploy/spore-api.service /etc/systemd/system/ && sudo systemctl daemon-reload
sudo systemctl enable --now spore-api && journalctl -u spore-api -f
```

The unit is sandboxed (`ProtectSystem=strict`): writable paths are only `server/data`, `deploy/pages`,
`.wrangler` and `logs`. `HOME=/opt/spore` so wrangler finds the token file there. Logs go to journald
(`journalctl --vacuum-size=500M` or `/etc/systemd/journald.conf` `SystemMaxUse=` for rotation).

## 4. Reverse proxy

- Forward everything to `127.0.0.1:8793`; pass `X-Forwarded-For` and `X-Forwarded-Proto`. The API has
  `TRUST_PROXY=loopback` by default, so client IPs for rate limits and logs are taken from the proxy and
  `Strict-Transport-Security` is sent when the proxy says the request was https (`HSTS=auto`).
- Do not buffer `/api/events` (SSE): nginx `proxy_buffering off`, Caddy `flush_interval -1`. The API also
  sends `X-Accel-Buffering: no`.
- Request body: ≥ 4 MB at the proxy (the upload is capped at 3 MB by the API; every other JSON body at 16 KB).
- Upstream read timeout ≥ 130 s: `/api/upload` waits for a Cloudflare Pages deploy (up to 120 s).
- Compression, ETags, `Cache-Control` and all security headers (CSP, frame-ancestors, nosniff, COOP,
  Permissions-Policy) come from the API; the proxy only needs TLS. If the proxy also compresses, that is harmless.

## 5. What the server does on the network

| Direction | Target | Why |
|---|---|---|
| out | `RPC_URL` / `WS_URL` | indexer (getProgramAccounts at boot, getMultipleAccounts batches, logsSubscribe), browser proxy `/api/rpc` (allow-listed methods, 60/min per IP) |
| out | `api.coingecko.com` | SOL and PUMP prices every 60 s |
| out | any public https host | off-chain metadata JSON of coins (DNS-checked against private ranges, redirects re-validated, 512 KB cap) |
| out | image allowlist (ipfs.io, pinata, pump.fun, arweave, `PAGES_DOMAIN`) | image proxy `/api/img` (4 MB cap, magic-byte sniffed, SVG refused, 24 h disk cache) |
| out | Cloudflare API via `npx wrangler` | publishing `deploy/pages/public` after an upload (single-flight, 240 s timeout) |
| in | `:8793` from the proxy | everything else |

## 6. Backfill time and RPC budget

The backfill scans every curve with `depth ≥ 1` (`getProgramAccounts`, ~12 k accounts, ~5 s per
depth), resolves each curve's mint (one `getTokenAccountsByOwner` per curve) and walks ancestors.
Measured: **5–10 minutes** on Helius with `RPC_RPS=40 CONCURRENCY=8`; **3–4 hours** on the public RPC
(4 rps, shared per-IP caps). It is resumable at every step, persisted in sqlite, and re-scans at most
once a day; a restart after completion is back to "live" in under a second. `/api/health` shows
`indexer.phase` (`backfill:scan|resolve|ancestors|mints|enrich` → `live`) and `backfill.resolved/total`.

Steady state on Helius: one `getMultipleAccounts` per 100 hot/rolling coins every 30 s, one price
fetch per minute, the WebSocket stream (≈ 10–20 messages/s from pump.fun), plus whatever the
browsers send through `/api/rpc`. Budget roughly 5–15 k RPC calls/hour including users.

## 7. Metadata host (DESIGN §11.3)

`POST /api/upload` writes `deploy/pages/public/m/<sha256>.<png|jpg|gif|webp>` and `<sha256>.json`
and runs `npx wrangler@3.99.0 pages deploy deploy/pages/public --project-name $PAGES_PROJECT`. The
whole directory ships every time, so **never delete files under `deploy/pages/public/m`**: a coin's
on-chain `uri` points at them forever. Back the directory up with the database (§10). The server
serves the same files at `/m/<name>` and resolves `https://$PAGES_DOMAIN/m/…` from disk first, so coin
pages work even when the host cannot reach `*.pages.dev`.

A wrangler failure answers `502 { error, retryAfter: 30, hint }`; the files are already on disk and go
out with the next successful deploy, so the Launch page can simply retry.

## 8. Treasury: claiming the platform's creator fees

The platform's 50% share accrues on-chain in each coin's vaults (DESIGN §11.4) until someone calls
`distribute_creator_fees_v2`. `GET /api/treasury` shows what is pending per quote mint (60 s cache).
Claiming needs the platform keypair, which the API process never has — run the tool from a separate
user or host, with the keypair **outside the repo**:

```sh
# as a user that owns the keypair; RPC_URL may be the same Helius key
export WALLET=/etc/spore/platform-keypair.json        # mode 600, owned by that user, never under /opt/spore
export RPC_URL=https://mainnet.helius-rpc.com/?api-key=…
cd /opt/spore/web && node --import ./test/cjs-sdk-hook.mjs --import tsx tools/treasury.mts list
cd /opt/spore/web && node --import ./test/cjs-sdk-hook.mjs --import tsx tools/treasury.mts claim --min 0.01 --send
```

`list` and `claim` without `--send` are simulations. `claim --send` sweeps the curve bucket, the
creator vault (and the AMM vault once migrated) and distributes to every shareholder; the platform's
part lands in its SOL account or the quote mint's ATA. `sell <mint> --send` converts collected parent
tokens to SOL through the same multi-hop route the site uses.

Cron, daily at 03:30 (the tool needs `web/node_modules`, so run from `web/`):

```
30 3 * * * cd /opt/spore/web && WALLET=/etc/spore/platform-keypair.json RPC_URL=… node --import ./test/cjs-sdk-hook.mjs --import tsx tools/treasury.mts claim --min 0.01 --send >> /var/log/spore-treasury.log 2>&1
```

Keep `--min` above the transaction cost (a claim is ~0.0002 SOL in fees + priority fee) so dust is
left to accumulate.

## 9. Health, limits, logs

- `GET /api/health` → `{ ok, status, uptimeS, indexer: { phase, lagS, backfill }, ws: { connected, lastMessageAgoMs }, rpc, meta, images, metahost, treasury, sse, memoryMb }`.
  `ok` is false when the WebSocket has been down for over two minutes or the refresh loop has not run
  for five; `GET /api/health?strict=1` then answers **503** for a load-balancer probe.
- Rate limits per client IP (configurable `RATE_*`): API reads 300/min, image proxy 900/min, RPC proxy
  60/min, upload 5/10 min (refunded when validation rejects), spawn report 20/10 min. Responses carry
  `X-RateLimit-Limit/Remaining/Reset/Policy`; a 429 adds `Retry-After` and `{ error, retryAfter }`.
- Logging: one line per error, per request over 1 s, and a `LOG_SAMPLE` fraction (default 10%) of the
  rest, as `http: GET /api/feed 200 3.2ms 1842B 203.0.113.9`. The RPC key is redacted. PM2 writes
  `logs/spore-api.{out,err}.log` (rotate with pm2-logrotate, §3); systemd uses journald.
- Caching: `/api/feed|roots|map|tree|coin|stats|candles` send a weak ETag and `public, max-age=3–10,
  stale-while-revalidate`; `/m/*` and `/assets/*` are `immutable` for a year; `index.html` is `no-cache`.
- CSP: the SPA gets `default-src 'self'`, connect-src self + `PAGES_DOMAIN`, img-src self/data/blob +
  `PAGES_DOMAIN`, Google Fonts, Solflare's connect iframe, `frame-ancestors 'none'`, and a per-request
  nonce. The only inline script allowed is one in `web/index.html` written as
  `<script nonce="__CSP_NONCE__">…</script>` — the server substitutes the nonce. Any other inline script
  or external host is blocked; add hosts with `CSP_CONNECT` only if the browser must reach them directly.

## 10. Backups

The whole state is `DATA_DIR/spore.sqlite` (WAL mode; the image cache in `DATA_DIR/img` is
disposable) plus `deploy/pages/public/m` (published metadata, irreplaceable). Online backup while
the server runs:

```sh
cd /opt/spore/server && node --disable-warning=ExperimentalWarning scripts/backup.mjs --out /var/backups/spore --keep 14
# cron, daily 04:10:
10 4 * * * cd /opt/spore/server && node --disable-warning=ExperimentalWarning scripts/backup.mjs --out /var/backups/spore >> /var/log/spore-backup.log 2>&1
20 4 * * * rsync -a /opt/spore/deploy/pages/public/m/ /var/backups/spore/m/
```

The script uses sqlite's backup API (consistent snapshot, no lock on writers), runs
`PRAGMA integrity_check` on the copy and prunes old files. Restore: stop the service, copy the
backup to `DATA_DIR/spore.sqlite`, delete any `-wal`/`-shm` next to it, start. Losing the database
costs only the backfill time (§6); losing `deploy/pages/public/m` breaks coin images and names on
pump.fun and wallets, so keep an off-host copy of it.

## 11. Upgrading

```sh
cd /opt/spore && sudo -u spore git pull
cd server && sudo -u spore npm ci --omit=dev && cd ../web && sudo -u spore npm ci && sudo -u spore npm run build
cd /opt/spore/server && SPORE_NET=0 sudo -u spore npm test        # must be green
pm2 reload spore-api        # or: sudo systemctl restart spore-api
curl -fsS localhost:8793/api/health?strict=1 >/dev/null && echo healthy
```

Schema migrations are idempotent and run at boot. A reload ends SSE streams; the web app reconnects
with backoff on its own.

## 12. Security checklist

- The API process has no private keys: `WALLET`/keypair files live outside `/opt/spore`, owned by
  another user. `.env` files are mode 600 and gitignored. `RPC_URL` carries the Helius key; it is
  redacted in logs and never sent to browsers (they use `/api/rpc`).
- Only the reverse proxy is reachable from the internet; bind the API to loopback at the firewall
  (`ufw allow 443; ufw deny 8793`).
- `TRUST_PROXY` must match the topology: `loopback` for a proxy on the same host, an explicit
  subnet for a separate one, never `true` on a host that is directly reachable (clients could spoof
  `X-Forwarded-For` and dodge rate limits).
- Uploads are plain text + raster images only (magic bytes checked, EXIF stripped, SVG/HTML refused);
  metadata JSON is fetched with DNS and redirect guards; images are proxied only from an allowlist.
- `npm audit` the two packages at upgrade time; wrangler is pinned (`3.99.0`).
- Keep `SHOW=ours` in production: it lists only coins whose on-chain fee split names the platform.
