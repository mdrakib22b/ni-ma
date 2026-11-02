/* =============================================================================
 * Ni'ma — shared helpers for the sync / push functions
 * -----------------------------------------------------------------------------
 * The leading underscore keeps Vercel from deploying this file as a function of
 * its own; account.mjs, vault.mjs, push.mjs and reminders.mjs import it.
 *
 * Every function here talks to Supabase over its REST APIs with plain fetch
 * (no SDK, so nothing to install). The app only ever calls these same-origin
 * endpoints, which keeps the Supabase URL and keys in Vercel env vars and the
 * CSP's connect-src at 'self'.
 *
 * ENV VARS (Vercel → Settings → Environment Variables, then redeploy)
 *   SUPABASE_URL               https://<project>.supabase.co
 *   SUPABASE_ANON_KEY          the project's anon / publishable key
 *   SUPABASE_SERVICE_ROLE_KEY  service role / secret key (account delete + reminders)
 *   VAPID_PUBLIC_KEY           } from `npm run vapid` at the repo root
 *   VAPID_PRIVATE_KEY          }
 *   VAPID_SUBJECT              mailto:you@example.com (push services require a contact)
 *   CRON_SECRET                any long random string; Vercel Cron sends it
 *   APP_URL                    optional; where email links land (defaults to this host)
 * ========================================================================== */

export function headerOf(req, name) {
  const h = req && req.headers;
  if (!h) return '';
  if (typeof h.get === 'function') return h.get(name) || '';
  return h[name] || h[name.toLowerCase()] || '';
}

export function getQuery(req) {
  if (req && req.query && typeof req.query === 'object') return req.query;
  try { return Object.fromEntries(new URL(req.url, 'http://x').searchParams); } catch (e) { return {}; }
}

// JSON body under either calling convention: a pre-parsed req.body (Node
// helpers), a Web Request (req.json()), or a raw Node stream.
export async function readBody(req) {
  try {
    if (req.body != null) return typeof req.body === 'string' ? JSON.parse(req.body || 'null') : req.body;
    if (typeof req.json === 'function') return await req.json();
    if (typeof req.on === 'function') {
      const chunks = [];
      await new Promise((ok, fail) => { req.on('data', (c) => chunks.push(c)); req.on('end', ok); req.on('error', fail); });
      const s = Buffer.concat(chunks).toString('utf8');
      return s ? JSON.parse(s) : null;
    }
  } catch (e) { return null; }
  return null;
}

export function bearer(req) {
  const m = /^Bearer\s+(.+)$/i.exec(headerOf(req, 'authorization') || '');
  return m ? m[1].trim() : '';
}

// Signature-agnostic wrapper, same contract as quotes.mjs: `build(req)` returns
// { status, body, headers? } and never touches a response object, so a missing
// `res` (Web signature) or an unexpected throw can't crash the function.
export function serve(build) {
  return async function handler(req, res) {
    let out;
    try { out = await build(req); }
    catch (e) {
      console.error('[api]', e);
      out = { status: 500, body: { error: 'internal', detail: String((e && e.message) || e) } };
    }
    const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', ...(out.headers || {}) };
    const payload = out.body == null ? null : JSON.stringify(out.body);
    if (res && typeof res.setHeader === 'function' && typeof res.end === 'function') {
      res.statusCode = out.status;
      for (const k in headers) res.setHeader(k, headers[k]);
      if (payload == null) res.end(); else res.end(payload);
      return;
    }
    return new Response(out.status === 204 ? null : payload, { status: out.status, headers });
  };
}

export const reply = (status, body) => ({ status, body });

function env() {
  return {
    url: (process.env.SUPABASE_URL || '').replace(/\/+$/, ''),
    anon: process.env.SUPABASE_ANON_KEY || '',
    service: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  };
}
export function configured() { const e = env(); return !!(e.url && e.anon); }
export function hasService() { return configured() && !!env().service; }

// One Supabase REST call. `token` is the signed-in user's access token, so
// Postgres row-level security decides what it can touch; `service` uses the
// service key instead (bypasses RLS — only the cron job and account delete).
// Legacy keys are JWTs and also go in Authorization; the newer sb_publishable_ /
// sb_secret_ keys are not JWTs and must only ride in `apikey`.
export async function supa(path, { method = 'GET', token, service = false, body, headers = {} } = {}) {
  const e = env();
  const key = service ? e.service : e.anon;
  const h = { apikey: key, ...headers };
  if (token) h.Authorization = 'Bearer ' + token;
  else if (key.startsWith('eyJ')) h.Authorization = 'Bearer ' + key;
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const r = await fetch(e.url + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (err) { data = text; }
  return { status: r.status, ok: r.ok, data };
}

// Where Supabase's email links (confirm / reset password) send the user back to.
export function appUrl(req) {
  if (process.env.APP_URL) return process.env.APP_URL;
  const host = headerOf(req, 'x-forwarded-host') || headerOf(req, 'host');
  return host ? `https://${host}/` : '';
}
