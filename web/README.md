# Spore — web

Vite 8 + React 19 + TypeScript front end for Spore, the pump.fun family-tree launchpad. It talks only to the Spore API under `/api/*` (same origin in production; proxied to `:8793` by Vite in development) and to the wallet in the browser. No RPC key, no private key, nothing custodial: every transaction is built client-side, simulated, then signed by Phantom/Solflare through wallet-adapter.

## Launchpad rules the UI follows (DESIGN.md §4, §11)

- **Launch is the primary action.** The nav item and page are "Launch" (`/launch`; `/spawn` is kept as an alias that renders the same page so old links work). The form's **pool defaults to SOL**: the first coin of any tree is a plain pump.fun coin, no parent needed. `?parent=<mint>` makes that coin the pool instead; the pool card has "Change" (search over all of pump.fun) and "Use SOL instead". Eligibility comes from `GET /api/eligibility/sol?creator=` for the SOL pool (`ok:true`, depth 0, `pool:"sol"`) and `/api/eligibility/:mint?creator=` for a coin (`pool:<mint>`); both carry the shares and the launch fee. After a launch the success screen's first button is "Launch a coin under $NEW" (→ `/launch?parent=<newMint>`, hidden when the new coin sits at the depth cap) so the tree can grow at once.
- **"Launch a coin" everywhere** (`components/LaunchButton.tsx`): on every Explore card, the Home "Launched on Spore" cards, the Coin page header, its sidebar CTA and its children grid, always → `/launch?parent=<mint>`. It renders disabled with the reason in its tooltip when the coin is at the depth cap (`depth >= stats.maxDepth`) or in mayhem mode (`Coin.mayhem`, optional); the live checks (pending migration, delisted quote) stay on the launch page. `CoinCard` has an `action` slot for it; clicks inside the slot never open the card. Copy says "launch" wherever the user acts; "spawn" survives only in the family-tree story.
- **Fee split: creator 50% / Spore 50%**, two shareholders, paid in the coin's quote (SOL for a root, the parent coin for a child), written at launch with the admin revoked. Every piece of copy (Home "Three steps", How, Launch preview, Coin page CTA) says exactly that; `SplitPreview` renders whatever `eligibility.shares` the server sends, so if `SPLIT_BPS` re-enables upward shares the rows (labelled by parent/grandparent ticker) and the bar follow. Duplicates arrive merged (a platform-owned spawn is one "you + Spore · 100%" row).
- **Launch fee**: `eligibility.launchFee {to, lamports, sol}` (optional; `LAUNCH_FEE_SOL` on the server). `lib/flow.ts → launchFeeOf` turns it into the `LaunchFee` that `buildSpawnTx` adds as a SystemProgram transfer inside the create transaction. `components/CostBox.tsx` shows it before the sign button with the estimated network rent (~0.025 SOL: mint, curve, fee config, vault ATA), the optional first buy and the total, against the wallet balance (`useSolBalance`, polled through `/api/rpc`); the fee line is hidden when it is 0 and the button turns into "Not enough SOL" when the balance is short (1 mSOL margin for network fees).
- **"Ours only" mode**: with `SHOW=ours` the server lists only coins launched here (`Coin.ours` / `Coin.oursPending`, `Stats.mode|ourCoins|otherChildren`, `CoinPage.otherChildren`; all optional in `lib/api.ts` so an older server never breaks a card). The nav pill and Home strip say "N launches" / "Spore launches", Home/Explore/Map show the `NoSpawnsYet` card ("Nothing launched yet — launch the first coin", with the Launch button) instead of an empty table or a blank canvas, the Coin page says "N other children on pump.fun" and gets a "launched on Spore" / "verifying launch" chip, and search/eligibility still cover all of pump.fun (any pump.fun coin can be a parent). After a spawn lands, `runSpawn` fires `POST /api/spawned {mint, sig}` (one retry, never blocks) so the coin is listed while the indexer verifies its fee split.

## Run

```sh
cd web
npm run dev        # Vite on http://localhost:5174, /api → http://127.0.0.1:8793
npm run typecheck  # tsc -b, zero errors expected
npm run build      # tsc -b && vite build → web/dist (served by the server in production)
npm run preview    # serve the production build locally
```

