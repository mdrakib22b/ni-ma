/* =============================================================================
 * Ni'ma — encrypted vault endpoint (one row per user)
 * -----------------------------------------------------------------------------
 * Stores exactly what the app hands it: `blob`, the app data already encrypted
 * on the device with a random data key, and `keys`, that data key locked with
 * the user's password and with their recovery key. Neither can be opened here.
 * Row-level security (supabase/schema.sql) limits every call to the caller's
 * own row, because each request carries the user's own access token.
 *
 *   GET            -> { vault: { version, updated_at, keys, blob } | null }
 *   GET ?meta=1    -> { vault: { version, updated_at } | null }
 *   GET ?keys=1    -> { vault: { version, updated_at, keys } | null }
 *   PUT { base, blob, keys? }  write the data. `base` is the version this device
 *                  last saw (0 = create); a stale base gets 409 { version } so
 *                  two devices can't silently overwrite each other.
 *   PUT { keys }   re-lock the data key (password change / new recovery key);
 *                  leaves the data and its version alone.
 *   DELETE         remove the vault (the account stays).
 * ========================================================================== */
import { serve, reply, readBody, bearer, supa, configured, getQuery } from './_lib.mjs';

const MAX_BLOB = 4_000_000;   // Vercel caps request bodies at ~4.5 MB
const isBox = (o) => o && typeof o === 'object' && typeof o.iv === 'string' && typeof o.ct === 'string';
const okKeys = (k) => k && typeof k === 'object' && isBox(k.pw) && isBox(k.rk) && typeof k.rk.salt === 'string'
  && JSON.stringify(k).length < 4000;

const unauth = (r) => r.status === 401 || (r.status === 403 && /jwt/i.test(JSON.stringify(r.data || '')));

async function current(token) {
  const r = await supa('/rest/v1/vaults?select=version', { token });
  return r.ok && Array.isArray(r.data) && r.data[0] ? r.data[0].version : 0;
}

async function build(req) {
  if (!configured()) return reply(503, { error: 'not_configured' });
  const token = bearer(req);
  if (!token) return reply(401, { error: 'signed_out' });
  const method = (req.method || 'GET').toUpperCase();

  if (method === 'GET') {
    const q = getQuery(req);
    const cols = q.meta ? 'version,updated_at' : q.keys ? 'version,updated_at,keys' : 'version,updated_at,keys,blob';
    const r = await supa(`/rest/v1/vaults?select=${cols}`, { token });
    if (unauth(r)) return reply(401, { error: 'signed_out' });
    if (!r.ok) return reply(502, { error: 'upstream' });
    return reply(200, { vault: (Array.isArray(r.data) && r.data[0]) || null });
  }

  if (method === 'PUT') {
    const b = (await readBody(req)) || {};
    if (b.keys !== undefined && !okKeys(b.keys)) return reply(400, { error: 'bad_keys' });

    // keys only — re-locking the data key never changes the data or its version
    if (b.blob === undefined) {
      if (!b.keys) return reply(400, { error: 'bad_request' });
      const r = await supa('/rest/v1/vaults?version=gte.0&select=version', { method: 'PATCH', token, body: { keys: b.keys },
        headers: { Prefer: 'return=representation' } });
      if (unauth(r)) return reply(401, { error: 'signed_out' });
      if (!r.ok) return reply(502, { error: 'upstream' });
      if (!Array.isArray(r.data) || !r.data.length) return reply(404, { error: 'no_vault' });
      return reply(200, { version: r.data[0].version });
    }

    if (typeof b.blob !== 'string' || !b.blob) return reply(400, { error: 'bad_request' });
    if (b.blob.length > MAX_BLOB) return reply(413, { error: 'too_large' });
    const base = Number.isInteger(b.base) && b.base >= 0 ? b.base : -1;
    if (base < 0) return reply(400, { error: 'bad_request' });

    if (base === 0) {
      if (!b.keys) return reply(400, { error: 'bad_keys' });
      const r = await supa('/rest/v1/vaults?select=version', { method: 'POST', token,
        body: { version: 1, keys: b.keys, blob: b.blob }, headers: { Prefer: 'return=representation' } });
      if (unauth(r)) return reply(401, { error: 'signed_out' });
      if (r.status === 409) return reply(409, { error: 'conflict', version: await current(token) });
      if (!r.ok) return reply(502, { error: 'upstream' });
      return reply(200, { version: 1 });
    }

    const patch = { version: base + 1, blob: b.blob, updated_at: new Date().toISOString() };
    if (b.keys) patch.keys = b.keys;
    const r = await supa(`/rest/v1/vaults?version=eq.${base}&select=version`, { method: 'PATCH', token, body: patch,
      headers: { Prefer: 'return=representation' } });
    if (unauth(r)) return reply(401, { error: 'signed_out' });
    if (!r.ok) return reply(502, { error: 'upstream' });
    if (!Array.isArray(r.data) || !r.data.length) return reply(409, { error: 'conflict', version: await current(token) });
    return reply(200, { version: base + 1 });
  }

  if (method === 'DELETE') {
    const r = await supa('/rest/v1/vaults?version=gte.0', { method: 'DELETE', token });
    if (unauth(r)) return reply(401, { error: 'signed_out' });
    if (!r.ok) return reply(502, { error: 'upstream' });
    return reply(200, { ok: true });
  }

  return reply(405, { error: 'method not allowed' });
}

export default serve(build);
