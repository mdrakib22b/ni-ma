/* =============================================================================
 * Ni'ma — live stock-price proxy
 * -----------------------------------------------------------------------------
 * WHY THIS FILE EXISTS
 *   Your Finnhub API key must NEVER ship in the front-end. Anyone could open
 *   dev-tools and copy it. So the app calls THIS function instead, and this
 *   function (running on a server you control) holds the key and calls Finnhub.
 *
 *   Flow:   app  ->  /api/quotes?symbols=AAPL,GOOG  ->  [this proxy]  ->  Finnhub
 *
 * HOW TO GO LIVE  (about 10 minutes)
 *   1. Get a free key at https://finnhub.io  ->  Dashboard  ->  copy API key.
 *   2. Deploy this file (Vercel auto-detects /api/*.js as a serverless function).
 *   3. Set an env var on the host:   FINNHUB_KEY = your key   (redeploy after!)
 *
 * WHAT IT RETURNS  (shape the client expects)
 *   {
 *     "delayed": false,
 *     "quotes": { "AAPL": { "c": 212.44, "pc": 209.10, "t": 1719600000 } },
 *     "fx": { "USDCAD": 1.37 },
 *     "fxRates": { "CAD": 1, "USD": 0.73, ... }
 *   }
 *   The client converts USD -> CAD and computes day-change itself.
 *
 * SIGNATURE-AGNOSTIC
 *   The whole handler is written to work under BOTH function signatures Vercel
 *   may invoke it with — the classic Node `(req, res)` and the newer Web
 *   `Request -> Response`. Guessing wrong is what produced opaque
 *   FUNCTION_INVOCATION_FAILED crashes (a missing `res` meant even the error
 *   path couldn't respond). We build a plain result object and emit it either
 *   way, and log any unexpected error to the runtime logs.
 * ========================================================================== */

// --- config ---------------------------------------------------------------
const FINNHUB = 'https://finnhub.io/api/v1/quote';
const CACHE_TTL_MS = 15_000;   // serve cached quotes for 15s -> protects the
                               // free-tier rate limit (60 calls/min).
const MAX_SYMBOLS  = 40;       // guard against abuse / runaway requests.

// In-memory cache. Survives between invocations on a warm serverless instance.
const cache = new Map();       // symbol -> { quote, at }

// Map an app ticker to the symbol Finnhub expects. TSX names need a ".TO"
// suffix; US tickers pass through unchanged.
const SYMBOL_MAP = {
  CNR: 'CNR.TO', CP: 'CP.TO',
  TD:  'TD.TO', RY: 'RY.TO', BNS: 'BNS.TO', BMO: 'BMO.TO', ENB: 'ENB.TO',
  CSU: 'CSU.TO', DOL: 'DOL.TO', SU: 'SU.TO', CNQ: 'CNQ.TO',
  XIU: 'XIU.TO', VFV: 'VFV.TO', XEQT: 'XEQT.TO', VEQT: 'VEQT.TO', WSHR: 'WSHR.NE',
};
function toFinnhub(ticker) { return SYMBOL_MAP[ticker] || ticker; }

// --- historical daily closes (for the portfolio chart's day-to-day backfill) --
// Native currency, no API key. Finnhub's candle endpoint is paywalled on the
// free tier, so we use keyless public sources: Yahoo's chart JSON (same ".TO"
// symbol form we already map, covers US + TSX) with a Stooq CSV fallback (US).
// Every path returns [] on any failure so the client simply gets no backfill —
// the chart still works, it just lacks anchors for the un-fetched days.
const ISO_DAY = (secs) => new Date(secs * 1000).toISOString().slice(0, 10);

async function yahooDaily(sym) {
  try {
    const now = Math.floor(Date.now() / 1000);
    const from = now - 800 * 24 * 60 * 60;
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?period1=${from}&period2=${now}&interval=1d`;
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) return [];
    const d = await r.json();
    const res = d && d.chart && d.chart.result && d.chart.result[0];
    const ts = res && res.timestamp;
    const cl = res && res.indicators && res.indicators.quote && res.indicators.quote[0] && res.indicators.quote[0].close;
    if (!ts || !cl) return [];
    const out = [];
    for (let i = 0; i < ts.length; i++) {
      const c = cl[i];
      if (c == null || !isFinite(c)) continue;
      out.push([ISO_DAY(ts[i]), Math.round(c * 1e4) / 1e4]);
    }
    return out;
  } catch (e) { return []; }
}

async function stooqDaily(ticker) {
  try {
    // Stooq US symbols carry a ".us" suffix; only attempt when no exchange suffix
    // is already present (TSX coverage there is unreliable — Yahoo handles those).
    const s = /\./.test(ticker) ? ticker.toLowerCase() : (ticker.toLowerCase() + '.us');
    const r = await fetch(`https://stooq.com/q/d/l/?s=${encodeURIComponent(s)}&i=d`);
    if (!r.ok) return [];
    const txt = await r.text();
    const lines = txt.trim().split('\n');
    if (lines.length < 2 || !/^date/i.test(lines[0])) return [];   // Date,Open,High,Low,Close,Volume
    const out = [];
    for (let i = 1; i < lines.length; i++) {
      const p = lines[i].split(',');
      const c = parseFloat(p[4]);
      if (p[0] && isFinite(c)) out.push([p[0], Math.round(c * 1e4) / 1e4]);
    }
    return out;
  } catch (e) { return []; }
}

