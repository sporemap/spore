// Exact sliding-window trade activity per mint: trades and USD volume over the last 24 h, trades and
// buys over the last hour, and the time of the last trade (DESIGN §11.5 "Activity (heat)").
//
// The 24 h numbers used to come from a GROUP BY over the trades table that every new trade
// invalidated, so at a few trades per second each /api/stats or /api/coin re-ran a 70–200 ms query
// on the event loop. Here every trade is an O(1) append to a time-ordered ring of typed arrays and
// two read heads (one per window) walk forward as time passes, decrementing the counters of the
// trades they leave behind. Reads cost nothing and nothing is allocated per trade.
//
// Trades arrive in time order from the live stream and from the boot seed (`ORDER BY time`). A trade
// older than the newest one recorded is appended anyway (a replayed or late event): the heads stop
// at the first trade still inside its window, so the windows' edges are then off by that skew until
// the newer trade in front of it expires too. Live skew is a few seconds at most.
//
// `volumes()` has exactly the shape and meaning of `Db.volume24hAll()` (Map<mint, { trades, usd }>,
// USD summed over the trades that carry one, mints without a trade in 24 h absent). Its value
// objects are created once per mint and mutated in place.

const BUY = 1;      // flag bit: the trade was a buy
const IN_HOUR = 2;  // flag bit: the trade was counted in the 1 h window when it was recorded
const U32_MAX = 0xffff_ffff;

export class Activity {
  constructor({ now = () => Math.floor(Date.now() / 1000), dayS = 86_400, hourS = 3_600, capacity = 4096 } = {}) {
    this.now = now; this.dayS = dayS; this.hourS = hourS;
    // Event ring: live events are [h24, tail); [h1, tail) are the ones the 1 h head has not passed.
    this.cap = Math.max(16, capacity);
    this.time = new Uint32Array(this.cap); this.usd = new Float64Array(this.cap); this.mid = new Int32Array(this.cap); this.flag = new Uint8Array(this.cap);
    this.h24 = 0; this.h1 = 0; this.tail = 0;
    // Per-mint counters by id. An id is released (and reused) when its 24 h count reaches zero.
    this.ids = new Map(); this.mintOf = []; this.free = [];
    this.idCap = 0; this.#growIds(256);
    this.vol = new Map(); this.volObj = [];
    this.seededMs = null;
  }

