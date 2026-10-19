# Spore server

Indexer + JSON API for the pump.fun family tree (coins quoted in other pump coins, `depth ≥ 1`,
plus every ancestor down to depth 0). Node 25 ESM, `express`, `node:sqlite`; no native modules, no
keys. The browser builds and signs every transaction itself; this process only reads the chain,
serves JSON, proxies an allow-listed JSON-RPC subset and publishes token metadata to our own host.

Spore is a launchpad (DESIGN §11): by default the API shows only coins spawned through it ("ours"),
charges a launch fee at spawn and hosts metadata itself (pump.fun's IPFS upload is gone).

```
npm start                       # production: BACKFILL on, serves ../web/dist if built
npm run dev                     # BACKFILL_LIMIT=150: a bounded backfill that finishes in ~1 min on the public RPC
npm test                        # node --test (SPORE_NET=0 skips the mainnet smoke test)
npm run fixtures                # re-capture test/fixtures from mainnet (read-only)
```

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8793` | HTTP port (Vite dev proxies `/api` here). |
| `RPC_URL` | `https://api.mainnet-beta.solana.com` | JSON-RPC endpoint. Never logged with its key. |
| `WS_URL` | derived (`https→wss`) | WebSocket endpoint for `logsSubscribe`. Helius-style `?api-key=` URLs derive correctly. |
| `DATA_DIR` | `server/data` | sqlite file (`spore.sqlite`, WAL) and the image cache (`img/`). |
| `PLATFORM_WALLET` | `FcbEAMqBvJVsfcFWDbED7geyBLR88ypcY88BoUSgmeT5` | Platform shareholder in the fee split, launch-fee recipient, and the "ours" marker (a coin is ours when its sharing config pays it at least `PLATFORM_MIN_BPS`). |
| `SPLIT_BPS` | `5000,0,0,5000` | child creator, parent creator, grandparent creator, platform (sum 10 000). Default = two shareholders, creator 50 / platform 50 (like ). Zero slices are dropped before the program sees them; `5000,2500,1000,1500` re-enables upward shares. |
| `PLATFORM_MIN_BPS` | the platform slice of `SPLIT_BPS` (5000) | Smallest platform share (bps) a sharing config must carry for the coin to count as ours. Anyone can write a config that merely names the platform; only the full share proves a Spore launch. |
| `SHOW` | `ours` | `ours`: feed/stats/roots/map/tree/candles and coin children cover only coins spawned through Spore (ancestors as context). `all`: the whole pump.fun tree (development). The indexer indexes everything in both modes. |
| `LAUNCH_FEE_SOL` | `0.02` | Launch fee the Spawn page transfers to `PLATFORM_WALLET` inside the create transaction; reported by `/api/eligibility` as `launchFee`. `0` disables it. |
| `PAGES_DOMAIN` | `spore-2x6.pages.dev` | Public host of the self-hosted metadata (`https://<PAGES_DOMAIN>/m/<hash>.json`). URLs on it resolve from the local directory first. |
| `PAGES_PROJECT` | `spore` | Cloudflare Pages project `wrangler pages deploy` publishes to (token read from `~/.cloudflare-token` at deploy time, account `CLOUDFLARE_ACCOUNT_ID` fixed in `lib/metahost.mjs`). |
| `META_DIR` | `../deploy/pages/public` | Directory holding `m/<sha256>.<ext>` + `m/<sha256>.json`, `_headers`, `index.html`; served locally at `/m/<name>`. |
| `REFRESH_MS` | `30000` | Refresh tick. Hot coins (live activity, recently viewed) are re-read every tick. |
| `FULL_REFRESH_MS` | `1200000` | Every tracked curve is re-read once per this window, spread over the ticks. |
| `BACKFILL` | `1` | `0` disables the backfill (live subscription only). |
| `BACKFILL_LIMIT` | unlimited | Stop resolving curves after this many (development). |
| `CONCURRENCY` | `4` | Parallel RPC requests. |
| `RPC_RPS` | `4` public / `40` otherwise | Request budget per second of the indexer lane (backfill, refresh, live); the public RPC caps each method at ~40 per 10 s per IP. |
| `RPC_API_RPS` / `RPC_PROXY_RPS` | `RPC_RPS / 4` (min 1) | Separate budgets for request-driven lookups (unknown coin pages, eligibility, spawn verification) and for the browser's `/api/rpc` traffic. A 429 pauses only the lane that hit it, so a client can never stall the indexer. |
| `CREATED_AT_PROBE` | `1` | `0` skips the per-coin `getSignaturesForAddress` creation-time lookup. |
| `ORIGINS` (alias `ORIGIN`) | empty | Comma-separated CORS allowlist (`scheme://host[:port]`) for a separate dev origin; production is same-origin. |
| `TRUST_PROXY` | `loopback` | express `trust proxy`: `loopback`, `true`, a hop count or IPs/subnets. Client IPs (rate limits, logs) and `req.secure` come from `X-Forwarded-*` only through a trusted proxy. |
| `HSTS` | `auto` | `Strict-Transport-Security`: `auto` = only on requests the trusted proxy marks https, `1` always, `0` never. |
| `LOG_SAMPLE` | `0.1` | Fraction of successful fast requests logged; errors and requests over 1 s are always logged. |
| `RATE_API` / `RATE_IMG` / `RATE_RPC` / `RATE_UPLOAD` / `RATE_SPAWNED` / `RATE_SSE` | `300` / `900` / `60` / `5` / `20` / `30` | Per-IP limits per window (1 min for api/img/rpc/sse, 10 min for upload/spawned). |
| `SSE_MAX_CLIENTS` / `SSE_PER_IP` | `2000` / `5` | Open `/api/events` streams allowed in total (503 beyond) and per client IP (429 beyond). A stream whose socket stops draining is cut once 256 KB are buffered for it. |
| `UPLOAD_DAILY_IP` / `UPLOAD_DAILY_MB` / `UPLOAD_DAILY_DEPLOYS` | `20` / `256` / `200` | Daily quotas of `/api/upload`: uploads per client IP, new bytes written and Pages deploys run (fixed 24 h window from boot; 429 with `retryAfter` when spent). |
| `META_GC_HOURS` | `24` | Uploaded metadata files no indexed coin references after this many hours are deleted (and un-published with the next deploy). `0` keeps everything. Only files `/api/upload` wrote are ever considered. |
| `IMG_CACHE_MB` | `512` | Disk budget of the image proxy cache; the oldest files are evicted beyond it. |
| `CSP_CONNECT` | empty | Extra `connect-src` hosts for the SPA's Content-Security-Policy (normally none: the browser reaches the chain only through `/api/rpc`). |
| `TREASURY_TTL_MS` | `60000` | Cache of `GET /api/treasury`. |
| `DIST_DIR` | `../web/dist` | Built web app served with the SPA fallback. |
| `PUBLIC_URL` | `https://sporepad.com` | Origin the partner API (`/v1`) builds absolute links and image URLs on. |
| `V1_RATE_PUBLIC` / `V1_RATE_PARTNER` | `60` / `1200` | `/v1` requests per minute: per client IP without a key, per key with one. |
| `V1_STREAMS_PUBLIC` / `V1_STREAMS_PARTNER` / `V1_STREAMS_MAX` | `2` / `20` / `2000` | Concurrent `/v1/stream` connections per IP, per key, and in total. |

Every variable is validated at boot by `lib/config.mjs`; a bad value stops the process with every
problem listed (`spore: invalid configuration: - PORT=… must be …`). `deploy/env.example` documents
them all and `../DEPLOY.md` covers running on a VPS.

## How the index is built

**Backfill (once, resumable).** `getProgramAccounts` on the pump program with two memcmp filters
(`BondingCurve` discriminator at 0, `depth` at offset 141) for every depth `1..Global.maxCurveDepth`
returns every curve with full data (12 227 depth-1 and 184 depth-2 curves on 2026-10-18, ~4.7 s per
call on the public RPC). The rows go to the `backfill_curves` staging table. A curve does not store its
mint, so each is resolved with `getTokenAccountsByOwner(curve)` (Token-2022 first, SPL Token as the
fallback for older coins): the token account whose mint is not the curve's `quote_mint` is the coin.
Resolution order is graduated curves first, then by `realQuoteReserves`, then deeper first, so the
leaderboard fills with the big ones. A resolved child also identifies its parent's curve for free
(`bondingCurvePda(quote_mint)`), so many depth-1 curves never need their own lookup. Progress is
persisted per curve; a restart continues where it stopped and rescans at most once a day.
Then every ancestor chain is walked (`quote_mint` → curve, batched 100 per `getMultipleAccounts`)
so each tracked coin reaches a depth-0 root, mint accounts are read for decimals / token program /
Token-2022 metadata (Metaplex PDA for SPL mints), pools and vault balances are read for migrated
coins, fee-sharing configs for depth ≥ 1, and finally creation times (oldest signature on the curve;
coins with more than 4 000 transactions keep `createdAt: null`).

Cost: one `getTokenAccountsByOwner` per curve (two for the rare SPL-Token coin), plus one request per
100 coins for every batched step and one `getSignaturesForAddress` per coin for the creation-time
probe. Measured on 2026-10-18: both `getProgramAccounts` scans take ~4.5 s each; on the public RPC the
resolve step ran at **0.8 curves/s** (the per-method cap is 4/s and the IP was shared with other
processes, so 429 pauses dominated), which puts the full 12.4k-curve tree at **3–4 hours**, about an
hour if the budget is yours alone; `BACKFILL_LIMIT=150` finishes in under two minutes. On Helius or
any paid RPC (`RPC_RPS=40`, `CONCURRENCY=8`) the whole backfill, creation-time probe included, takes
**5–10 minutes**. It is resumable at every step: a restart after the limit was reached re-reports
"done" in well under a second from sqlite.

**Live.** `logsSubscribe({ mentions: [pump] })` over `WS_URL`. Every `Program data:` line is matched by
its 8-byte discriminator: `CreateEvent` with `depth ≥ 1` inserts the child (and pulls an unknown
parent chain), `TradeEvent` for a tracked mint updates reserves and records a trade, `CompleteEvent`
marks the curve complete, and pump-amm `BuyEvent` / `SellEvent` keep graduated coins' pool reserves
and trades current. The socket reconnects with backoff (1→30 s) and a silent socket is reopened
after 60 s; every (re)connect triggers a refresh.

**Refresh.** Each tick re-reads curves touched by live events or API views in the last two minutes,
plus a rolling slice sized so the whole set cycles once per `FULL_REFRESH_MS`; migrated coins get
their vault balances; SOL/USD comes from CoinGecko every 60 s (last value kept on failure).

**Pricing.** `priceQuote` = quote per token (curve: virtual reserves; pool: vault balances), scaled by
decimals. `priceSol` multiplies `priceQuote` up the chain to a SOL-quoted root; a USDC root gives
`priceUsd` directly (`priceSol = priceUsd / solUsd`); a root quoted in PUMP is priced through
PUMP's CoinGecko price (fetched with SOL's, every 60 s); any other listed quote mint (tokenized
stocks) prices as `null`.
`lockedQuote` is the sum over direct children of their raised parent tokens (curve
`realQuoteReserves`, or the pool's quote vault once migrated), in the parent's raw units;
`lockedUsd` applies the parent's own `priceUsd`.

## "Ours only" mode (DESIGN §11.1)

A coin is **ours** when its on-chain fee-sharing config (pump-fees) pays `PLATFORM_WALLET` at least
`PLATFORM_MIN_BPS` (the platform slice of `SPLIT_BPS`, 50% by default), which is what the Spawn page
writes in the create transaction. Merely naming the platform is not enough: the config is written by
the creator, and a 1 bps share would otherwise buy a permanent listing.

For the first minutes a spawn may instead be **pending**: the UI reports it with
`POST /api/spawned { mint, sig }` and the server **verifies the transaction on-chain** before
believing it (`lib/spawned.mjs`): `getTransaction(sig)` must succeed without error and carry a pump
`CreateEvent` whose mint is the reported one, whose creator is a wallet (a program-derived creator is
a holder-reward coin, which the split cannot apply to), and the platform wallet's balance must have
grown by at least the launch fee (`LAUNCH_FEE_SOL`; skipped when the fee is 0 or the platform launched
the coin itself). Anything else is a 400 (`404 { retryAfter: 3 }` while the RPC has not seen the
signature yet); a verdict is cached per signature, so the UI's retry and any replay cost no RPC.
A verified spawn is stored pending with a timestamp and the fee it paid (persisted in `kv`, bounded
to 500 entries, so a restart keeps it), the coin is inserted from its own CreateEvent (roots included:
the launch tab defaults to a SOL-quoted root, which the live path ignores as a non-spawn), tracked,
its sharing config read immediately, and it is kept hot. The indexer re-reads the sharing config of
every pending mint and of every coin younger than 30 minutes on every refresh tick (besides the 6 h
re-read for everything at depth ≥ 1); a config paying the platform its share turns the flag into
`ours`, and a pending flag older than 10 minutes without confirmation is dropped (a genuine split
lands within seconds of the create). `Coin.feePaid` (lamports as a string, or `null`) is what the
verified create paid.

Every `Coin`, `CoinRef` and map node carries `ours` and `oursPending`. With `SHOW=ours`:

- `/api/feed`: our coins (ours or pending), roots included.
- `/api/roots` and `/api/map`: the depth-0 ancestors of our coins, one row per root; `children` = direct children in scope, `descendants` = our coins below, `lockedQuote/lockedUsd` over our direct children.
- `/api/tree` and the `children` of `/api/coin`: only in-scope coins (ours + their ancestors); `otherChildren` is how many direct children on pump.fun were left out (also on `Coin`).
- `/api/candles`: 404 for a coin outside the scope.
- `/api/stats`: `coins`/`byDepth` over our coins, `roots` as above, plus `mode`, `ourCoins`, `otherChildren`.
- `/api/search`, `/api/eligibility` and `/api/coin` itself stay global: anyone may spawn under any pump coin, and a foreign coin's page opens (with no children listed).
- SSE `coin` events are sent only for our coins.

`SHOW=all` serves the whole tree; `mode`/`ourCoins` are still reported and `otherChildren` is 0.

## The map shows everything, live (DESIGN §11.5)

The Map page draws the whole custom-pair ecosystem whatever the listing mode, and must not re-request
it on every open. Server side:

**Full forest.** `GET /api/map?scope=all&limit=all[&depth=2]` → `{ roots: MapNode[], scope: "all",
version, generatedAt, total }` with every root and every descendant (`MapNode = { coin: MapCoin,
children }`, `MapCoin` = `CoinRef` + `ours/oursPending`, `mcapUsd`, `lockedUsd`, `children`,
`descendants`, `migrated`, `createdAt`), no fan-out cap, roots and children ordered by locked value.
`depth` defaults to the program's current depth cap (2) so nothing is left out. Built from `mapRef`
only (no `view()`: no ancestor walk, no volume join) from the precomputed children index; cached per
model version and at most once per 10 s, together with its JSON, gzip and brotli bytes, so a burst of
opens shares one build. Measured on the production copy (15 575 nodes, 2 145 roots): ~50 ms tree
walk + ~65 ms encode on a warm process, 5 MB JSON / 1.1 MB gzip; the response carries
`x-map-build-ms` / `x-map-encode-ms` and `/api/health.map` keeps `lastBuildMs`/`maxBuildMs`.
`limit=<n>` (default 60, fan-out 40) and the ours-mode default are unchanged.

**Delta sync.** Every coin row carries `updated_at` in **milliseconds** (schema v3 multiplies the old
seconds once; `Coin.updatedAt` on the coin page stays in seconds). It moves only when something a map
node shows changed: a new coin, reserves / complete / migrate / pool balances (trades and refresh
ticks), a sharing config (`ours`), a pending flag, an on-chain name/ticker/uri that resolved, or an
off-chain image that resolved (the `meta` row's image changed → every coin behind that uri is stamped
through the uri → mints index). A child's reserve/migration change also stamps its parent (locked
value, child count). A refresh tick that re-reads an identical curve stamps nothing. Stamps are kept
strictly after the last full build (`generatedAt`), so a change landing in the same millisecond is
still caught. Not stamped: price moves inherited from an ancestor or from SOL/USD (every node would
change every minute; the client recomputes nothing and `mapdelta` carries the traded coins).
`GET /api/map?scope=all&limit=all&since=<ms>` → `{ nodes: [{ ...MapCoin, parentMint }], removed: [],
generatedAt, total, version }`: only the nodes with `updated_at > since` that the full map would draw
(a root with children, or a child whose parent chain reaches a tracked root), largest locked value
first; `removed` is reserved (coins are never deleted); `total` lets a client tell a stale cache from
a complete one. Cached 10 s per `since` value. A client keeps the full set + `generatedAt`, asks
`since=<generatedAt>` on open and merges.

