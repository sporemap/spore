# Spore — pump.fun family-tree launchpad

Working brand: **Spore** ("coins that grow coins"). Rename is a one-line change; do not spread the name into identifiers (use `spore` only in package names, titles and copy).

## 1. The idea

pump.fun's `create_v2` lets a new coin be quoted in another pump coin instead of SOL. The child's bonding curve collects **parent tokens**; every SOL buy of the child routes SOL → parent → child, so the parent is bought and parked in the child's curve, and locked in the child/parent PumpSwap pool once the child graduates. Spore:

1. **Indexes the whole tree** of pump.fun (every coin with `depth ≥ 1`, plus their ancestors) and shows it: feed of new spawns, root leaderboard, coin pages with ancestors + children, an animated tree.
2. **Spawns coins under a parent** from the browser (user signs with Phantom/Solflare; nothing is signed server-side).
3. **Routes creator fees upward** with pump's fee-sharing config, set once at creation: child creator, parent creator, grandparent creator, platform.
4. **Buys/sells any coin in the tree from SOL** with `multi_hop_swap`.

Nothing custodial. No private keys anywhere in this repo. Every on-chain action is built client-side, simulated, then signed by the wallet.

## 2. Verified on-chain facts (mainnet, 2026-10-17)

- Programs: pump `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`, pump-amm `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA`, pump-fees `pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ`. Metaplex token metadata `metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s`.
- `Global.maxCurveDepth = 2` (program hard cap `MAX_CURVE_DEPTH = 5`), `createV2Enabled = true`, `creatorFeeConfigurable = true` (max 300 bps), holder rewards enabled.
- 212 listed quote mints (SOL, USDC, 210 quote-control mints such as tokenized stocks). A coin quoted in a listed mint has `depth 0`; a coin quoted in a pump coin has `parent.depth + 1`.
- Live counts: 12,189 depth-1 curves, 184 depth-2 curves. `getProgramAccounts` on the pump program with memcmp filters works on the public RPC (~4.5 s each).
- `BondingCurve` account (Anchor, discriminator `[23,183,248,55,96,216,172,96]`), fields in order: virtual_token_reserves u64, virtual_quote_reserves u64, real_token_reserves u64, real_quote_reserves u64, token_total_supply u64, complete bool, creator pubkey, is_mayhem_mode bool, is_cashback_coin bool, quote_mint pubkey, creator_fee_bps u64, can_edit_creator_fee bool, is_holder_reward bool, creator_fee u64, protocol_fees u64, depth u8, initial_virtual_quote_reserves u64, post_complete_base_out u64, post_complete_quote_in u64. Offsets: creator 49, quote_mint 83, depth 141. **The curve does not store its mint.** Curve PDA = `["bonding-curve", mint]`. A SOL-quoted curve stores the zero pubkey as quote_mint.
- Migrated curve: all four reserves zero (`isBondingCurveMigrated`). Pool = `canonicalPumpPoolPdaWithQuote(mint, normalizeQuoteMint(quoteMint))`; pool account has `pool_base_token_account`, `pool_quote_token_account` (vault balances give reserves).
- Events are emitted as `Program data: <base64>` log lines of the pump program. `CreateEvent` fields: name, symbol, uri, mint, bonding_curve, user, creator, timestamp, virtual_token_reserves, virtual_sol_reserves, real_token_reserves, token_total_supply, token_program, is_mayhem_mode, is_cashback_enabled, quote_mint, virtual_quote_reserves, creator_fee_bps, is_holder_reward, depth. `TradeEvent` has mint, is_buy, user, timestamp, token_amount, quote_amount, virtual_quote_reserves, virtual_token_reserves, real_quote_reserves, real_token_reserves, quote_mint, fee fields. `CompleteEvent` marks graduation.
- Multi-hop fees: the protocol fee is charged once on the hop that trades the user's own currency, the creator/holder fee once on the far-end coin, intermediate hops charge nothing. **Parent creators earn nothing from child trades on their own** — the upward flow is the fee-sharing config.
- Fee sharing (pump-fees): `create_fee_sharing_config` (creator signs; `pool` only if graduated) then `update_fee_shares_v2` (≤ 10 shareholders, bps sum 10 000, no duplicates, no zero shares). Updating sets `admin_revoked`, so it is effectively **once**. Payouts are in the coin's quote mint (parent tokens → shareholder ATAs). `distribute_creator_fees_v2` is permissionless.
- New coins are Token-2022 (`create_v2` uses TOKEN_2022). Older pump coins can be SPL Token; always take the token program from the mint account owner (`resolveQuoteMint` returns `quoteTokenProgram`).
- A child cannot be created while any coin on the chain is complete but not yet migrated (6107); mayhem coins cannot be parents (6100); depth over `maxCurveDepth` fails (6105).

## 3. SDK: `@pump-fun/pump-sdk` 4.1.0 (installed in both packages)

