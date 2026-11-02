/* =============================================================================
 * Ni'ma — minimal Web Push sender (no dependencies)
 * -----------------------------------------------------------------------------
 * Reminders go out WITHOUT a payload: the push only wakes the service worker,
 * which shows a fixed "a bill is due" notification. That keeps the details of
 * a bill out of the server entirely, and an empty push needs no message
 * encryption — just a VAPID-signed JWT (RFC 8292) proving who sent it.
 * ========================================================================== */
import { createPrivateKey, sign } from 'node:crypto';

const b64u = (buf) => Buffer.from(buf).toString('base64url');

// Push services the reminders job will POST to. Subscriptions are supplied by
// clients, so anything else is refused rather than letting the job be pointed
// at an arbitrary URL.
const PUSH_HOSTS = ['fcm.googleapis.com', 'android.googleapis.com', '.push.services.mozilla.com',
  '.notify.windows.com', 'web.push.apple.com', '.push.apple.com'];
export function okEndpoint(endpoint) {
  try {
    const u = new URL(endpoint);
    if (u.protocol !== 'https:' || endpoint.length > 1000) return false;
    return PUSH_HOSTS.some((h) => (h.startsWith('.') ? u.hostname.endsWith(h) : u.hostname === h));
  } catch (e) { return false; }
}

export function vapidJwt(audience, { publicKey, privateKey, subject }, now = Date.now()) {
  const pub = Buffer.from(publicKey, 'base64url');   // 65-byte uncompressed P-256 point
  const key = createPrivateKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', d: privateKey,
    x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) } });
  const input = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' })) + '.'
    + b64u(JSON.stringify({ aud: audience, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject }));
  return input + '.' + b64u(sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' }));
}

// Returns the push service's HTTP status (201 = queued; 404/410 = subscription gone).
export async function sendEmptyPush(endpoint, vapid) {
  const jwt = vapidJwt(new URL(endpoint).origin, vapid);
  const r = await fetch(endpoint, { method: 'POST', headers: {
    TTL: '86400', Urgency: 'normal', 'Content-Length': '0',
    Authorization: `vapid t=${jwt}, k=${vapid.publicKey}` } });
  return r.status;
}