**SSE `pair`** `{ coin: MapCoin, parent: MapCoin }`: every coin the live stream creates whose parent is
tracked (depth ≥ 1), in both listing modes, and again when a known child's parent becomes known
(adopt / enrich pull the ancestor chain; an on-demand, untracked parent is tracked the moment it gets
a child). Deduped per mint for 60 s. `coin` keeps its ours-only semantics.

**SSE `mapdelta`** `{ at, updated: [{ mint, mcapUsd, lockedUsd, children, descendants, migrated, name,
symbol, image }] }`: flushed every 3 s, only when something changed, from the same dirty set the
stamps feed (so a late-resolved logo or name reaches open maps), at most 500 entries per batch
(largest locked value first; the rest wait for the next flush). `trade` and `stats` are unchanged.
`/api/health.indexer.map` counts pairs and deltas sent.

**Metadata coverage** (names and logos must show). On-chain name/symbol come from the `mints` table and
ride on every node. Off-chain JSON is fetched for **every tracked coin in both modes**: `MetaFetcher`
runs a sweep every minute that queues every tracked coin whose uri has no row, a stale row, or a
failed row whose backoff elapsed, ordered by locked value then recency; 6 workers; results persist in
`meta` (`attempts` counts consecutive failures: retries after 15 min, 30 min, 1 h … capped at 24 h; a
resolved image is re-read weekly, a resolved JSON without an image daily; a uri that once resolved
keeps its image when a later re-read fails). IPFS content (`ipfs://`, any `/ipfs/<cid>` path, or
`<cid>.ipfs.<gateway>`) goes through the gateway rotation pump.mypinata.cloud → ipfs.io → dweb.link
→ gateway.pinata.cloud → w3s.link (DESIGN §11.5's four in their order, with pump.fun's own pinata
gateway in front: measured 2026-10-19 it answers in 0.2 s, 200 for everything pump.fun pinned and a
definitive 403 otherwise, while the three public gateways answer 429 within seconds of six workers
and gateway.pinata.cloud needs ~7 s per CID; cf-ipfs.com is dead and never asked; a gateway outside
the rotation that a creator wrote into the uri is tried first, the content may only be there). A
403/404/410/5xx, a 429 or a timeout from one gateway moves to the next; each attempt has its own
10 s timeout under a 25 s budget per uri (15 s / 30 s for images); the least-busy gateway is asked
first so the workers spread over the rotation (200 ms spacing per host, 429 pauses per host as
before). The image proxy uses the same rotation and allowlist (`dweb.link` / `w3s.link` path form
included; they redirect to the listed `<cid>.ipfs.*` form). This is HTTP to gateways only, never the
RPC. `/api/health.meta` reports the coverage over tracked coins, `{ total, withMeta, withImage,
noUri, failed, queued }` (`failed` = coins whose last fetch failed), plus this process's counters
under `run: { fetched, failed, rateLimited, rotated, sweeps }`.