```ts
import { OnlinePumpSdk, PUMP_SDK, PUMP_PROGRAM_ID, PUMP_AMM_PROGRAM_ID, PUMP_FEE_PROGRAM_ID, GLOBAL_PDA,
  bondingCurvePda, canonicalPumpPoolPdaWithQuote, normalizeQuoteMint, isBondingCurveMigrated, isLegacyQuoteMint,
  feeSharingConfigPda, MAX_CURVE_DEPTH, multiHopRouteEnds, type MultiHopHop } from "@pump-fun/pump-sdk";
const online = new OnlinePumpSdk(connection);
await online.fetchGlobal();                       // maxCurveDepth, createV2Enabled, ...
await online.fetchSupportedQuoteMints();          // 212 listed mints: {mint, source: "sol"|"global"|"quoteControl", initialVirtualQuoteReserves}
await online.resolveQuoteMint(parentMint);        // {mint, source:"pumpCoin", quoteTokenProgram, decimals, initialVirtualQuoteReserves, pumpQuote:{curve, accounts, depth}} — throws typed errors when the parent is not eligible
await online.fetchPumpQuote(parentMint, {global}); // {curve:{mint,bondingCurve,pool?,chain:[...]}, accounts:{pool?, chain:[{mint,pool?}]}} — the parent chain nearest-first down to depth 0
PUMP_SDK.decodeBondingCurve(accountInfo); PUMP_SDK.decodeCreateEventBc(buf); PUMP_SDK.decodeTradeEventBc(buf); PUMP_SDK.decodeCompleteEventBc(buf); PUMP_SDK.decodeSharingConfig(accountInfo);
await PUMP_SDK.createV2Instruction({ mint, name, symbol, uri, creator, user, mayhemMode:false, quoteMint: parentMint, quoteTokenProgram, creatorFeeBps?, holderReward?, pumpQuote: resolved.pumpQuote.accounts });
await PUMP_SDK.createFeeSharingConfig({ creator, mint, pool: null });
await PUMP_SDK.updateFeeSharesV2({ authority: creator, mint, currentShareholders: [creator], newShareholders: [{address, shareBps}], quoteMint: parentMint, quoteTokenProgram, bondingCurveComplete: false });
await PUMP_SDK.multiHopSwapInstructions({ user, hops, side: "buy"|"sell", amountIn: BN, minAmountOut: BN }); // hops: [{venue:"pool"|"curve", baseMint, quoteMint, baseTokenProgram, quoteTokenProgram}] ordered from the user's currency outward; SOL hops use NATIVE_MINT + TOKEN_PROGRAM_ID
```
Source of truth for signatures: `node_modules/@pump-fun/pump-sdk/src/{sdk,onlineSdk,state,bondingCurve}.ts`. Read them before guessing.

## 4. Fee split (configurable, defaults — owner decision 2026-10-18: two shareholders)

| Shareholder | bps |
|---|---|
| child creator | 5000 |
| parent creator (`parent.BondingCurve.creator`) | 0 (env `SPLIT_BPS` can re-enable upward shares, e.g. `5000,2500,1000,1500`) |
| grandparent creator | 0 |
| platform (`PLATFORM_WALLET`, default `FcbEAMqBvJVsfcFWDbED7geyBLR88ypcY88BoUSgmeT5`) | 5000 |

Default `SPLIT_BPS=5000,0,0,5000`: exactly two shareholders (creator, platform), the same two-shareholder model other launchpads use on Solana. Zero slices are dropped before the program sees them.