Dependencies are already installed; do not run `npm install` here. The RPC endpoint is `window.location.origin + "/api/rpc"`, the server's allow-listed JSON-RPC proxy. Every page renders with loading skeletons, empty states and error notices when the API is down.

## Routes

| Path | Page | What it shows |
|---|---|---|
| `/` | `pages/Home.tsx` | Hero over the spore canvas, search, stats strip, live launch feed (SSE), "Launched on Spore" cards (top 6 of `/api/feed` by locked then mcap, each with the Launch button), 3-step summary |
| `/explore` | `pages/Explore.tsx` | Card grid of every coin launched here (`/api/feed?limit=200`, SSE prepend) with client-side sort tabs new / locked / mcap / children, each card with "Launch a coin"; a secondary "Roots" tab keeps the old leaderboard table (`/api/roots`, load more); search; `NoSpawnsYet` card when empty |
| `/map` | `pages/Map.tsx` | Full-viewport ecosystem bubble map (`/api/map`): every root with (our) children as a cluster, size by locked or mcap, find-on-map search, top 30/60/120 roots; `NoSpawnsYet` card when empty |
| `/c/:mint` | `pages/Coin.tsx` | Coin header + parent-chain breadcrumbs (+ "launched on Spore" chip), stat tiles, price chart, family bubble map, children grid ("N other children on pump.fun" in ours mode), live trade tape, trade widget, "Launch a coin under $X" CTA, fee shares / "Lock fee split", details |
| `/launch` (`?parent=<mint>`) | `pages/Launch.tsx` | Pool card (SOL root by default; a coin via `?parent=`, "Change" search, "Use SOL instead"), eligibility + split preview, form, optional first buy, cost box with balance check, step-by-step progress, success screen with "Launch a coin under $NEW" + coin page / pump.fun / share links |
| `/spawn` | alias | Renders the same Launch page (old links and share posts) |
| `/how` | `pages/How.tsx` | Mechanism diagram, spawn steps, fee table (creator 50 / Spore 50), depth limits (live from `/api/stats`), trading, risks |

## Launch flow (`lib/flow.ts → runSpawn`)

`SpawnInput.parent` is `Coin | null`: null is the SOL pool (a root coin), a coin is the parent.

1. `POST /api/upload` with name, ticker, description, socials and the image as a data URL (≤ 2 MB) → `metadataUri` (self-hosted, content-addressed metadata on Spore's Pages domain; pump.fun's IPFS endpoint is retired).
2. `GET /api/eligibility/sol?creator=<wallet>` (SOL pool) or `GET /api/eligibility/:mint?creator=<wallet>` (parent) was fetched when the pool was chosen; its `shares` are the exact fee split that gets signed (the server merges duplicates) and its `launchFee` is the transfer added to the transaction.
3. `buildSpawnTx(conn, wallet, parentMint | null, {name, symbol, uri, creatorFeeBps?}, shares, launchFee)` (null = SOL root) → one v0 transaction (`create_v2` + launch fee + fee-sharing config; a second `feeTx` only when the split does not fit), signed by the wallet plus the fresh mint keypair, confirmed by polling. The step list names the fee amount.
4. `POST /api/spawned {mint, sig}` (fire-and-forget, one retry) so the listing shows the coin before the indexer verifies the fee split on-chain.
5. Optional first buy: a root's chain is `[{mint: new, quoteMint: null, tokenProgram: TOKEN_2022, quoteTokenProgram: SPL Token, migrated: false, depth: 0}]` (`chainForRoot`); a child's is `[{mint: new, quoteMint: parent, tokenProgram: TOKEN_2022, quoteTokenProgram: parent's, migrated: false, depth}, ...parentChain]`; `quoteSwap` simulates, `buildSwapTx` applies the chosen slippage, a second signature lands it. A failed first buy is reported separately and never masks the successful spawn.

## Trade widget (`components/TradeWidget.tsx`)