**Live-path cost.** A trade used to trigger a full derived recompute (`computed()`, ≈ 90 ms at 15k
coins) because the coin's own upsert had just bumped the model version; `Model.priceOf(mint)` prices
one coin from its own chain instead, so the forest is recomputed only by consumers (API reads, the
3 s `mapdelta` flush, the 30 s stats tick). Unchanged-curve re-reads no longer bump the version either.

## Metadata host (DESIGN §11.3)

`POST /api/upload` validates like before, then `lib/metahost.mjs` writes two content-addressed files
under `META_DIR/m` (`<sha256 of the image>.<png|jpg|gif|webp>` and `<sha256 of the JSON text>.json`,
JSON shape `{ name, symbol, description, image, showName: true, createdOn, twitter?, telegram?, website? }`)
and runs `npx wrangler@3.99.0 pages deploy` for the whole directory (so earlier files stay published).
Deploys are single-flight: callers arriving during a deploy share one follow-up deploy, never two
wrangler processes at once; 240 s timeout; a failure answers 502 with the wrangler reason. The
response is `{ metadataUri, imageUri, metadata }` with `https://<PAGES_DOMAIN>/m/<hash>.json`.
The same files are served at `GET /m/<name>` (immutable, CORS `*`), and the metadata fetcher and the
image proxy resolve any `https://<PAGES_DOMAIN>/m/...` URL from the local directory before touching
the network, so coin pages work on a machine that cannot reach `*.pages.dev`.