Merge duplicates (self-spawn, platform-owned parent) by summing bps; never send duplicates or zero shares. The split is shown before signing and is immutable afterwards. `creatorFeeBps` stays default (0 = pump schedule) unless the user picks a custom one (≤ 300). Holder rewards off by default (a holder-reward coin's `creator` is a PDA and the fee split would not apply).

## 5. Repository layout

```
spore/
  DESIGN.md
  server/            Node 25 ESM. express + node:sqlite (built in; no native modules — node-gyp is unavailable on this machine)
    index.mjs        boots everything (indexer + API + static web/dist in production)
    lib/*.mjs        rpc.mjs, decode.mjs, indexer.mjs, pricing.mjs, db.mjs, api.mjs, events.mjs (SSE), meta.mjs (metadata + image cache)
    test/*.test.mjs  node --test; pure-logic tests must not need the network, network tests skip when SPORE_NET=0
    data/            sqlite file + image cache (gitignored)
  web/               Vite 8 + React 19 + TypeScript + wallet-adapter (deps installed; vite.config.ts proxies /api → :8793)
    src/main.tsx App.tsx styles.css pages/ components/ lib/api.ts lib/format.ts lib/pump/*
    test/*.mts       tsx scripts: build spawn + swap transactions and simulate them on mainnet (no sending)
```

Ports: API 8793, Vite dev 5174. Env (server): `PORT`, `RPC_URL` (default `https://api.mainnet-beta.solana.com`), `WS_URL` (default derived from RPC_URL: https→wss), `DATA_DIR`, `PLATFORM_WALLET`, `SPLIT_BPS` (default `5000,2500,1000,1500`), `REFRESH_MS` (30000), `BACKFILL` (1), `ORIGIN` (CORS allowlist, optional). The RPC key never reaches the browser: the web app talks only to `/api/*`, including an allow-listed JSON-RPC proxy at `POST /api/rpc`.

## 6. Server: indexer

1. **Backfill (once, resumable, persisted):** `getProgramAccounts(pump, filters: [disc BondingCurve, depth == d])` for d = 1..`maxCurveDepth` (full data). Decode. The curve has no mint, so resolve it with `getTokenAccountsByOwner(curve, {programId: TOKEN_2022})` (and SPL Token if empty): the account whose mint ≠ quote_mint is the coin's mint; the other is the quote ATA (its amount = raised parent tokens). Rate-limit (configurable concurrency, default 4; back off on 429). Record `backfill_state` in sqlite so a restart continues. Then add every ancestor (walk quote_mint until depth 0) so the tree is complete; ancestors at depth 0 are tracked for pricing only.
2. **Live:** `logsSubscribe({mentions:[pump]})` via WS_URL. Parse every `Program data:` line, match the 8-byte discriminator, decode `CreateEvent` (depth ≥ 1 → insert child with name/symbol/uri/creator/quote_mint/depth/timestamp; also insert the parent if unknown), `TradeEvent` for tracked mints (update reserves, insert a trade row, push SSE), `CompleteEvent` (mark complete). Reconnect with backoff; on reconnect run a refresh.
3. **Refresh loop (REFRESH_MS):** `getMultipleAccounts` in batches of 100 over all tracked curves → reserves/complete; for migrated coins read the canonical pool's two vault balances (`getMultipleAccounts` of the vault token accounts; decode SPL/Token-2022 token account amount at offset 64). SOL/USD from CoinGecko simple price every 60 s (fallback keep last). Metadata: Metaplex metadata PDA `["metadata", program, mint]` decoded (name, symbol, uri; borsh strings are u32-length-prefixed with trailing NULs) in batches; off-chain JSON fetched lazily with a 6 h cache for `image`, `description`, `twitter`, `telegram`, `website`.
4. **Pricing:** `priceQuote` = quote per 1 base token (curve: `virtualQuoteReserves / virtualTokenReserves` scaled by decimals — base coins have 6 decimals, quote decimals from the mint; pool: `quoteVault / baseVault`). `priceSol` = product of priceQuote up the chain to a SOL-quoted root; a USDC root uses 1 USD / solUsd; other listed quote mints → `priceSol = null`. `mcapUsd = priceUsd × tokenTotalSupply`. `lockedQuote` for a coin = Σ over children of (child.realQuoteReserves, or the child's pool quote-vault balance once migrated); `lockedUsd` uses the coin's own priceUsd. `descendants` = recursive child count. `progress` = curve progress 0..1 (`1 − realTokenReserves / initialRealTokenReserves`, 1 when complete).
5. **Trades table** keeps `TradeEvent`s seen live (sig, mint, slot, time, isBuy, user, baseAmount, quoteAmount, priceQuote) → 24 h volume and a price series for the chart (`/api/candles`). Keep at most 2 000 trades per mint.

## 7. Server: API contract (all JSON, all fields present, nulls allowed as typed)

```ts
type CoinRef = { mint: string; name: string | null; symbol: string | null; image: string | null; depth: number };
type Shares = { address: string; bps: number }[];
type Coin = {
  mint: string; name: string | null; symbol: string | null; image: string | null; description: string | null;
  twitter: string | null; telegram: string | null; website: string | null;
  creator: string; quoteMint: string | null /* null = SOL */; quoteSymbol: string /* "SOL" | "USDC" | parent symbol | short mint */;
  depth: number; parent: CoinRef | null; root: CoinRef | null; ancestors: CoinRef[] /* nearest first, excludes self */;
  complete: boolean; migrated: boolean; pool: string | null; createdAt: number | null; createdSlot: number | null;
  tokenProgram: string; decimals: number; totalSupply: string;
  priceQuote: number | null; priceSol: number | null; priceUsd: number | null; mcapSol: number | null; mcapUsd: number | null; progress: number;
  children: number; descendants: number; lockedQuote: string; lockedUsd: number | null; volume24hUsd: number; trades24h: number;
  holderReward: boolean; creatorFeeBps: number; shares: Shares | null; updatedAt: number;
};
type Stats = { coins: number; roots: number; byDepth: number[]; lockedUsd: number; volume24hUsd: number; solUsd: number | null; maxDepth: number; backfill: { done: boolean; total: number; resolved: number }; updatedAt: number };
type Trade = { sig: string; mint: string; slot: number; time: number; isBuy: boolean; user: string; baseAmount: string; quoteAmount: string; priceQuote: number; priceUsd: number | null };
type TreeNode = { coin: Coin; children: TreeNode[] };
type Eligibility = { ok: boolean; reason: string | null; depth: number | null; chain: CoinRef[]; parentCreator: string | null; grandparentCreator: string | null; shares: Shares; platform: string };
type Heat = { at: number /* unix s */; since: number /* at − 86400 */; mint: string[]; t1h: number[] /* trades in the last 3600 s */; n24: number[] /* trades 24 h */; v24: number[] /* USD 24 h, cents */; last: number[] /* unix s of the last trade */; buys1h: number[] }; // parallel arrays, one entry per mint

GET  /api/stats                            → Stats
GET  /api/feed?limit=50&before=<createdAt> → { coins: Coin[] }                  newest spawns (depth ≥ 1)
GET  /api/roots?sort=locked|children|new|volume&limit=50&offset=0 → { roots: Coin[] }  depth-0 coins that have children
GET  /api/coin/:mint                       → { coin: Coin; children: Coin[] /* sorted by lockedUsd desc */; trades: Trade[] /* last 50 */ }
                                             `?children=0` / `?trades=0` return `children: []` / `trades: []` (same shape, same coin; the map's side panel needs only the coin)
GET  /api/tree/:mint?depth=3               → TreeNode                                      rooted at :mint (ancestors in coin.ancestors)
GET  /api/candles/:mint?res=60             → { candles: { t: number; o: number; h: number; l: number; c: number; v: number }[]; priceKey: "usd"|"quote" }
                                             `&scope=all`: any tracked coin whatever the listing mode (404 "unknown mint" / "not tracked"); without it, unchanged
GET  /api/map/heat                         → Heat                                          every tracked coin with a trade in 24 h whatever the mode, t1h desc then v24 desc; max-age 15 + ETag (§11.5 Activity)
GET  /api/search?q=                        → { coins: Coin[] }                              name/symbol prefix or exact mint, max 20
GET  /api/eligibility/:mint                → Eligibility                                   can :mint be a parent right now (depth, mayhem, pending migration, exists) + the split preview for the connected user (`?creator=<pubkey>` merges duplicates)
GET  /api/events                           → SSE: `event: coin|trade|stats`, `data: <json>`; heartbeat comment every 15 s
GET  /api/img?u=<https url>                → cached image proxy (allowlist: ipfs.io, *.pinata.cloud, *.pump.fun, arweave.net, *.arweave.net, cf-ipfs.com, *.ipfs.*; max 4 MB; 24 h cache; 404 otherwise). Coin.image already points here.
POST /api/upload                           → { metadataUri } (pump.fun IPFS; body {name, symbol, description, image: dataURL, twitter, telegram, website}; copy the validation from ~/tldpad/app/server/index.mjs)
POST /api/rpc                              → allow-listed JSON-RPC proxy (getLatestBlockhash, sendTransaction, simulateTransaction, getSignatureStatuses, getBalance, getAccountInfo, getMultipleAccounts, getTokenAccountBalance, getTokenAccountsByOwner, getTokenSupply, getMinimumBalanceForRentExemption, getTransaction, getSlot, getBlockHeight, getBlockTime, getEpochInfo, isBlockhashValid, getRecentPrioritizationFees, getFeeForMessage, getHealth, getVersion, getAddressLookupTable, getProgramAccounts is NOT allowed)
```
Errors: `{ error: string }` with 4xx/5xx. Unknown mint → 404. Everything is CORS-same-origin in production (static build served by the server).

## 8. Web app

Routes: `/` Home (hero, live spawn feed via SSE, top roots, stats strip), `/explore` (root leaderboard with sort tabs + search), `/c/:mint` Coin (header with image/name/ticker/parent chain breadcrumbs, price/mcap/locked/progress, tree viz centered on this coin, children grid, trade widget, "Spawn under this coin" CTA, fee shares, creator links), `/spawn?parent=<mint>` Spawn (parent picker with search + eligibility, form name/ticker/image/description/socials, optional first buy in SOL, split preview, step-by-step progress, success screen with share links), `/how` (how it works, fees, depth limits, risks).

`lib/pump/` (owned by the transaction library, imported by pages):
```ts
export type Chain = { mint: string; quoteMint: string | null; tokenProgram: string; quoteTokenProgram: string; migrated: boolean; depth: number }[]; // self first, down to the depth-0 root
export function hopsFor(chain: Chain, side: "buy" | "sell"): MultiHopHop[];      // SOL → root → ... → coin (buy) or reverse (sell); only SOL-rooted chains are tradable here
export async function quoteSwap(conn: Connection, user: PublicKey, chain: Chain, side: "buy" | "sell", amountIn: bigint): Promise<{ amountOut: bigint; logs: string[]; unitsConsumed: number }>; // simulateTransaction with minAmountOut = 1, parse the final TradeEvent/BuyEvent from logs
export async function buildSwapTx(conn: Connection, user: PublicKey, chain: Chain, side: "buy" | "sell", amountIn: bigint, minAmountOut: bigint): Promise<VersionedTransaction>;
export type SpawnForm = { name: string; symbol: string; uri: string; creatorFeeBps?: number };
export async function buildSpawnTx(conn: Connection, creator: PublicKey, parentMint: PublicKey, form: SpawnForm, shares: { address: PublicKey; shareBps: number }[]): Promise<{ tx: VersionedTransaction; mint: Keypair; depth: number }>; // create_v2 (+ pumpQuote accounts) + create_fee_sharing_config + update_fee_shares_v2 in ONE v0 transaction; compute budget set; throws typed errors from resolveQuoteMint
export async function sendAndConfirm(conn: Connection, wallet: WalletContextState, tx: VersionedTransaction, extraSigners?: Keypair[]): Promise<string>; // poll-based confirm like ~/tldpad/app/web/src/lib/tx.ts (no websockets through the proxy)
```
If one transaction is too large (legacy limit 1232 bytes; v0 without a lookup table has the same byte limit), split into tx1 = create_v2, tx2 = fee sharing, and say so in the Spawn steps UI. Measure with `tx.serialize().length` in the simulation test and record the number in `web/test/README.md`.

Visual direction: dark, organic, premium. Palette: background `#07100b` → `#0b1a12`, surfaces glass `rgba(255,255,255,.04)` with 1px `rgba(182,255,92,.12)` borders, accent spore-lime `#b6ff5c`, secondary violet `#b08cff`, text `#e8f3e8` / muted `#8ea596`. Fonts: Geist + Geist Mono (Google Fonts, as in Handle). A full-screen canvas of slowly drifting glowing spores behind the hero (requestAnimationFrame, pauses when hidden, respects `prefers-reduced-motion`). Tree viz: d3-hierarchy radial tree in SVG with the centered coin in the middle, parents inward, children outward, node size by lockedUsd, coin images clipped in circles, hover tooltips, click navigates. Cards show coin image, name, ticker, parent ticker pill ("↳ under $PARENT"), depth badge, mcap, locked, age. Numbers formatted compactly (`$12.4K`, `1.2M`). Mobile-first responsive, 16px gutters, no horizontal scroll. Wallet buttons come from wallet-adapter (real wallet logos; never hand-drawn brand logos). Loading skeletons, empty states, error toasts. Light theme is not required.

## 9. Testing

- `server`: `node --test` pure tests for decoders (feed a real base64 `CreateEvent`/`TradeEvent` captured from mainnet into a fixture), pricing chain math, split merging, image allowlist. Network smoke (skipped with `SPORE_NET=0`): fetch one depth-2 curve and walk its chain.
- `web/test`: `npx tsx test/simulate.mts` builds (a) a spawn under a live depth-1 parent and (b) a SOL → depth-2 buy and a sell, simulates both on mainnet with `sigVerify:false, replaceRecentBlockhash:true` from a funded public wallet (`dBs75Gf7RXQMAsMLuTLYdH2fHV1ac9zgCEh6zC7TxXs`; it is a public key, nothing is signed or sent), and prints units consumed, serialized sizes, and the decoded result. Both must pass without "custom program error".
- `npm run typecheck` and `npm run build` in `web` must pass with zero errors.

## 10. Rules for everyone working in this repo

- No secrets, ever: no private keys, no RPC keys in source. Read `RPC_URL` from env. Never read `.env` files.
- Never send a transaction from tests or scripts. Simulation only. Launching a coin on mainnet happens only when the owner does it in the browser.
- Do not run `npm install` in `web` (deps are installed; `d3`, `lightweight-charts`, `bn.js`, `tsx` included). The server may add a dependency only if truly needed.
- Node 25: `node:sqlite` (`DatabaseSync`) is available; no native modules.
- Comments explain why, not what. Keep files focused; no 2 000-line files.

## 11. Launchpad rules (owner decisions, 2026-10-18)

**Spore is a launchpad, not a coin project.** Spore never launches coins itself; revenue is commission on other people's launches. The platform wallet is `FcbEAMqBvJVsfcFWDbED7geyBLR88ypcY88BoUSgmeT5` (env `PLATFORM_WALLET`).

### 11.1 "Ours only" (default `SHOW=ours`, env; `SHOW=all` restores the full pump.fun tree for development)
A coin is **ours** when its on-chain fee-sharing config gives the platform wallet at least `PLATFORM_MIN_BPS` (env, default = the platform slice of `SPLIT_BPS`, i.e. 5000; a config that merely lists the wallet at 1 bps does not count), or, for the first minutes after a spawn, when the UI reported it through `POST /api/spawned {mint, sig}` and the server verified the signature on-chain (`getTransaction`: a pump CreateEvent for that mint, a wallet creator, and a platform balance gain ≥ `LAUNCH_FEE_SOL`; self-launches by the platform wallet are exempt). Verified reports set the pending flag (TTL 10 min, map capped at 500) and persist `feePaid`; the indexer then confirms the sharing config and drops the flag if it never appears. Reports without a valid signature are refused (400; 404 + retry-after while the RPC has not seen it). Depth-0 roots launched here are ours too and appear in the feed. Every coin gets `ours: boolean`, `oursPending: boolean` and `feePaid: string|null` in the API.
In `ours` mode: `/api/feed`, `/api/stats`, `/api/roots`, `/api/map`, `/api/tree`, `/api/candles` and the `children` of `/api/coin` include only our coins; ancestors of our coins are served as context (`ours:false`, shown in breadcrumbs, the map and as the "root" of a cluster); roots are the depth-0 ancestors of our coins (one row per root, counts = our descendants only). `/api/search` and `/api/eligibility` keep covering all of pump.fun (anyone may spawn under any coin). `Stats` gains `{ mode: "ours"|"all", ourCoins, otherChildren }` so the UI can say "and N other children on pump.fun". The indexer keeps indexing the whole tree in both modes. The map's side panel charts any coin it draws through `/api/candles/:mint?scope=all` (the map is the all-scope surface, §11.5); without `scope` the defaults stay ours-only.
Empty states (nothing launched yet): Home/Explore/Map show a "No spawns yet — be the first" card with the Spawn CTA, never a broken layout.

**Client-side policy (security review 2026-10-18, finding #1):** the web bundle pins the platform wallet, the maximum launch fee (0.02 SOL) and the split (`web/src/lib/policy.ts`). `flow.ts` derives the shares with `splitShares` and refuses to build when the server's `shares` or `launchFee` differ (`PolicyError`, shown on the Launch page); the fee-split retry and the coin page's "Lock fee split" derive from the policy too, never from a stored record or the API. The server can explain and preview the split but cannot move money. Server side, `POST /api/spawned` accepts a CreateEvent only from the pump program's own log frame, requires the mint among the signers, and the self-launch exemption only when the platform wallet signed; the pending window is anchored to the transaction's block time.

### 11.5 The map shows everything, live (owner 2026-10-19: "anlık olsun ve mapte her şey gözüksün")

The Map page is the one surface that shows the **whole pump.fun custom-pair ecosystem** (every root with a tracked child and every descendant, ~15 k coins and growing), whatever the listing mode; Spore launches carry `ours: true` and a lime ring. Explore, feed, stats and roots stay ours-only.

**Server contract**
- `GET /api/map?scope=all&limit=all[&depth=2]` → `{ roots: MapNode[], scope: "all", version, generatedAt }` with **every** root and **every** descendant (no fan-out cap when `limit=all`); `limit=<n>` keeps the top-n behaviour. The all-tree is built at most once per 10 s (cached per model version), gzip/ETag as every JSON route; building it for 20 k nodes must stay under 300 ms (`mapRef` only, no `view()`).
- SSE `pair` (new): emitted for every coin the live stream sees whose parent is tracked (depth ≥ 1), in both modes, and again when a known child's parent becomes known during adopt/enrich (deduped per mint for 60 s). Payload `{ coin: MapCoin, parent: MapCoin }` (both `mapRef`), so a client can add the root when it is not drawn yet. `coin` keeps its ours-only semantics.
- SSE `mapdelta` (new): at most every 3 s, only when something changed: `{ at, updated: [{ mint, mcapUsd, lockedUsd, children, descendants, migrated }] }` for coins whose numbers moved (trades, refresh ticks, completes), capped at 500 entries per batch (largest lockedUsd first when capped). `trade` stays as is.
- Tests: all-tree route (shape, no cap, version), `pair` emission on a live CreateEvent with a tracked parent, `mapdelta` batching and cap.

**Web contract**
- Map page defaults to **everything** (`limit=all`); the roots control becomes all · top 200 · top 60 (URL-synced, `all` default on desktop; phones default to top 200 with "all" available, documented in the UI).
- Performance budget at 20 k nodes (headless Chrome, software raster, 1440×900): ≤ 16 ms per frame while settled, ≤ 33 ms while the layout settles, first paint of the bubbles within 2 s of the data arriving. How is an implementation choice (force simulation in a Web Worker with transferred Float32Array positions, or per-root `d3.pack` plus a cluster-level force) and must be written in a comment at the top of BubbleMap.tsx. Sprites cached, offscreen culling, labels only when zoomed in (cap 120 visible), hull glows only for the 60 largest clusters, no per-frame allocation in the draw loop.
- Live: `pair` inserts the child (and its root when absent) with the pulse animation and a local relaxation only (never a full restart); `mapdelta` tweens radius/values; `stats` updates the panel counters; the LIVE dot reflects the stream status. Pan/zoom/hover/click/search/`?focus=` keep working at full size; Esc clears.
- Verified by a CDP script in web/test (frame timings at full load, console errors = 0, screenshots at 1440 and 390, a synthetic `pair` event inserted through the EventSource mock or a real one observed).

**Owner feedback 2026-10-19 (must be met):** "opening the map lags a lot; does it re-request everything each time? Only the new ones should be added; and coin names and logos are sometimes missing."

**Delta sync + client cache (no full reload on every open)**
- Every coin row carries `updated_at` (ms); `GET /api/map?scope=all&limit=all&since=<ms>` returns only nodes with `updated_at > since` (each with its `parentMint`; the client already has the rest), plus `removed: []` (reserved), `generatedAt` and `total`. Without `since` the full tree comes back. Both variants ≤ 300 ms to build, cached 10 s.
- The web client persists the full node set **and the layout positions** in IndexedDB (key: node mint; store `generatedAt`), renders from the cache immediately on open (bubbles painted < 500 ms after navigation on a warm cache), then asks `since=<generatedAt>` and merges: new nodes are placed next to their parent and relaxed locally, changed values tween, nothing restarts. A cold cache does one full load. The cache survives reloads and republishes; a schema `v` bump clears it.
- Live `pair` / `mapdelta` events patch the same cache, so the next open is already current.

**Metadata coverage (names and logos must show)**
- On-chain name/symbol exist for 99.9 % of mints (`mints` table) and are what the map labels use; a bubble without off-chain metadata still shows its on-chain name. Never draw a nameless bubble when the mint has a name.
- Off-chain metadata (image, socials) is fetched for **every tracked coin** in both modes, not only in-scope ones: a background queue ordered by locked value / recency, concurrency 6, persisted in `meta`, retried with backoff (403/404/timeouts from one gateway are not final). IPFS URIs are tried through a gateway rotation (ipfs.io → dweb.link → gateway.pinata.cloud → w3s.link; cf-ipfs.com is dead) and the image proxy uses the same rotation for `ipfs://`/`/ipfs/` URLs. Target: ≥ 95 % of tracked coins with a resolved image within an hour of first sight; `/api/health.meta` reports coverage (`withImage/total`).
- Labels: the map draws the ticker label for every bubble whose on-screen radius ≥ 9 px (not only the largest), culls by overlap (cap 160 visible), shows the full name + ticker on hover/tap, and draws the logo whenever the image is loaded (letter avatar meanwhile, swapped in without a flicker when it arrives).
- Image re-check: `META_IMAGE_RULE` (lib/meta.mjs) versions the rule that decides which image URLs are usable. When the rule recorded in `kv.metaImageRule` (default 1) is older, the first sweep after boot treats every resolved row without an image as due whatever its age (usual order: locked value, then recency, so the largest roots come first), logs `meta: image recheck queued N` and records the new rule: once per rule change, never once per boot. Rows that have an image are never refetched by it and no TTL changes. Rule 2 (2026-10-19, any public https host) re-checked 5 204 rows and took tracked coins with a logo from 59.1 % to 94.6 % within six minutes of the first boot (NTRNDM, simulator and UHI among them). Bump the rule whenever it widens again. A restart before the queue drains leaves the rest to the regular 24 h no-image TTL.

**Activity (heat)**
- `lib/activity.mjs` keeps exact sliding windows per mint: trades and USD volume over the last 24 h, trades and buys over the last hour, and the last trade's time. A trade is an O(1) append to a time-ordered ring of typed arrays; two read heads (24 h and 1 h) walk forward as the clock moves and decrement the counters of what they leave behind, so nothing is allocated per trade and reads are free. A trade exactly 86 400 s (3 600 s) old is still inside, like SQL's `time >= now − 86400`. Only rows sqlite actually inserted are counted (`insertTrade` returns false for a replayed `(sig, mint, idx)`). Boot seeds the counters from `trades` (`time >= now − 86400` in time order: ~120 k rows in ~150 ms on a warm cache). A trade older than the newest one recorded is appended anyway; the window edges are then off by that skew.
- They replace the GROUP BY over 24 h of trades that every new trade invalidated (70–200 ms on the event loop, re-run by the next /api/stats or /api/coin after each of ~3–8 trades/s). `volume24hUsd`, `trades24h`, `Stats.volume24hUsd` and the roots' volume sort read `model.volumes()`, with the shape and meaning of `Db.volume24hAll()`.
- `GET /api/map/heat` (`Heat`, §7) serves them to the map as a sidecar of parallel arrays: every tracked coin with a trade in the last 24 h, whatever SHOW, most trades in the last hour first, then 24 h volume. It is rebuilt at most every 15 s (`HEAT_CACHE_MS`) and kept with its encoded bytes like the forest (`max-age=15`, ETag/304); about 60 KB gzipped for 1.5 k active mints, built in a few ms. It is a sidecar rather than part of `mapRef`/`since=` because the numbers decay with the clock without any row changing, so a delta keyed on `updated_at` could never carry them. The client polls it every 60 s while visible and advances its rows from the SSE `trade` stream in between.
- Caveat: the counters include trades the 2 000-rows-per-mint SQL trim later deletes, so a mint with more than 2 000 trades in 24 h reads higher than a SQL recount until the next restart re-seeds (2 010 against 2 000 for the busiest mint when measured).
- `/api/health.activity` = `{ mints, events, seededMs }`.
- The derived pass (`computed()`: prices, locked value, descendants) still runs once per model version, and every live trade moves the version. Its per-coin inputs are now memoized by coin object (an indexed coin object is never mutated) and the descendant counts by tree structure, which takes it from ~22–31 ms to ~12–13 ms at 16 k coins (same data, same machine) with identical output. Making it incremental is a later step.

**Map v2 (web, 2026-10-19)**
- Overview: the largest trees carry a title (`$ROOT · <coins>`) at overview zoom; hovering a cluster shows its root, coin count, locked value and largest children; clicking it frames the tree and selects its root.
- Spore launches are drawn as lime-ringed beacons of at least 4 px at any zoom.
- Trades draw ripples sized by log USD (a lime ring growing outward = buy, a pink ring shrinking inward = sell); a buy routed through the parent (same signature, child → parent) draws a comet along the link.
- Link dots move only on links whose child traded in the last 30 min (and on the hovered coin's links).
- Hull glows fade out between k = 0.6 and 1.6.
- Every camera move is a flight on the van Wijk zoom-and-pan path; the cold open snaps straight to fit.
- Highlight filters dim the coins that do not match and never remove them, so the layout stays: `?hl=ours,new1h,new24h,grad,min1k,active,since` (combined with AND); `?size=locked|mcap` picks the bubble area.
- Rails: New, Hot (trades in the last hour, from heat), Growing and Spore, plus a "since your last visit" count.
- Side panel: mcap, locked value, children and descendants come from the all-scope map node; price, volume, curve and socials from `/api/coin/:mint?children=0&trades=0`; the price sparkline from `/api/candles/:mint?scope=all`. Breadcrumb, Frame tree, sortable children list, Share and Copy CA. Search covers every node on the map and resolves pasted mints and pump.fun URLs, with a pump.fun fallback; arrow keys walk the tree; phones get measured insets and a peek/full bottom sheet.
- The client runs a full re-sync (no `since=`) when its last full load is older than 15 min. This bounds the USD drift of warm caches, because `since=` carries only the coins whose own row changed.
- Logo thumbnails are downsampled on the client (square, 64–256 px, LRU by pixel budget).
- A server without the heat sidecar or `scope=all` (404) degrades: the Hot rail, the "Traded 1h" filter and the sparkline are hidden.

**Owner commitment (2026-10-19):** the platform's 50 % share of creator fees is used to buy the Spore coin ($SPORE, to be launched by the owner) and lock it; the site says so on Home, Fees, How, Launch and the footer. X account: https://x.com/Sporemap (footer link).

### 11.7 Claim page

`/claim` (nav item "Claim"): connect a wallet → every indexed coin whose fee-sharing config names it, with the pending fees, the wallet's share and part, a Claim button per coin (same build → simulate → confirm → wallet flow as the coin-page card) and "Claim all" (sequential, one wallet approval each; a refusal stops the run). Below: the Spore launches with fees waiting, claimable by anyone (the signer pays the network fee, the program pays the shareholders).

- `GET /api/claims/:wallet` → `{ wallet, coins: [CoinRef & Fees & { yourBps, yourAmount, yourUsd }], totals: { usd, byQuote: [{ quoteMint, quoteSymbol, quoteDecimals, amount, usd }] }, updatedAt }`, max 100 coins, sorted by `yourUsd`; 400 on a malformed wallet.
- `GET /api/claims?limit=50` → the Spore launches with `total > 0`, sorted by `totalUsd`, cached 30 s.
- Both read fee accounts in batches (`Treasury.feesMany`, one getMultipleAccounts per 20 coins) through the 15 s per-mint cache `/api/fees` uses.

### 11.2 Launch fee
`LAUNCH_FEE_SOL` env (code default `0.02`; **production runs 0 since 2026-10-19 by owner decision: launching costs only network fees, Spore earns only through the 50% creator-fee share**; the web pins 0.02 as the maximum it will ever sign). `GET /api/eligibility/:mint` returns `launchFee: { to: string; lamports: string; sol: number }`. The web passes it to `buildSpawnTx(..., launchFee)` (lib/pump already adds a SystemProgram transfer to the platform inside the create transaction). The Spawn page shows a cost box before signing: launch fee, estimated network rent (~0.025 SOL: mint + curve + fee-sharing config + vault ATA) and the optional first buy, with the total. A fee of 0 hides the line.

### 11.3 Metadata hosting
pump.fun's `/api/ipfs` is retired (500 as of 2026-10-18). Metadata is self-hosted: `POST /api/upload` validates like before, then writes content-addressed files under `deploy/pages/public/m/` (`<sha256>.<ext>` image, `<sha256>.json` metadata `{name, symbol, description, image, showName:true, createdOn, twitter?, telegram?, website?}`) and publishes the directory to the Cloudflare Pages project `spore` (`tools/publish-meta.mjs` does exactly this; reuse its logic as a module, serialise deploys with a queue, one deploy may batch several uploads). Response stays `{ metadataUri }` with `https://spore-2x6.pages.dev/m/<hash>.json` (env `PAGES_DOMAIN`). The server also serves the same files locally at `/m/<name>` and resolves metadata/image URLs under `PAGES_DOMAIN` from the local directory first (this Mac's network cannot reach `*.pages.dev`; production servers can).

### 11.4 Infrastructure owned by the platform wallet (2026-10-18)
- Address lookup table `5WK4tafybAnHV4grvSipYfLfV8Bd7Rzcwb5eNE1PQRnx`: 56 static pump/pump-amm/pump-fees accounts, created and **frozen** (no authority) by the platform wallet with `web/tools/create-alt.mts`; `web/src/lib/pump/alt.ts` points at it. With it: spawn 954 B, fee split 720 B, 3-hop buy 905 B, 2-hop sell 762 B.
- Treasury: `web/tools/treasury.mts` (`list` / `claim --send` / `sell <mint> --send`) scans the pump-fees program for sharing configs that pay the platform (shareholder at byte 114, or 80 when merged), sums the curve bucket + creator vault + AMM vault, and distributes with `sweep_creator_fee` → (`sweep_creator_fee` on the pool + `transfer_creator_fees_to_pump_v2` when migrated) → `distribute_creator_fees_v2(initialize_ata=true)`. Rehearsed in simulation on three live coins of another launchpad (curve/token quote, curve/SOL quote, migrated pool). A scheduled claim (server keeper) is the natural next step.
- Metadata publisher: `tools/publish-meta.mjs` + Cloudflare Pages project `spore` (`spore-2x6.pages.dev`).

### 11.6 Claim fees (owner 2026-10-19: "a claim-fee action on every coin page, like other launchpads")

**Mechanics (pump.fun).** A coin's creator fee waits in up to four places: the bonding curve's `creatorFee` bucket (unswept trades before migration), the pump-amm pool's `creator_fees` bucket (unswept trades after it), the fee-sharing config's **creator vault** (SOL as lamports on the vault PDA above its rent floor, `rent.minimum_balance(0)` = 650 240 lamports on mainnet today; a token-quoted coin's fees in the vault's ATA for the quote mint) and, once migrated, the **AMM creator vault** (a token account of the quote mint, WSOL for a SOL-quoted pool — never lamports on the PDA). Distribution is **permissionless**: anyone pays the transaction that sweeps the buckets into the vault and runs `distribute_creator_fees_v2`, which pays every shareholder of the sharing config in the coin's quote (SOL or the parent token). Order of instructions (as `web/tools/treasury.mts claim` does it): `sweep_creator_fee` on the curve when its bucket > 0 → when migrated, `sweep_creator_fee` on the pool + `transfer_creator_fees_to_pump_v2` → `distribute_creator_fees_v2(initialize_ata = true)` with the sharing config's shareholders as remaining accounts. Coins without a sharing config (`shares: null`) and holder-reward coins have nothing to claim through this path. The program's own minimum (`get_minimum_distributable_fee`) is decided by the browser's preflight simulation, not by the server.

**Server contract**
- `GET /api/fees/:mint` → `{ mint, quoteMint, quoteSymbol, quoteDecimals, quoteUsd, shares: [{ address, bps }] | null, bucket, vault, amm, total, totalUsd, perShare: [{ address, bps, amount }], migrated, claimable: boolean, reason: string | null, updatedAt }`. `bucket`, `vault`, `amm`, `total` and every `amount` are raw quote units as decimal strings (`quoteMint` null = SOL, 9 decimals); `amm` = AMM vault ATA balance + the pool's unswept bucket; `vault` for SOL is what sits above the rent floor; `perShare[i].amount = floor(total × bps / 10 000)`. `shares` is the on-chain config read live (a config the indexer has not fetched yet is adopted into the model, so the coin becomes provably ours at once); `claimable` is false with one `reason` for a holder-reward coin, a coin without a config, or `total == 0`. The five accounts (curve, vault, AMM vault ATA, canonical pool, sharing config) are read in one `getMultipleAccounts` on the api RPC lane; cached 15 s per mint (concurrent callers share the read, a failed refresh serves the last value); rate limited like every api route; ETag + `max-age=5` like `/api/coin`; 400 for a malformed mint, 404 for a mint pump.fun does not know (an unknown one is looked up live first, like `/api/coin`), 503 when the RPC is unreachable and nothing is cached. The same per-coin reader (`lib/treasury.mjs`: `feeAccounts` + `feeBalances`) feeds `/api/treasury`, so the platform view counts migrated SOL coins' WSOL vaults too.
- A refetch right after a claim lands may still return the cached numbers for up to 15 s: the page polls until `updatedAt` moves (or shows the Solscan link and refreshes on the next tick).

**Web contract**
- `web/src/lib/pump/claim.ts`: `buildClaimTx(conn, payer, mint) → VersionedTransaction` (sweep the curve bucket when > 0, sweep the pool vault when migrated, `distribute_creator_fees_v2`), compiled v0 with the Spore lookup table (`alt.ts`), ≤ 1 232 bytes, for **any** connected wallet as payer; `simulate.ts` preflight before the wallet signs, `send.ts` to send.
- Coin page card **"Creator fees"**: pending total in quote + USD, the split rows with each shareholder's amount (the connected wallet's row marked "you"), a **Claim** button → preflight simulation (shows the network fee) → wallet → toast with the Solscan link → refetch. Disabled states with one reason each: no wallet, nothing to claim (below the program's minimum), no sharing config (then the existing fee-split action is shown instead), holder-reward coin. A small "fees to claim" chip on coin cards and feed rows when `total > 0` is optional.
