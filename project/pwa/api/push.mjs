/* =============================================================================
 * Ni'ma — push subscription endpoint
 * -----------------------------------------------------------------------------
 *   POST   { endpoint, tz, days:['YYYY-MM-DD', …] }   register / refresh
 *   DELETE { endpoint }                               unregister
 *
 * `days` is the only thing the server learns about a user's money: the dates
 * something falls due, so the daily reminders job knows whom to wake. No
 * amounts, names or categories are ever sent.
 * ========================================================================== */
import { serve, reply, readBody, bearer, supa, configured } from './_lib.mjs';
import { okEndpoint } from './_webpush.mjs';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const TZ_RE = /^[A-Za-z0-9_+\-/]{1,64}$/;

async function build(req) {
  if (!configured()) return reply(503, { error: 'not_configured' });
  const token = bearer(req);
  if (!token) return reply(401, { error: 'signed_out' });
  const method = (req.method || 'GET').toUpperCase();
  const b = (await readBody(req)) || {};
  if (typeof b.endpoint !== 'string' || !okEndpoint(b.endpoint)) return reply(400, { error: 'bad_endpoint' });

  if (method === 'POST') {
    const days = Array.isArray(b.days) ? b.days.filter((d) => typeof d === 'string' && DAY_RE.test(d)).slice(0, 120) : [];
    const tz = typeof b.tz === 'string' && TZ_RE.test(b.tz) ? b.tz : 'UTC';
    const r = await supa('/rest/v1/push_subs?on_conflict=endpoint', { method: 'POST', token,
      body: { endpoint: b.endpoint, tz, days }, headers: { Prefer: 'resolution=merge-duplicates,return=minimal' } });
    if (r.status === 401) return reply(401, { error: 'signed_out' });
    if (!r.ok) return reply(502, { error: 'upstream' });
    return reply(200, { ok: true });
  }
  if (method === 'DELETE') {
    const r = await supa(`/rest/v1/push_subs?endpoint=eq.${encodeURIComponent(b.endpoint)}`, { method: 'DELETE', token });
    if (r.status === 401) return reply(401, { error: 'signed_out' });
    return reply(200, { ok: true });
  }
  return reply(405, { error: 'method not allowed' });
}

export default serve(build);