The upload is reachable before any wallet has signed anything (the Spawn page uploads first, then
builds the transaction), so it is bounded on its own: daily quotas per client IP and globally for
bytes and deploys (`UPLOAD_DAILY_*`, 429 with `retryAfter` once spent), a ledger in sqlite
(`uploads`) of every file the endpoint wrote, and an hourly garbage collector that deletes ledger
files older than `META_GC_HOURS` that no indexed coin references (a mint's `uri` or a metadata
`image` on our host), image files only once no surviving JSON points at them (identical images share
one file). A removal triggers one deploy so the public host forgets the file too. Files written by
`tools/publish-meta.mjs` or anything else are not in the ledger and are never touched. What is not
done here: binding the upload to a wallet signature, which needs the web flow to sign a message
first (see the security notes in the fix report).

## Storage

`node:sqlite`, WAL mode: `coins`, `mints`, `trades` (≤ 2 000 per mint, 24 h volume and candles),
`meta` (off-chain JSON cache with `attempts`; weekly re-read of a resolved image, backoff retries from
15 min to 24 h, IPFS gateway rotation), `backfill_curves`, `backfill_state`, `kv` (SOL price,
decoded `Global`, schema version), `api_keys` (partner keys as sha256, usage counters). `coins.updated_at` is milliseconds (v3). Migrations are idempotent
(`CREATE IF NOT EXISTS` plus versioned column additions; v3 also rescales `updated_at` once).

