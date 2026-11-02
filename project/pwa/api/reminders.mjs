/* =============================================================================
 * Ni'ma — daily bill reminders (Vercel Cron, see vercel.json "crons")
 * -----------------------------------------------------------------------------
 * Once a day: for every push subscription whose `days` include today (in that
 * device's own time zone), send one empty push. The service worker turns it
 * into a "a bill is due" notification. Subscriptions the push service reports
 * as gone (404/410) are deleted.
 *
 * Vercel Cron calls this with `Authorization: Bearer $CRON_SECRET`; anything
 * else is refused, so the job can't be triggered from outside.
 * ========================================================================== */
import { serve, reply, bearer, supa, hasService } from './_lib.mjs';
import { okEndpoint, sendEmptyPush } from './_webpush.mjs';

export function localDay(tz, now = new Date()) {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now); }
  catch (e) { return now.toISOString().slice(0, 10); }
}

async function build(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return reply(503, { error: 'CRON_SECRET not configured' });
  if (bearer(req) !== secret) return reply(401, { error: 'unauthorized' });
  if (!hasService()) return reply(503, { error: 'not_configured' });
  const vapid = { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY,
    subject: process.env.VAPID_SUBJECT || 'mailto:admin@example.com' };
  if (!vapid.publicKey || !vapid.privateKey) return reply(503, { error: 'VAPID keys not configured' });

  const r = await supa('/rest/v1/push_subs?select=endpoint,tz,days,last_sent', { service: true });
  if (!r.ok || !Array.isArray(r.data)) return reply(502, { error: 'upstream' });

  let sent = 0, removed = 0, failed = 0;
  for (const s of r.data) {
    const today = localDay(s.tz || 'UTC');
    if (!Array.isArray(s.days) || !s.days.includes(today) || s.last_sent === today) continue;
    const q = `/rest/v1/push_subs?endpoint=eq.${encodeURIComponent(s.endpoint)}`;
    if (!okEndpoint(s.endpoint)) { await supa(q, { method: 'DELETE', service: true }); removed++; continue; }
    let status = 0;
    try { status = await sendEmptyPush(s.endpoint, vapid); } catch (e) { status = 0; }
    if (status === 404 || status === 410) { await supa(q, { method: 'DELETE', service: true }); removed++; }
    else if (status >= 200 && status < 300) { await supa(q, { method: 'PATCH', service: true, body: { last_sent: today } }); sent++; }
    else failed++;
  }
  return reply(200, { checked: r.data.length, sent, removed, failed });
}

export default serve(build);
