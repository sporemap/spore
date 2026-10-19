# Web tests: mainnet simulations + the dry-run launch flow

Nothing here signs or sends. Transactions are built exactly as the app builds them and run through
`simulateTransaction` with `sigVerify: false` and `replaceRecentBlockhash: true`, from real public
wallets that can never be charged by a simulation.

```sh
# the pump SDK's ESM build does not load under Node; the hook serves its CommonJS build instead
node --import ./test/cjs-sdk-hook.mjs --import tsx test/simulate.mts [parentMint] [buyCoin] [splitSubject] [sellCoin] [sellHolder] [tradeThenSplitRoot] [wsolHolder] [wsolCoin] [claimSolCoin] [claimTokenCoin]
npx tsx --test test/shares.test.mts

# end-to-end launch in the real page (dry mode), against a dev server on :5191 with the SHOW=all API
API_PORT=8794 npx vite --port 5191 --strictPort &
SHOT_DIR=/tmp/spore-e2e node --import tsx test/e2e-launch.mts both      # desktop | mobile | both
```

## simulate.mts — measured 2026-10-18 (public RPC, lookup table 5WK4tafybAnHV4grvSipYfLfV8Bd7Rzcwb5eNE1PQRnx, Spore's own, frozen)

| Flow | Subject | Bytes | Accounts | Compute units | Result |
|---|---|---|---|---|---|
| spawn: create_v2 under a depth-1 parent (child depth 2), split in a second tx | parent 8M8hAuus…pump, payer dBs75…TxXs | 954 (+ 837 for the second tx: sweep + vault ATA + config + split) | 18 | ~150–165k | ok |
| root launch: create_v2 (SOL) + 0.02 SOL launch fee + fee split, one tx | payer dBs75…TxXs | 1024 | 16 | ~241–251k | ok |
| fee split: sweep_creator_fee + vault ATA + create_fee_sharing_config + update_fee_shares_v2 | 2uprf2a8…pump, signer = its creator | 871 | 17 | 192k | ok ("Nothing to sweep": the empty sweep costs no rent) |
| fee split on a migrated coin: curve sweep + pool sweep + config with pool + split with pool | 8wa1G6GN…, Hukxg44m…, 83Yup6Y5… (depth 1, graduated, no config), signer = creator | 1055 | — | 274k–325k | ok (budget 450k) |
| trade, then split in ONE tx, no sweep: multi_hop_swap buy 0.001 SOL by the probe, then config + split by the creator | root 9L4yqKhJ…pump ('Lamport', depth 0, no config) | 1053 | 19 | 215k | **6095 CreatorFeesNotSwept, expected** |
| trade, then sweep + config + split in one tx | same | 1172 | 22 | 360k | ok |
| multi-hop buy, 3 hops (curve → curve → pool), 0.01 SOL | GtsYUp4G…pump (depth 2) | 905 | 20 | 196k | ok, 55.6M tokens, = SDK `simulateMultiHopSwap` |
| multi-hop sell, 2 hops (pool → pool), 1 000 tokens | 3ZvEeeLx…pump, signer = holder 2orGyHSp… | 762 | 16 | 118k | ok, = SDK reference |
| multi-hop sell by a holder with a funded WSOL account (7.33 SOL wrapped), 1 000 tokens, 1% slippage | BsbsB3WL…pump ($GTA, pool), signer = holder H9kuqGKN… | 629 | 12 | 67k | ok, quote 0.013412751 SOL = SDK reference, `unwrapped` = the account's lamports |
| claim creator fees (§11.6), migrated SOL root: pump-amm pool sweep + transfer_creator_fees_to_pump_v2 + distribute_creator_fees_v2 (2026-10-19) | $SPORE HfzNFxar…wJTJY (config = platform 100%), payer = probe dBs75…TxXs (not a shareholder) | 684 | 14 | 109k | ok, event: 5.179 SOL distributed, 100% to the platform; the vault's 650 240-lamport rent floor stays behind; payer spends 17 500 lamports (fees only) |
| claim creator fees, live child quoted in $SPORE: curve sweep + distribute_creator_fees_v2 (creates the creator's missing $SPORE ATA) | $SPCAT 75Waoewr…fGaU (creator 50 / platform 50), payer = probe | 663 | 14 | 112k | ok, event: 417 817.09 $SPORE distributed, 208 908.55 each; payer spends ~0.0015 SOL (one Token-2022 ATA + fees) |

Without the lookup table the 3-hop buy is 1,245 bytes and create + fee split together cannot be
encoded at all, which is why `buildSpawnTx` returns the split as a second transaction (`feeTx`)
when it does not fit. Holders sell: when the sell test says "could not find account", pick a recent
buyer from `/api/coin/3ZvEeeLx…/trades` and pass it as the fifth argument (done 2026-10-18, the
previous holder DvFZ1iuU… had emptied its account).

`shares.test.mts`: 6 pure tests of the split merging (duplicates, zero slices, missing ancestors).

## e2e-launch.mts — the launch page end to end, nothing on-chain

Headless Chrome over the DevTools protocol (like `tools/shot.mjs`) opens `/launch?dry=1`, fills the
form the way a user would (native value setters + input/focusout events, a 700×460 PNG drawn in
the page handed to the file input), presses Launch and waits for the success screen. In dry mode
(`lib/dry.ts`, development builds only: `import.meta.env.DEV` is a build-time constant, so
`isDry()` compiles to `() => false` in production and `window.sporeDry` is never created):

- the upload is skipped for a fixed https metadata URI;
- the wallet is `window.sporeTestWallet`, a shim `{ publicKey, signTransaction }` built from a
  throwaway `Keypair` generated in the page. It presents the funded public wallet
  `dBs75Gf7…TxXs` as payer because a simulation needs a payer with SOL (a fresh key has none and
  fails at the fee payer before any program runs); with `sigVerify: false` no signature is checked,
  and nothing is ever signed for real;
- every `send` becomes `simulateTransaction(sigVerify:false, replaceRecentBlockhash:true)`; the
  result is appended to `window.sporeDry.log` and a signature-shaped `dry…` marker stands in for
  the real one (no explorer link);
- `POST /api/spawned` and the localStorage record are skipped, so the dev index is not polluted;
- the first buy is quoted with pump's curve math (`estimateFirstBuy`) and not simulated, because
  the curve only exists after a real launch; a second fee-split transaction (needed when create +
  split do not fit 1232 bytes) is built and measured but recorded as `skipped` for the same reason —
  `simulate.mts` validates that builder on an existing coin.

The test asserts: the ticker was upper-cased, `@spore_e2e` became `https://x.com/spore_e2e`, the
image was cropped/resized to 512×512, the success screen appeared, and every entry of
`window.sporeDry.log` passed (`launch` present, no failures). A third scenario injects a persisted
mid-flight launch into localStorage and checks that the Resume card renders with "Finish the fee
split". Screenshots (`<flow>-<mode>-1-filled`, `-2-steps`, `-3-success`, `resume-<mode>`) go to `SHOT_DIR`.

Results 2026-10-18 (dev server on :5191 → API :8794 in SHOW=all; public RPC through `/api/rpc`):

| Scenario | Create tx | Simulation | Steps |
|---|---|---|---|
| SOL root, desktop + mobile, 0.05 SOL first buy | 1035 bytes, one tx (create + 0.02 SOL fee + split) | ok, ~258–261k CU, payer spends 0.0315 SOL | 7/7 done; first buy ≈ 1,763,352 tokens |
| child under BsbsB3WL…pump ($GTA, depth 0 → child depth 1), desktop + mobile | 912 bytes create; split 720 bytes in a second tx | create ok, ~149–155k CU, 0.0271 SOL; split built, skipped (needs the real mint) | 7/7 done; first buy ≈ 1,966,899 tokens |
| resume card from a persisted record | — | — | card shown with "Finish the fee split" |

Each scenario takes 3–20 s; the public RPC rate limit is the variance.

## What the simulations taught the builders

- `update_fee_shares_v2` distributes pending fees through the sharing config's creator vault and
  reads the vault's quote token account. On a fresh config it does not exist (`InvalidAccountData`),
  so the builders create it idempotently first (`vaultAtaIx`). Shareholder token accounts are not
  needed at this point; the permissionless `distribute_creator_fees_v2` creates them later.
- Holder-reward coins have a PDA as creator, so no wallet can ever sign their fee split; Spore
  spawns with holder rewards off.
- The public RPC refuses `getTokenLargestAccounts` ("Too many requests for a specific RPC call"),
  so the sell test takes the holder as an argument.
- `createV2` with a pump-coin quote needs the parent chain's curves (and pools once migrated) as
  remaining accounts; `OnlinePumpSdk.resolveQuoteMint` collects them and the depth.
- A pre-flight simulation with `accounts: [payer]` returns the payer's post-state, so the exact
  cost of a signature (rent + fees + launch fee) is known before the wallet opens
  (`lib/pump/simulate.ts → preflight`): 0.0315 SOL for a root launch with the 0.02 SOL fee.
- Vite's dev server binds `localhost` (::1 here); `127.0.0.1` is refused, so the e2e uses `localhost`.
- pump refuses `create_fee_sharing_config` (its `MigrateBondingCurveCreator` CPI) and `update_fee_shares_v2`
  while the curve's creator-fee bucket is nonzero: 6095 `CreatorFeesNotSwept`. Any trade between the
  create and a split sent later fills that bucket, which is exactly the window of a two-transaction
  spawn (wallet popup + confirmation) and of every "Lock fee split" retry. Measured 2026-10-18 on
  live coins with un-swept fees (NFV8jyFZ…, 88wbHmq3…) and reproduced in one transaction (the
  trade-then-split rows above). Every split therefore starts with `sweep_creator_fee` for the
  curve's current creator; with an empty bucket the instruction logs "Nothing to sweep" and costs
  only its compute (29k CU, no rent). `buildFeeSplitTx` reads the curve first: the sweep pays the
  creator it finds there, a complete curve gets its pool in the share update whatever the caller
  passed, and a migrated coin also gets the pool in the config and a pump-amm pool sweep.
- Claiming (§11.6, `lib/pump/claim.ts`) is permissionless: the probe wallet, which holds no share
  of either coin, built and simulated both payouts; the program pays the sharing config's wallets
  whoever signs. A SOL vault keeps a rent floor the distribution leaves behind (650 240 lamports on
  $SPORE: the API's `vault` figure includes it, the event's `distributed` does not), so the card's
  pending total can exceed the payout by that much on a SOL coin. On a migrated coin the fees sit
  in the pool's own `creator_fees` bucket (pool bytes 279..287) and the AMM creator vault's quote
  ATA (wrapped SOL for a SOL pool), which `transfer_creator_fees_to_pump_v2` unwraps into the
  pump vault; `readClaimState` sums both as `amm`. The curve sweep stays in the claim whenever the
  curve is still live even when its bucket reads 0 (the same race as the fee split: a trade
  between the read and the signature would make the distribution fail 6095), and is left out only
  on a migrated curve with an empty bucket. A token-quoted distribution creates a shareholder's
  missing ATA at the payer's cost (`shouldInitializeAta`), which `preflight`'s `spent` reports.
- A multi-hop route whose input or output is SOL creates the user's WSOL ATA idempotently and
  closes it at the end. If that account already existed, its rent and wrapped balance pour into the
  wallet in the same transaction: measured 2026-10-18, a 1 000-token $GTA sell by a holder with
  7.33 SOL wrapped "quoted" 7.347 SOL where the real output is 0.013 SOL, and a $SURGE sell by
  another such holder 6.766 SOL for 0.000276 SOL. `quoteSwap` now reads that account before and
  after the simulation so the quote equals the hop output `min_amount_out` is checked against (equal
  to the lamport to the SDK's `simulateMultiHopSwap`), and reports the closed account's lamports
  as `unwrapped` so the UI can warn that wrapped SOL gets unwrapped as a side effect.