  #growIds(n) {
    const grow = (a, T) => { const b = new T(n); if (a) b.set(a); return b; };
    this.n24 = grow(this.n24, Uint32Array); this.u24 = grow(this.u24, Uint32Array);
    this.v24 = grow(this.v24, Float64Array); this.c24 = grow(this.c24, Float64Array);
    this.t1h = grow(this.t1h, Uint32Array); this.b1h = grow(this.b1h, Uint32Array); this.last = grow(this.last, Uint32Array);
    this.idCap = n;
  }
  #id(mint) {
    let id = this.ids.get(mint);
    if (id !== undefined) return id;
    id = this.free.length ? this.free.pop() : this.mintOf.length;
    if (id >= this.idCap) this.#growIds(this.idCap * 2);
    this.ids.set(mint, id); this.mintOf[id] = mint;
    this.n24[id] = 0; this.u24[id] = 0; this.v24[id] = 0; this.c24[id] = 0; this.t1h[id] = 0; this.b1h[id] = 0; this.last[id] = 0;
    const v = { trades: 0, usd: 0 };
    this.volObj[id] = v; this.vol.set(mint, v);
    return id;
  }
  /** Its last trade left the 24 h window: the counters are exactly zero again and the id is reusable. */
  #release(id) {
    const mint = this.mintOf[id];
    this.ids.delete(mint); this.vol.delete(mint);
    this.mintOf[id] = null; this.volObj[id] = null;
    this.n24[id] = 0; this.u24[id] = 0; this.v24[id] = 0; this.c24[id] = 0; this.t1h[id] = 0; this.b1h[id] = 0; this.last[id] = 0;
    this.free.push(id);
  }
  // USD sums are compensated (Neumaier), so a mint that sees thousands of adds and removes a day
  // does not drift away from a fresh SUM() over the same rows.
  #addUsd(id, x) {
    const s = this.v24[id], t = s + x;
    this.c24[id] += Math.abs(s) >= Math.abs(x) ? (s - t) + x : (x - t) + s;
    this.v24[id] = t;
  }
  #usdOf(id) { const v = this.v24[id] + this.c24[id]; return v > 0 ? v : 0; }

  /** Room for one more event at `tail`: drop the expired prefix when there is one, else double. */
  #makeRoom() {
    if (this.h24 > 0) { this.#compact(); if (this.tail < this.cap) return; }
    const n = this.cap * 2;
    const grow = (a, T) => { const b = new T(n); b.set(a); return b; };
    this.time = grow(this.time, Uint32Array); this.usd = grow(this.usd, Float64Array); this.mid = grow(this.mid, Int32Array); this.flag = grow(this.flag, Uint8Array);
    this.cap = n;
  }
  #compact() {
    const h = this.h24, n = this.tail - h;
    if (n > 0) { this.time.copyWithin(0, h, this.tail); this.usd.copyWithin(0, h, this.tail); this.mid.copyWithin(0, h, this.tail); this.flag.copyWithin(0, h, this.tail); }
    this.h1 -= h; this.tail = n; this.h24 = 0;
  }

  /**
   * Moves both heads past the trades that left their window at `nowS`. The 1 h head goes first: a
   * mint whose 24 h count then reaches zero has nothing left in the hour either, so its id can be
   * released at once.
   */
  #expire(nowS) {
    const hourCut = nowS - this.hourS, dayCut = nowS - this.dayS;
    const { time, flag, mid, tail } = this;
    let h = this.h1;
    while (h < tail && time[h] < hourCut) {
      const f = flag[h];
      if (f & IN_HOUR) { const id = mid[h]; this.t1h[id]--; if (f & BUY) this.b1h[id]--; }
      h++;
    }
    this.h1 = h;
    h = this.h24;
    while (h < tail && time[h] < dayCut) {
      const id = mid[h], x = this.usd[h];
      if (--this.n24[id] === 0) { this.#release(id); h++; continue; }
      if (x === x) { if (--this.u24[id] === 0) { this.v24[id] = 0; this.c24[id] = 0; } else this.#addUsd(id, -x); }
      const v = this.volObj[id]; v.trades = this.n24[id]; v.usd = this.#usdOf(id);
      h++;
    }
    this.h24 = h;
    if (h === tail) { this.h24 = 0; this.h1 = 0; this.tail = 0; }
    else if (h > this.cap >> 1) this.#compact();
  }

  /**
   * Counts one trade `{ mint, time (unix s), isBuy, valueUsd (number | null) }`. A trade older than
   * the 24 h window is ignored; returns whether it was counted.
   */
  record(t) {
    const nowS = this.now();
    this.#expire(nowS);
    const time = Math.floor(Number(t?.time));
    if (typeof t?.mint !== "string" || !Number.isFinite(time) || time < nowS - this.dayS) return false;
    const id = this.#id(t.mint);
    if (this.tail === this.cap) this.#makeRoom();
    const i = this.tail++;
    const x = typeof t.valueUsd === "number" && Number.isFinite(t.valueUsd) ? t.valueUsd : NaN;
    const inHour = time >= nowS - this.hourS;
    this.time[i] = Math.min(U32_MAX, Math.max(0, time)); this.usd[i] = x; this.mid[i] = id; this.flag[i] = (t.isBuy ? BUY : 0) | (inHour ? IN_HOUR : 0);
    this.n24[id]++;
    if (x === x) { this.u24[id]++; this.#addUsd(id, x); }
    if (inHour) { this.t1h[id]++; if (t.isBuy) this.b1h[id]++; }
    if (time > this.last[id]) this.last[id] = Math.min(U32_MAX, time);
    const v = this.volObj[id]; v.trades = this.n24[id]; v.usd = this.#usdOf(id);
    return true;
  }
  /** Seeds from stored trades in time order (`Db.tradesWindow`); returns how many were counted. */
  seed(rows) {
    let n = 0;
    for (const r of rows) if (this.record(r)) n++;
    return n;
  }

  /** `{ trades, usd, t1h, buys1h, last }` for a mint with a trade in the last 24 h, else null. */
  get(mint) {
    this.#expire(this.now());
    const id = this.ids.get(mint);
    if (id === undefined) return null;
    return { trades: this.n24[id], usd: this.#usdOf(id), t1h: this.t1h[id], buys1h: this.b1h[id], last: this.last[id] };
  }
  /** Map<mint, { trades, usd }>: the live 24 h volumes, same shape and meaning as Db.volume24hAll(). */
  volumes() {
    this.#expire(this.now());
    return this.vol;
  }
  /**
   * The map's heat sidecar: parallel arrays over every mint with a trade in the last 24 h (`keep`
   * narrows them, e.g. to tracked coins), most trades in the last hour first, then 24 h volume.
   * USD is rounded to cents.
   */
  heat({ keep = null } = {}) {
    const at = this.now();
    this.#expire(at);
    const ids = [];
    for (const [mint, id] of this.ids) if (!keep || keep(mint)) ids.push(id);
    ids.sort((a, b) => this.t1h[b] - this.t1h[a] || this.#usdOf(b) - this.#usdOf(a));
    const n = ids.length;
    const out = { at, since: at - this.dayS, mint: new Array(n), t1h: new Array(n), n24: new Array(n), v24: new Array(n), last: new Array(n), buys1h: new Array(n) };
    for (let k = 0; k < n; k++) {
      const id = ids[k];
      out.mint[k] = this.mintOf[id]; out.t1h[k] = this.t1h[id]; out.n24[k] = this.n24[id];
      out.v24[k] = Math.round(this.#usdOf(id) * 100) / 100; out.last[k] = this.last[id]; out.buys1h[k] = this.b1h[id];
    }
    return out;
  }
  /** `{ mints, events }` inside the 24 h window. */
  size() {
    this.#expire(this.now());
    return { mints: this.ids.size, events: this.tail - this.h24 };
  }
}
