import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import SporeCanvas from "../components/SporeCanvas";
import { CodeBlock, CodeTabs, CopyButton } from "../components/docs/CodeBlock";
import { EndpointCard, Params, PathText, type Field } from "../components/docs/EndpointCard";
import SnippetGenerator from "../components/docs/SnippetGenerator";
import StreamConsole from "../components/docs/StreamConsole";
import { EX, MUSHROOM_MINT, SPORE_MINT } from "../components/docs/examples";
import { API_ORIGIN, json } from "../components/docs/util";
import "../components/docs.css";

const BASE = `${API_ORIGIN}/v1`;
const MAIL = "mailto:team@sporepad.com?subject=Spore%20partner%20key";
const X_URL = "https://x.com/Sporemap";
const n = (v: number) => v.toLocaleString("en-US");

const TOC = [
  ["overview", "Overview"],
  ["quick-start", "Quick start"],
  ["endpoints", "Endpoints"],
  ["stream", "Live stream"],
  ["embeds", "Embeds"],
  ["keys", "Keys & limits"],
  ["terms", "Attribution & terms"],
  ["openapi", "OpenAPI"],
] as const;
const ENDPOINTS = [["ep-family", "/coin/:mint/family"], ["ep-tree", "/tree/:mint"], ["ep-map", "/map"], ["ep-heat", "/heat"]] as const;