## API

All JSON; errors are `{ error }` with a 4xx/5xx status; unknown mint → 404. Field-for-field as in
DESIGN §7, plus a few extras that never replace a contract field:

- `GET /api/stats` → `Stats`
- `GET /api/feed?limit=50&before=<createdAt>` → `{ coins }` newest spawns (depth ≥ 1)
- `GET /api/roots?sort=locked|children|new|volume&limit=50&offset=0` → `{ roots, total }` (`new` = most recent child)
- `GET /api/coin/:mint` → `{ coin, children, trades }`; a pump coin the index has not seen yet is fetched live (untracked until it has a child)
- `GET /api/tree/:mint?depth=3&limit=100` → `TreeNode` (children sorted by `lockedUsd`, `limit` per node)
- `GET /api/candles/:mint?res=60` → `{ candles, priceKey }` from live trades (USD when every trade has a USD price)
- `GET /api/search?q=` → `{ coins }` symbol/name prefix (`$` allowed) or exact mint, max 20
- `GET /api/eligibility/:mint?creator=` → `Eligibility` + `launchFee { to, lamports, sol }`, decided by the SDK's `pumpQuoteReserves` on live state (same checks as `create_v2`); the split is two shareholders by default (creator, platform; without `creator` the child slot's address is `""`; creator == platform merges to one)
- `POST /api/spawned` `{ mint, sig }` → `{ ok, mint, ours, oursPending, verified: true, feePaid?, coin }` the Spawn page reports a signed spawn; the transaction is read back and must be a pump create of that mint by a wallet with the launch fee paid to the platform, else `400 { error }` (`404 { error, retryAfter: 3 }` until the RPC sees the signature); 20 per 10 min per IP, verdicts cached per signature
- `GET /m/:name` → a self-hosted metadata/image file (immutable)
- `GET /api/events` → SSE `coin | trade | stats`, heartbeat comment every 15 s
- `GET /api/img?u=` → cached image proxy for URLs the API itself handed out (the `image` of an indexed coin or a file on our metadata host; anything else is 404 even on an allowed host; allowlist in `lib/meta.mjs`, 4 MB, 24 h, `IMG_CACHE_MB` budget); `Coin.image` already points here
- `POST /api/upload` → `{ metadataUri, imageUri, metadata }` self-hosted (see "Metadata host"; 5 per 10 min per IP, daily quotas → `429 { error, retryAfter }`)
- `POST /api/rpc` → allow-listed JSON-RPC proxy (no `getProgramAccounts`) on its own RPC lane; batches of at most 5; `getMultipleAccounts` ≤ 32 keys; `getTokenAccountsByOwner` never `jsonParsed`; `sendTransaction` / `simulateTransaction` only for transactions that invoke a pump program (decoded and checked, base64 or base58); relayed answers capped at 2 MB; 60 per minute per IP
- `GET /api/treasury` → `{ platform, ourCoins, pendingByQuote: [{ quoteMint, symbol, amount, usd, coins }], coins, updatedAt }`: the platform's pending creator-fee share, read from the curve bucket, creator vault and AMM vault of every coin whose sharing config names the platform (DESIGN §11.4); cached 60 s; empty until the first launch
- `GET /api/fees/:mint` → `{ mint, quoteMint, quoteSymbol, quoteDecimals, quoteUsd, shares, bucket, vault, amm, total, totalUsd, perShare: [{ address, bps, amount }], migrated, claimable, reason, updatedAt }` (DESIGN §11.6): one coin's pending creator fees for the coin page's "Creator fees" card, read live on the api lane from the curve's `creatorFee` bucket (`bucket`), the sharing config's creator vault (`vault`: SOL above the vault's rent floor, or the vault's quote ATA) and, once migrated, the AMM creator vault ATA plus the pool's unswept `creator_fees` (`amm`); amounts are raw quote units as strings (`quoteMint` null = SOL), `shares` is the on-chain config (null when there is none; a config the indexer has not seen yet is adopted into the model), `perShare` is each shareholder's cut of `total`, `claimable` is false with a `reason` for a holder-reward coin, a coin without a config or an empty total (the browser's preflight simulation decides the program's minimum); cached 15 s per mint (`updatedAt` moves when it refreshes, so a refetch right after a claim may still show the old numbers), ETag + `max-age=5`, 404 for a mint pump.fun does not know, 503 while the RPC is unreachable and nothing is cached
- `GET /api/claims/:wallet` → `{ wallet, coins: [CoinRef & Fees & { yourBps, yourAmount, yourUsd }], totals: { usd, byQuote: [{ quoteMint, quoteSymbol, quoteDecimals, amount, usd }] }, updatedAt }`: every indexed coin whose fee-sharing config names the wallet (max 100), sorted by the wallet's part in USD; 400 on a malformed wallet (DESIGN §11.7).
- `GET /api/claims?limit=50` → `{ coins, totals, updatedAt }`: the Spore launches with creator fees waiting, biggest first; cached 30 s. Both read fee accounts in batches through the per-mint cache `/api/fees` uses.
- `GET /api/health` → `{ ok, status, uptimeS, indexer: { phase, lagS, backfill }, ws: { connected, lastMessageAgoMs, backoffMs }, rpc, rpcLanes, meta, images, metahost (+ quota), treasury, sse, sseStats, memoryMb }`; `?strict=1` answers 503 when degraded (socket down > 2 min or no refresh for 5 min)

