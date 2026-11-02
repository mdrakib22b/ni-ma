/* =============================================================================
 * Ni'ma — account endpoint (sign up / in / out, password reset, delete)
 * -----------------------------------------------------------------------------
 * A thin pass-through to Supabase Auth. The "password" this endpoint receives
 * is NOT the user's password: the app stretches the real password on the
 * device and splits it in two — one half signs in here, the other unlocks the
 * encryption key and never leaves the device. So nothing that passes through
 * this server (or sits in Supabase) can decrypt the synced data.
 *
 *   GET                         -> { sync, push, vapidKey }   what's configured
 *   POST { action:'signup',  email, password }
 *   POST { action:'signin',  email, password }   -> { session }
 *   POST { action:'refresh', refresh_token }     -> { session }
 *   POST { action:'recover', email }             (always 200: no account probing)
 *   GET-ish with Authorization: Bearer <access token>
 *   POST { action:'user' }                       -> { user:{ id, email } }
 *   POST { action:'password', password }
 *   POST { action:'signout' }
 *   POST { action:'delete' }                     (account + its vault + push subs)
 * ========================================================================== */
import { serve, reply, readBody, bearer, supa, configured, hasService, appUrl } from './_lib.mjs';

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
const okEmail = (s) => typeof s === 'string' && s.length <= 320 && EMAIL_RE.test(s);
// the derived sign-in secret is 64 hex chars; allow some slack, refuse junk
const okPw = (s) => typeof s === 'string' && s.length >= 16 && s.length <= 200;

function session(d) {
  if (!d || !d.access_token || !d.refresh_token || !d.user) return null;
  return { access_token: d.access_token, refresh_token: d.refresh_token,
    expires_in: d.expires_in || 3600, user: { id: d.user.id, email: d.user.email } };
}
// GoTrue error bodies vary by version ({error_code}, {code}, {error_description}, {msg}).
function errCode(d) {
  if (!d || typeof d !== 'object') return '';
  return String(d.error_code || d.code || d.error || '') + ' ' + String(d.msg || d.message || d.error_description || '');
}

async function build(req) {
  const method = (req.method || 'GET').toUpperCase();
  if (method === 'GET') {
    const push = hasService() && !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
    return reply(200, { sync: configured(), push, vapidKey: push ? process.env.VAPID_PUBLIC_KEY : null });
  }
  if (method !== 'POST') return reply(405, { error: 'method not allowed' });
  if (!configured()) return reply(503, { error: 'not_configured' });

  const b = (await readBody(req)) || {};
  const token = bearer(req);
  const redirect = encodeURIComponent(appUrl(req));
  const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : '';

  switch (b.action) {
    case 'signup': {
      if (!okEmail(email) || !okPw(b.password)) return reply(400, { error: 'bad_request' });
      const r = await supa(`/auth/v1/signup?redirect_to=${redirect}`, { method: 'POST', body: { email, password: b.password } });
      if (!r.ok) {
        const c = errCode(r.data);
        if (/already|exists|registered/i.test(c)) return reply(409, { error: 'exists' });
        if (r.status === 429 || /rate/i.test(c)) return reply(429, { error: 'rate_limited' });
        return reply(r.status >= 500 ? 502 : 400, { error: 'signup_failed' });
      }
      // With email confirmation on (Supabase's default) there's no session yet.
      return reply(200, { session: session(r.data) });
    }
    case 'signin': {
      if (!okEmail(email) || !okPw(b.password)) return reply(400, { error: 'bad_request' });
      const r = await supa('/auth/v1/token?grant_type=password', { method: 'POST', body: { email, password: b.password } });
      if (!r.ok) {
        const c = errCode(r.data);
        if (/not.?confirmed/i.test(c)) return reply(403, { error: 'unconfirmed' });
        if (r.status === 429 || /rate/i.test(c)) return reply(429, { error: 'rate_limited' });
        if (r.status >= 500) return reply(502, { error: 'upstream' });
        return reply(401, { error: 'bad_login' });
      }
      return reply(200, { session: session(r.data) });
    }
    case 'refresh': {
      if (typeof b.refresh_token !== 'string' || !b.refresh_token || b.refresh_token.length > 2000) return reply(400, { error: 'bad_request' });
      const r = await supa('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: b.refresh_token } });
      if (!r.ok) return reply(r.status >= 500 ? 502 : 401, { error: 'signed_out' });
      return reply(200, { session: session(r.data) });
    }
    case 'recover': {
      if (!okEmail(email)) return reply(400, { error: 'bad_request' });
      const r = await supa(`/auth/v1/recover?redirect_to=${redirect}`, { method: 'POST', body: { email } });
      if (r.status === 429) return reply(429, { error: 'rate_limited' });
      return reply(200, { ok: true });
    }
    case 'user': {
      if (!token) return reply(401, { error: 'signed_out' });
      const r = await supa('/auth/v1/user', { token });
      if (!r.ok || !r.data || !r.data.id) return reply(401, { error: 'signed_out' });
      return reply(200, { user: { id: r.data.id, email: r.data.email } });
    }
    case 'password': {
      if (!token) return reply(401, { error: 'signed_out' });
      if (!okPw(b.password)) return reply(400, { error: 'bad_request' });
      const r = await supa('/auth/v1/user', { method: 'PUT', token, body: { password: b.password } });
      // Setting the same password again is not a failure for our purposes.
      if (!r.ok && !/same.?password/i.test(errCode(r.data))) {
        return reply(r.status === 401 || r.status === 403 ? 401 : 400, { error: 'password_failed' });
      }
      return reply(200, { ok: true });
    }
    case 'signout': {
      if (token) await supa('/auth/v1/logout', { method: 'POST', token }).catch(() => {});
      return reply(200, { ok: true });
    }
    case 'delete': {
      if (!token) return reply(401, { error: 'signed_out' });
      if (!hasService()) return reply(503, { error: 'not_configured' });
      const u = await supa('/auth/v1/user', { token });
      if (!u.ok || !u.data || !u.data.id) return reply(401, { error: 'signed_out' });
      // Deleting the auth user cascades to the vault and push subscriptions.
      const r = await supa(`/auth/v1/admin/users/${encodeURIComponent(u.data.id)}`, { method: 'DELETE', service: true });
      if (!r.ok) return reply(502, { error: 'delete_failed' });
      return reply(200, { ok: true });
    }
    default:
      return reply(400, { error: 'bad_action' });
  }
}

export default serve(build);