/// Highlights the section being read. The line sits a third of the way down the viewport, so a
/// short section still lights up before the next one takes over.
function useActiveSection(ids: readonly string[]) {
  const [active, setActive] = useState(ids[0]);
  useEffect(() => {
    const els = ids.map((id) => document.getElementById(id)).filter((x): x is HTMLElement => !!x);
    if (!els.length || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => {
      const hit = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (hit) setActive(hit.target.id);
    }, { rootMargin: "-30% 0px -65% 0px" });
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [ids]);
  return active;
}

const QUICK_CURL = `# The family of $SPORE: root, parent, ancestors, top children, locked value
curl ${BASE}/coin/${SPORE_MINT}/family

# The whole tree it belongs to, with a partner key (higher limits)
curl -H "X-API-Key: spk_YOUR_KEY" \\
  ${BASE}/tree/${SPORE_MINT}

# New pairs and trades in the $SPORE tree, live (-N: do not buffer)
curl -N "${BASE}/stream?types=pair,trade&mint=${SPORE_MINT}"`;

const QUICK_JS = `const SPORE = "${SPORE_MINT}";

const res = await fetch(\`${BASE}/coin/\${SPORE}/family\`);
if (res.status === 404) throw new Error("not a pump.fun coin");
const family = await res.json();

console.log(\`$\${family.symbol}: \${family.children.count} children, \${family.descendants} below it\`);
for (const child of family.children.top) {
  console.log(child.symbol, child.mcapUsd, child.lockedUsd);
}
// A link back is part of the terms: family.links.spore`;

const QUICK_SSE = `const url = "${BASE}/stream?types=pair,trade&mint=${SPORE_MINT}";
const stream = new EventSource(url);

stream.addEventListener("pair", (e) => {
  const { coin, parent } = JSON.parse(e.data);
  console.log(\`new coin $\${coin.symbol} under $\${parent.symbol}\`);
});
stream.addEventListener("trade", (e) => {
  const t = JSON.parse(e.data);
  console.log(t.isBuy ? "buy" : "sell", t.mint, t.valueUsd);
});
// EventSource reconnects by itself after a dropped connection.`;

const QUICK_NODE = `// Server side: a partner key never ships to a browser.
const res = await fetch("${BASE}/heat", {
  headers: { "X-API-Key": process.env.SPORE_API_KEY },
});
console.log(res.headers.get("X-Spore-Tier"), res.headers.get("X-RateLimit-Remaining"));
const heat = await res.json();
const rows = heat.mint.map((mint, i) => ({ mint, trades1h: heat.t1h[i], volume24h: heat.v24[i] }));`;

const TREE_JS = `const { root, nodes } = await (await fetch(\`${BASE}/tree/\${mint}\`)).json();
const byMint = new Map(nodes.map((n) => [n.mint, { ...n, kids: [] }]));
for (const n of byMint.values()) byMint.get(n.parentMint)?.kids.push(n);
const tree = byMint.get(root.mint); // the root, with every descendant under .kids`;

const MAP_JS = `let cursor = 0;          // generatedAt of the copy you hold (ms)
let lastFull = 0;

async function sync(store) {
  const full = !cursor || Date.now() - lastFull > 15 * 60_000;
  const url = full ? "${BASE}/map" : \`${BASE}/map?since=\${cursor}\`;
  const body = await (await fetch(url)).json();
  if (full) { store.replace(body.roots); lastFull = Date.now(); }
  else for (const node of body.nodes) store.upsert(node); // each carries parentMint
  cursor = body.generatedAt;
}`;

const ATTRIBUTION = `<a href="https://sporepad.com" target="_blank" rel="noopener">Data by Spore</a>`;

const FAMILY_FIELDS: Field[] = [
  ["depth", "number", "Hops from the root: 0 for a root, 1 for its child, 2 for a grandchild (pump.fun's cap today)."],
  ["quoteMint · quoteSymbol", "string | null · string", <>What the coin's curve is priced in. <code>null</code> / <code>"SOL"</code> for a root; the parent's mint and ticker for a child.</>],
  ["root · parent · ancestors", "CoinRef · CoinRef | null · CoinRef[]", <>The chain up to the root. <code>ancestors</code> is nearest first and excludes the coin itself; a root has <code>parent: null</code> and no ancestors, and is its own <code>root</code>.</>],
  ["children.count · children.top", "number · CoinRef & {mcapUsd, lockedUsd}[]", "Direct children, and up to 20 of them ranked by locked value."],
  ["descendants", "number", "Every coin below this one, at any depth."],
  ["lockedUsd", "number | null", "USD value of this coin's tokens held by its children: in their bonding curves, or in the child/parent pools once they migrate."],
  ["mcapUsd", "number | null", "Price × total supply, priced along the chain down to SOL."],
  ["change24h", "number | null", <>Price change over the last 24 h in percent, two decimals (<code>27.95</code> = +27.95 %): the current price against the last trade at or before 24 h ago, or the first trade inside the window when the history starts there. In USD when both prices have one, else in the quote. <code>null</code> when the coin has no recorded trade.</>],
  ["trades1h", "number", "Trades in the last hour."],
  ["launchedOnSpore", "boolean", "True when the coin was launched through sporepad.com."],
  ["links", "object", <><code>spore</code> (coin page), <code>launchUnder</code> (launch a child under this coin), <code>embed</code> (its family-tree widget).</>],
];
const NODE_FIELDS: Field[] = [
  ["mint · name · symbol · image · depth", "CoinRef", "The coin; image is an https URL or null."],
  ["parentMint", "string | null", "The node's parent in this tree; null for the root."],
  ["mcapUsd · lockedUsd", "number | null", "As in /family."],
  ["children · descendants", "number", "Direct children, and every coin below at any depth."],
  ["otherChildren", "number", "Always 0 here: /v1 covers the whole ecosystem, so no child is left out."],
  ["migrated", "boolean", "Graduated from the bonding curve to its PumpSwap pool."],
  ["ours · oursPending", "boolean", "Launched through Spore; pending is the first minutes after a launch, before the fee config is confirmed on-chain."],
  ["createdAt", "number | null", "Unix seconds of the create transaction, when the index saw it."],
];
const HEAT_FIELDS: Field[] = [
  ["at · since", "number", "Unix seconds the snapshot was built, and at − 86 400."],
  ["mint[]", "string[]", "One entry per coin with a trade in the last 24 h; index i of every other array describes mint[i]."],
  ["t1h[] · buys1h[]", "number[]", "Trades and buys in the last hour."],
  ["n24[] · v24[]", "number[]", "Trades and USD volume (two decimals) in the last 24 h."],
  ["last[]", "number[]", "Unix seconds of the coin's latest trade."],
];

const STREAM_EVENTS: { type: string; when: string; shape: string }[] = [
  { type: "pair", when: "A coin is created under a parent the index tracks, or an older child's parent becomes known (once per mint per minute).", shape: "{ coin: MapCoin & {parentMint}, parent: MapCoin & {parentMint} }" },
  { type: "trade", when: "Every buy or sell of a tracked coin.", shape: "{ sig, mint, slot, time, isBuy, user, baseAmount, quoteAmount, priceQuote, priceUsd, valueUsd }" },
  { type: "heat", when: "Right after each trade: that coin's row of /v1/heat, updated.", shape: "{ mint, at, t1h, n24, v24, last, buys1h }" },
  { type: "stats", when: "After each refresh pass of the index (about every 30 s). Never filtered by mint.", shape: "{ coins, roots, byDepth, lockedUsd, volume24hUsd, solUsd, maxDepth, … }" },
  { type: "mapdelta", when: "At most every 3 s, the coins whose map numbers moved (up to 500 per batch). Not in the default set.", shape: "{ at, updated: [{ mint, mcapUsd, lockedUsd, children, descendants, migrated, name, symbol, image }] }" },
  { type: "coin", when: "A coin's full record when a Spore launch appears or a coin completes its curve. Not in the default set.", shape: "Coin (the record behind a sporepad.com coin page)" },
];

export default function ApiDocs() {
  useEffect(() => { document.title = "API & embeds · Spore"; return () => { document.title = "Spore"; }; }, []);
  const active = useActiveSection(TOC.map(([id]) => id));
  const c = EX.counts;
  return (
    <>
      <SporeCanvas density={0.35} />
      <div className="docs">
        <aside className="docs-toc" aria-label="On this page">
          <span className="docs-toc-title">API v1</span>
          <nav>
            {TOC.map(([id, label]) => (
              <a key={id} href={`#${id}`} className={active === id ? "on" : undefined} aria-current={active === id ? "location" : undefined}>{label}</a>
            ))}
          </nav>
          <div className="docs-toc-sub">
            {ENDPOINTS.map(([id, p]) => <a key={id} href={`#${id}`} className="mono">{p}</a>)}
          </div>
        </aside>

        <div className="docs-main">
          <header className="page-head docs-hero">
            <span className="eyebrow">Developers · API v1</span>
            <h1>The family tree, <em>as an API</em>.</h1>
            <p className="lead">Every pump.fun coin quoted in another pump.fun coin, its parents, its children and the liquidity they lock, live. Read-only JSON, a live event stream and two drop-in widgets for trading terminals and coin pages.</p>
            <div className="docs-hero-actions">
              <a className="btn accent" href="#quick-start">Quick start</a>
              <a className="btn" href="/v1/openapi.json" target="_blank" rel="noreferrer">OpenAPI spec ↗</a>
              <a className="btn ghost" href={MAIL}>Request a partner key</a>
            </div>
            <div className="docs-facts">
              <div className="docs-fact base"><span>Base URL</span><b className="mono">{BASE}</b><CopyButton text={BASE} /></div>
              <div className="docs-fact"><span>Access</span><b>Read-only</b><small>GET only, nothing is ever signed or sent</small></div>
              <div className="docs-fact"><span>Free tier</span><b>60 req/min</b><small>no key, CORS open</small></div>
              <div className="docs-fact"><span>Embeds</span><b>1 iframe</b><small>tree or map, dark or light</small></div>
            </div>
          </header>

          <section id="overview" className="docs-section" aria-labelledby="overview-h">
            <h2 id="overview-h"><a href="#overview">Overview</a></h2>
            <div className="prose">
              <p>pump.fun's <code>create_v2</code> lets a coin be quoted in another pump.fun coin instead of SOL. Spore indexes that whole custom-pair ecosystem straight from the chain: every root that has a child, and every coin below it, about {n(Math.round(EX.stream.stats.coins / 1000) * 1000)} coins in {n(Math.round(c.roots / 100) * 100)} trees today. It is the data behind the <Link to="/map">map</Link> and every coin page on this site. <Link to="/how">How it works</Link> explains the mechanics.</p>
            </div>
            <dl className="docs-glossary">
              <div><dt>Root</dt><dd>A depth-0 coin, quoted in SOL, with at least one child.</dd></div>
              <div><dt>Parent · child</dt><dd>A child's quote mint is its parent: its bonding curve collects parent tokens instead of SOL, so buying the child buys the parent first.</dd></div>
              <div><dt>Depth</dt><dd>Hops from the root. pump.fun caps it at 2 today: root → child → grandchild.</dd></div>
              <div><dt>Locked</dt><dd>A coin's tokens held by its children's curves and pools, in USD. Permanent buy-side liquidity for the parent.</dd></div>
              <div><dt>Descendants</dt><dd>Every coin below a coin, at any depth.</dd></div>
              <div><dt>Spore launch</dt><dd>A coin launched through sporepad.com (<code>launchedOnSpore</code> / <code>ours</code>). The data covers every coin, not only these.</dd></div>
            </dl>
            <ul className="docs-rules">
              <li><b>JSON, camelCase.</b> Every field is always present; unknown values are <code>null</code>.</li>
              <li><b>Numbers.</b> Token amounts are strings in raw units, next to their <code>decimals</code>; USD values are numbers or <code>null</code>; timestamps are unix seconds. The map's sync cursor (<code>since</code>, <code>generatedAt</code>) is in milliseconds.</li>
              <li><b>Errors</b> are <code>{"{ \"error\": \"…\" }"}</code> with the status: 400 malformed input, 401 bad key, 404 not a pump.fun mint (or no such route), 405 anything but GET, 429 over the limit and 503 while an on-chain lookup is unavailable, both with <code className="nw">Retry-After</code>.</li>
              <li><b>Read-only.</b> Only <code>GET</code> (plus <code>HEAD</code> and <code>OPTIONS</code>). No endpoint signs, sends or accepts a transaction, and none ever will.</li>
            </ul>
          </section>

          <section id="quick-start" className="docs-section" aria-labelledby="qs-h">
            <h2 id="qs-h"><a href="#quick-start">Quick start</a></h2>
            <p className="docs-intro">No sign-up: the public tier needs no key. These use <Link to={`/c/${SPORE_MINT}`}>$SPORE</Link>, a live root with children on the map.</p>
            <CodeTabs label="Quick start examples" tabs={[
              { id: "curl", label: "curl", lang: "bash", code: QUICK_CURL },
              { id: "js", label: "fetch", lang: "js", code: QUICK_JS },
              { id: "sse", label: "Stream", lang: "js", code: QUICK_SSE },
              { id: "node", label: "Node + key", lang: "js", code: QUICK_NODE },
            ]} />
          </section>

          <section id="endpoints" className="docs-section" aria-labelledby="ep-h">
            <h2 id="ep-h"><a href="#endpoints">Endpoints</a></h2>
            <p className="docs-intro">All under <code>{BASE}</code>. Examples are real responses recorded from the index; <b>Run live</b> calls the same route from this page on the public tier.</p>

            <EndpointCard id="ep-family" path="/v1/coin/:mint/family"
              summary={<p>Where a coin sits, in one call: its root, parent and ancestors, its children ranked by locked value, descendant count, locked value, market cap, 24 h change, trades in the last hour, whether it launched on Spore, and links back. Built for a "family" panel on a coin page. Works for <b>any pump.fun mint</b>: one the index has not seen yet is looked up on-chain first.</p>}
              params={[{ name: "mint", in: "path", type: "string (base58)", required: true, desc: "Any pump.fun coin. 400 when malformed, 404 when pump.fun does not know it." }]}
              fields={FAMILY_FIELDS}
              request={`curl ${BASE}/coin/${SPORE_MINT}/family`}
              examples={[
                { id: "spore", label: "$SPORE · root", value: EX.familySpore, caption: <>A root: no parent, {EX.familySpore.children.count} children ranked by locked value.</> },
                { id: "mush", label: "$MUSHROOM · depth 2", value: EX.familyMush, caption: <>A grandchild: <code>ancestors</code> runs nearest first, $HYPHAE then $SPORE.</> },
              ]}
              live={() => `/v1/coin/${SPORE_MINT}/family`} />

            <EndpointCard id="ep-tree" path="/v1/tree/:mint"
              summary={<p>The whole tree that contains a coin, from its root down, as a flat list: the root first, then breadth-first, siblings by locked value. Pass any coin in the tree, root or child. Every node carries its <code>parentMint</code>, so the hierarchy rebuilds in one pass.</p>}
              params={[{ name: "mint", in: "path", type: "string (base58)", required: true, desc: "Any pump.fun coin. One without a family returns a tree of one node; one the index has not seen yet comes back with its chain to the root." }]}
              fields={NODE_FIELDS}
              notes={<CodeBlock code={TREE_JS} lang="js" title="Rebuild the hierarchy" />}
              request={`curl ${BASE}/tree/${MUSHROOM_MINT}`}
              examples={[{ id: "tree", label: "$SPORE tree", value: EX.tree, caption: <>{c.treeShown} of {c.treeTotal} nodes shown; <code>total</code> counts every node, the root included. Asking for $MUSHROOM returns the same tree.</> }]}
              live={() => `/v1/tree/${SPORE_MINT}`} />

            <EndpointCard id="ep-map" path="/v1/map"
              summary={<p>The entire ecosystem: every root with a tracked child and every descendant, as nested trees. The full download is large (about 6.5 MB of JSON, 1.5 MB compressed), so fetch it once and then ask for <code>since=</code> the <code>generatedAt</code> you hold: only the nodes whose row changed come back.</p>}
              params={[{ name: "since", in: "query", type: "integer (ms)", desc: <>The <code>generatedAt</code> of your copy (rounded down to the second). The answer is then <code>{"{ nodes, removed, generatedAt, version, total }"}</code>: changed nodes, each with its <code>parentMint</code>; <code>removed</code> is reserved and empty today. Without it: <code>{"{ roots: MapNode[], scope, version, generatedAt, total }"}</code> with <code>MapNode = {"{ coin, children: MapNode[] }"}</code>.</> }]}
              fields={NODE_FIELDS}
              notes={<><p className="hint">A node's USD values move with its parent's price even when its own row does not change, so a delta-only copy drifts slowly. Run a full sync every 15 minutes, as the Spore map does; between syncs the stream's <code>heat</code> events keep the numbers current.</p><CodeBlock code={MAP_JS} lang="js" title="Full sync, then deltas" /></>}
              request={`curl --compressed "${BASE}/map?since=${EX.mapDelta.generatedAt - 60_000}"`}
              examples={[
                { id: "delta", label: "since= (delta)", value: EX.mapDelta, caption: <>{c.deltaShown} of {c.deltaTotal} changed nodes shown (one minute of changes).</> },
                { id: "full", label: "full", value: EX.mapFull, caption: <>1 of {n(c.roots)} roots shown; <code>total</code> counts every coin on the map.</> },
              ]}
              live={() => `/v1/map?since=${Date.now() - 60_000}`} />

            <EndpointCard id="ep-heat" path="/v1/heat"
              summary={<p>Trading activity for every coin with a trade in the last 24 h, as parallel arrays: busiest in the last hour first, then by 24 h volume. Rebuilt at most every 15 s; about 60 KB compressed. Use it for "hot" lists and activity badges.</p>}
              params={[]}
              fields={HEAT_FIELDS}
              notes={<CodeBlock code={`const heat = await (await fetch("${BASE}/heat")).json();\nconst rows = heat.mint.map((mint, i) => ({ mint, trades1h: heat.t1h[i], buys1h: heat.buys1h[i], volume24h: heat.v24[i] }));`} lang="js" title="Rows from the arrays" />}
              request={`curl ${BASE}/heat`}
              examples={[{ id: "heat", label: "heat", value: EX.heat, caption: <>{c.heatShown} of {n(c.heatMints)} mints shown.</> }]}
              live={() => "/v1/heat"} />
          </section>

          <section id="stream" className="docs-section" aria-labelledby="stream-h">
            <h2 id="stream-h"><a href="#stream">Live stream</a></h2>
            <div className="docs-endpoint card" id="ep-stream">
              <header className="docs-endpoint-head">
                <h3><span className="docs-method">GET</span><code className="docs-path"><PathText path="/v1/stream" /></code></h3>
                <CopyButton text={`${BASE}/stream?types=pair,trade,heat,stats`} label="Copy URL" className="ghost" />
              </header>
              <div className="docs-endpoint-body">
                <div className="docs-endpoint-text"><p>Server-sent events: one long-lived <code>text/event-stream</code> response. Each frame is <code>event: &lt;type&gt;</code> plus one line of JSON in <code>data:</code>. A comment line (<code>: hb …</code>) arrives every 25 s as a heartbeat, and the stream asks clients to reconnect after 3 s (<code>retry: 3000</code>). EventSource does that on its own; after a gap, catch up with <a href="#ep-map"><code>/v1/map?since=</code></a>.</p></div>
                <Params params={[
                  { name: "types", in: "query", type: "list", desc: <>Comma-separated, from <code>pair</code>, <code>trade</code>, <code>heat</code>, <code>stats</code>, <code>mapdelta</code>, <code>coin</code>. Default: <code>pair,trade,heat,stats</code>. An unknown type is a 400.</> },
                  { name: "mint", in: "query", type: "string (base58)", desc: "Only events from the tree that contains this coin (its root or any coin in it). stats is never filtered." },
                  { name: "key", in: "query", type: "spk_…", desc: <>A partner key, for clients that cannot set headers (EventSource). Accepted on this route only; anywhere else it is a 400, send <code className="nw">X-API-Key</code>.</> },
                ]} />
                <div className="docs-events" role="table" aria-label="Event types">
                  {STREAM_EVENTS.map((e) => (
                    <div role="row" key={e.type} className="docs-event">
                      <span role="cell" className={`docs-ev type-${e.type}`}>{e.type}</span>
                      <span role="cell" className="docs-event-text">{e.when}<code>{e.shape}</code></span>
                    </div>
                  ))}
                </div>
                <CodeBlock code={`curl -N "${BASE}/stream?types=trade,heat&mint=${SPORE_MINT}"`} lang="bash" title="Request" />
                <CodeTabs label="Stream event payloads" tall tabs={[
                  { id: "pair", label: "pair", lang: "json", code: json(EX.stream.pair), caption: <>The <code>data</code> of an <code>event: pair</code> frame, as it arrived. A coin seconds old can still have <code>null</code> prices and image until the next refresh fills them; a <code>mapdelta</code> or <code>/v1/map?since=</code> brings them.</> },
                  { id: "trade", label: "trade", lang: "json", code: json(EX.stream.trade), caption: <>Amounts are raw units: <code>baseAmount</code> in the coin's 6 decimals, <code>quoteAmount</code> in its quote's (SOL: 9). <code>time</code> is unix seconds.</> },
                  { id: "heat", label: "heat", lang: "json", code: json(EX.stream.heat), caption: <>The coin's /v1/heat row after the trade above it; <code>at</code> and <code>last</code> are unix seconds.</> },
                  { id: "mapdelta", label: "mapdelta", lang: "json", code: json(EX.stream.mapdelta), caption: <>2 of {c.mapdeltaEntries} entries shown. <code>at</code> is in milliseconds, like the map cursor.</> },
                  { id: "stats", label: "stats", lang: "json", code: json(EX.stream.stats) },
                ]} />
                <h4 className="docs-sub">Try it from this page</h4>
                <StreamConsole />
              </div>
            </div>
          </section>

          <section id="embeds" className="docs-section" aria-labelledby="embeds-h">
            <h2 id="embeds-h"><a href="#embeds">Embeds</a></h2>
            <div className="prose">
              <p>Two widgets, one iframe each, no script and no key. They draw with the same engine as the <Link to="/map">Spore map</Link>, without the site around them, and fit any frame from 320 × 240 up. They never navigate your page: <b>Launch under on Spore ↗</b> and <b>Powered by Spore</b> open sporepad.com in a new tab.</p>
            </div>
            <div className="docs-embed-kinds">
              <div className="card pad"><code className="docs-path"><PathText path="/embed/tree/<mint>" /></code><p className="hint">The coin's family tree, headed "Family tree · $TICKER", with the coin in focus. For a coin page.</p></div>
              <div className="card pad"><code className="docs-path"><PathText path="/embed/map" /></code><p className="hint">The whole ecosystem map. <code>?focus=&lt;mint&gt;</code> opens it on a coin. For a discovery tab.</p></div>
            </div>
            <SnippetGenerator />
            <Params params={[
              { name: "theme", in: "query", type: "dark | light", desc: "Default dark. Pick the one closest to your page." },
              { name: "hideHeader", in: "query", type: "1", desc: "Drops the header row (title and launch button) for tight slots. The Powered by Spore link stays." },
              { name: "focus", in: "query", type: "string (base58)", desc: "Map only: the coin to open on." },
            ]} />
            <p className="hint docs-embed-note">Framing is allowed from any site on <code>/embed/*</code> only; every other Spore page refuses to be framed. If you sandbox the frame, keep <code>allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox</code> so the widget can load its data and open Spore in a new tab.</p>
          </section>

          <section id="keys" className="docs-section" aria-labelledby="keys-h">
            <h2 id="keys-h"><a href="#keys">Keys &amp; limits</a></h2>
            <div className="docs-table-wrap">
              <table className="table docs-tiers">
                <thead><tr><th scope="col"><span className="docs-sr">Limit</span></th><th scope="col">Public</th><th scope="col">Partner</th></tr></thead>
                <tbody>
                  <tr><th scope="row">Key</th><td>none</td><td><code>X-API-Key: spk_…</code></td></tr>
                  <tr><th scope="row">Requests</th><td className="mono">60 / min per IP</td><td className="mono accent">1 200 / min per key</td></tr>
                  <tr><th scope="row">Open streams</th><td className="mono">2 per IP</td><td className="mono accent">20 per key</td></tr>
                  <tr><th scope="row">Cost</th><td>free</td><td>free, on request</td></tr>
                </tbody>
              </table>
            </div>
            <div className="docs-cols">
              <div className="prose">
                <h3>Sending a key</h3>
                <p>Keys look like <code className="nw">spk_</code> followed by 32 base58 characters. Send one as the <code className="nw">X-API-Key</code> header; only the stream also takes <code className="nw">?key=</code>, for EventSource. A key is shown once when it is issued and stored only as a hash, so a lost key is replaced, never recovered.</p>
                <p>Keep partner keys on your servers. Browsers can call the API directly on the public tier (CORS is open: <code>Access-Control-Allow-Origin: *</code>, no credentials).</p>
              </div>
              <div className="prose">
                <h3>Headers and errors</h3>
                <p>Every response says which tier served it in <code className="nw">X-Spore-Tier</code> (<code>public</code> or <code>partner</code>) and how much is left in <code className="nw">X-RateLimit-Limit</code>, <code className="nw">X-RateLimit-Remaining</code> and <code className="nw">X-RateLimit-Reset</code> (unix seconds). Over the limit, or over the open-stream cap: <code>429</code> with <code className="nw">Retry-After</code>. An unknown or revoked key: <code>401</code>; it never falls back to the public tier silently.</p>
              </div>
              <div className="prose">
                <h3>Caching</h3>
                <p>Family, tree, map and heat send <code>Cache-Control: public, max-age=5, s-maxage=10</code> and an <code className="nw">ETag</code>: send <code className="nw">If-None-Match</code> and an unchanged answer is a bodyless <code>304</code>. The data moves every few seconds, so polling faster than 5 s gains nothing; for anything live, use the stream (<code>no-store</code>). A response served from the CDN can carry the rate headers of an earlier caller.</p>
              </div>
            </div>
            <div className="docs-key-cta card pad">
              <div><b>Need more than the public tier?</b><p className="hint">Tell us the product, a contact and the traffic you expect. Partner keys are free.</p></div>
              <div className="docs-key-links">
                <a className="btn accent" href={MAIL}>team@sporepad.com</a>
                <a className="btn" href={X_URL} target="_blank" rel="noreferrer">DM @Sporemap ↗</a>
              </div>
            </div>
          </section>

          <section id="terms" className="docs-section" aria-labelledby="terms-h">
            <h2 id="terms-h"><a href="#terms">Attribution &amp; terms</a></h2>
            <ul className="docs-terms">
              <li><b>Credit the data.</b> Wherever Spore data appears, show <b>"Data by Spore"</b> with a link to <a href="https://sporepad.com" target="_blank" rel="noreferrer">sporepad.com</a> (or to the coin's <code>links.spore</code>). The embeds already carry it.</li>
              <li><b>Free.</b> The public tier needs no sign-up; partner keys are free on request.</li>
              <li><b>Read-only, as-is.</b> The data comes from public on-chain state and is provided without warranty or uptime guarantee. It is not investment advice; these are memecoins and they are risky.</li>
              <li><b>Be gentle.</b> Cache, use <code>since=</code> and the stream rather than tight polling. A key that keeps ignoring its limits can be revoked.</li>
            </ul>
            <CodeBlock code={ATTRIBUTION} lang="html" title="Attribution link" />
          </section>

          <section id="openapi" className="docs-section" aria-labelledby="openapi-h">
            <h2 id="openapi-h"><a href="#openapi">OpenAPI</a></h2>
            <p className="docs-intro">Every <code>/v1</code> route with its parameters, schemas and examples, as an OpenAPI 3.1 document: the six paths above, the response schemas (<code>Family</code>, <code>Tree</code>, <code>MapFull</code>, <code>MapDelta</code>, <code>Heat</code>, the stream events…) and both ways to send a key. Import it into Postman or Insomnia, or generate a typed client.</p>
            <CodeBlock lang="bash" title="Shell" code={`curl ${BASE}/openapi.json -o spore-openapi.json\n\n# a typed TypeScript client, for example\nnpx @openapitools/openapi-generator-cli generate \\\n  -i ${BASE}/openapi.json -g typescript-fetch -o ./spore-client`} />
            <div className="docs-foot">
              <a className="btn" href="/v1/openapi.json" target="_blank" rel="noreferrer">Open openapi.json ↗</a>
              <Link className="btn ghost" to="/map">See the data on the map</Link>
            </div>
          </section>
        </div>
      </div>
    </>
  );
}
