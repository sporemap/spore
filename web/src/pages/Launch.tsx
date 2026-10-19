import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { PublicKey } from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { api, type Coin } from "../lib/api";
import { useAsync, useDebounced, useSolBalance, useStats } from "../lib/hooks";
import { QUOTE_PROBE, drySigner, finishFeeSplit, launchFeeOf, policyShares, runSpawn, walletSigner, type Signer, type SpawnResult } from "../lib/flow";
import { friendlyError, type Step } from "../lib/steps";
import { chainFor } from "../lib/chain";
import { estimateFirstBuy } from "../lib/pump";
import { isHttpUrl, normaliseSocial, type PreparedImage } from "../lib/image";
import { clearPending, loadPending, type PendingLaunch } from "../lib/launch-store";
import { dryWallet, isDry } from "../lib/dry";
import { count, parseAmount, sol, lamportsToSol, usd } from "../lib/format";
import Search from "../components/Search";
import Steps from "../components/Steps";
import SplitPreview from "../components/SplitPreview";
import CostBox, { FEE_MARGIN_LAMPORTS, spawnTotal, type BuyEstimate } from "../components/CostBox";
import ChainBreadcrumb from "../components/ChainBreadcrumb";
import SporeCanvas from "../components/SporeCanvas";
import ImageField from "../components/launch/ImageField";
import LaunchSuccess from "../components/launch/LaunchSuccess";
import ResumeCard from "../components/launch/ResumeCard";
import { Chip, DepthBadge, ErrorBox, Logo, Skeleton, nameOf, sym, useTint } from "../components/Bits";
import { useToast } from "../components/Toast";
import "../components/launch.css";

const SLIPPAGES = [100, 200, 300, 500];
const TICKER_RE = /^[A-Z0-9]{1,13}$/;
// Shown in the preview until the server's eligibility split arrives. Two shareholders by default
// (DESIGN §4): the creator and Spore.
const DEFAULT_SPLIT: { label: string; bps: number; tone: "you" | "up" | "platform" }[] = [{ label: "you", bps: 5000, tone: "you" }, { label: "Spore", bps: 5000, tone: "platform" }];
// SOL's tint for the pool card: the same lime the depth-0 badge uses, as an "r,g,b" triplet.
const SOL_TINT = "182,255,92";
type Field = "name" | "symbol" | "description" | "image" | "twitter" | "telegram" | "website" | "firstBuy" | "feeBps";

/// A persisted launch as a result the success screen can show (and finish). The signature is empty
/// for a launch recovered from the chain (the wallet never returned one); the screen hides its link.
const resultFromPending = (p: PendingLaunch): SpawnResult => ({
  sig: p.sig ?? "", mint: p.mint, depth: p.depth, name: p.name, symbol: p.symbol, image: p.image,
  parent: p.parentMint ? { mint: p.parentMint, symbol: p.parentSymbol } : null,
  split: { done: p.step === "done", sig: p.splitSig, error: null }, buy: null, buyError: null, spent: null, dry: false, pending: p,
});

