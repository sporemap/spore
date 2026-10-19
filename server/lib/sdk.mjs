// Single entry point for the pump SDK and the Solana libraries it is built on.
//
// Loaded through CommonJS on purpose: the SDK's ESM build pulls in
// @pump-fun/agent-payments-sdk, whose ESM bundle does `import { BN } from "@coral-xyz/anchor"`
// against a CommonJS package. Node's ESM loader cannot see that named export and refuses the
// whole import graph, while the CommonJS build of the same code resolves cleanly.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

// bigint-buffer prints "Failed to load bindings, pure JS will be used" once at require time
// because no native module can be built on this machine (node-gyp is unavailable). The pure JS
// path is correct, so the warning is noise; it is muted only for the duration of the require.
const warn = console.warn;
console.warn = (...args) => { if (!String(args[0]).startsWith("bigint: Failed to load bindings")) warn(...args); };
const sdk = require("@pump-fun/pump-sdk");
const web3 = require("@solana/web3.js");
const splToken = require("@solana/spl-token");
const anchor = require("@coral-xyz/anchor");
console.warn = warn;

export const BN = anchor.BN;

export const {
  PUMP_SDK, pumpIdl,
  PUMP_PROGRAM_ID, PUMP_AMM_PROGRAM_ID, PUMP_FEE_PROGRAM_ID,
  GLOBAL_PDA, QUOTE_CONTROL_PDA,
  bondingCurvePda, canonicalPumpPoolPdaWithQuote, feeSharingConfigPda, creatorVaultPda, ammCreatorVaultPda,
  normalizeQuoteMint, isLegacyQuoteMint, isBondingCurveMigrated,
  MAX_CURVE_DEPTH, pumpQuoteReserves,
  CurveDepthExceededError, QuoteBondingCurveNotEligibleError, QuoteCurveAwaitingMigrationError,
  QuoteReservesOutOfRangeError, UnsupportedQuoteMintError, QuotePoolNotFoundError,
} = sdk;

export const { PublicKey, VersionedTransaction } = web3;
export const { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, NATIVE_MINT, getAssociatedTokenAddressSync } = splToken;
export const METAPLEX_PROGRAM_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

/** The vendored pump-amm IDL: not on the package's export map, so it is read from its source tree. */
// The export map hides everything but the entry points, so the package root is found from the
// resolved entry (`dist/index.js`) and the IDL is read from its `src/idl/` tree.
export const PUMP_SDK_DIR = join(dirname(require.resolve("@pump-fun/pump-sdk")), "..");
export const pumpAmmIdl = JSON.parse(readFileSync(join(PUMP_SDK_DIR, "src/idl/pump_amm.json"), "utf8"));

export const b58 = (k) => (k instanceof PublicKey ? k.toBase58() : k == null ? null : String(k));
export const pk = (s) => (s instanceof PublicKey ? s : new PublicKey(s));

/** Metaplex token-metadata PDA for a mint (`["metadata", program, mint]`). */
export const metaplexPda = (mint) => PublicKey.findProgramAddressSync([Buffer.from("metadata"), METAPLEX_PROGRAM_ID.toBuffer(), pk(mint).toBuffer()], METAPLEX_PROGRAM_ID)[0];
