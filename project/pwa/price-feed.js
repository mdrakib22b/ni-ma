/* =============================================================================
 * Ni'ma — client-side price feed
 * -----------------------------------------------------------------------------
 * One small class the app talks to for prices. LIVE data only — there is no
 * simulator: it polls the serverless proxy (pwa/api/quotes.js), which holds
 * the Finnhub key. On any failure it reports 'offline' and the app keeps
 * showing last-known prices; when the market is closed the app holds the last
 * close and shows "Market Closed".
 *
 * The price map the app keeps is:  { TICKER: { cur, prev } }, both in the
 * ticker's NATIVE currency (USD for US names, CAD for TSX). The app converts to
 * CAD itself using the live USD->CAD rate, so the feed must never pre-convert.
 * ========================================================================== */

export class PriceFeed {
  constructor(opts = {}) {
    this.url       = opts.url || '';
    // Accepted for backwards-compat; live prices are kept in native currency and
    // the app does its own USD->CAD, so the feed no longer converts here.
    this.fxUsdCad  = opts.fxUsdCad || 1.42;
    this.cadTickers = new Set(opts.cadTickers || []);
    this.timeoutMs = opts.timeoutMs || 6000;
  }

  get live() { return !!this.url; }

  /* LIVE: GET {url}?symbols=AAPL,GOOG
     Proxy responds with { delayed, quotes: { AAPL:{c,pc,t}, ... }, fx:{USDCAD} }.
       c  = current price (native ccy)   pc = previous close (native ccy)
       t  = quote time (unix seconds)
     Prices are returned in the ticker's OWN currency (USD for US names, CAD for
     .TO names) — the app applies USD->CAD itself via the separate `fx` rate, so
     converting here would double-count. We only decide live vs delayed and pass
     the FX rate through. Throws on network/HTTP failure so the caller can flag
     'offline' and keep the last prices. */
  async fetchLive(symbols) {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const sep = this.url.includes('?') ? '&' : '?';
      const u = this.url + sep + 'symbols=' + encodeURIComponent(symbols.join(','));
      const r = await fetch(u, { signal: ctrl.signal });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const data = await r.json();

      const px = {};
      let newest = 0;
      const q = data.quotes || {};
      Object.keys(q).forEach(t => {
        const item = q[t];
        if (!item || item.c == null) return;
        // Store the native price as-is; the app converts to CAD with `fx` below.
        px[t]  = {
          cur:  +item.c.toFixed(2),
          prev: +(item.pc != null ? item.pc : item.c).toFixed(2),
        };
        if (item.t) newest = Math.max(newest, item.t * 1000);
      });

      const asOf  = newest || Date.now();
      const stale = (Date.now() - asOf) > 15 * 60 * 1000;   // >15 min behind = delayed
      const fx = (data.fx && typeof data.fx.USDCAD === 'number') ? data.fx.USDCAD : null;
      // base-CAD display-currency table: rates[X] = units of X per 1 CAD
      const fxRates = (data.fxRates && typeof data.fxRates.USD === 'number') ? data.fxRates : null;
      return { status: (data.delayed || stale) ? 'delayed' : 'live', asOf, px, fx, fxRates };
    } finally {
      clearTimeout(to);
    }
  }

  /* LIVE: GET {url}?profile=AAPL
     Proxy responds with { profile: { name, industry, currency } } (or null).
     Used by the Add-holding sheet to auto-fill company/sector/currency for any
     listed ticker. Returns null on any failure so the caller can silently fall
     back to the built-in ticker table. */
  async fetchProfile(symbol) {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const sep = this.url.includes('?') ? '&' : '?';
      const u = this.url + sep + 'profile=' + encodeURIComponent(symbol);
      const r = await fetch(u, { signal: ctrl.signal });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const data = await r.json();
      return (data && data.profile) ? data.profile : null;
    } finally {
      clearTimeout(to);
    }
  }

  /* LIVE: GET {url}?history=AAPL&days=120
     Proxy responds with { history: [[ 'YYYY-MM-DD', close ], ...] } in the
     ticker's NATIVE currency. Used to backfill the portfolio chart's daily
     history on open (past closes never change), so the curve shows real
     day-to-day moves even for days the app wasn't running. Returns [] on any
     failure so the caller silently skips the backfill. */
  async fetchHistory(symbol, days = 120) {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const sep = this.url.includes('?') ? '&' : '?';
      const u = this.url + sep + 'history=' + encodeURIComponent(symbol) + '&days=' + encodeURIComponent(days);
      const r = await fetch(u, { signal: ctrl.signal });
      if (!r.ok) return [];
      const data = await r.json();
      return (data && Array.isArray(data.history)) ? data.history : [];
    } catch (e) {
      return [];
    } finally {
      clearTimeout(to);
    }
  }
}