// Full history per ticker, cached 6h (daily closes change at most once/day).
async function histCloses(ticker, days) {
  const sym = toFinnhub(ticker);
  const ck = 'HIST:' + sym;
  const HIST_TTL = 6 * 60 * 60 * 1000;
  const hit = cache.get(ck);
  let rows = (hit && (Date.now() - hit.at) < HIST_TTL) ? hit.quote : null;
  if (!rows) {
    rows = await yahooDaily(sym);
    if (!rows.length) rows = await stooqDaily(ticker);
    if (rows.length) cache.set(ck, { quote: rows, at: Date.now() });
  }
  if (!rows || !rows.length) return [];
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return rows.filter(([d]) => { const t = Date.parse(d); return !isNaN(t) && t >= cutoff; });
}

// Read query params from `req.query` when the runtime provides it, else parse
// them out of the raw URL — so it works whether or not the querystring is
// pre-parsed (Node req vs Web Request both expose `.url`).
function getQuery(req) {
  if (req && req.query && typeof req.query === 'object') return req.query;
  try { return Object.fromEntries(new URL(req.url, 'http://localhost').searchParams); }
  catch (e) { return {}; }
}

// Read one request header under either a Node headers object or a Web Headers.
function headerOf(req, name) {
  const h = req && req.headers;
  if (!h) return undefined;
  if (typeof h.get === 'function') return h.get(name);   // Web Headers
  return h[name];                                         // Node plain object
}

