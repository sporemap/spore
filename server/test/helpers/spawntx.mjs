// A launch transaction for the verifier tests, built from the real create transaction captured in
// fixtures/tx-create.json (pump.fun mainnet, 2026-10-18). The CreateEvent bytes are real; the
// helper only rewrites the mint and the creator inside them (the fixture coin was launched through
// another launchpad whose creator is a program address, so a wallet creator is substituted by
// default) and appends the platform wallet with a balance change, so each rule of lib/spawned.mjs
// is exercised on genuine data.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PublicKey } from "../../lib/sdk.mjs";
import { decodeEvent, eventsInLogs } from "../../lib/decode.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const FIXTURE = JSON.parse(readFileSync(join(here, "../fixtures/tx-create.json"), "utf8"));
export const FIXTURE_EVENT = decodeEvent("CreateEvent", eventsInLogs(FIXTURE.tx.meta.logMessages).find((e) => e.name === "CreateEvent").data);

const PROGRAM_DATA = "Program data: ";
const replaceKey = (buf, from, to) => {
  const i = buf.indexOf(new PublicKey(from).toBuffer());
  if (i < 0) throw new Error(`${from} not in event`);
  new PublicKey(to).toBuffer().copy(buf, i);
};

/** A wallet (on the ed25519 curve) that signs launches in these tests: the real default platform address, never a test platform. */
export const WALLET = "FcbEAMqBvJVsfcFWDbED7geyBLR88ypcY88BoUSgmeT5";

/**
 * A copy of the fixture transaction whose CreateEvent names `mint` and `creator` (a wallet by
 * default), with `platform` appended as an account that gained `fee` lamports (or none when
 * `fee` is null).
 */
export function createTxFor({ mint, creator = WALLET, platform = null, fee = null, err = null } = {}) {
  const tx = structuredClone(FIXTURE.tx);
  tx.blockTime = Math.floor(Date.now() / 1000) - 20; // a report arrives seconds after the create; the pending window is anchored to this
  tx.meta.logMessages = tx.meta.logMessages.map((line) => {
    if (!line.startsWith(PROGRAM_DATA)) return line;
    const buf = Buffer.from(line.slice(PROGRAM_DATA.length), "base64");
    if (mint && mint !== FIXTURE.mint) replaceKey(buf, FIXTURE.mint, mint);
    if (creator) replaceKey(buf, FIXTURE_EVENT.creator, creator);
    return PROGRAM_DATA + buf.toString("base64");
  });
  // A genuine create has the mint among the signers and the creator paying: keep that true for the
  // substituted keys (static keys 0..numRequiredSignatures-1 are the signers).
  const keys = tx.transaction.message.accountKeys;
  if (mint && mint !== FIXTURE.mint) { const i = keys.indexOf(FIXTURE.mint); if (i >= 0) keys[i] = mint; }
  if (creator) keys[0] = creator;
  if (platform && fee != null) {
    tx.transaction.message.accountKeys.push(platform);
    tx.meta.preBalances.push(1_000_000);
    tx.meta.postBalances.push(1_000_000 + Number(fee));
  }
  if (err) tx.meta.err = err;
  return tx;
}