## Partner API (/v1, DESIGN §12)

Read-only data for other trading terminals, versioned under `/v1` (`lib/v1.mjs`, OpenAPI in
`lib/openapi.mjs`, keys in `lib/apikeys.mjs`). Only GET routes exist; any other method is 405.

- `GET /v1/coin/:mint/family` → `{ mint, name, symbol, image, depth, quoteMint, quoteSymbol, root, parent, ancestors, children: { count, top }, descendants, lockedUsd, mcapUsd, change24h, trades1h, launchedOnSpore, links }`: any pump.fun mint (live lookup on the api RPC lane when not indexed; 404 when it is not a pump coin, 503 when the lookup fails); `top` = up to 20 children by locked value; `change24h` in percent against the last trade at or before 24 h ago (null without trades); cached 5 s per mint.
- `GET /v1/tree/:mint` → `{ root, nodes: [{ ...MapCoin, parentMint }], total }`: the whole tree containing the mint, root first, breadth-first, siblings by locked value; cached 10 s per root.
- `GET /v1/map[?since=<ms>]` and `GET /v1/heat`: the `/api/map?scope=all&limit=all` and `/api/map/heat` bodies from the same caches (the map bytes rewritten once per build so images are absolute; `since` rounded down to the second).
- `GET /v1/stream?types=pair,trade,heat,stats[,mapdelta,coin][&mint=<coin>]`: the hub's events (the hub has a `subscribe` hook for in-process listeners), filtered by type and by the tree of `mint` (root resolved per event), `heat` rows derived per trade, absolute images, `retry: 3000`, heartbeat every 25 s, backpressure cut at 256 KB.
- `GET /v1/openapi.json`: the OpenAPI 3.1 document (tests check that every route is listed and every `$ref` resolves).