Buy from SOL / sell to SOL through every hop with `multi_hop_swap`. Quotes come from `quoteSwap` (a simulation that reads the final trade event), so the preview is what the program does. Slippage 1–5% sets `minAmountOut`. Buys can be quoted before a wallet is connected (simulated from a public probe key); sells need the wallet's token balance. Chains not rooted in SOL show a notice and a pump.fun link.

## Components

| File | Role |
|---|---|
| `SporeCanvas` | Full-screen drifting-spore canvas behind the hero; rAF, pauses when hidden, still frame under `prefers-reduced-motion` |
| `BubbleMap` (+ `CoinBubbleMap`, `bubblemap.css`) | d3-force bubble map on canvas: clusters per root, node area = locked USD or mcap, images in circles, ancestors stacked above the focused coin, drift dots child → parent, zoom/drag, hover tooltip, click navigates; `CoinBubbleMap` fetches `/api/tree` for the coin page, the Map page feeds it `/api/map` |
| `CostBox` | Launch fee (hidden at 0) + estimated rent + first buy = total, with the wallet balance and a "Not enough SOL" notice |
| `PriceChart` | lightweight-charts v5 candles + volume from `/api/candles`, resolution tabs, dust-price formatting, live refresh on SSE trades |
| `SpawnFeed` + `LiveDot` | Newest launches (roots included) with SSE prepend and highlight; stream status dot |
| `CoinCard` | Image, name, ticker, "↳ under $PARENT" pill, depth badge, mcap, locked, children, curve progress, age; optional `action` slot |
| `LaunchButton` | "Launch a coin" → `/launch?parent=<mint>`; disabled with a tooltip at the depth cap or in mayhem mode (`launchBlock`) |
| `ChainBreadcrumb` | `QUOTE › $ROOT › $PARENT › $COIN` |
| `SplitPreview` | The fee split as a bar + rows: two rows by default (you / Spore), a merged single row when the creator is the platform, parent/grandparent rows only if the server sends them |
| `FeeSplitAction` | "Lock fee split" for a coin of yours that has no sharing config yet (also what makes it "ours") |
| `TradeWidget`, `Steps`, `Search`, `Stat`, `Toast`, `Bits` (Logo, DepthBadge, ParentPill, Chip, Addr, Ext, Skeleton*, Empty, NoSpawnsYet, ErrorBox) | as named |

## Lib

- `lib/api.ts` — typed client for every endpoint in DESIGN.md §7 (types copied verbatim; the §11 fields `ours`, `oursPending`, `mode`, `ourCoins`, `otherChildren`, `launchFee` are optional), `api.eligibilitySol`, `api.spawned`, `ApiError`, URL helpers.
- `lib/events.ts` — one shared `EventSource` to `/api/events` with refcounting and exponential-backoff reconnect; `useEvents`, `useStreamStatus`.
- `lib/hooks.ts` — `useAsync`, `useStats` (poll + SSE), `useSolBalance`, `useTick`, `useDebounced`, `useLocalPref`.
- `lib/chain.ts` — builds the tx library's `Chain` from API coins (`chainFor`, `chainForChild`, `chainForRoot`, `isSolRooted`, `routeLabels`).
- `lib/flow.ts` — `runSpawn`, `runSwap`, `launchFeeOf`, `withSlippage`, `QUOTE_PROBE`.
- `lib/steps.ts` — step model + `friendlyError` (wallet/program errors → short human causes).
- `lib/format.ts` — compact numbers, USD with subscript dust notation, SOL, percentages, bps, ages, addresses, exact decimal parsing.
- `lib/pump/` — the on-chain library (owned by the tx agent): `hopsFor`, `quoteSwap`, `buildSwapTx`, `buildSpawnTx`, `sendAndConfirm`, `splitShares`.

## Visual direction

Dark organic premium: background `#07100b → #0b1a12`, glass surfaces with lime borders, accent `#b6ff5c`, violet `#b08cff` for ancestry and sells, Geist / Geist Mono. Mobile-first, 16 px gutters, no horizontal scroll. Wallet logos come from wallet-adapter; the Spore mark lives in `public/mark.svg` / `public/favicon.svg` and `components/Mark.tsx`.
