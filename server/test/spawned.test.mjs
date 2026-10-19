// The spawn verifier (lib/spawned.mjs) on real bytes: a mainnet create transaction, patched per
// case (fixtures/tx-create.json via helpers/spawntx.mjs). No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PublicKey, PUMP_PROGRAM_ID } from "../lib/sdk.mjs";
import { verifySpawnTx, balanceDeltaOf, accountKeysOf } from "../lib/spawned.mjs";
import { createTxFor, FIXTURE, FIXTURE_EVENT, WALLET } from "./helpers/spawntx.mjs";
import { K, PLATFORM } from "./helpers/tree.mjs";

const FEE = 20_000_000n;

test("the mainnet create (with a wallet creator) passes with no fee configured and is refused when a fee is expected", () => {
  const tx = createTxFor({ mint: FIXTURE.mint });
  const ok = verifySpawnTx(tx, { mint: FIXTURE.mint, platformWallet: PLATFORM, feeLamports: 0n });
  assert.equal(ok.ok, true, ok.reason); assert.equal(ok.feePaid, 0n); assert.equal(ok.create.mint, FIXTURE.mint); assert.equal(ok.create.symbol, "ponzi"); assert.equal(ok.create.depth, 2); assert.equal(ok.create.creator, WALLET);
  assert.equal(ok.slot, FIXTURE.tx.slot); assert.equal(ok.blockTime, tx.blockTime);
  const no = verifySpawnTx(tx, { mint: FIXTURE.mint, platformWallet: PLATFORM, feeLamports: FEE });
  assert.equal(no.ok, false); assert.match(no.reason, /launch fee not paid: the platform received 0 of 20000000/);
  // The untouched fixture: its creator is a program address (launched through another launchpad), which the verifier refuses.
  const raw = verifySpawnTx(FIXTURE.tx, { mint: FIXTURE.mint, platformWallet: PLATFORM, feeLamports: 0n });
  assert.equal(raw.ok, false); assert.match(raw.reason, /program address/);
});

test("the launch fee is read from the platform wallet's balance change, in balance order (static keys, then loaded addresses)", () => {
  const paid = verifySpawnTx(createTxFor({ mint: K.X, platform: PLATFORM, fee: FEE }), { mint: K.X, platformWallet: PLATFORM, feeLamports: FEE });
  assert.equal(paid.ok, true); assert.equal(paid.feePaid, FEE); assert.equal(paid.create.mint, K.X);
  const short = verifySpawnTx(createTxFor({ mint: K.X, platform: PLATFORM, fee: FEE - 1n }), { mint: K.X, platformWallet: PLATFORM, feeLamports: FEE });
  assert.equal(short.ok, false); assert.match(short.reason, /received 19999999 of 20000000/);
  // The platform among the lookup-table-loaded addresses: same index arithmetic.
  const loaded = createTxFor({ mint: K.X });
  loaded.meta.loadedAddresses = { writable: [PLATFORM], readonly: [] };
  loaded.meta.preBalances.push(5); loaded.meta.postBalances.push(5 + Number(FEE));
  assert.equal(accountKeysOf(loaded).at(-1), PLATFORM);
  assert.equal(balanceDeltaOf(loaded, PLATFORM), FEE);
  assert.equal(verifySpawnTx(loaded, { mint: K.X, platformWallet: PLATFORM, feeLamports: FEE }).ok, true);
  assert.equal(balanceDeltaOf(loaded, K.U), 0n, "an account outside the transaction gained nothing");
});

test("refused: another mint, a failed transaction, a missing transaction, a program-derived creator", () => {
  const other = verifySpawnTx(createTxFor({ mint: K.X, platform: PLATFORM, fee: FEE }), { mint: K.U, platformWallet: PLATFORM, feeLamports: FEE });
  assert.equal(other.ok, false); assert.match(other.reason, /no pump.fun create of this mint/);
  const failed = verifySpawnTx(createTxFor({ mint: K.X, platform: PLATFORM, fee: FEE, err: { InstructionError: [2, "Custom"] } }), { mint: K.X, platformWallet: PLATFORM, feeLamports: FEE });
  assert.equal(failed.ok, false); assert.match(failed.reason, /failed on-chain/);
  const missing = verifySpawnTx(null, { mint: K.X, platformWallet: PLATFORM, feeLamports: FEE });
  assert.equal(missing.ok, false); assert.equal(missing.notFound, true);
  const pda = PublicKey.findProgramAddressSync([Buffer.from("holder-rewards")], PUMP_PROGRAM_ID)[0].toBase58();
  const prog = verifySpawnTx(createTxFor({ mint: K.X, creator: pda, platform: PLATFORM, fee: FEE }), { mint: K.X, platformWallet: PLATFORM, feeLamports: FEE });
  assert.equal(prog.ok, false); assert.match(prog.reason, /program address/);
  assert.equal(PublicKey.isOnCurve(new PublicKey(FIXTURE_EVENT.creator).toBytes()), false, "the fixture creator really is a program address");
  assert.equal(PublicKey.isOnCurve(new PublicKey(WALLET).toBytes()), true);
});

test("a CreateEvent logged by a foreign program is ignored; the self-launch exemption needs the platform's signature", () => {
  const forged = createTxFor({ mint: K.X, platform: PLATFORM, fee: FEE });
  // Move every pump "Program data:" line into a frame of a made-up program: same bytes, wrong emitter.
  const logs = forged.tx ? forged.tx.meta.logMessages : forged.meta.logMessages;
  const fake = "Fake1111111111111111111111111111111111111111";
  const moved = [];
  for (const line of logs) {
    if (line.startsWith("Program data: ")) moved.push(`Program ${fake} invoke [1]`, line, `Program ${fake} success`);
    else if (!line.startsWith("Program data: ")) moved.push(line);
  }
  (forged.tx ? forged.tx.meta : forged.meta).logMessages = moved.filter((l, i, a) => !(l.startsWith("Program data: ") && a[i - 1]?.startsWith(`Program ${fake}`) === false));
  const v = verifySpawnTx(forged, { mint: K.X, platformWallet: PLATFORM, feeLamports: FEE });
  assert.equal(v.ok, false);
  assert.match(v.reason, /no pump.fun create/);
  // creator = platform but the platform never signed → the fee is owed like anyone else's
  const notSigned = createTxFor({ mint: K.X, creator: PLATFORM });
  notSigned.transaction.message.accountKeys[0] = WALLET; // someone else paid and signed
  const w = verifySpawnTx(notSigned, { mint: K.X, platformWallet: PLATFORM, feeLamports: FEE });
  assert.equal(w.ok, false);
  assert.match(w.reason, /launch fee not paid/);
  // and a create whose mint did not sign is not a create
  const noMintSig = createTxFor({ mint: K.X, platform: PLATFORM, fee: FEE });
  noMintSig.transaction.message.accountKeys[1] = K.U;
  const m = verifySpawnTx(noMintSig, { mint: K.X, platformWallet: PLATFORM, feeLamports: FEE });
  assert.equal(m.ok, false);
  assert.match(m.reason, /did not sign/);
});

test("the platform launching its own coin owes itself nothing", () => {
  const self = verifySpawnTx(createTxFor({ mint: K.X, creator: PLATFORM }), { mint: K.X, platformWallet: PLATFORM, feeLamports: FEE });
  assert.equal(self.ok, true); assert.equal(self.feePaid, FEE);
});
