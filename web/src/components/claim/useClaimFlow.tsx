// The claim flow shared by the Claim page rows: build the permissionless payout in the browser,
// simulate it, show who gets what, then hand it to the wallet. "Claim all" runs the same steps
// for each coin in turn, each with its own wallet approval. The server only reports numbers; the
// transaction is assembled from the chain (lib/pump/claim.ts) and nothing is custodial.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { PublicKey, type VersionedTransaction } from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { solscanTx, type FeeShare } from "../../lib/api";
import { buildClaimTx, parseClaimLogs, preflight, sendAndConfirm, type ClaimPayout } from "../../lib/pump";
import { friendlyError } from "../../lib/steps";
import { PLATFORM_WALLET } from "../../lib/policy";
import { DRY_FUNDED, drySend, isDry } from "../../lib/dry";
import { amount, feeSol, tokens } from "../../lib/format";
import { Logo } from "../Bits";
import { useToast } from "../Toast";

export type ClaimTarget = { mint: string; symbol: string | null; image: string | null; quoteSymbol: string; quoteDecimals: number; total: string; perShare: FeeShare[] };
type Phase =
  | { kind: "building"; target: ClaimTarget }
  | { kind: "confirm"; target: ClaimTarget; tx: VersionedTransaction; spent: bigint | null; units: number; payout: ClaimPayout | null }
  | { kind: "sending"; target: ClaimTarget; sig: string | null };

const PLATFORM = PLATFORM_WALLET.toBase58();