Every image is absolute on `PUBLIC_URL`. CORS is `*` (GET/OPTIONS, `X-API-Key`, no credentials; preflights
answered before auth); `/api` keeps its allowlist. Family/tree/map/heat send `public, max-age=5, s-maxage=10`
+ ETag/304 so a CDN absorbs polling; the stream and errors are `no-store`.

**Tiers.** No key = public: `V1_RATE_PUBLIC` requests/min per client IP, `V1_STREAMS_PUBLIC` streams per IP.
`X-API-Key: spk_<32 base58>` = partner: `V1_RATE_PARTNER`/min and `V1_STREAMS_PARTNER` streams per key
(`?key=` only on `/v1/stream`, a 400 elsewhere). Invalid or revoked key → 401 (charged to the IP's public
budget). Headers: `X-Spore-Tier`, `X-RateLimit-Limit/Remaining/Reset/Policy`; 429 carries `Retry-After`.
Keys are stored as sha256 only (`api_keys`); a verified key is cached 15 s, so a revocation lands within 15 s;
`requests` / `last_used_at` are written in one transaction every 30 s and at shutdown. `/api/health.v1`
reports open streams and key counters.

**Keys (CLI only, no HTTP admin):**

```
node --disable-warning=ExperimentalWarning scripts/keys.mjs create --name "Axiom" --contact "@axiom"   # prints the key once
node --disable-warning=ExperimentalWarning scripts/keys.mjs list                                        # id, name, contact, tier, created, status
node --disable-warning=ExperimentalWarning scripts/keys.mjs revoke 3                                    # refused by the server within 15 s
node --disable-warning=ExperimentalWarning scripts/keys.mjs usage                                       # requests and last use (≤ 30 s behind)
```

It opens `DATA_DIR/spore.sqlite` (`--data <dir>` overrides) next to the running server and refuses a missing
file. The server's connection waits up to 2 s for a write lock (`busy_timeout`) so the CLI never makes a
server write fail.

**Embeds.** `/embed` and `/embed/*` serve index.html with `frame-ancestors *` and no `X-Frame-Options`
(`isEmbedPath` in lib/http.mjs); every other path keeps `frame-ancestors 'none'` + `X-Frame-Options: DENY`.

## Hardening (lib/http.mjs, lib/validate.mjs, lib/net.mjs)

