// `logsSubscribe` on the pump program over a WebSocket, with reconnect and backoff.
//
// Uses Node's built-in WebSocket (no extra dependency). It has no ping API, so liveness is judged
// by traffic: the pump program logs many transactions per second, and a socket silent for
// `staleMs` is treated as dead and reopened. Every (re)connection calls `onConnect` so the indexer
// can run a refresh and close the gap the outage left.
export class LogsSubscriber {
  constructor({ wsUrl, programId, onLogs, onConnect, log = console, staleMs = 60_000 }) {
    this.wsUrl = wsUrl; this.programId = programId; this.onLogs = onLogs; this.onConnect = onConnect; this.log = log; this.staleMs = staleMs;
    this.ws = null; this.stopped = false; this.backoffMs = 0; this.connectedAt = 0; this.lastMessageAt = 0; this.reconnectTimer = null;
    this.stats = { connects: 0, messages: 0, notifications: 0, errors: 0, lastError: null };
    this.watchdog = setInterval(() => this.#checkStale(), 10_000); this.watchdog.unref();
  }

  start() { this.stopped = false; this.#connect(); return this; }
  stop() { this.stopped = true; clearInterval(this.watchdog); clearTimeout(this.reconnectTimer); this.reconnectTimer = null; this.#close(); }
  get connected() { return !!this.ws && this.ws.readyState === 1; }

  #connect() {
    if (this.stopped) return;
    let ws;
    try { ws = new WebSocket(this.wsUrl); } catch (e) { this.#failed(e); return; }
    this.ws = ws;
    ws.onopen = () => {
      this.stats.connects++; this.connectedAt = Date.now(); this.lastMessageAt = Date.now();
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "logsSubscribe", params: [{ mentions: [this.programId] }, { commitment: "confirmed" }] }));
      this.log.info?.(`live: subscribed to ${this.programId} logs`);
      try { this.onConnect?.(); } catch (e) { this.log.warn?.(`live: onConnect failed: ${e.message}`); }
    };
    ws.onmessage = (ev) => {
      this.lastMessageAt = Date.now(); this.stats.messages++;
      let msg;
      try { msg = JSON.parse(typeof ev.data === "string" ? ev.data : Buffer.from(ev.data).toString("utf8")); } catch { return; }
      if (msg.method !== "logsNotification") return;
      const v = msg.params?.result?.value; const slot = msg.params?.result?.context?.slot;
      if (!v || !Array.isArray(v.logs)) return;
      this.stats.notifications++;
      try { this.onLogs({ slot, signature: v.signature, err: v.err, logs: v.logs }); } catch (e) { this.stats.errors++; this.stats.lastError = e.message; }
    };
    ws.onerror = (ev) => { this.stats.errors++; this.stats.lastError = ev?.message ?? "socket error"; };
    ws.onclose = () => { if (this.ws === ws) { this.ws = null; this.#reconnect(); } };
  }
  #failed(e) { this.stats.errors++; this.stats.lastError = e.message; this.#reconnect(); }
  #reconnect() {
    if (this.stopped || this.reconnectTimer) return;
    // A connection that lived a while resets the backoff; a flapping one keeps doubling up to 30 s.
    // Jitter spreads reconnects so several instances behind one provider never retry in lockstep.
    this.backoffMs = Date.now() - this.connectedAt > 60_000 ? 1_000 : Math.min(30_000, Math.max(1_000, this.backoffMs * 2));
    const delay = jitter(this.backoffMs);
    this.log.warn?.(`live: disconnected, reconnecting in ${delay} ms`);
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.#connect(); }, delay);
    this.reconnectTimer.unref();
  }
  #checkStale() {
    if (this.ws && this.connected && Date.now() - this.lastMessageAt > this.staleMs) { this.log.warn?.("live: no messages for a minute, reopening the socket"); this.#close(); this.#reconnect(); }
  }
  #close() { const ws = this.ws; this.ws = null; try { ws?.close(); } catch { /* already closed */ } }

  snapshot() { return { ...this.stats, connected: this.connected, lastMessageAgoMs: this.lastMessageAt ? Date.now() - this.lastMessageAt : null, backoffMs: this.backoffMs, reconnecting: !!this.reconnectTimer }; }
}

/** Full jitter: a uniform delay in [base/2, base]. */
export function jitter(base, random = Math.random) { return Math.round(base / 2 + random() * (base / 2)); }
