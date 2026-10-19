// Server-sent events hub for /api/events: `coin`, `trade` and `stats` events plus a heartbeat
// comment every 15 s so proxies and browsers keep the connection open.
//
// Connections are bounded (per client IP and in total) and a client that stops reading is dropped
// once Node has buffered `maxBuffered` bytes for it: `res.write` never blocks, so without that
// check a few hundred stalled sockets would keep every frame in memory for as long as they live.
export class EventHub {
  constructor({ heartbeatMs = 15_000, maxClients = 2_000, maxPerIp = 5, maxBuffered = 256 * 1024 } = {}) {
    this.clients = new Set();
    this.perIp = new Map();
    this.maxClients = maxClients; this.maxPerIp = maxPerIp; this.maxBuffered = maxBuffered;
    this.stats = { refused: 0, dropped: 0 };
    this.listeners = new Set(); // in-process consumers of every event (the /v1 stream, DESIGN §12)
    this.timer = setInterval(() => this.#heartbeat(), heartbeatMs);
    this.timer.unref();
  }

  attach(req, res) {
    const ip = req.ip ?? req.socket?.remoteAddress ?? "?";
    const mine = this.perIp.get(ip) ?? 0;
    if (this.clients.size >= this.maxClients || mine >= this.maxPerIp) {
      this.stats.refused++;
      const perIp = mine >= this.maxPerIp;
      res.setHeader("retry-after", perIp ? "10" : "30");
      return res.status(perIp ? 429 : 503).json({ error: perIp ? `at most ${this.maxPerIp} event streams per client` : "too many event streams open, try again shortly", retryAfter: perIp ? 10 : 30 });
    }
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no", // nginx would otherwise buffer the stream
    });
    res.write(": connected\n\n");
    res.sseIp = ip;
    this.clients.add(res);
    this.perIp.set(ip, mine + 1);
    req.on("close", () => this.#forget(res));
  }

  emit(event, data) {
    for (const fn of this.listeners) { try { fn(event, data); } catch { /* a listener never breaks the stream */ } }
    if (!this.clients.size) return;
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of this.clients) this.#write(res, frame);
  }

  /** Calls `fn(event, data)` for every event emitted from now on; returns the unsubscribe function. */
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  #heartbeat() { for (const res of this.clients) this.#write(res, `: hb ${Date.now()}\n\n`); }
  #write(res, frame) {
    try {
      res.write(frame);
      // Backpressure: `write` returned false earlier and the socket never drained. Rather than let
      // the buffer grow with every tick, the stalled client is cut; a live one reconnects at once.
      if (res.writableLength > this.maxBuffered) { this.stats.dropped++; this.#drop(res); }
    } catch { this.#drop(res); }
  }
  #forget(res) {
    if (!this.clients.delete(res)) return;
    const n = (this.perIp.get(res.sseIp) ?? 1) - 1;
    if (n > 0) this.perIp.set(res.sseIp, n); else this.perIp.delete(res.sseIp);
  }
  #drop(res) { this.#forget(res); try { res.destroy(); } catch { /* already gone */ } }

  close() { this.listeners.clear(); clearInterval(this.timer); for (const res of this.clients) { try { res.end(); } catch { /* closing */ } } this.clients.clear(); this.perIp.clear(); }
}