export function useClaimFlow(onClaimed: () => void) {
  const { connection } = useConnection();
  const wallet = useWallet();
  const toast = useToast();
  const dry = isDry();
  const me = dry ? (new URLSearchParams(window.location.search).get("as") || DRY_FUNDED) : (wallet.publicKey?.toBase58() ?? null);
  const [phase, setPhase] = useState<Phase | null>(null);
  const [bulk, setBulk] = useState<{ i: number; n: number; done: number } | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const fmt = (t: ClaimTarget, raw: string | bigint) => amount(tokens(raw, t.quoteDecimals), t.quoteSymbol);
  const roleOf = (a: string) => (me && a === me ? "you" : a === PLATFORM ? "Spore" : "shareholder");

  const prepare = useCallback(async (t: ClaimTarget) => {
    const payer = new PublicKey(me!);
    const tx = await buildClaimTx(connection, payer, new PublicKey(t.mint));
    const pf = await preflight(connection, tx, payer);
    return { tx, spent: pf.spent, units: pf.unitsConsumed, payout: parseClaimLogs(pf.logs) };
  }, [connection, me]);

  const send = useCallback(async (t: ClaimTarget, tx: VersionedTransaction, payout: ClaimPayout | null) => {
    const sig = dry ? await drySend(connection, tx, "claim") : await sendAndConfirm(connection, wallet, tx, [], (s) => { if (alive.current) setPhase({ kind: "sending", target: t, sig: s }); });
    const paid = payout ? `${fmt(t, payout.distributed)} to ${payout.shares.length} wallet${payout.shares.length === 1 ? "" : "s"}` : "the pending fees";
    toast.success(dry ? `Dry run: the ${t.symbol ? "$" + t.symbol : ""} claim passes (${paid})` : `Claimed ${paid}`, dry ? undefined : { href: solscanTx(sig), label: "view transaction" });
    return sig;
  }, [connection, dry, toast, wallet]);

  /** One coin: simulate, then the confirm dialog decides. */
  const start = useCallback(async (t: ClaimTarget) => {
    if (!me || phase || bulk) return;
    setPhase({ kind: "building", target: t });
    try {
      const r = await prepare(t);
      if (alive.current) setPhase({ kind: "confirm", target: t, ...r });
    } catch (e) { toast.error(friendlyError(e)); if (alive.current) setPhase(null); }
  }, [me, phase, bulk, prepare, toast]);

  const confirm = useCallback(async () => {
    if (phase?.kind !== "confirm") return;
    const { target, tx, payout } = phase;
    setPhase({ kind: "sending", target, sig: null });
    try { await send(target, tx, payout); onClaimed(); }
    catch (e) { toast.error(friendlyError(e)); }
    finally { if (alive.current) setPhase(null); }
  }, [phase, send, onClaimed, toast]);

  /** Every claimable coin in turn; a coin whose simulation fails is skipped, a wallet refusal stops the run. */
  const claimAll = useCallback(async (targets: ClaimTarget[]) => {
    if (!me || phase || bulk || !targets.length) return;
    let done = 0;
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      if (!alive.current) return;
      setBulk({ i, n: targets.length, done });
      setPhase({ kind: "building", target: t });
      let r: Awaited<ReturnType<typeof prepare>>;
      try { r = await prepare(t); } catch (e) { toast.error(`${t.symbol ? "$" + t.symbol : t.mint.slice(0, 6)}: ${friendlyError(e)}`); continue; }
      setPhase({ kind: "sending", target: t, sig: null });
      try { await send(t, r.tx, r.payout); done++; }
      catch (e) {
        const msg = friendlyError(e);
        toast.error(msg);
        if (/reject|declin|cancel/i.test(String((e as Error)?.message ?? e))) break;
      }
    }
    if (alive.current) { setPhase(null); setBulk(null); }
    onClaimed();
  }, [me, phase, bulk, prepare, send, onClaimed, toast]);

  const busyMint = phase?.target.mint ?? null;
  const labelFor = (mint: string) => {
    if (busyMint !== mint || !phase) return null;
    return phase.kind === "building" ? "Simulating…" : phase.kind === "sending" ? (phase.sig ? "Confirming…" : "Waiting for wallet…") : "Review…";
  };

  const dialog: ReactNode = phase?.kind === "confirm" ? createPortal(
    <div className="confirm-backdrop" onClick={() => setPhase(null)}>
      <div className="confirm" role="dialog" aria-modal="true" aria-label="Confirm claim" onClick={(e) => e.stopPropagation()}>
        <div className="confirm-head"><Logo src={phase.target.image} label={phase.target.symbol} size={32} /><b>Claim fees · {phase.target.symbol ? `$${phase.target.symbol}` : phase.target.mint.slice(0, 6)}</b><button type="button" className="sheet-close" aria-label="Cancel" onClick={() => setPhase(null)}>✕</button></div>
        <div className="confirm-rows">
          <div><span>Pays out</span><b className="accent">{fmt(phase.target, phase.payout ? phase.payout.distributed : phase.target.total)}</b></div>
          {(phase.payout?.shares ?? phase.target.perShare.map((s) => ({ address: s.address, bps: s.bps, amount: s.amount }))).map((s) => {
            const a = typeof s.address === "string" ? s.address : (s.address as PublicKey).toBase58();
            return <div key={a}><span className={me && a === me ? "accent" : ""}>{roleOf(a)} · {a.slice(0, 4)}…{a.slice(-4)}</span><b className={me && a === me ? "accent" : ""}>{fmt(phase.target, s.amount)}</b></div>;
          })}
          <div><span>Network fee</span><b title={`${phase.units.toLocaleString("en-US")} compute units`}>{phase.spent === null ? "—" : phase.spent < 0n ? `+${feeSol(-phase.spent)} net` : feeSol(phase.spent)}</b></div>
        </div>
        <p className="hint">{dry ? "Dry run: the transaction is simulated again instead of signed." : "Simulated on-chain just now. Anyone may trigger a payout: you pay the network fee, the program pays the shareholders above."}</p>
        <div className="confirm-actions">
          <button type="button" className="btn ghost" onClick={() => setPhase(null)}>Cancel</button>
          <button type="button" className="btn accent" onClick={confirm}>{dry ? "Simulate claim" : "Claim in wallet"}</button>
        </div>
      </div>
    </div>,
    document.body,
  ) : null;

  return { me, dry, busy: !!phase || !!bulk, bulk, start, claimAll, labelFor, dialog };
}
