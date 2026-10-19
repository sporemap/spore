import React, { useMemo } from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter, SolflareWalletAdapter } from "@solana/wallet-adapter-wallets";
import "@solana/wallet-adapter-react-ui/styles.css";
import "./styles.css";
import App from "./App";

// All RPC traffic goes through the API's allow-listed JSON-RPC proxy: no RPC key in the browser,
// and the same origin in production (the server serves this build).
const RPC = `${window.location.origin}/api/rpc`;

function Root() {
  // Phantom and Solflare register through Wallet Standard as well; listing the adapters keeps
  // them visible (with their own logos) even before the extension injects.
  const wallets = useMemo(() => [new PhantomWalletAdapter(), new SolflareWalletAdapter()], []);
  return (
    <ConnectionProvider endpoint={RPC} config={{ commitment: "confirmed", disableRetryOnRateLimit: false }}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <BrowserRouter><App /></BrowserRouter>
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
ReactDOM.createRoot(document.getElementById("root")!).render(<React.StrictMode><Root /></React.StrictMode>);
