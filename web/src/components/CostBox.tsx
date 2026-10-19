import type { ReactNode } from "react";
import { lamportsToSol, sol, usd } from "../lib/format";
import "./launch.css";

// Rent the launch transaction pays on top of the launch fee: mint + bonding curve + fee-sharing
// config + the curve's quote vault ATA, roughly 0.025 SOL on mainnet (DESIGN §11.2). An estimate,
// so the box says "~" and the balance check keeps a small margin for network fees.
export const EST_RENT_LAMPORTS = 25_000_000n;
export const FEE_MARGIN_LAMPORTS = 1_000_000n;
export const spawnTotal = (feeLamports: bigint, buyLamports: bigint) => feeLamports + EST_RENT_LAMPORTS + buyLamports;

export type BuyEstimate = { tokens: bigint | null; symbol: string; loading: boolean; error: string | null; hops: number };

type Props = { feeLamports: bigint; buyLamports: bigint; connected: boolean; balance: bigint | null; balanceError: string | null; solUsd: number | null; estimate?: BuyEstimate | null };

/// What the signature spends, line by line, against the wallet balance. The fee line disappears
/// when the server charges nothing; the balance check keeps a small margin for network fees. With
/// a first buy, the row also says what that buy would return (pump's curve math on the new curve).
export default function CostBox({ feeLamports, buyLamports, connected, balance, balanceError, solUsd, estimate }: Props) {
  const total = spawnTotal(feeLamports, buyLamports);
  const insufficient = balance !== null && balance < total + FEE_MARGIN_LAMPORTS;
  const inUsd = (lamports: bigint) => (solUsd ? usd(lamportsToSol(lamports) * solUsd) : null);
  const Row = ({ label, note, value, total: isTotal = false, approx = false }: { label: string; note?: ReactNode; value: bigint; total?: boolean; approx?: boolean }) => (
    <><dt className={isTotal ? "total" : ""}>{label}{note && <small>{note}</small>}</dt><dd className={`mono ${isTotal ? "total" : ""}`}>{isTotal ? "≈ " : approx ? "~" : ""}{sol(lamportsToSol(value))}{inUsd(value) && <small>{inUsd(value)}</small>}</dd></>
  );
  const est = estimate && buyLamports > 0n ? estimate : null;
  const estText = est ? (est.loading ? "quoting…" : est.error ? est.error : est.tokens !== null ? `≈ ${(Number(est.tokens) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 0 })} $${est.symbol || "TOKENS"}${est.hops > 1 ? ` through ${est.hops} hops` : ""}` : null) : null;
  return (
    <div className={`cost ${insufficient ? "short" : ""}`} aria-label="Cost">
      <div className="cost-head">
        <span className="eyebrow">Cost</span>
        {!connected ? <span className="muted">connect a wallet to check your balance</span>
          : balance === null ? <span className="muted">{balanceError ? "balance unavailable" : "reading your balance…"}</span>
          : <span className={`mono ${insufficient ? "bad" : "muted"}`}>wallet {sol(lamportsToSol(balance))}</span>}
      </div>
      <dl className="cost-rows">
        {feeLamports > 0n && <Row label="Launch fee" note="to Spore, inside the launch transaction" value={feeLamports} />}
        <Row label="Network rent" note="mint · curve · fee config · vault, estimated" value={EST_RENT_LAMPORTS} approx />
        {buyLamports > 0n && <Row label="First buy" note={<>second signature, optional{estText && <> · <span className={est?.error ? "bad" : "accent"}>{estText}</span></>}</>} value={buyLamports} />}
        <Row label="Total" value={total} total />
      </dl>
      {insufficient && balance !== null && <div className="notice bad compact"><span><b>Not enough SOL.</b> This needs about {sol(lamportsToSol(total + FEE_MARGIN_LAMPORTS))} including network fees; the wallet holds {sol(lamportsToSol(balance))}, short by {sol(lamportsToSol(total + FEE_MARGIN_LAMPORTS - balance))}. Top up or lower the first buy.</span></div>}
      {!insufficient && feeLamports === 0n && <p className="hint">No launch fee today. Spore's 50% comes out of creator fees once the coin trades.</p>}
    </div>
  );
}
