# Spore

**Coins that grow coins.** A pump.fun launchpad for family trees, live at [sporepad.com](https://sporepad.com).

pump.fun lets a new coin be quoted in *any* pump.fun coin instead of SOL. Spore turns that into a tree: launch a root with SOL, launch children under it, and every buy of a child buys and locks its parent along the way. Creator fees are split 50/50 between the creator and Spore on-chain (admin revoked at launch); Spore's half buys $SPORE and locks it. No launch fee, nothing custodial: every transaction is built in the browser and signed by the user's wallet.

- **Live site:** https://sporepad.com · map of the whole ecosystem: https://sporepad.com/map
- **X:** [@Sporemap](https://x.com/Sporemap)

## What is in this repo

| Path | What |
|---|---|
| `server/` | Node (ESM, `node:sqlite`) indexer + JSON API + SSE + static web host. Indexes every pump.fun custom pair (backfill + live `logsSubscribe`), prices chains, verifies launches, publishes token metadata, serves the built web app. |
| `web/` | Vite + React + TypeScript app: Explore, live ecosystem map (d3-force in a Web Worker, IndexedDB cache, delta sync), Launch flow (pre-flight simulation, resume/recovery), coin pages with trading, Fees & rules. `web/src/lib/pump` builds the pump.fun transactions. |
| `deploy/` | env template, PM2 / systemd units, reverse-proxy examples, published metadata files. |
| `tools/` | screenshot, brand and metadata-publishing tools. |
| `DESIGN.md` | the design contract (on-chain facts, API, rules). `DEPLOY.md` — how to run it. |

## Run it

```sh
# API + indexer (Node ≥ 24)
cd server && npm ci && cp ../deploy/env.example ../deploy/.env   # set RPC_URL (a paid RPC with WebSocket)
set -a && . ../deploy/.env && set +a && node --disable-warning=ExperimentalWarning index.mjs

# web app
cd web && npm ci && npm run dev      # dev server proxies /api to the local API
npm run build                        # web/dist is served by the API
```

Tests: `cd server && npm test` · `cd web && npm run typecheck`. Mainnet transaction simulations: `web/test/simulate.mts` (see `web/test/README.md`).

## Public API

The API behind sporepad.com is open to read: `GET /api/map?scope=all&limit=all` (the whole forest, `since=<ms>` for deltas), `/api/stats`, `/api/coin/<mint>`, `/api/search?q=`, `/api/eligibility/<mint>`, `/api/candles/<mint>`, SSE `/api/events` (`pair`, `mapdelta`, `trade`, `coin`, `stats`). Shapes are documented in `server/README.md`.

## License

MIT — see `LICENSE`.
