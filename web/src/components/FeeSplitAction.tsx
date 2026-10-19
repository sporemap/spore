// Lets a coin's creator lock the creator/Spore fee split on a coin that has none yet: a spawn whose
// second transaction did not land, or a child coin created elsewhere. Same shares as at spawn time
// (the server computes them), signed by the connected wallet. A locked split that names the Spore
// wallet is also what makes the coin "ours" in the listings (DESIGN §11.1).
import { useEffect, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { api, solscanTx, type Coin, type Eligibility } from "../lib/api";
import { buildFeeSplitTx, sendAndConfirm } from "../lib/pump";
import { policyShares } from "../lib/flow";
import SplitPreview from "./SplitPreview";
import { Ext } from "./Bits";

export default function FeeSplitAction({ coin, onDone }: { coin: Coin; onDone: () => void }) {
  const { connection } = useConnection();
  const wallet = useWallet();
  const me = wallet.publicKey?.toBase58() ?? null;
  const [elig, setElig] = useState<Eligibility | null>(null);
  const [state, setState] = useState<{ busy: boolean; sig: string | null; error: string | null }>({ busy: false, sig: null, error: null });
  const parent = coin.parent;
  const mine = !!me && me === coin.creator;

  useEffect(() => {
    if (!mine || !parent) { setElig(null); return; }
    let alive = true;
    api.eligibility(parent.mint, me).then((e) => { if (alive) setElig(e); }).catch(() => { if (alive) setElig(null); });
    return () => { alive = false; };
  }, [mine, parent, me]);

  if (!mine || !parent || coin.holderReward) return null;

  const lock = async () => {
    if (!elig?.shares.length || !wallet.publicKey) return;
    setState({ busy: true, sig: null, error: null });
    try {
      const parentCoin = (await api.coin(parent.mint)).coin;
      const shares = policyShares(wallet.publicKey, elig); // pinned creator 50 / Spore 50; the server's copy must agree
      const tx = await buildFeeSplitTx(connection, wallet.publicKey, new PublicKey(coin.mint), new PublicKey(parent.mint), new PublicKey(parentCoin.tokenProgram), shares, coin.complete);
      const sig = await sendAndConfirm(connection, wallet, tx);
      setState({ busy: false, sig, error: null });
      onDone();
    } catch (e) {
      setState({ busy: false, sig: null, error: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <section className="card pad">
      <span className="eyebrow">Your coin</span>
      <h3>Lock the fee split</h3>
      <p className="muted">This coin has no fee-sharing config yet, so all creator fees stay with you and the coin is not listed as a Spore launch. Locking the split writes the creator/Spore shares on-chain, paid in the parent coin. It is set once; the admin is revoked, so it can never change.</p>
      {elig?.shares.length ? <SplitPreview shares={elig.shares} you={me} parentCreator={elig.parentCreator} grandparentCreator={elig.grandparentCreator} platform={elig.platform} parentSymbol={parent.symbol} grandparentSymbol={coin.ancestors[1]?.symbol ?? null} /> : <p className="muted">Computing the split…</p>}
      <button className="btn accent" type="button" disabled={state.busy || !elig?.shares.length} onClick={lock}>{state.busy ? "Waiting for your wallet…" : "Lock fee split"}</button>
      {state.sig && <p className="hint">Locked. <Ext href={solscanTx(state.sig)}>View transaction ↗</Ext></p>}
      {state.error && <p className="error">{state.error}</p>}
    </section>
  );
}