- Headers on every response: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` (not on the `/embed/*` pages), `Referrer-Policy`, `Permissions-Policy`, `Cross-Origin-Opener-Policy`, a closed CSP for JSON (`default-src 'none'; frame-ancestors 'none'`), HSTS when the request came over TLS. `index.html` gets the SPA CSP (`default-src 'self'`, connect/img to self + `PAGES_DOMAIN`, Google Fonts, Solflare's iframe and same-origin frames (`frame-src 'self'`, so /docs/api can preview the `/embed/*` widgets), `frame-ancestors 'none'`) with a per-request nonce substituted into `__CSP_NONCE__` so one inline theme snippet may exist; nothing else inline.
- Bodies: 16 KB JSON everywhere, 3 MB on `/api/upload` → `413 { error }`.
- Rate limits per IP with `X-RateLimit-Limit/Remaining/Reset/Policy`, `429 { error, retryAfter }` + `Retry-After`. An upload rejected by validation (or by a daily quota) refunds its attempt.
- SSE: new `/api/events` connections are rate-limited per IP, capped per IP and in total (`SSE_*`), and a client that stops reading is destroyed once 256 KB are buffered for it instead of growing the heap.
- RPC: three lanes (indexer / API lookups / browser proxy) with their own token buckets and 429 pauses; request-driven lookups remember per mint for a minute whether a coin exists, eligibility caches its chain reads per mint (the creator only changes the split math), on-demand coins nobody spawned under live in memory only and are evicted after 10 idle minutes, and the API-view table is pruned every tick.
- Compression: gzip/brotli from `node:zlib` for text/JSON bodies ≥ 1 KB (sync for one-shot responses, streamed for static files); never for the SSE stream.
- Caching: weak ETags + `public, max-age=3–10, stale-while-revalidate` on feed/roots/map/tree/coin/stats/candles (304 on `If-None-Match`); `/m/*` and `/assets/*` immutable; `index.html` no-cache; everything else `no-store`.
- Upload validation: name/description plain text (no `<>`, control or invisible characters, caps 32/400), ticker `[A-Za-z0-9]{1,13}`, socials as handles or x.com/t.me links, website http(s); image data URL ≤ 2 MB whose magic bytes match the declared png/jpeg/gif/webp (SVG never), JPEG APP1/APP13 and PNG text/EXIF chunks stripped before the file is written. A wrangler failure is `502 { error, retryAfter: 30, hint }`; the files stay on disk for the next deploy.
- Outbound fetches (metadata JSON, images): hostnames are resolved and refused when any address is private/loopback/link-local, IPv4-compatible, 6to4/NAT64-embedding a private address, Teredo, ULA or documentation space (`lib/net.mjs`); the TLS connection is then **pinned to the vetted address** (`pinnedFetch` over `node:https` with a fixed `lookup`, SNI and certificate checks on the real hostname), so a rebinding resolver cannot redirect a later fetch; redirects are followed manually with the allowlist and the pin re-done per hop, bodies are size- and time-bounded; proxied images are served with the sniffed type. The image allowlist names the IPFS subdomain gateways explicitly (`<cid>.ipfs.dweb.link` etc., never a `.ipfs.` substring) and refuses any explicit port.
- Logging: `http: GET /api/feed 200 3.2ms 1842B 203.0.113.9` for every error, every request over 1 s and a `LOG_SAMPLE` fraction of the rest; the RPC key is redacted.
- Shutdown: SIGTERM/SIGINT stop the indexer, end SSE streams, let in-flight requests finish, checkpoint and close sqlite, exit within 8 s.
- Backups: `scripts/backup.mjs` copies the sqlite file online (backup API + integrity check), see `../DEPLOY.md`.

Extra fields on `Coin`: `quoteDecimals` (to format `lockedQuote`), `curve`, `mayhem`, `tracked`, `ours`, `oursPending`, `feePaid`, `otherChildren`.
`totalSupply` and `lockedQuote` are raw on-chain integers as strings; use `decimals` / `quoteDecimals`.
`root` and `parent` are `null` on a depth-0 coin.

In production the server also serves `../web/dist` with an SPA fallback for every path outside `/api` and `/v1`.

## Layout

```
index.mjs           boot: config, db, model, rpc, hub, image cache, metadata fetcher, indexer, treasury, app, graceful shutdown
lib/config.mjs      every env variable read and validated once (fail fast with one readable error)
lib/http.mjs        security headers + CSP nonce, CORS, rate limits, request log, zlib compression, ETag helpers
lib/validate.mjs    upload text fields, image magic bytes, EXIF/text-chunk stripping
lib/net.mjs         SSRF guards: public-IP check (v4 + v6 forms), DNS guard, address-pinned https fetch, manual redirects
lib/spawned.mjs     on-chain verification of a reported spawn: CreateEvent for the mint, wallet creator, launch fee paid
lib/treasury.mjs    creator-fee accounting: the per-coin reader (curve bucket, creator vault, AMM vault, pool bucket, sharing config), GET /api/treasury (platform share, 60 s) and GET /api/fees/:mint (one coin, 15 s per mint)
lib/sdk.mjs         pump SDK loader (CommonJS entry; the ESM build breaks on a transitive dependency)
lib/decode.mjs      pure decoders: events, curve, mint (+Token-2022 metadata), Metaplex, pool, token account
lib/rpc.mjs         JSON-RPC client: per-lane token buckets (main/api/proxy), concurrency gates, 429 backoff, bounded proxy relay
lib/db.mjs          node:sqlite schema + statements
lib/model.mjs       in-memory tree, derived numbers, API views
lib/pricing.mjs     price chain, progress, fee split merging, launch fee
lib/metahost.mjs    self-hosted metadata files + single-flight wrangler deploy, daily quotas, upload ledger + garbage collection
lib/meta.mjs        off-chain metadata fetcher, image proxy cache, allowlists
lib/live.mjs        logsSubscribe with reconnect
lib/indexer.mjs     backfill, live handlers, refresh loop
lib/eligibility.mjs create_v2 admission check via the SDK
lib/events.mjs      SSE hub with per-IP / global caps and backpressure
lib/api.mjs         express routes
lib/v1.mjs          partner API: tiers, family/tree/map/heat, filtered stream (DESIGN §12)
lib/openapi.mjs     OpenAPI 3.1 document of /v1
lib/apikeys.mjs     partner keys: generation, sha256 storage, verify cache, batched usage counters
scripts/capture-fixtures.mjs   captures real events/accounts into test/fixtures
scripts/backup.mjs             online sqlite backup (backup API, integrity check, retention)
scripts/keys.mjs               partner API keys: create (printed once) / list / revoke / usage
test/*.test.mjs     decoders (real bytes), pricing, split, launch fee, allowlists, db, model, ours mode (model + API, bps floor), spawn verification (real create tx, fixtures/tx-create.json), indexer adopt + lookup cache, metadata host (deploy lock, quotas, gc), API contract (incl. proxy rules), hardening (headers, CSP, 413, 429, compression, ETag, health, treasury, upload validation), per-coin fees (shape, split, migrated SOL vaults, cache, 304, 404, no config / nothing / holder-reward), SSE caps, validation, SSRF guards (v6 forms, pinning), config, RPC lanes, live reconnect, treasury, partner API (shapes, 404s, live lookup, cache headers, CORS, read-only, tiers, stream filters, embed framing, OpenAPI refs), API keys (format, hash-only storage, revocation, batched usage, CLI), network smoke
```
