// The "Creator fees" card of a coin page (DESIGN §11.6): what the coin's fee-sharing config holds
// right now, each shareholder's cut, and a Claim button that pays everyone out. The payout is
// permissionless on-chain, so any connected wallet may trigger it; the signature costs the network
// fee (plus rent for a shareholder's missing token account on a token-quoted coin). Built in the
// browser, simulated before the wallet opens, signed by the wallet; the server only reports numbers.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { PublicKey, type VersionedTransaction } from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { api, solscanTx, type Coin, type Fees } from "../lib/api";
import { buildClaimTx, parseClaimLogs, preflight, sendAndConfirm, type ClaimPayout } from "../lib/pump";
import { friendlyError } from "../lib/steps";
import { PLATFORM_WALLET } from "../lib/policy";
import { DRY_FUNDED, drySend, isDry } from "../lib/dry";
import { useAsync } from "../lib/hooks";
import { ago, amount, bps, feeSol, tokens, usd } from "../lib/format";
import { Addr, Chip, ErrorBox, Logo, Skeleton, sym } from "./Bits";
import { useToast } from "./Toast";

type Phase =
  | { kind: "idle" }
  | { kind: "building" }
  | { kind: "confirm"; tx: VersionedTransaction; spent: bigint | null; units: number; payout: ClaimPayout | null }
  | { kind: "sending"; sig: string | null };

const PLATFORM = PLATFORM_WALLET.toBase58();
/// The API caches each coin's figures for 15 s; a claim empties the vault on-chain at once, so the
/// card refetches now (whatever the cache has) and again once the cache has certainly turned over.
const CACHE_MS = 16_000;
const POLL_MS = 30_000;