/// The launch form. The pool is SOL by default (a root coin, no parent needed); `?parent=<mint>`
/// makes any pump.fun coin the pool instead, so the tree grows one launch at a time. The page is
/// served at /launch and at its old address /spawn.
export default function Launch() {
  const [params, setParams] = useSearchParams();
  const parentMint = params.get("parent") || "";
  const { connection } = useConnection();
  const wallet = useWallet();
  const toast = useToast();
  const { stats } = useStats();
  // Dev-only dry run (`?dry=1`): a wallet shim replaces wallet-adapter and every send is a
  // simulation. `isDry()` is false in production builds whatever the URL says.
  const dry = isDry();
  const dryW = useMemo(() => (dry ? dryWallet() : null), [dry]);
  const signer: Signer | null = useMemo(() => (dryW ? drySigner(connection, dryW) : walletSigner(connection, wallet)), [connection, dryW, wallet]);
  const connected = !!signer;
  const creator = signer?.publicKey.toBase58() ?? null;
  const balance = useSolBalance(connection, signer?.publicKey ?? null);
  // "Change" opens the parent search over the pool card without dropping the current choice.
  const [picking, setPicking] = useState(false);
  useEffect(() => { document.title = "Launch · Spore"; return () => { document.title = "Spore"; }; }, []);

  const parent = useAsync(() => (parentMint ? api.coin(parentMint).then((r) => r.coin) : Promise.resolve<Coin | null>(null)), [parentMint]);
  // Eligibility is re-fetched with the connected wallet so the server merges duplicate shares
  // (self-launch, platform-owned parent); the shares it returns are exactly what gets signed.
  // The SOL pool has its own endpoint: no parent to check, same split and launch fee.
  const elig = useAsync(() => (parentMint ? api.eligibility(parentMint, creator) : api.eligibilitySol(creator)), [parentMint, creator]);

  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [description, setDescription] = useState("");
  const [twitter, setTwitter] = useState(""); const [telegram, setTelegram] = useState(""); const [website, setWebsite] = useState("");
  const [image, setImage] = useState<PreparedImage | null>(null);
  const [firstBuy, setFirstBuy] = useState("");
  const [slippage, setSlippage] = useState(300);
  const [feeBps, setFeeBps] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [touched, setTouched] = useState<Set<Field>>(new Set());
  const [tried, setTried] = useState(false);
  const [steps, setSteps] = useState<Step[]>([]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SpawnResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The fee-split retry (success screen / resume card) has its own step list.
  const [splitSteps, setSplitSteps] = useState<Step[]>([]);
  const [splitBusy, setSplitBusy] = useState(false);
  const [splitError, setSplitError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingLaunch | null>(() => loadPending());
  const launchCard = useRef<HTMLElement>(null);
  useEffect(() => { setResult(null); setSteps([]); setError(null); setPicking(false); }, [parentMint]);

  const touch = (f: Field) => setTouched((t) => (t.has(f) ? t : new Set(t).add(f)));
  const show = (f: Field) => tried || touched.has(f);
  const buyLamports = useMemo(() => parseAmount(firstBuy, 9) ?? 0n, [firstBuy]);
  const feeValue = feeBps.trim() === "" ? undefined : Number(feeBps);
  const socialBad = (kind: "twitter" | "telegram" | "website", v: string) => v.trim() !== "" && !isHttpUrl(normaliseSocial(kind, v));
  // One sentence per field, shown inline once the field was touched (or a launch was attempted).
  const errors: Partial<Record<Field, string>> = {
    ...(!name.trim() ? { name: "Give the coin a name (1–32 characters)" } : name.trim().length > 32 ? { name: "At most 32 characters" } : {}),
    ...(!symbol ? { symbol: "Pick a ticker: 1–13 letters or digits" } : !TICKER_RE.test(symbol) ? { symbol: "Letters and digits only, up to 13" } : {}),
    ...(!image ? { image: "Add an image: the coin's face on every card" } : {}),
    ...(description.length > 400 ? { description: "At most 400 characters" } : {}),
    ...(socialBad("twitter", twitter) ? { twitter: "A profile link or handle, like @spore" } : {}),
    ...(socialBad("telegram", telegram) ? { telegram: "A t.me link or handle" } : {}),
    ...(socialBad("website", website) ? { website: "A full URL, like https://example.com" } : {}),
    ...(firstBuy.trim() && buyLamports === 0n ? { firstBuy: "A SOL amount, or leave it empty" } : {}),
    ...(feeValue !== undefined && (!Number.isInteger(feeValue) || feeValue < 0 || feeValue > 300) ? { feeBps: "0–300 bps, or leave it empty" } : {}),
  };
  const problems = Object.keys(errors) as Field[];
  const isSol = !parentMint;
  const p = parent.data;
  const e = elig.data;
  // The pool is settled when SOL is chosen, or when the parent coin and its eligibility both loaded.
  const poolReady = isSol || !!p;
  // Launch fee from the server, checked against the pinned policy (lib/policy.ts); a violation blocks the launch.
  let launchFee: ReturnType<typeof launchFeeOf> = null, policyProblem: string | null = null;
  try { launchFee = e ? launchFeeOf(e) : null; if (e && signer) policyShares(signer.publicKey, e); } catch (err) { policyProblem = err instanceof Error ? err.message : String(err); }
  const eligibleNow = !!(poolReady && e && e.ok && e.shares.length > 0 && creator) && !policyProblem;
  // A first buy from SOL needs a SOL-rooted chain: always true for a root, true for a child of one.
  const canBuy = !!(e?.ok && poolReady && (isSol || (p!.depth === 0 ? p!.quoteMint === null : true)));
  const newDepth = isSol ? 0 : p ? p.depth + 1 : (e?.depth ?? 1);
  const quoteLabel = isSol ? "SOL" : sym(p);
  // Cost box: launch fee (server-set, may be 0) + estimated rent + the optional first buy.
  const feeLamports = launchFee?.lamports ?? 0n;
  const buyCost = canBuy ? buyLamports : 0n;
  const insufficient = balance.lamports !== null && balance.lamports < spawnTotal(feeLamports, buyCost) + FEE_MARGIN_LAMPORTS;
  // Progress rail: pool settled and eligible → coin described → launched.
  const step1 = !!(poolReady && e?.ok);
  const step2 = !!(name.trim() && TICKER_RE.test(symbol) && image && description.length <= 400);
  const step3 = !!result;
  const [previewTint, onPreviewImg] = useTint(image?.dataUrl || null, symbol || name || "spore");
  const [parentTint, onParentImg] = useTint(p?.image ?? null, p?.mint ?? "parent");
  const poolTint = isSol ? SOL_TINT : parentTint;
  // SOL → $ROOT → … → $PARENT → your coin, for the preview's route sentence.
  const route = p ? [...p.ancestors].reverse().map((a) => sym(a)).concat(sym(p)) : [];

  // Soft duplicate-ticker hint: tickers are not unique on pump.fun, but a taken one is harder to find.
  const dSymbol = useDebounced(symbol, 450);
  const dupes = useAsync(() => (dSymbol.length >= 2 ? api.search(`$${dSymbol}`).then((r) => r.coins.filter((c) => (c.symbol ?? "").toUpperCase() === dSymbol)) : Promise.resolve<Coin[]>([])), [dSymbol]);
  const dupeList = dSymbol === symbol ? dupes.data ?? [] : [];

  // First-buy estimate from pump's curve math (the curve does not exist yet), debounced on the amount.
  const parentChain = useAsync(() => (p ? chainFor(p) : Promise.resolve(null)), [p?.mint ?? null]);
  const dBuy = useDebounced(canBuy ? buyLamports : 0n, 500);
  const estimateKey = `${dBuy}|${parentMint}|${feeValue ?? ""}|${parentChain.data ? "c" : "n"}`;
  const estimate = useAsync(async () => {
    if (dBuy <= 0n || (p && !parentChain.data)) return null;
    return estimateFirstBuy(connection, signer?.publicKey ?? QUOTE_PROBE, p ? new PublicKey(p.mint) : null, parentChain.data, dBuy, feeValue && !errors.feeBps ? feeValue : undefined);
  }, [estimateKey]);
  const buyEstimate: BuyEstimate | null = dBuy > 0n ? { tokens: estimate.data?.tokens ?? null, symbol, loading: estimate.loading || dBuy !== buyLamports, error: estimate.error ? "could not quote yet" : null, hops: estimate.data?.hops ?? 0 } : null;

  async function go() {
    setTried(true);
    if (!e || !eligibleNow || !signer || !image || problems.length) return;
    setBusy(true); setError(null); setResult(null);
    const form = { name: name.trim(), symbol, description: description.trim(), image: image.dataUrl, twitter: normaliseSocial("twitter", twitter), telegram: normaliseSocial("telegram", telegram), website: normaliseSocial("website", website) };
    try {
      const r = await runSpawn(connection, signer, { parent: isSol ? null : p, eligibility: e, firstBuyLamports: canBuy ? buyLamports : 0n, slippageBps: slippage, creatorFeeBps: feeValue || undefined, form }, setSteps);
      setResult(r);
      setPending(null);
      balance.refresh();
      if (r.split.done) toast.success(isSol ? `${symbol} is live, quoted in SOL` : `${symbol} is live under ${sym(p)}`, r.dry ? undefined : { href: `https://solscan.io/tx/${r.sig}`, label: "transaction" });
      else toast.error(`${symbol} was created but the fee split did not land. Finish it below.`);
      if (r.buyError) toast.error(`Launched, but the first buy failed: ${friendlyError(new Error(r.buyError))}`);
      setTimeout(() => launchCard.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
    } catch (err) { setError(friendlyError(err)); }
    finally { setBusy(false); setPending(loadPending()); }
  }

  /// Retries only the fee split of a launch whose create landed (from the success screen or the
  /// resume card): no upload, no new mint, one signature.
  async function finishSplit(rec: PendingLaunch) {
    if (!signer) { toast.error("Connect the wallet that launched the coin first"); return; }
    setSplitBusy(true); setSplitError(null); setSplitSteps([]);
    try {
      const sig = await finishFeeSplit(connection, signer, rec, setSplitSteps);
      setResult((r) => ({ ...(r ?? resultFromPending(rec)), split: { done: true, sig, error: null } }));
      setPending(null);
      toast.success("Fee split locked. Spore lists the coin once the indexer sees it.");
    } catch (err) { setSplitError(friendlyError(err)); }
    finally { setSplitBusy(false); }
  }

  const launchLabel = busy ? "Launching…" : insufficient ? "Not enough SOL" : isSol ? `Launch ${symbol || "coin"} with SOL` : p ? `Launch ${symbol || "coin"} under ${sym(p)}` : "Pick a pool first";
  const err = (f: Field) => (show(f) && errors[f] ? <span className="field-error" role="alert">{errors[f]}</span> : null);

  return (
    <>
      <SporeCanvas density={0.5} />
      <div className="container spawn">
        <div className="page-head">
          <span className="eyebrow">Launch{dry && <Chip tone="warn" title="Development only: every transaction is simulated, nothing is sent">dry run</Chip>}</span>
          <h1>{isSol ? <>Launch a coin. <em>Start</em> a tree.</> : <>Launch a coin under <em>{p ? sym(p) : "a parent"}</em>.</>}</h1>
          <p className="lead">{isSol
            ? "The first coin of a tree is a plain pump.fun coin quoted in SOL; no parent needed. Coins launched under it later buy and lock it on every trade. Creator fees are split 50/50 between you and Spore. One signature; nothing custodial."
            : "The new coin is created on pump.fun with the parent as its quote: its curve collects parent tokens, and its creator fees are split 50/50 between you and Spore, paid in the parent coin. One signature; nothing custodial."}</p>
        </div>

        <div className="spawn-grid">
          <div className="spawn-main">
            {pending && !result && <ResumeCard conn={connection} pending={pending} onResume={(rec) => { setResult(resultFromPending(rec)); void finishSplit(rec); setTimeout(() => launchCard.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50); }} onDismiss={() => { clearPending(); setPending(null); }} />}

            <div className="spawn-progress" aria-label="Progress">
              <span className={step1 ? "done" : "active"}><i /><em>1 · pool</em></span>
              <span className={step2 ? "done" : step1 ? "active" : ""}><i /><em>2 · your coin</em></span>
              <span className={step3 ? "done" : step1 && step2 ? "active" : ""}><i /><em>3 · launch</em></span>
            </div>

            {/* Pool: what the new coin is quoted in. SOL (a root) by default; any pump.fun coin otherwise. */}
            <section className={`card raised step-card ${step1 ? "done" : ""} ${busy || result ? "locked" : ""}`} style={{ "--tint": poolTint } as CSSProperties}>
              <div className="step-head"><i>{step1 ? "✓" : "1"}</i><h2>Pool</h2>
                <div className="pool-actions">
                  {!picking && <button type="button" className="btn sm ghost" onClick={() => setPicking(true)}>{isSol ? "Launch under a coin instead" : "Change"}</button>}
                  {!isSol && !picking && <button type="button" className="btn sm ghost" onClick={() => setParams(dry ? { dry: "1" } : {})}>Use SOL instead</button>}
                </div>
              </div>
              {picking && <>
                <p className="muted">Any pump.fun coin can be a parent: search it here, or open a coin page and press “Launch a coin”.</p>
                <div className="pool-search"><Search size="lg" autoFocus placeholder="Parent coin: name, ticker or mint…" onPick={(c) => { setPicking(false); setParams(dry ? { parent: c.mint, dry: "1" } : { parent: c.mint }); }} /><button type="button" className="btn ghost" onClick={() => setPicking(false)}>Cancel</button></div>
              </>}
              {!picking && isSol && (
                <div className="parent-pick pool-sol">
                  <span className="logo letter ring sol-mark" aria-hidden="true" style={{ width: 60, height: 60 }}>◎</span>
                  <div className="parent-text">
                    <div className="parent-title"><b>SOL</b><span className="mono muted">— new root coin</span><DepthBadge depth={0} title="a root: depth 0, quoted in SOL" /></div>
                    <p className="muted pool-note">A plain pump.fun curve that takes SOL. No parent needed: this coin becomes the root other coins can launch under.</p>
                  </div>
                  <div className="parent-elig">
                    {elig.loading ? <Skeleton w={120} h={24} r={6} />
                      : elig.error && !e ? <Chip tone="bad">eligibility unknown</Chip>
                      : e?.ok ? <Chip tone="good">ready · root at depth 0</Chip>
                      : <Chip tone="bad">{e?.reason || "not available"}</Chip>}
                  </div>
                </div>
              )}
              {!picking && parentMint && parent.loading && <Skeleton h={88} r={12} />}
              {!picking && parentMint && parent.error && !p && <ErrorBox error={parent.error} retry={parent.reload} />}
              {!picking && p && (
                <div className="parent-pick">
                  <Logo src={p.image} label={p.symbol} size={60} className="ring" onLoad={onParentImg} />
                  <div className="parent-text">
                    <div className="parent-title"><b>{nameOf(p)}</b><span className="mono muted">{sym(p)}</span><DepthBadge depth={p.depth} />{p.migrated && <Chip tone="good">graduated</Chip>}</div>
                    <ChainBreadcrumb coin={p} rootQuote={p.depth === 0 ? p.quoteSymbol : p.root ? null : p.quoteSymbol} />
                    <div className="parent-facts"><span>mcap <b>{usd(p.mcapUsd)}</b></span><span>locked <b>{usd(p.lockedUsd)}</b></span><span>children <b>{count(p.children)}</b></span><span>your coin <b>under {sym(p)} · depth {p.depth + 1}</b></span><Link to={`/c/${p.mint}`}>coin page →</Link></div>
                  </div>
                  <div className="parent-elig">
                    {elig.loading ? <Skeleton w={120} h={24} r={6} />
                      : elig.error && !e ? <Chip tone="bad">eligibility unknown</Chip>
                      : e?.ok ? <Chip tone="good">eligible · child at depth {e.depth}</Chip>
                      : <Chip tone="bad">{e?.reason || "not eligible"}</Chip>}
                  </div>
                </div>
              )}
              {!picking && elig.error && !e && !elig.loading && isSol && <ErrorBox error={elig.error} retry={elig.reload} compact />}
              {!picking && poolReady && e && !e.ok && <div className="notice bad"><span>{e.reason || "This coin cannot be a parent right now."} {stats && <>Depth cap is {stats.maxDepth}.</>}</span>{!isSol && <button type="button" className="btn sm ghost" onClick={() => setParams({})}>Use SOL instead</button>}</div>}
              {!picking && p && !canBuy && e?.ok && <div className="notice warn">This chain is not rooted in SOL, so a first buy from SOL is not possible here; the launch itself works.</div>}
            </section>

            <section className={`card raised step-card ${!poolReady ? "dim" : ""} ${step2 ? "done" : ""} ${busy || result ? "locked" : ""}`} aria-disabled={!poolReady || busy || !!result}>
              <div className="step-head"><i>{step2 ? "✓" : "2"}</i><h2>Your coin</h2>{result && <button type="button" className="btn sm ghost" onClick={() => { setResult(null); setSteps([]); setName(""); setSymbol(""); setDescription(""); setImage(null); setFirstBuy(""); setTried(false); setTouched(new Set()); }}>Launch another</button>}</div>
              <div className="grid-2">
                <label className={`field ${show("name") && errors.name ? "invalid" : ""}`}><span>Name <small className="muted">{name.length}/32</small></span><input className="input" value={name} maxLength={32} onChange={(ev) => setName(ev.target.value)} onBlur={() => touch("name")} placeholder="Little Pepe" autoComplete="off" />{err("name")}</label>
                <label className={`field ${show("symbol") && errors.symbol ? "invalid" : ""}`}><span>Ticker <small className="muted">{symbol.length}/13 · auto-uppercase</small></span><input className="input mono" value={symbol} onChange={(ev) => setSymbol(ev.target.value.replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 13))} onBlur={() => touch("symbol")} placeholder="LILPEPE" autoComplete="off" spellCheck={false} />{err("symbol")}
                  {!errors.symbol && dupeList.length > 0 && <span className="field-hint warn">{dupeList.length >= 20 ? "20+" : dupeList.length} coin{dupeList.length === 1 ? "" : "s"} already use ${symbol} on pump.fun (e.g. {nameOf(dupeList[0])}). Tickers are not unique, but a distinct one is easier to find.</span>}
                  {!errors.symbol && dSymbol === symbol && symbol.length >= 2 && dupes.data && dupeList.length === 0 && <span className="field-hint good">No pump.fun coin uses ${symbol} yet.</span>}
                </label>
              </div>
              <label className={`field ${show("description") && errors.description ? "invalid" : ""}`}><span>Description <small className={`muted ${description.length > 360 ? "warn" : ""}`}>{description.length}/400</small></span><textarea className="textarea" value={description} maxLength={400} onChange={(ev) => setDescription(ev.target.value)} onBlur={() => touch("description")} placeholder={p ? `Why ${sym(p)} deserves a child.` : "What is this coin?"} />{err("description")}</label>
              <div className="grid-3">
                <label className={`field ${show("twitter") && errors.twitter ? "invalid" : ""}`}><span>X / Twitter <small className="muted">handle or link</small></span><input className="input" value={twitter} maxLength={120} onChange={(ev) => setTwitter(ev.target.value)} onBlur={() => { touch("twitter"); setTwitter((v) => normaliseSocial("twitter", v)); }} placeholder="@handle" autoComplete="off" />{err("twitter")}</label>
                <label className={`field ${show("telegram") && errors.telegram ? "invalid" : ""}`}><span>Telegram <small className="muted">handle or link</small></span><input className="input" value={telegram} maxLength={120} onChange={(ev) => setTelegram(ev.target.value)} onBlur={() => { touch("telegram"); setTelegram((v) => normaliseSocial("telegram", v)); }} placeholder="t.me/…" autoComplete="off" />{err("telegram")}</label>
                <label className={`field ${show("website") && errors.website ? "invalid" : ""}`}><span>Website</span><input className="input" value={website} maxLength={200} onChange={(ev) => setWebsite(ev.target.value)} onBlur={() => { touch("website"); setWebsite((v) => normaliseSocial("website", v)); }} placeholder="https://…" autoComplete="off" />{err("website")}</label>
              </div>
              <div className={`field ${show("image") && errors.image ? "invalid" : ""}`}><span>Image <small className="muted">square · 512×512 after resize</small></span>
                <ImageField value={image} onChange={(v) => { setImage(v); touch("image"); }} tint={previewTint} onPreviewLoad={onPreviewImg} />
                {err("image")}
              </div>
            </section>

            <section ref={launchCard} className={`card raised step-card ${!poolReady ? "dim" : ""} ${step3 ? "done" : ""}`} aria-disabled={!poolReady}>
              <div className="step-head"><i>{step3 ? "✓" : "3"}</i><h2>Launch</h2></div>
              {!result && <>
                <div className="grid-2" style={{ alignItems: "start" }}>
                  <label className={`field ${show("firstBuy") && errors.firstBuy ? "invalid" : ""}`}><span>First buy · optional</span>
                    <div className="amount"><input className="input mono" inputMode="decimal" value={firstBuy} disabled={!canBuy} onChange={(ev) => setFirstBuy(ev.target.value.replace(/[^\d.,]/g, ""))} onBlur={() => touch("firstBuy")} placeholder="0.5" /><em>SOL</em></div>
                    {err("firstBuy")}
                  </label>
                  <div className="hint buy-hint">
                    {buyLamports > 0n
                      ? <>Right after the launch lands, a second signature buys {isSol ? `${symbol || "your coin"} from its fresh curve` : `${sym(p)} → ${symbol || "your coin"} through the chain`}{stats?.solUsd ? ` (≈ ${usd((Number(buyLamports) / 1e9) * stats.solUsd)})` : ""}. Slippage <span className="seg inline">{SLIPPAGES.map((s) => <button key={s} type="button" aria-pressed={slippage === s} onClick={() => setSlippage(s)}>{s / 100}%</button>)}</span></>
                      : isSol ? "Buy the first tokens of your coin from its fresh curve with SOL, right after the launch. Being first on your own curve is the cheapest entry there will ever be." : "Buy the first tokens of your coin from its fresh curve through the whole chain (SOL → parent → your coin), right after the launch."}
                  </div>
                </div>
                <button type="button" className="linkish" aria-expanded={advanced} onClick={() => setAdvanced((a) => !a)}>{advanced ? "▾" : "▸"} Advanced{feeValue !== undefined && !errors.feeBps ? <span className="muted"> · creator fee {feeValue} bps</span> : ""}</button>
                {advanced && (
                  <div className="grid-2 advanced">
                    <label className={`field ${show("feeBps") && errors.feeBps ? "invalid" : ""}`}><span>Creator fee · bps · optional</span><div className="amount"><input className="input mono" inputMode="numeric" value={feeBps} onChange={(ev) => setFeeBps(ev.target.value.replace(/\D/g, "").slice(0, 3))} onBlur={() => touch("feeBps")} placeholder="pump schedule" /><em>{feeValue !== undefined && !errors.feeBps ? `${(feeValue / 100).toFixed(2)}%` : "bps"}</em></div>{err("feeBps")}</label>
                    <div className="hint">The creator fee is the slice of every trade that goes to the fee split (you 50 / Spore 50). Leave it empty for pump.fun's default schedule, which steps down as market cap grows. A custom rate (0–300 bps = 0–3%) is fixed for the coin's life and only honoured on quote-control chains; SOL and USDC roots always use the schedule.</div>
                  </div>
                )}
                {policyProblem && <p className="error" role="alert">{policyProblem}</p>}
                {poolReady && <CostBox feeLamports={feeLamports} buyLamports={buyCost} connected={connected} balance={balance.lamports} balanceError={balance.error} solUsd={stats?.solUsd ?? null} estimate={buyEstimate} />}
                {tried && problems.length > 0 && poolReady && <ul className="problems" role="alert">{problems.map((f) => <li key={f}>{errors[f]}</li>)}</ul>}
              </>}
              {error && <div className="notice bad launch-error" role="alert"><span><b>The launch stopped.</b> {error}{/nothing was (sent|charged)/i.test(error) ? "" : " If a transaction was sent, it is linked in the step list."}</span>{!busy && <button type="button" className="btn sm" onClick={go}>Try again</button>}</div>}
              {steps.length > 0 && !result && <Steps steps={steps} title={busy ? "Launching" : error ? "Stopped" : "Done"} />}
              {result && steps.length > 0 && <details className="steps-details"><summary>What happened</summary><Steps steps={steps} /></details>}
              {result ? <LaunchSuccess r={result} maxDepth={stats?.maxDepth} onFinishSplit={() => void finishSplit(result.pending)} splitBusy={splitBusy} splitSteps={splitSteps} splitError={splitError} />
                : !connected ? <div className="connect-row"><WalletMultiButton>Connect wallet to launch</WalletMultiButton><span className="hint">Phantom, Solflare or any wallet-standard wallet. The transaction is built here and signed there; Spore never holds a key.</span></div>
                : <div className="launch-row">
                    <button type="button" className="btn lg accent launch-btn" disabled={busy || !eligibleNow || insufficient || (tried && problems.length > 0)} onClick={go}>{busy && <span className="spin" aria-hidden="true" />}{launchLabel}</button>
                    {dry && <span className="hint">Dry run as <span className="mono">{creator?.slice(0, 6)}…</span>: simulated on mainnet state, nothing sent.</span>}
                    {!busy && !dry && eligibleNow && !insufficient && <span className="hint">{problems.length ? `${problems.length} thing${problems.length === 1 ? "" : "s"} to fix above` : "Simulated before you sign; your wallet shows the exact cost."}</span>}
                  </div>}
              {connected && poolReady && e && e.ok && !creator && <div className="hint">Waiting for the wallet address…</div>}
            </section>
          </div>

          <aside className="spawn-side">
            {/* Live preview: the card this coin will get, updating as the form is typed. */}
            <section className="card preview" style={{ "--tint": previewTint } as CSSProperties}>
              <div className="preview-band">
                <span className="eyebrow">Preview</span>
                {image ? <img className="preview-img" src={image.dataUrl} alt="" onLoad={(ev) => onPreviewImg(ev.currentTarget)} /> : <div className="preview-img letter" aria-hidden="true">{(symbol || name || "?").slice(0, 1).toUpperCase()}</div>}
                <div className="preview-name"><b>{name.trim() || "Your coin"}</b><span className="mono muted">{symbol ? `$${symbol}` : "$TICKER"}</span></div>
                <div className="preview-pills">
                  {isSol ? <span className="pill root">root · quoted in SOL</span> : p ? <span className="pill parent">↳ under {sym(p)}</span> : <span className="pill root">loading parent…</span>}
                  <DepthBadge depth={newDepth} title={isSol ? "a root coin: depth 0" : `child at depth ${newDepth}`} />
                </div>
              </div>
              <div className="preview-body">
                {description.trim() ? <p className="preview-desc">{description.trim()}</p>
                  : isSol ? <p className="hint">Quoted in SOL: a root coin. Every coin launched under it later buys {symbol ? `$${symbol}` : "it"} on every trade and parks it in its own curve.</p>
                  : <p className="hint">Quoted in {quoteLabel}: every buy routes SOL → {route.length ? `${route.join(" → ")} → ` : "parent → "}{symbol ? `$${symbol}` : "your coin"}.</p>}
                {(twitter || telegram || website) && <div className="preview-links">{twitter && <span>𝕏 {normaliseSocial("twitter", twitter).replace(/^https?:\/\/(www\.)?/, "")}</span>}{telegram && <span>TG {normaliseSocial("telegram", telegram).replace(/^https?:\/\/(www\.)?/, "")}</span>}{website && <span>🌐 {normaliseSocial("website", website).replace(/^https?:\/\/(www\.)?/, "")}</span>}</div>}
                <div className="preview-split">
                  <span><em>creator fee split</em><em>{e ? "live" : "default"}</em></span>
                  <div className="split-bar" aria-hidden="true">
                    {e && e.shares.length
                      ? e.shares.map((s) => <i key={s.address} className={creator && s.address === creator ? "you" : s.address === e.platform ? "platform" : "up"} style={{ width: `${s.bps / 100}%` }} title={`${s.bps / 100}%`} />)
                      : DEFAULT_SPLIT.map((s) => <i key={s.label} className={s.tone} style={{ width: `${s.bps / 100}%` }} title={`${s.label} ${s.bps / 100}%`} />)}
                  </div>
                  <span className="hint">{e && e.shares.length ? `${e.shares.length} shareholder${e.shares.length === 1 ? "" : "s"} · set at launch, admin revoked` : `you 50% · Spore 50% · paid in ${isSol ? "SOL" : "the parent coin"}`}</span>
                </div>
              </div>
            </section>
            <section className="card pad">
              {elig.loading ? <Skeleton h={120} r={10} />
                : e ? <SplitPreview shares={e.shares} you={creator} parentCreator={e.parentCreator} grandparentCreator={e.grandparentCreator} platform={e.platform} parentSymbol={p?.symbol} grandparentSymbol={p?.parent?.symbol} quoteSymbol={isSol ? "SOL" : p ? sym(p) : null} />
                : <><span className="eyebrow">Creator fee split</span><p className="muted">Default: you 50%, Spore 50%, paid in {isSol ? "SOL" : "the parent coin"} on every trade of your coin. Set once at launch; the admin is revoked, so it can never change. Spore's half buys $SPORE and locks it.</p></>}
            </section>
            <section className="card pad">
              <span className="eyebrow">What it costs</span>
              <p className="muted">{feeLamports > 0n ? `A ${sol(lamportsToSol(feeLamports))} launch fee to Spore, paid inside the launch transaction, plus` : "No launch fee; just"} the network rent for the mint, curve and fee-sharing config (about 0.025 SOL), network fees, and your first buy if you set one. Spore's 50% of creator fees comes out of trading, not your wallet. Every line is on <Link to="/fees">Fees &amp; rules</Link>.</p>
              <span className="eyebrow">What happens when you press launch</span>
              <ol className="launch-plan">
                <li>Your image and metadata are published to Spore's host.</li>
                <li>One transaction is built: create the coin{feeLamports > 0n ? ", pay the launch fee" : ""} and lock the fee split.</li>
                <li>It is simulated first; a problem stops here, before your wallet opens.</li>
                <li>You approve in your wallet; the page follows the signature until it confirms.</li>
                {buyLamports > 0n && canBuy && <li>A second signature makes your first buy.</li>}
              </ol>
              <span className="eyebrow">Rules</span>
              <p className="muted">A root (quoted in SOL) is depth 0. Depth cap {stats ? stats.maxDepth : "2"} (pump.fun Global.maxCurveDepth). Mayhem-mode coins cannot be parents. A chain with a coin that has graduated but not migrated must wait for migration. The fee split cannot be changed after creation.</p>
            </section>
          </aside>
        </div>
      </div>
    </>
  );
}
