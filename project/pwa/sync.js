// Ni'ma — end-to-end encrypted sync: the crypto and the HTTP calls.
//
// The server only ever holds ciphertext. How the keys fit together:
//
//   password ──PBKDF2(600k, salt = email)──► master ──HKDF──┬─► authPw  (signs in; this is all the server sees)
//                                                           └─► pwKek   (never leaves the device)
//   recovery key ──HKDF(salt)──► rkKek
//   data key (random AES-256) ── encrypts the app data ──► vault.blob
//   vault.keys = { pw: data key locked by pwKek, rk: data key locked by rkKek }
//
// So the password and the recovery key can each unlock the data key, and
// changing the password only re-locks that one small key. Each signed-in
// device also keeps the data key locally (inside the passcode-encrypted store
// when the app lock is on), which is how a device that's still signed in can
// set a new password without the recovery key.

const te = new TextEncoder(), td = new TextDecoder();
const subtle = () => crypto.subtle;
const KDF_ITER = 600000;

export const b64 = (buf) => { let s = ''; new Uint8Array(buf).forEach((b) => { s += String.fromCharCode(b); }); return btoa(s); };
export const unb64 = (s) => { const bin = atob(s); const a = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return a; };
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const rand = (n) => crypto.getRandomValues(new Uint8Array(n));

export const normEmail = (s) => String(s || '').trim().toLowerCase();

// ---- account keys -------------------------------------------------------
export async function deriveAccountKeys(email, password) {
  const base = await subtle().importKey('raw', te.encode(password), 'PBKDF2', false, ['deriveBits']);
  const master = await subtle().deriveBits({ name: 'PBKDF2', hash: 'SHA-256', iterations: KDF_ITER,
    salt: te.encode('nima-sync:' + normEmail(email)) }, base, 256);
  const hk = await subtle().importKey('raw', master, 'HKDF', false, ['deriveBits', 'deriveKey']);
  const info = (s) => ({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: te.encode(s) });
  const authPw = hex(await subtle().deriveBits(info('nima-auth'), hk, 256));
  const pwKek = await subtle().deriveKey(info('nima-wrap'), hk, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  return { authPw, pwKek };
}

// ---- recovery key: 160 random bits as 8 groups of 4 (Crockford base32) ----
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export function newRecoveryKey() {
  const chars = [...rand(32)].map((b) => B32[b & 31]).join('');
  return chars.match(/.{4}/g).join('-');
}
// Forgiving about case, spaces, dashes and the look-alikes Crockford folds together.
export function normRecoveryKey(s) {
  return String(s || '').toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
}
export const okRecoveryKey = (s) => /^[0-9A-HJKMNP-TV-Z]{32}$/.test(normRecoveryKey(s));
async function rkKek(rk, salt) {
  const hk = await subtle().importKey('raw', te.encode(normRecoveryKey(rk)), 'HKDF', false, ['deriveKey']);
  return subtle().deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: te.encode('nima-recovery') }, hk,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

// ---- AES-GCM boxes --------------------------------------------------------
async function seal(key, bytes) {
  const iv = rand(12);
  return { iv: b64(iv), ct: b64(await subtle().encrypt({ name: 'AES-GCM', iv }, key, bytes)) };
}
async function open(key, box) {
  return new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: unb64(box.iv) }, key, unb64(box.ct)));
}

// The data key travels as raw base64 (`dek`) and is imported per use.
export const newDataKey = () => b64(rand(32));
const dataKey = (dek) => subtle().importKey('raw', unb64(dek), 'AES-GCM', false, ['encrypt', 'decrypt']);

export const lockWithPassword = (pwKek, dek) => seal(pwKek, unb64(dek));
export async function lockWithRecovery(rk, dek) {
  const salt = rand(16);
  return { salt: b64(salt), ...(await seal(await rkKek(rk, salt), unb64(dek))) };
}
export async function makeKeys(pwKek, rk, dek) {
  return { v: 1, pw: await lockWithPassword(pwKek, dek), rk: await lockWithRecovery(rk, dek) };
}
// Both throw (AES-GCM auth failure) when the password / recovery key doesn't match.
export async function unlockWithPassword(keys, pwKek) { return b64(await open(pwKek, keys.pw)); }
export async function unlockWithRecovery(keys, rk) {
  return b64(await open(await rkKek(rk, unb64(keys.rk.salt)), keys.rk));
}

export async function encryptData(dek, json) {
  return JSON.stringify({ v: 1, ...(await seal(await dataKey(dek), te.encode(json))) });
}
export async function decryptData(dek, blob) {
  return td.decode(await open(await dataKey(dek), JSON.parse(blob)));
}

// The local copy of the sync session's secrets (refresh token + data key) is
// sealed with the app-lock key when a passcode is on, like the store itself.
export const sealWith = (key, json) => seal(key, te.encode(json));
export const openWith = async (key, box) => td.decode(await open(key, box));

// ---- HTTP ------------------------------------------------------------------
// Same-origin serverless functions (api/account, api/vault, api/push). Never
// throws: a network failure comes back as status 0 so callers can show
// "offline" instead of crashing.
export async function api(path, { method = 'GET', body, token } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = 'Bearer ' + token;
  try {
    const r = await fetch('api/' + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store' });
    let data = null;
    try { data = await r.json(); } catch (e) { data = null; }
    return { status: r.status, data: data || {} };
  } catch (e) {
    return { status: 0, data: {} };
  }
}

export function urlB64ToBytes(s) {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  return unb64((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
}