// --- the actual work: returns { status, headers, body } (body = JS object or
// null). No response object touched here, so it can't crash on a missing `res`.
async function build(req) {
  const headers = {
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'public, max-age=15',
  };
  // CORS: same-origin needs none; cross-origin must be opted in via ALLOWED_ORIGIN.
  const allowed = (process.env.ALLOWED_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
  const origin = headerOf(req, 'origin');
  if (origin && allowed.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Vary'] = 'Origin';
  }

  const method = (req.method || 'GET').toUpperCase();
  if (method === 'OPTIONS') return { status: 204, headers, body: null };
  if (method !== 'GET') return { status: 405, headers, body: { error: 'method not allowed' } };

  const key = process.env.FINNHUB_KEY;
  if (!key) return { status: 500, headers, body: { error: 'FINNHUB_KEY not configured' } };

  const query = getQuery(req);

  // --- company profile lookup: GET ?profile=TICKER -----------------------
  const profReq = (query.profile || '').toString().trim().toUpperCase();
  if (profReq) {
    if (!/^[A-Z0-9.\-:]{1,12}$/.test(profReq)) return { status: 400, headers, body: { error: 'bad symbol' } };
    const nowTs = Date.now();
    const sym = toFinnhub(profReq);
    const ck = 'PROFILE:' + sym;
    const PROFILE_TTL = 30 * 24 * 60 * 60 * 1000;   // 30 days — profiles are static
    const hit = cache.get(ck);
    if (hit && (nowTs - hit.at) < PROFILE_TTL) return { status: 200, headers, body: { profile: hit.quote } };
    try {
      const url = `https://finnhub.io/api/v1/stock/profile2?symbol=${encodeURIComponent(sym)}&token=${key}`;
      const r = await fetch(url);
      if (!r.ok) throw new Error('finnhub ' + r.status);
      const d = await r.json();
      if (d && (d.name || d.finnhubIndustry)) {
        const profile = { name: d.name || '', industry: d.finnhubIndustry || '', currency: (d.currency || '').toUpperCase() };
        cache.set(ck, { quote: profile, at: nowTs });
        return { status: 200, headers, body: { profile } };
      }
      return { status: 200, headers, body: { profile: null } };
    } catch (e) {
      return { status: 200, headers, body: { profile: null } };
    }
  }

  // --- daily-close history: GET ?history=TICKER&days=120 -----------------
  // Returns { history: [[ 'YYYY-MM-DD', close ], ...] } in the ticker's native
  // currency, so the client can backfill the portfolio chart on open.
  const histReq = (query.history || '').toString().trim().toUpperCase();
  if (histReq) {
    if (!/^[A-Z0-9.\-:]{1,12}$/.test(histReq)) return { status: 400, headers, body: { error: 'bad symbol' } };
    const days = Math.min(Math.max(parseInt(query.days, 10) || 120, 1), 800);
    const history = await histCloses(histReq, days);
    return { status: 200, headers, body: { history } };
  }

  // --- quotes: GET ?symbols=AAPL,GOOG ------------------------------------
  const raw = (query.symbols || '').toString();
  const tickers = raw.split(',').map(s => s.trim().toUpperCase())
                     .filter(s => /^[A-Z0-9.\-:]{1,12}$/.test(s)).slice(0, MAX_SYMBOLS);
  if (tickers.length === 0) return { status: 400, headers, body: { error: 'no symbols' } };

  const now = Date.now();
  const quotes = {};
  await Promise.all(tickers.map(async (ticker) => {
    const sym = toFinnhub(ticker);
    const hit = cache.get(sym);
    if (hit && (now - hit.at) < CACHE_TTL_MS) { quotes[ticker] = hit.quote; return; }
    try {
      const url = `${FINNHUB}?symbol=${encodeURIComponent(sym)}&token=${key}`;
      const r = await fetch(url);
      if (!r.ok) throw new Error('finnhub ' + r.status);
      const d = await r.json();
      if (d && typeof d.c === 'number' && d.c > 0) {
        const quote = { c: d.c, pc: d.pc, t: d.t };
        cache.set(sym, { quote, at: now });
        quotes[ticker] = quote;
      }
    } catch (e) {
      if (hit) quotes[ticker] = hit.quote;   // fall back to last cached value
    }
  }));

  // --- FX, once per request, cached ~6h. Frankfurter = ECB daily rates, free.
  // base-CAD table: rates[X] = units of X per 1 CAD.
  const DISPLAY_CCYS = 'USD,EUR,GBP,JPY,AUD,NZD,CHF,INR,CNY,HKD,SGD,MYR,MXN,BRL,ZAR';
  let fxRates = null;
  const fxHit = cache.get('FX:TABLE');
  if (fxHit && (now - fxHit.at) < 6 * 60 * 60 * 1000) {
    fxRates = fxHit.quote;
  } else {
    try {
      const fr = await fetch('https://api.frankfurter.app/latest?from=CAD&to=' + DISPLAY_CCYS);
      const fd = await fr.json();
      if (fd && fd.rates && typeof fd.rates.USD === 'number') {
        fxRates = { CAD: 1, ...fd.rates };
        cache.set('FX:TABLE', { quote: fxRates, at: now });
      }
    } catch (e) { if (fxHit) fxRates = fxHit.quote; }
  }
  const usdCad = (fxRates && fxRates.USD) ? +(1 / fxRates.USD).toFixed(4) : null;

  return { status: 200, headers, body: { delayed: false, quotes, fx: { USDCAD: usdCad }, fxRates } };
}

// --- the handler: build the result, then emit it under whichever signature
// Vercel used. Any unexpected error is logged (runtime logs) AND returned as
// JSON, so it can never collapse into an opaque FUNCTION_INVOCATION_FAILED.
export default async function handler(req, res) {
  let out;
  try {
    out = await build(req);
  } catch (err) {
    console.error('quotes proxy error:', (err && err.stack) || err);
    out = { status: 500, headers: { 'X-Content-Type-Options': 'nosniff' },
            body: { error: 'proxy error', detail: String((err && err.message) || err) } };
  }

  const payload = out.body == null ? null : JSON.stringify(out.body);
  const headers = { 'Content-Type': 'application/json; charset=utf-8', ...out.headers };

  // Node.js signature: (req, res) with an http.ServerResponse.
  if (res && typeof res.setHeader === 'function' && typeof res.end === 'function') {
    try {
      res.statusCode = out.status;
      for (const k in headers) res.setHeader(k, headers[k]);
      if (payload == null) res.end(); else res.end(payload);
      return;
    } catch (e) {
      console.error('quotes node-emit error:', (e && e.stack) || e);
    }
  }

  // Web signature: return a Response (204 must not carry a body).
  return new Response(payload, { status: out.status, headers });
}
