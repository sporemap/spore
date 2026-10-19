// Spore's on-chain library: everything the pages need to spawn, buy and sell. Browser-safe; the
// same code runs under node for the mainnet simulation tests in web/test.
export { splitShares, DEFAULT_SPLIT_BPS, type Share } from "./shares";
export { hopsFor, isSolRooted, type Chain, type ChainLink, type Side } from "./route";
export { quoteSwap, buildSwapTx, explainSimulationError, compileV0, txBytes, MAX_TX_BYTES, type Quote } from "./trade";
export { buildSpawnTx, buildFeeSplitTx, type SpawnForm, type SpawnBuild, type LaunchFee } from "./spawn";
export { LOOKUP_TABLE, lookupTables } from "./alt";
export { sendAndConfirm, confirm, signatureState, ExpiredError, UnconfirmedError } from "./send";
export { preflight, SimulationError, type Preflight } from "./simulate";
export { estimateFirstBuy, type FirstBuyEstimate } from "./estimate";