export default function ClaimFees({ coin }: { coin: Coin }) {
  const { connection } = useConnection();
  const wallet = useWallet();
  const toast = useToast();
  // Dev dry mode (`?dry=1`, development builds only): the claim is simulated instead of signed,
  // from the funded probe wallet or `?as=<pubkey>` so a shareholder's "you" row can be reviewed.
  const dry = isDry();
  const me = dry ? (new URLSearchParams(window.location.search).get("as") || DRY_FUNDED) : (wallet.publicKey?.toBase58() ?? null);
  const fees = useAsync(() => api.fees(coin.mint), [coin.mint]);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [lastSig, setLastSig] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  // Fees accrue with every trade: refresh while the tab is visible and no claim is under way.
  const busy = phase.kind !== "idle";
  useEffect(() => {
    const t = setInterval(() => { if (!document.hidden && !busy) fees.reload(); }, POLL_MS);
    return () => clearInterval(t);
  }, [fees.reload, busy]);

  const f = fees.data;
  const dec = f?.quoteDecimals ?? (coin.quoteMint === null ? 9 : 6);
  const unit = f?.quoteSymbol ?? coin.quoteSymbol;
  const fmt = (raw: string | bigint) => amount(tokens(raw, dec), unit);
  // Once a config exists the curve's creator is the config PDA, so the launching wallet is only
  // recognisable as the non-platform half of Spore's two-way split (DESIGN §4).
  const shareAddrs = f?.shares?.map((s) => s.address) ?? [];
  const twoWay = shareAddrs.length === 2 && shareAddrs.includes(PLATFORM);
  const roleOf = (addr: string) => {
    const roles: string[] = [];
    if (me && addr === me) roles.push("you");
    if (addr === coin.creator || (twoWay && addr !== PLATFORM)) roles.push("creator");
    if (addr === PLATFORM) roles.push("Spore");
    return roles.length ? roles.join(" · ") : "shareholder";
  };
  const toneOf = (addr: string) => (me && addr === me ? "you" : addr === PLATFORM ? "platform" : "up");

  // The reason the button is off, in order of what the user can do about it. The API's own
  // reason wins when it has one; the fallbacks cover an older server.
  const blocker = !f ? null
    : coin.holderReward ? (f.reason ?? "Creator fees of this coin go to its holders; there is no fee split to claim through.")
    : !f.shares?.length ? (f.reason ?? "No fee-sharing config: creator fees stay with the creator's wallet, so there is nothing to claim here.")
    : !f.claimable ? (f.reason ?? "Nothing to claim yet.")
    : null;

  const start = async () => {
    if (!me || !f) return;
    setPhase({ kind: "building" });
    try {
      const payer = new PublicKey(me);
      const tx = await buildClaimTx(connection, payer, new PublicKey(coin.mint));
      const pf = await preflight(connection, tx, payer);
      if (!alive.current) return;
      setPhase({ kind: "confirm", tx, spent: pf.spent, units: pf.unitsConsumed, payout: parseClaimLogs(pf.logs) });
    } catch (e) {
      toast.error(friendlyError(e));
      if (alive.current) setPhase({ kind: "idle" });
    }
  };
  const confirm = async () => {
    if (phase.kind !== "confirm") return;
    const { tx, payout } = phase;
    setPhase({ kind: "sending", sig: null });
    try {
      const sig = dry ? await drySend(connection, tx, "claim") : await sendAndConfirm(connection, wallet, tx, [], (s) => { if (alive.current) setPhase({ kind: "sending", sig: s }); });
      const paid = payout ? `${fmt(payout.distributed)} to ${payout.shares.length} wallet${payout.shares.length === 1 ? "" : "s"}` : "the pending fees";
      toast.success(dry ? `Dry run: the claim passes (${paid})` : `Claimed ${paid}`, dry ? undefined : { href: solscanTx(sig), label: "view transaction" });
      if (!alive.current) return;
      setLastSig(dry ? null : sig);
      fees.reload();
      setTimeout(() => { if (alive.current) fees.reload(); }, CACHE_MS);
    } catch (e) {
      toast.error(friendlyError(e));
    } finally {
      if (alive.current) setPhase({ kind: "idle" });
    }
  };

  const total = f ? tokens(f.total, dec) : 0;
  const label = phase.kind === "building" ? "Simulating…" : phase.kind === "sending" ? (phase.sig ? "Confirming…" : "Waiting for your wallet…") : blocker ? blocker : `Claim ${fmt(f?.total ?? "0")}`;

  return (
    <section className="card pad fees" aria-busy={fees.loading}>
      <div className="fees-head">
        <span className="eyebrow">Creator fees</span>
        {f && f.claimable && <Chip tone="accent" title="Pending fees can be paid out now">to claim</Chip>}
        {f && !f.claimable && f.shares?.length ? <Chip title={f.reason ?? undefined}>{total > 0 ? "below minimum" : "none pending"}</Chip> : null}
        <button type="button" className="linkish" onClick={fees.reload} disabled={fees.loading || busy} aria-label="Refresh fees">↻</button>
      </div>

      {fees.loading && !f && <div className="stack-2"><Skeleton w="55%" h={26} /><Skeleton h={14} /><Skeleton h={14} /></div>}
      {fees.error && !f && <ErrorBox compact error={fees.error} retry={fees.reload} />}

      {f && (
        <>
          <div className="fees-total">
            <b className={`mono ${total > 0 ? "accent" : ""}`}>{fmt(f.total)}</b>
            <span className="muted">{f.totalUsd != null && total > 0 ? `≈ ${usd(f.totalUsd)} · ` : ""}pending, paid in {unit}{f.migrated ? " · curve + pool" : ""}</span>
          </div>
          {f.perShare.length > 0 && (
            <ul className="fees-rows" aria-label="Who receives the pending fees">
              {f.perShare.map((s) => (
                <li key={s.address} className={me && s.address === me ? "you" : ""}>
                  <i className={`dot ${toneOf(s.address)}`} aria-hidden="true" />
                  <span className="split-role">{roleOf(s.address)}</span>
                  <Addr a={s.address} n={4} />
                  <b className="mono fees-amt">{fmt(s.amount)}<small>{bps(s.bps)}</small></b>
                </li>
              ))}
            </ul>
          )}
          <div className="fees-parts" title="Where the fees sit before a claim sweeps them into the vault">
            <span><i>curve</i> {fmt(f.bucket)}</span><span><i>vault</i> {fmt(f.vault)}</span>{f.migrated && <span><i>pool</i> {fmt(f.amm)}</span>}
          </div>

          {blocker ? (
            <button type="button" className="btn block" disabled title={blocker}>{coin.holderReward ? "Holder-reward coin" : !f.shares?.length ? "No fee split to claim through" : total > 0 ? "Below the minimum payout" : "Nothing to claim yet"}</button>
          ) : !me ? (
            <WalletMultiButton>Connect wallet to claim</WalletMultiButton>
          ) : (
            <button type="button" className="btn accent block" disabled={busy} onClick={start}>{label}</button>
          )}
          {blocker && <p className="hint">{blocker}</p>}
          {!blocker && <p className="hint">Anyone may claim: the signature pays the network fee{f.quoteMint ? " (and rent for a shareholder's missing token account)" : ""}, and the program pays the wallets above in these proportions.</p>}
          {lastSig && <p className="hint">Last claim: <a href={solscanTx(lastSig)} target="_blank" rel="noreferrer">view transaction ↗</a></p>}
          <div className="fees-foot muted"><span>updated {ago(f.updatedAt)}</span>{dry && <span className="warn">dry run</span>}</div>
        </>
      )}

      {/* Portalled to <body>: the card's backdrop-filter would otherwise turn the fixed backdrop into a box inside the card. */}
      {phase.kind === "confirm" && f && createPortal(
        <div className="confirm-backdrop" onClick={() => setPhase({ kind: "idle" })}>
          <div className="confirm" role="dialog" aria-modal="true" aria-label="Confirm claim" onClick={(e) => e.stopPropagation()}>
            <div className="confirm-head"><Logo src={coin.image} label={coin.symbol} size={32} /><b>Claim fees · {sym(coin)}</b><button type="button" className="sheet-close" aria-label="Cancel" onClick={() => setPhase({ kind: "idle" })}>×</button></div>
            <div className="confirm-rows">
              <div><span>Pays out</span><b className="accent">{phase.payout ? fmt(phase.payout.distributed) : fmt(f.total)}</b></div>
              {(phase.payout?.shares ?? f.perShare.map((s) => ({ address: s.address, bps: s.bps, amount: s.amount }))).map((s) => {
                const a = typeof s.address === "string" ? s.address : s.address.toBase58();
                return <div key={a}><span className={me && a === me ? "accent" : ""}>{roleOf(a)} · {a.slice(0, 4)}…{a.slice(-4)}</span><b className={me && a === me ? "accent" : ""}>{fmt(s.amount)}</b></div>;
              })}
              <div><span>Network fee</span><b title={`${phase.units.toLocaleString("en-US")} compute units`}>{phase.spent === null ? "—" : phase.spent < 0n ? `+${feeSol(-phase.spent)} net` : feeSol(phase.spent)}</b></div>
            </div>
            <p className="hint">{dry ? "Dry run: the transaction is simulated again instead of signed." : "Simulated on-chain just now. Your wallet shows the final simulation before you sign; nothing is custodial."}</p>
            <div className="confirm-actions">
              <button type="button" className="btn ghost" onClick={() => setPhase({ kind: "idle" })}>Cancel</button>
              <button type="button" className="btn accent" onClick={confirm}>{dry ? "Simulate claim" : "Claim in wallet"}</button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </section>
  );
}

/// A short "fees to claim" marker for cards and feed rows when a coin's pending total is known.
export const FeesChip = ({ fees }: { fees: Fees | null | undefined }) => (fees && fees.claimable ? <Chip tone="accent" title={`${amount(tokens(fees.total, fees.quoteDecimals), fees.quoteSymbol)} of creator fees waiting`}>fees to claim</Chip> : null);
